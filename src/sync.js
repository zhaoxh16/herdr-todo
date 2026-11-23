// 同步编排：把「规则层 + 存储层 + 缓存」串成两个动作——
//   - 写命令：事务内应用规则、落行、落事件，然后只替换缓存里的那一条；
//   - pull：拉事件、读受影响事项的当前行、把它们合进缓存，成功后才推进游标。
//
// 两条路径都在 src/cache.js 的写保护里收口。这里只负责「合并什么」，不负责
// 「怎么原子写」与「谁赢」——那两件事属于 cache.js 与 spec §4.4。
//
// 事项在三种形状之间转换，转换函数只在这里出现一次：
//   item record（store）←→ cache item（面板读的）←→ event（时间线）

import { TodoError, emptyState } from "./core.js";
import { ulid, isUlid } from "./ulid.js";
import { readSync, writeSync, advanceSync, ownerMismatch } from "./cache.js";

const TIMELINE_KEEP = 20;
const PULL_BATCH = 500;
const MAX_BATCHES = 40;
const REBUILD_ATTEMPTS = 3;

/** 把 CLI 的位置参数解析成 { id } 或 { num }。`t12` 明确拒绝（不兼容旧 id）。 */
export function parseRef(arg) {
  const s = String(arg ?? "").trim();
  if (!s) throw new TodoError("需要一个事项编号或 id", "invalid");
  if (/^t\d+$/i.test(s)) {
    throw new TodoError(
      `旧编号 ${s} 不再支持。改用 #编号（如 #12）或完整 id（26 位大写字母数字）。`,
      "invalid",
    );
  }
  if (isUlid(s)) return { id: s };
  const m = /^#?(\d+)$/.exec(s);
  if (m) {
    const num = Number(m[1]);
    if (!Number.isSafeInteger(num) || num <= 0) throw new TodoError(`编号不合法：${s}`, "invalid");
    return { num };
  }
  throw new TodoError(
    `认不出「${s}」是哪条事项。可用 #12 或 26 位 id；t12 形式已不再支持。`,
    "invalid",
  );
}

/**
 * 事件 → 缓存时间线条目。字段名与迁移前逐字段相同（面板渲染不认别的形状）。
 *
 * 额外带一个 `seq`：`occurred_at` 是客户端时钟，跨设备会偏，**顺序的权威只能是
 * 事件序号**（spec §6.3）。缓存是面板唯一的读源，不把 seq 带下来，展示层就只能
 * 按时钟排，跨设备时间线会乱序。
 */
export function eventToTimeline(e) {
  const d = e.data ?? {};
  let from = null;
  let to = null;
  if (e.kind === "created") {
    to = d.status ?? "todo";
  } else if (e.kind === "note") {
    // 旧账本里备注条目用 {length} 对象，`describeEntry` 读的是 e.from.length。
    from = d.from_len == null ? null : { length: d.from_len };
    to = d.to_len == null ? null : { length: d.to_len };
  } else {
    from = d.from ?? null;
    to = d.to ?? null;
  }
  const out = { at: e.at, kind: e.kind, from, to, by: e.actor };
  // 从库里读出来的事件有 seq；从旧账本时间线来的条目没有（不存在这个字段）。
  if (e.seq != null) out.seq = e.seq;
  return out;
}

/** item record → 缓存里的那条事项。字段集与迁移前相同（外加 num）。 */
export function itemToCache(item, timeline) {
  return {
    id: item.id,
    num: item.num,
    title: item.title,
    note: item.note,
    priority: item.priority,
    status: item.status,
    spaces: [...(item.spaces ?? [])],
    created: item.created ?? 0,
    updated: item.updated ?? 0,
    timeline: (timeline ?? []).map((e) => (e.kind && e.actor ? eventToTimeline(e) : { ...e })),
    ...(item.archived != null ? { archived: item.archived } : {}),
    ...(item.agent ? { agent: { address: item.agent.address, space: item.agent.space } } : {}),
  };
}

// ---------- 写路径 ----------

