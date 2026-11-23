// MySQL 存储层：事务、owner 行锁、编号分配、事件写入、增量拉取。
//
// 这里是**唯一**知道数据库形状的模块。上层（CLI、pull）只看见两种东西：
//   - 事项记录（item record）：{ id, num, title, note, priority, status,
//     spaces[], agent, created, updated, archived, closedAt, deletedAt, rev, ... }
//     时间一律是 epoch 毫秒；
//   - 事件记录：{ seq, itemId, kind, data, actor, at }。
// 行列映射只在这一处，分叉的机会因此只有一处。
//
// 三条不能改的规则（见 spec §4.4）：
//   1. 每个写事务的第一条语句是锁 owner 行。它同时做三件事：串行化同 owner 写、
//      分配连续 num、让 seq 的分配顺序等于提交顺序。
//   2. 增量拉取的游标只能推进到本次实际取到的最大 seq，绝不能取全局 MAX(seq)。
//   3. 没有取到任何事件时游标不动。

import mysql from "mysql2/promise";

import { TodoError } from "../core.js";
import { ulid } from "../ulid.js";

/** 数据库不可达。CLI 把它映射成退出码 4，与「写入冲突（3）」区分开。 */
export class DbUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = "DbUnreachableError";
    this.code = "db_unreachable";
  }
}

/** 我们认识的 schema 版本。库里的更大时拒绝运行（旧客户端不该往新库写）。 */
const KNOWN_SCHEMA_VERSION = 1;

/** mysql2 的重复键错误。幂等重试靠它。 */
const ER_DUP_ENTRY = 1062;

const RETRYABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND",
  "EHOSTUNREACH", "ENETUNREACH", "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR", "ER_SERVER_SHUTDOWN", "ER_ACCESS_DENIED_ERROR",
]);

function isUnreachable(e) {
  if (!e) return false;
  if (RETRYABLE_CODES.has(e.code)) return true;
  // TLS 握手失败、DNS 失败都以通用错误抛出，没有稳定 code。
  return /connect|handshake|certificate|TLS|socket/i.test(String(e.message ?? ""));
}

function wrap(e, what) {
  if (e instanceof TodoError) return e;
  if (isUnreachable(e)) {
    return new DbUnreachableError(
      `连不上数据库（${what}）：${e.message}\n检查网络、主机端口、口令与证书；可先用 devices 命令试探连通性。`,
    );
  }
  return e;
}

/** 把事件 data 里的字段按 kind 收敛成数据库里的形状。写入端是唯一校验点。 */
function eventRow(ownerId, itemId, e, clientOpId) {
  return [
    ownerId,
    itemId,
    e.kind,
    JSON.stringify(e.data ?? {}),
    e.by ?? "cli",
    clientOpId ?? null,
    new Date(e.at),
  ];
}

/** 时间列读到 JS Date（mysql2 配 timezone:'Z' 会按 UTC 解析，见 spec §3.3）。 */
function ms(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 建连接。每次 CLI 调用建一条短连接（CLI 是短进程，连接池没有意义），
 * 因此这里不做池化。
 *
 * 时区必须两侧同时固定：会话 time_zone 决定服务端怎么解释 NOW()/比较，
 * 连接选项 timezone:'Z' 决定驱动怎么把 DATETIME 解析成 JS 时间点。只设前者
 * 会让读回来的时间整体偏 8 小时且不报错（spec §3.3 有实测记录）。
 */
export async function connect(cfg) {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      timezone: "Z",
      dateStrings: false,
      ssl: cfg.ssl,
      connectTimeout: 8000,
      // 一条命令一次往返就够；显式写出来，避免默认值变化改变行为。
      multipleStatements: false,
      charset: "utf8mb4",
    });
  } catch (e) {
    throw wrap(e, "建立连接");
  }
  try {
    await conn.query("SET SESSION time_zone = '+00:00'");
    const [rows] = await conn.query("SELECT v FROM meta WHERE k = 'schema_version'");
    const v = rows.length ? Number(rows[0].v) : null;
    if (v != null && Number.isFinite(v) && v > KNOWN_SCHEMA_VERSION) {
      throw new TodoError(
        `数据库 schema 版本 ${v} 比本客户端认识的新（${KNOWN_SCHEMA_VERSION}）。请升级 herdr-todo。`,
        "unsupported_version",
      );
    }
  } catch (e) {
    await conn.end().catch(() => {});
    throw wrap(e, "初始化会话");
  }
  return new Store(conn, cfg.owner);
}

export class Store {
  constructor(conn, ownerSlug) {
    this.conn = conn;
    this.ownerSlug = ownerSlug;
    this._ownerId = null;
  }

  async close() {
    await this.conn.end().catch(() => {});
  }

  /**
   * 解析 owner slug → owner 行 id。不存在就建一行（首次写即建档）。
   *
   * 建行用 INSERT ... ON DUPLICATE KEY UPDATE，让两台设备同时首次运行时
   * 不会一个成功一个撞唯一键。
   */
  async ownerId() {
    if (this._ownerId != null) return this._ownerId;
    const now = new Date();
    await this.conn.execute(
      "INSERT INTO owners (slug, item_num, created_at) VALUES (?, 0, ?) " +
        "ON DUPLICATE KEY UPDATE slug = VALUES(slug)",
      [this.ownerSlug, now],
    );
    const [rows] = await this.conn.execute("SELECT id FROM owners WHERE slug = ?", [this.ownerSlug]);
    if (!rows.length) throw new TodoError(`owner ${this.ownerSlug} 建档后仍读不到`, "corrupt");
    this._ownerId = Number(rows[0].id);
    return this._ownerId;
  }

  /**
   * 一个写事务。fn 拿到 tx 句柄；抛错则整体回滚。
   *
   * 事务隔离级别用默认的 REPEATABLE READ。写路径不需要更强：owner 行锁已经
   * 把同 owner 的写排成一队，本事务读到的 items 行不可能是别人「刚好在改」的
   * 中间态。
   */
  async tx(fn) {
    const ownerId = await this.ownerId();
    try {
      await this.conn.beginTransaction();
    } catch (e) {
      throw wrap(e, "开启事务");
    }
    const tx = new Tx(this.conn, ownerId);
    try {
      // 第一条语句必须是它：串行化 + 分配 num + 让 seq 分配序等于提交序。
      const [rows] = await this.conn.execute(
        "SELECT item_num FROM owners WHERE id = ? FOR UPDATE",
        [ownerId],
      );
      tx.itemNum = Number(rows[0]?.item_num ?? 0);
      const out = await fn(tx);
      await this.conn.commit();
      return out;
    } catch (e) {
      await this.conn.rollback().catch(() => {});
      throw wrap(e, "写入");
    }
  }

  /** 读一个 owner 的事项（可选过滤）。只读路径不走事务。 */
  async listItems({ includeDeleted = false, includeClosed = true } = {}) {
    const ownerId = await this.ownerId();
    const where = ["owner_id = ?"];
    const args = [ownerId];
    if (!includeDeleted) where.push("deleted_at IS NULL");
    if (!includeClosed) where.push("status NOT IN ('done','cancelled')");
    const [rows] = await this.conn.execute(
      `SELECT ${ITEM_COLS} FROM items WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`,
      args,
    );
    const places = await this.placesFor(rows.map((r) => r.id));
    return rows.map((r) => toItem(r, places));
  }

  /** 按 id 或 num 读一条事项（含已删除的，供 show/诊断区分「不存在」与「已删除」）。 */
  async getItem({ id = null, num = null } = {}) {
    const ownerId = await this.ownerId();
    const [rows] = id
      ? await this.conn.execute(`SELECT ${ITEM_COLS} FROM items WHERE owner_id = ? AND id = ?`, [ownerId, id])
      : await this.conn.execute(`SELECT ${ITEM_COLS} FROM items WHERE owner_id = ? AND num = ?`, [ownerId, num]);
    if (!rows.length) return null;
    const places = await this.placesFor([rows[0].id]);
    return toItem(rows[0], places);
  }