/**
 * 事务提交后把结果刷进缓存：只替换本次改动的那一条，其余事项原样保留，并把
 * `synced_through` 提到本次的 seq——但**不动** `pull_cursor`（spec §4.4 两个游标）。
 *
 * 不能无脑覆盖那一条。从本事务提交到拿到缓存锁之间有一段窗口，期间可能是：
 *   - 另一个 pull 把同伴对这个事项的**更新**合进了缓存（提交顺序在本事务之后）；
 *   - 同伴**删除**了这个事项，pull 已把它从缓存移除。
 * 这两种情况下缓存里的那份比事务快照新。判据与 pull 的 `mergeBatch` 完全相同
 * （事项级 `updated`），否则两套写保护会给出不同答案：缓存长期停在旧内容，
 * 更糟的是删掉的条目被重新插回去，而删除事件已在游标之下、再也不会被拉回。
 *
 * `synced_through` 仍然照常前进——它只表示「这份缓存不认可更早的写入」，与
 * 本条内容是否被采用无关。
 */
async function flushToCache(cache, result) {
  const item = result.item;
  const through = result.seqs?.length ? Math.max(...result.seqs) : result.seq ?? null;
  try {
    // `requireExisting`：缓存文件不在时**不写**。从空基线写出一份只含这一条的
    // 缓存，等于告诉下一次 pull「缓存是可合并的」，其余事项（事件早已在游标
    // 之下）就永远回不来。留空让它走全量重建。
    const r = await cache.update((baseline) => {
      const cached = baseline.items.find((it) => it.id === item.id);
      // 基线里已没有这一条，只有两种可能：从未拉过（本机新建，可以插入），
      // 或同伴已删除且 pull 处理过（不能再插回去）。
      const removedByPeer = !cached && Number(baseline.synced_through) >= (through ?? 0);
      // 缓存里那份比本事务快照新：留着它，别删。**不能先去重再判断**——
      // 先把这条从 items 里过滤掉、发现较新又不放回去，等于删掉了较新的那份。
      const newer = cached && Number(cached.updated) > Number(item.updated);
      let items;
      if (newer) {
        items = baseline.items.slice();
      } else {
        items = baseline.items.filter((it) => it.id !== item.id);
        if (!removedByPeer && item.deletedAt == null) {
          items.push(itemToCache(item, result.timeline ?? null));
        }
      }
      return {
        ...baseline,
        synced_through: Math.max(Number(baseline.synced_through) || 0, through ?? 0),
        synced_at: Date.now(),
        items,
      };
    }, { requireExisting: true });
    if (r.missing) return { ...result, through, cacheSkipped: true };
  } catch (e) {
    // v1 旧账本在缓存路径上：写命令同样不能碰它（那是唯一真相），但也不是
    // 「写失败」——事务已提交。跳过缓存，让用户按 pull 的提示去导入。
    if (e.code === "legacy_ledger") return { ...result, through, cacheSkipped: true };
    // 缓存损坏不是写命令的失败：事务已提交，真相在库里。合并进一份读不懂的
    // 基线只会把别的条目丢掉，所以这里不写；下一次 pull 识别出损坏并整体重建。
    if (e.code !== "corrupt") throw e;
    return { ...result, through, cacheSkipped: true };
  }
  return { ...result, through };
}

/**
 * 写一条事项：事务内读行 → 应用规则 → 落行 + 落事件 → 刷缓存。
 *
 * `mutate(record)` 返回 { item, events }，与 rules.js 的返回同形。可以连应用
 * 多条规则（`move` 的「先摘来源再落目标」就是这样），事件按顺序全部记下。
 */
export async function updateItem(store, cache, ref, mutate, { clientOpId }) {
  const result = await withReplay(store, clientOpId, async (tx) => {
    const current = ref.id ? await tx.getItem(ref.id) : await tx.getItemByNum(ref.num);
    if (!current) {
      throw new TodoError(
        ref.id ? `找不到事项 ${ref.id}` : `找不到编号 #${ref.num} 的事项`,
        "not_found",
      );
    }
    if (current.deletedAt != null) throw new TodoError(`事项 ${current.id} 已被删除`, "not_found");
    const { item, events } = mutate(current);
    if (!events.length) return { item: current, events: [], seqs: [], changed: false };
    await tx.saveItem(item);
    const seqs = await tx.appendEvents(item.id, events, clientOpId);
    const fresh = await tx.getItem(item.id);
    return { item: fresh, events, seqs, timeline: await tx.recentEvents(item.id), changed: true };
  });
  if (!result.changed) return result;
  return flushToCache(cache, result);
}