  async placesFor(ids) {
    if (!ids.length) return new Map();
    const ph = ids.map(() => "?").join(",");
    const [rows] = await this.conn.execute(
      `SELECT item_id, kind, ref, in_space FROM item_places WHERE item_id IN (${ph})`,
      ids,
    );
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.item_id)) map.set(r.item_id, []);
      map.get(r.item_id).push(r);
    }
    return map;
  }

  /**
   * 增量拉取一批事件。返回 { events, maxSeq }。
   *
   * `maxSeq` 是本批实际取到的最大 seq；没有事件时为 null——调用方据此判断
   * 「游标不动」。绝不能把它换成全局 MAX(seq)（spec §4.4 的硬约束）。
   */
  async pullEvents(sinceSeq, limit = 500) {
    const ownerId = await this.ownerId();
    const [rows] = await this.conn.execute(
      "SELECT seq, item_id, kind, data, actor, occurred_at FROM item_events " +
        "WHERE owner_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      [ownerId, sinceSeq, limit],
    );
    return {
      events: rows.map(toEvent),
      maxSeq: rows.length ? Number(rows[rows.length - 1].seq) : null,
    };
  }

  /**
   * 读一批事项的当前状态与各自最近 `timelineLimit` 条事件，供 pull 派生缓存。
   *
   * **含墓碑行**：库里已删除的事项照样返回（带 `deletedAt`），调用方据此把它们
   * 从缓存移除。只过滤物理清除——那种事项不在结果里，同样按「从缓存移除」处理。
   */
  async snapshotFor(ids, timelineLimit = 20) {
    const map = new Map();
    if (!ids.length) return map;
    const ownerId = await this.ownerId();
    const ph = ids.map(() => "?").join(",");
    const [items] = await this.conn.execute(
      `SELECT ${ITEM_COLS} FROM items WHERE owner_id = ? AND id IN (${ph})`,
      [ownerId, ...ids],
    );
    if (!items.length) return map;
    const places = await this.placesFor(items.map((r) => r.id));
    const [events] = await this.conn.execute(
      `SELECT seq, item_id, kind, data, actor, occurred_at FROM (
         SELECT seq, item_id, kind, data, actor, occurred_at,
                ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY seq DESC) AS rn
           FROM item_events WHERE item_id IN (${ph})
       ) t WHERE rn <= ? ORDER BY item_id, seq ASC`,
      [...ids, timelineLimit],
    );
    const byItem = new Map();
    for (const e of events) {
      if (!byItem.has(e.item_id)) byItem.set(e.item_id, []);
      byItem.get(e.item_id).push(toEvent(e));
    }
    for (const r of items) {
      const item = toItem(r, places);
      item.timeline = byItem.get(r.id) ?? [];
      map.set(r.id, item);
    }
    return map;
  }

  /**
   * 全量重建用的一致性快照。
   *
   * 必须在同一事务内读完：分页读的过程中若有并发提交，读到的行会跨多个时间点，
   * 而游标取重建结束时的最大 seq——那个事件对应的事项可能读的是旧值，于是被
   * 当成「已应用」而永久落后（实测复现过，见 activity.md 的 ri/iev 探针）。
   *
   * 所以：开启可重复读事务 → 立刻取本 owner 的 MAX(seq) 作为游标上限 →
   * 同一事务内分页读完全部事项。快照之后提交的事件留给下一次增量拉取。
   */
  async fullSnapshot({ pageSize = 200, timelineLimit = 20 } = {}) {
    // ownerId 必须在开事务**之前**解析：首次调用它会 INSERT owners，把一次写
    // 放进快照事务里，快照边界就取决于驱动何时建立 read view 这种默认行为。
    // 先解析好，事务里第一条语句就一定是 MAX(seq)。
    const ownerId = await this.ownerId();
    try {
      await this.conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await this.conn.beginTransaction();
    } catch (e) {
      throw wrap(e, "开启快照事务");
    }
    try {
      // 第一条语句就是取 MAX(seq)：这一瞬间的快照边界即游标上限。
      const [maxRows] = await this.conn.execute(
        "SELECT COALESCE(MAX(seq), 0) AS m FROM item_events WHERE owner_id = ?",
        [ownerId],
      );
      const maxSeq = Number(maxRows[0].m) || 0;

      const items = [];
      let lastId = "";
      for (;;) {
        const [page] = await this.conn.execute(
          `SELECT ${ITEM_COLS} FROM items
            WHERE owner_id = ? AND deleted_at IS NULL AND id > ?
            ORDER BY id ASC LIMIT ?`,
          [ownerId, lastId, pageSize],
        );
        if (!page.length) break;
        items.push(...page);
        lastId = page[page.length - 1].id;
        if (page.length < pageSize) break;
      }

      const places = await this.placesFor(items.map((r) => r.id));
      const byItem = new Map();
      if (items.length) {
        const ids = items.map((r) => r.id);
        const ph = ids.map(() => "?").join(",");
        const [events] = await this.conn.execute(
          `SELECT seq, item_id, kind, data, actor, occurred_at FROM (
             SELECT seq, item_id, kind, data, actor, occurred_at,
                    ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY seq DESC) AS rn
               FROM item_events WHERE item_id IN (${ph})
           ) t WHERE rn <= ? ORDER BY item_id, seq ASC`,
          [...ids, timelineLimit],
        );
        for (const e of events) {
          if (!byItem.has(e.item_id)) byItem.set(e.item_id, []);
          byItem.get(e.item_id).push(toEvent(e));
        }
      }
      const out = items.map((r) => {
        const item = toItem(r, places);
        item.timeline = byItem.get(r.id) ?? [];
        return item;
      });
      await this.conn.commit();
      return { maxSeq, items: out };
    } catch (e) {
      await this.conn.rollback().catch(() => {});
      throw wrap(e, "全量重建");
    }
  }

  /** 一条事项的**完整**时间线（show / export / 导入自检用）。按 seq 升序。 */
  async fullTimeline(itemId) {
    const ownerId = await this.ownerId();
    const [rows] = await this.conn.execute(
      "SELECT seq, item_id, kind, data, actor, occurred_at FROM item_events " +
        "WHERE owner_id = ? AND item_id = ? ORDER BY seq ASC",
      [ownerId, itemId],
    );
    return rows.map(toEvent);
  }

  /**
   * 设备登记与拉取位点。见 spec §4.4 删除与墓碑。
   *
   * `devices.id` 是全局主键，所以「同一个 id 换一个 owner 再用一次」不能被当成
   * 同一台设备：ODKU 只会改到别人那一行，本 owner 永远没有登记行（`listDevices`
   * 为空、`minPulledSeq` 为 null），墓碑 GC 的安全判定就对着一个不存在的设备算。
   * 因此先读归属，撞上别人的行就明确报错，而不是静默写穿。
   *
   * 设备 id 由本机按 owner 生成（换 owner 会换一个），正常路径上这里只会命中
   * 自己那一行；多一次主键查询是为了让「写错库/写错 id」变成可照做的错误。
   */
  async ensureDevice(deviceId, name) {
    const ownerId = await this.ownerId();
    const now = new Date();
    const [rows] = await this.conn.execute("SELECT owner_id FROM devices WHERE id = ?", [deviceId]);
    if (rows.length && Number(rows[0].owner_id) !== ownerId) {
      throw new TodoError(
        `设备 id ${deviceId} 已登记在另一个 owner 名下。` +
          `本机同步状态（sync.json）与当前配置的 owner 不一致时会这样：` +
          `删掉 ~/.config/herdr-todo/sync.json 后重试，它会按当前 owner 重新生成。`,
        "invalid",
      );
    }
    await this.conn.execute(
      "INSERT INTO devices (id, owner_id, name, created_at, last_seen_at, last_pull_seq, revoked) " +
        "VALUES (?, ?, ?, ?, ?, 0, 0) ON DUPLICATE KEY UPDATE last_seen_at = VALUES(last_seen_at)",
      [deviceId, ownerId, name, now, now],
    );
  }

  /**
   * 推进设备的拉取位点。带 `owner_id` 过滤：device id 是 ULID，知道别人的值不该
   * 就能改他的位点；更现实的是同一条连接上写错 device id 时不该静默改到别人行上。
   * 位点被改高会让 `minPulledSeq()` 误判「该设备已拉过删除事件」，进而让 GC 清掉
   * 它还没拉到的墓碑。
   */
  async setDevicePullSeq(deviceId, seq) {
    const ownerId = await this.ownerId();
    await this.conn.execute(
      "UPDATE devices SET last_pull_seq = ?, last_seen_at = ? WHERE id = ? AND owner_id = ?",
      [seq, new Date(), deviceId, ownerId],
    );
  }

  /** 吊销设备：不再计入墓碑 GC 的安全判定（spec §4.4 删除与墓碑）。 */
  async revokeDevice(deviceId) {
    const ownerId = await this.ownerId();
    const [r] = await this.conn.execute(
      "UPDATE devices SET revoked = 1 WHERE id = ? AND owner_id = ?",
      [deviceId, ownerId],
    );
    if (!r.affectedRows) throw new TodoError(`找不到设备 ${deviceId}`, "not_found");
  }

  async listDevices() {
    const ownerId = await this.ownerId();
    const [rows] = await this.conn.execute(
      "SELECT id, name, created_at, last_seen_at, last_pull_seq, revoked FROM devices " +
        "WHERE owner_id = ? ORDER BY last_seen_at DESC",
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      created: ms(r.created_at),
      lastSeen: ms(r.last_seen_at),
      lastPullSeq: Number(r.last_pull_seq),
      revoked: Boolean(r.revoked),
    }));
  }

  /**
   * 删除事件的 seq（墓碑 GC 需要「所有未吊销设备都拉过它」）。
   * 找不到（已被物理清除）返回 null，此时可以当作「没人需要它了」。
   */
  async deleteEventSeq(itemId) {
    const ownerId = await this.ownerId();
    const [rows] = await this.conn.execute(
      "SELECT seq FROM item_events WHERE owner_id = ? AND item_id = ? AND kind = 'deleted' " +
        "ORDER BY seq ASC LIMIT 1",
      [ownerId, itemId],
    );
    return rows.length ? Number(rows[0].seq) : null;
  }

  /** 未吊销设备里最小的 last_pull_seq。没有设备时返回 null（可以清）。 */
  async minPulledSeq() {
    const ownerId = await this.ownerId();
    const [rows] = await this.conn.execute(
      "SELECT MIN(last_pull_seq) AS m FROM devices WHERE owner_id = ? AND revoked = 0",
      [ownerId],
    );
    const m = rows[0]?.m;
    return m == null ? null : Number(m);
  }

  /** 物理清除墓碑行（连同关联与事件）。调用方必须先判 canPurge。 */
  async purgeItem(itemId) {
    await this.tx(async (tx) => {
      await tx.q("DELETE FROM item_events WHERE item_id = ?", [itemId]);
      await tx.q("DELETE FROM item_places WHERE item_id = ?", [itemId]);
      await tx.q("DELETE FROM items WHERE id = ?", [itemId]);
    });
  }
}

const ITEM_COLS =
  "id, owner_id, num, parent_id, title, note, status, priority, progress, " +
  "created_at, updated_at, closed_at, archived_at, deleted_at, rev";

function toItem(row, places) {
  const mine = places.get(row.id) ?? [];
  const spaces = mine.filter((p) => p.kind === "space").map((p) => p.ref);
  const agentRow = mine.find((p) => p.kind === "agent");
  return {
    id: row.id,
    num: Number(row.num),
    parentId: row.parent_id ?? null,
    title: row.title,
    note: row.note,
    status: row.status,
    priority: `P${Number(row.priority)}`,
    progress: row.progress == null ? null : Number(row.progress),
    created: ms(row.created_at),
    updated: ms(row.updated_at),
    archived: ms(row.archived_at),
    closedAt: ms(row.closed_at),
    deletedAt: ms(row.deleted_at),
    rev: Number(row.rev),
    spaces,
    ...(agentRow ? { agent: { address: agentRow.ref, space: agentRow.in_space } } : {}),
  };
}

function toEvent(row) {
  return {
    seq: Number(row.seq),
    itemId: row.item_id,
    kind: row.kind,
    data: typeof row.data === "string" ? JSON.parse(row.data) : row.data,
    actor: row.actor,
    at: ms(row.occurred_at),
  };
}