/** 新建：id 由客户端生成（ULID），num 由 owner 行锁分配。 */
export async function createItem(store, cache, input, { clientOpId, applyCreate }) {
  const result = await withReplay(store, clientOpId, async (tx) => {
    const num = await tx.allocateNum();
    const at = Date.now();
    const { item, events } = applyCreate({ ...input, id: ulid(at), num, at, by: input.by });
    await tx.saveItem(item);
    const seqs = await tx.appendEvents(item.id, events, clientOpId);
    const fresh = await tx.getItem(item.id);
    return { item: fresh, events, seqs, timeline: await tx.recentEvents(item.id), changed: true };
  });
  // 重放（同一 --op 第二次到达）不刷缓存：事件是上一次写的，缓存里那条大概率
  // 已是这个状态，而那个 seq 早已在 synced_through 之下。
  if (!result.changed) return result;
  return flushToCache(cache, result);
}

/**
 * 事务 + 幂等重放。
 *
 * 撞 uk_op 时事务已回滚，那条事件是上一次调用写的。正确动作不是重试也不是
 * 报错，而是**读回**：按幂等键取事件与 item_id，再读事项当前行，组装成与首次
 * 调用同形的返回值。返回的是事项的**当前状态**，不是首次调用时的快照——两者
 * 之间若有别人写入，当前状态会不同，这是正确行为而非缺陷。
 *
 * `changed: false` 让调用方跳过刷缓存：事件是上一次写的，缓存里那条大概率
 * 已经是这个状态；即使不是，下一轮 pull 会补上（而且重放不该推进
 * `synced_through`——那个 seq 早就在里面了）。
 */
async function withReplay(store, clientOpId, fn) {
  try {
    return await store.tx(fn);
  } catch (e) {
    if (!clientOpId || e?.code !== "ER_DUP_ENTRY") throw e;
    return store.tx(async (tx) => {
      const event = await tx.eventByOp(clientOpId);
      if (!event) throw e; // 撞的是别的唯一键（例如 uk_one_agent），照原样抛
      const item = await tx.getItem(event.itemId);
      return {
        item, events: [], seqs: [], seq: event.seq, changed: false, replayed: true,
        timeline: await tx.recentEvents(event.itemId),
      };
    });
  }
}

// ---------- pull ----------

/**
 * 一次 pull。返回 { applied, cursor, rebuilt, itemCount }。
 *
 * 三种情形：
 *   1. sync.json 正常且缓存文件在 → 增量拉取；
 *   2. sync.json 缺失/损坏、缓存读不懂或缓存文件不在 → 归零并**落盘**，然后全量重建；
 *   3. 增量拉取过程中发现没有新事件 → 游标不动，什么都不写。
 *
 * 第 2 条也可能在增量拉取中途触发（缓存被删掉），见循环里的 `requireExisting`。
 */