/** 事务句柄。只暴露上层需要的那几个动作，避免上层拼 SQL。 */
class Tx {
  constructor(conn, ownerId) {
    this.conn = conn;
    this.ownerId = ownerId;
    this.itemNum = 0;
  }

  q(sql, args) {
    return this.conn.execute(sql, args);
  }

  /**
   * 读一条事项行（含关联），用于在事务内应用规则。找不到返回 null。
   */
  async getItem(id) {
    const [rows] = await this.q(`SELECT ${ITEM_COLS} FROM items WHERE owner_id = ? AND id = ?`, [
      this.ownerId,
      id,
    ]);
    if (!rows.length) return null;
    const [places] = await this.q(
      "SELECT kind, ref, in_space FROM item_places WHERE item_id = ?",
      [id],
    );
    const map = new Map([[id, places]]);
    return toItem(rows[0], map);
  }

  /** 同 getItem，按人读编号。 */
  async getItemByNum(num) {
    const [rows] = await this.q(`SELECT id FROM items WHERE owner_id = ? AND num = ?`, [
      this.ownerId,
      num,
    ]);
    if (!rows.length) return null;
    return this.getItem(rows[0].id);
  }

  /**
   * 分配下一个 num。owner 行已在事务开头锁住，所以这里的 +1 不会与同 owner
   * 的另一个写事务竞争。
   */
  async allocateNum() {
    this.itemNum += 1;
    await this.q("UPDATE owners SET item_num = ? WHERE id = ?", [this.itemNum, this.ownerId]);
    return this.itemNum;
  }