export async function pullOnce(store, cache, syncFile, { deviceName = "cli" } = {}) {
  const loaded = await readSync(syncFile);
  let deviceId = loaded?.device_id ?? null;
  let cursor = loaded && !loaded.corrupt ? loaded.pull_cursor : 0;
  // 本机状态（sync.json + 缓存）是**某个 owner 的视图**。换了身份（改配置文件
  // 的 owner）还沿用旧文件，就会拿另一个租户的游标去增量拉——跳过的那些事件
  // 再也不会被拉到。所以身份对不上时整份本机状态作废、从零重建。
  const ownerChanged = ownerMismatch(loaded, store.ownerSlug);
  // 缓存读不懂时不能合并（合并会丢掉别的条目），只能整体重建。缓存是派生物，
  // 丢掉重来不丢数据——真相在库里。
  //
  // 缓存文件被删掉（或从未有过）同样走重建，这次检查**不能**只靠循环里的
  // `requireExisting`：没有新事件时循环一次都不进，pull 会报「已是最新」而缓存
  // 仍然是空的。
  //
  // 还有一种写法：文件在、内容却是空的（`> todos.json`、编辑器重写中途被打断、
  // 恢复工具留下 0 字节）。`read()` 对它返回空状态，`exists()` 也为真，于是被当成
  // 「合法的空快照」增量合并——其余事项的事件早已在游标之下，永远回不来。
  // `isBlank()` 把「缺失」与「0 字节」一并算作没有基线；正常写出的空缓存是一份
  // 完整 JSON，不会被误判。
  const cacheBlank = await cache.isBlank();
  let cacheCorrupt = false;
  try {
    await cache.read();
  } catch (e) {
    // v1 旧账本**不是**损坏：它是一份更值钱的数据，处理方式完全不同（停下让
    // 人先导入，而不是覆盖）。单独上抛，由 CLI 给出可照做的提示。
    if (e.code === "legacy_ledger") throw e;
    if (e.code !== "corrupt") throw e;
    cacheCorrupt = true;
  }
  const cacheUnusable =
    ownerChanged || cacheCorrupt || cacheBlank ||
    !loaded || loaded.corrupt || !loaded.device_id || loaded.rebuild_required;

  if (cacheUnusable) {
    // 换身份时设备 id 一并换新：旧 id 已登记在上一个 owner 名下，沿用会被
    // ensureDevice 的归属守卫拒绝。
    return resetAndRebuild(store, cache, syncFile, ownerChanged ? null : deviceId, deviceName, {
      ownerSwitch: ownerChanged,
    });
  }

  await store.ensureDevice(deviceId, deviceName);

  let applied = 0;
  let maxApplied = cursor;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { events, maxSeq } = await store.pullEvents(cursor, PULL_BATCH);
    if (maxSeq == null) break; // 没有事件：游标不动

    const ids = [...new Set(events.map((e) => e.itemId))];
    const snapshot = await store.snapshotFor(ids, TIMELINE_KEEP);

    // 合进缓存后才推进游标。cache.update 的写保护只会在「本机写入比这批更新」时
    // 换基线重试，最终落盘的那份一定覆盖到 maxSeq；重试耗尽则抛错，游标不推进。
    //
    // `requireExisting` 堵住一个窄窗口：缓存存在性在上面查过一次，但拉取要跑好几批，
    // 期间用户可能把缓存删掉（删缓存是文档承诺的合法操作）。那时 read() 返回空状态，
    // 合并只会留下本批涉及的事项，其余事项的事件早已在游标之下、再也不会被拉到——
    // 与「删缓存后直接 pull」同一条失效路径。查到缺失就转全量重建。
    const res = await cache.update(
      (baseline) => mergeBatch(baseline, ids, snapshot, maxSeq),
      { requireExisting: true },
    );
    if (res.missing) return resetAndRebuild(store, cache, syncFile, deviceId, deviceName);
    // 落盘成功才推进游标（spec §4.4）。写成断言而不是靠注释：合并逻辑将来若
    // 返回 null（不写），游标仍会照常前进，那一批事件就永远补不回来。
    if (!res.written) {
      throw new TodoError(`缓存未能落盘，本次 pull 停在游标 ${cursor}（下次重试）`, "conflict");
    }

    // 同一设备可能有两个 pull 在跑（两个侧栏各起一个）。`pull_cursor` 的语义是
    // 「已应用到哪儿」，回退会让下一轮重复拉，不会丢数据，但会让 `devices`
    // 的位点与真实进度分叉——spec 明确要求它单调。advanceSync 在文件锁里取
    // 磁盘现值与本次值的较大者，所以两个 pull 交错也不会把它写小。
    await advanceSync(syncFile, {
      device_id: deviceId,
      owner: store.ownerSlug,
      pull_cursor: maxSeq,
      last_pull_at: Date.now(),
      rebuild_required: false,
    });
    await store.setDevicePullSeq(deviceId, maxSeq);

    cursor = maxSeq;
    maxApplied = maxSeq;
    applied += events.length;
    if (events.length < PULL_BATCH) break;
  }

  return {
    applied,
    cursor,
    rebuilt: false,
    itemCount: (await cache.read()).items.length,
    advanced: maxApplied !== (loaded?.pull_cursor ?? 0),
  };
}

/**
 * 全量重建的共同入口：把游标归零**落盘**并打上 `rebuild_required`，再重建；
 * 重建成功后才把游标推进到快照上限并清掉标记。
 *
 * 归为零必须落盘：重建失败或重试耗尽时，下次运行看到的仍是「要从零重建」，
 * 而不是「从 0 增量拉」。后者会让「库里已不存在的事项」永远留在缓存里——它们
 * 的事件早被清掉，增量拉不会再碰到它们。
 *
 * `ownerSwitch` 为真表示这次重建是因为换了身份。缓存里那份属于上一个 owner，
 * 它的 `synced_through` 与本 owner 的序号不可比，写保护会一直判「现有的更新」
 * 而拒绝替换——所以先备份再删掉，重建从空文件起步。
 */