  /**
   * 落一条事项。新建与更新共用：按 id upsert，关联整体替换。
   *
   * 关联用「删了重插」而不是差量比对：一条事项的关联最多几个，重插比算出
   * 增删集合更不容易错，且它是幂等的（重跑一次结果相同）。
   */
  async saveItem(item) {
    await this.q(
      "INSERT INTO items (id, owner_id, num, parent_id, title, note, status, priority, progress, " +
        "created_at, updated_at, closed_at, archived_at, deleted_at, rev) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) " +
        "ON DUPLICATE KEY UPDATE title=VALUES(title), note=VALUES(note), status=VALUES(status), " +
        "priority=VALUES(priority), progress=VALUES(progress), updated_at=VALUES(updated_at), " +
        "closed_at=VALUES(closed_at), archived_at=VALUES(archived_at), deleted_at=VALUES(deleted_at), " +
        "parent_id=VALUES(parent_id), rev=rev+1",
      [
        item.id,
        this.ownerId,
        item.num,
        item.parentId ?? null,
        item.title,
        item.note,
        item.status,
        Number(String(item.priority).replace("P", "")),
        item.progress ?? null,
        new Date(item.created),
        new Date(item.updated),
        item.closedAt == null ? null : new Date(item.closedAt),
        item.archived == null ? null : new Date(item.archived),
        item.deletedAt == null ? null : new Date(item.deletedAt),
      ],
    );

    await this.q("DELETE FROM item_places WHERE item_id = ?", [item.id]);
    for (const sid of item.spaces ?? []) {
      await this.q(
        "INSERT INTO item_places (item_id, kind, ref, in_space) VALUES (?, 'space', ?, NULL)",
        [item.id, sid],
      );
    }
    if (item.agent) {
      await this.q(
        "INSERT INTO item_places (item_id, kind, ref, in_space) VALUES (?, 'agent', ?, ?)",
        [item.id, item.agent.address, item.agent.space],
      );
    }
  }

  /**
   * 追加事件，返回各自分配到的 seq。
   *
   * 幂等键撞唯一键时不在这里吞掉：那是「这次操作已经生效过」的信号，必须
   * 由调用方回滚整个事务、再按 client_op_id 读回结果（见 src/sync.js 的 withReplay）。
   */
  async appendEvents(itemId, events, clientOpId) {
    const seqs = [];
    for (let i = 0; i < events.length; i++) {
      // client_op_id 只挂本批的**最后**一条：它是「这次用户操作」的代表。
      // 一条操作可能产生两条事件（例如重开+取消归档），两条共用一个幂等键
      // 会让第二条自己撞自己。
      const opId = i === events.length - 1 ? clientOpId ?? null : null;
      const [r] = await this.conn.execute(
        "INSERT INTO item_events (owner_id, item_id, kind, data, actor, client_op_id, occurred_at) " +
          "VALUES (?,?,?,?,?,?,?)",
        eventRow(this.ownerId, itemId, events[i], opId),
      );
      seqs.push(Number(r.insertId));
    }
    return seqs;
  }

  /** 按幂等键找回那条事件（重试路径）。 */
  async eventByOp(clientOpId) {
    const [rows] = await this.q(
      "SELECT seq, item_id, kind, data, actor, occurred_at FROM item_events " +
        "WHERE client_op_id = ? AND owner_id = ?",
      [clientOpId, this.ownerId],
    );
    return rows.length ? toEvent(rows[0]) : null;
  }

  /** 一条事项最近的事件，按 seq 升序。写命令要用它刷新缓存里的时间线。 */
  async recentEvents(itemId, limit = 20) {
    const [rows] = await this.q(
      "SELECT seq, item_id, kind, data, actor, occurred_at FROM ( " +
        "SELECT seq, item_id, kind, data, actor, occurred_at, " +
        "ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY seq DESC) AS rn " +
        "FROM item_events WHERE item_id = ?" +
        ") t WHERE rn <= ? ORDER BY seq ASC",
      [itemId, limit],
    );
    return rows.map(toEvent);
  }
}

export { ER_DUP_ENTRY, eventRow };