async function resetAndRebuild(store, cache, syncFile, deviceId, deviceName, { ownerSwitch = false } = {}) {
  const id = deviceId ?? ulid();
  if (ownerSwitch) {
    // 备份是尽力而为的一步：删的是派生缓存，重建失败也只是下次重来。
    // sync.json 留着没关系——下面马上整份重写，且 device id 已换成新的。
    await cache.backup("owner-switch");
    await cache.remove();
  }
  await writeSync(syncFile, {
    device_id: id,
    owner: store.ownerSlug,
    pull_cursor: 0,
    last_pull_at: null,
    rebuild_required: true,
  });
  const rebuilt = await rebuild(store, cache, id, deviceName);
  await writeSync(syncFile, {
    device_id: id,
    owner: store.ownerSlug,
    pull_cursor: rebuilt.cursor,
    last_pull_at: Date.now(),
    rebuild_required: false,
  });
  return { ...rebuilt, rebuilt: true, reset: true, ownerSwitch };
}

/**
 * 把一批事件涉及的事项合进缓存。
 *
 * 同 id 冲突以**缓存里那份较新的**为准：库中之读发生在本机写入提交之前，
 * 拿它覆盖会把本机刚写的改动短暂回退（下一轮 pull 会修回，但用户会看到闪回）。
 * 判据是 `updated`——同一条事项的时间戳在两端只有一个来源（写入端），可以比。
 */
function mergeBatch(baseline, ids, snapshot, maxSeq) {
  const byId = new Map(baseline.items.map((it) => [it.id, it]));
  for (const id of ids) {
    const fromDb = snapshot.get(id);
    if (!fromDb || fromDb.deletedAt != null) {
      byId.delete(id); // 已删除或已物理清除：从缓存移除
      continue;
    }
    const cached = byId.get(id);
    if (cached && Number(cached.updated) > Number(fromDb.updated)) continue; // 缓存较新
    byId.set(id, itemToCache(fromDb, fromDb.timeline));
  }
  return {
    ...baseline,
    synced_through: Math.max(Number(baseline.synced_through) || 0, maxSeq),
    synced_at: Date.now(),
    items: [...byId.values()],
  };
}

/**
 * 全量重建：一致性快照 → 整体替换缓存（不是合并，否则「库里已不存在的事项」
 * 永远留着）→ 成功后才推进游标。
 *
 * 与写保护相遇时的处理：整体替换会被「现有更较新」判据挡下，此时**重新取
 * 快照重做一次**，而不是放弃——放弃会让「早于快照已删除、deleted 事件不会再
 * 被增量拉到」的条目留在缓存里，正好抵消掉重建存在的理由。重试耗尽则本次
 * pull 放弃且不推进游标（调用方抛错，下次再来）。
 */
async function rebuild(store, cache, deviceId, deviceName) {
  await store.ensureDevice(deviceId, deviceName);
  // 整体替换会把缓存路径上的旧内容全部丢掉。正常情况下那是一份派生缓存（丢了
  // 不心疼），但「缓存路径上放着一份还没被导入的旧账本」正是迁移窗口的常态——
  // 那时它是唯一真相。所以覆盖前先留一份，且备份失败就中止（宁可这次 pull 不
  // 成功，也不能在没有退路的情况下销毁用户数据）。
  const backupPath = await cache.backup("bak");
  for (let attempt = 0; attempt < REBUILD_ATTEMPTS; attempt++) {
    const snap = await store.fullSnapshot({ timelineLimit: TIMELINE_KEEP });
    const state = {
      v: 2,
      synced_through: snap.maxSeq,
      synced_at: Date.now(),
      items: snap.items.map((it) => itemToCache(it, it.timeline)),
    };
    const res = await cache.update((baseline) => {
      // 重建期间本机写入把 synced_through 顶到快照之后：这份替换已经过期，
      // 不写，交给外层重取快照。
      if (Number(baseline.synced_through) > snap.maxSeq) return null;
      return state;
    }, { fromCorrupt: true });
    if (res.written) {
      await store.setDevicePullSeq(deviceId, snap.maxSeq);
      return {
        applied: snap.items.length,
        cursor: snap.maxSeq,
        itemCount: snap.items.length,
        backupPath,
      };
    }
  }
  throw new TodoError(
    `全量重建连着 ${REBUILD_ATTEMPTS} 次被本机写入打断，本次 pull 放弃（游标未推进）。稍后重试。`,
    "conflict",
  );
}
