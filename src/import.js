// 旧账本（v1 单机 JSON）→ 数据库。一次性迁移，可重复执行但默认拒绝非空库。
//
// 迁的是什么：每条事项的当前字段、它全部时间线条目（按原顺序成为事件）、
// space 与 agent 关联。迁的不是什么：旧 id（`t12` 已不再可寻址，新 id 是 ULID）、
// `seq` 计数器（Number 由 owner 行锁重新分配）。
//
// 顺序很重要：事项按旧账本里的 `seq`/出现顺序迁入，因此新 `num` 也是 1..N，
// 与旧编号「大致对得上」（删过号的话会紧凑掉，这是预期的：新编号连续）。
// 事件按每条事项自己的时间线顺序写入，seq 因此严格递增——所有设备首次 pull
// 都能拿到完整历史。
//
// 自检：迁完回读一遍，逐条比对「标题/状态/优先级/备注长度/关联数/时间线条数」，
// 把差异打出来。差异不阻断迁移（数据已经写进去了），命令仍退出 0，但会打印
// 「自检发现 N 处差异」并逐条列出——这是给人看的告警，不是机器判据；脚本要
// 严格把关请用 `--json` 自己检查 `mismatches`。

import fs from "node:fs/promises";

import { normalizeState, TodoError } from "./core.js";
import { itemToCache } from "./sync.js";
import { ulid } from "./ulid.js";

/**
 * 旧时间线条目 → 事件。字段名变化：
 *   at → occurred_at（由 appendEvents 转成 Date）
 *   by → actor
 *   {from,to} 的形状按 kind 换成 data 里的字段名。
 */
function entryToEvent(entry) {
  const kind = entry.kind;
  let data;
  switch (kind) {
    case "created":
      data = { title: null, status: entry.to ?? "todo", priority: null, from_parent: null };
      break;
    case "note":
      data = {
        from_len: entry.from?.length ?? 0,
        to_len: entry.to?.length ?? 0,
      };
      break;
    case "spaces":
      data = { from: Array.isArray(entry.from) ? entry.from : [], to: Array.isArray(entry.to) ? entry.to : [] };
      break;
    case "archived":
    case "unarchived":
      data = {};
      break;
    default:
      data = { from: entry.from ?? null, to: entry.to ?? null };
  }
  return { kind, data, actor: entry.by ?? "import", at: Number(entry.at) };
}

/** 旧事项 → 可写入的 item record。spaces/agent 拆成关联，状态与时间戳原样带过。 */
function itemFromLegacy(it, id, num) {
  return {
    id,
    num,
    parentId: null,
    title: String(it.title ?? ""),
    note: String(it.note ?? ""),
    status: it.status ?? "todo",
    priority: it.priority ?? "P2",
    progress: null,
    created: Number(it.created) || 0,
    updated: Number(it.updated) || Number(it.created) || 0,
    archived: it.archived != null ? Number(it.archived) : null,
    closedAt: null,
    deletedAt: null,
    rev: 1,
    spaces: Array.isArray(it.spaces) ? [...it.spaces].map(String) : [],
    ...(it.agent ? { agent: { address: String(it.agent.address), space: String(it.agent.space) } } : {}),
  };
}

/**
 * 导入。返回 { imported, skipped, mismatches }。
 *
 * 默认拒绝在非空库上执行：重复导入会让每条事项再存一份（id 是新生成的 ULID，
 * 不与已有的重），这不是「幂等」而是「翻倍」。`--force` 才继续。
 */
export async function importLedger(store, cache, file, options = {}) {
  const {
    by = "import",
    force = false,
    dryRun = false,
    json = false,
    out = console.log,
    // 过程提示（备份路径、缓存跳过）走这里。`--json` 时 stdout 必须只有一份
    // 可解析的 JSON，否则脚本拿到的是一行中文加一段 JSON——这是对外契约，
    // 不是排版偏好。
    note = console.error,
  } = options;

  const raw = await fs.readFile(file, "utf8").catch((e) => {
    throw new TodoError(`读不了旧账本 ${file}：${e.message}`, "invalid");
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new TodoError(`旧账本 ${file} 不是合法 JSON：${e.message}`, "invalid");
  }
  // v1 可能已经带 synced_* 字段（若被人手工跑过 v2 代码），normalizeState 都认。
  const legacy = normalizeState(parsed);
  if (!legacy.items.length) throw new TodoError(`旧账本 ${file} 里没有事项`, "invalid");

  const existing = await store.listItems({ includeClosed: true });
  if (existing.length && !force) {
    throw new TodoError(
      `库里已有 ${existing.length} 条事项，看起来已经导入过。` +
        `确实要再导入一份（会翻倍）请加 --force；只想备份请用 export。`,
      "exists",
    );
  }

  if (dryRun) {
    const n = legacy.items.length;
    const events = countEvents(legacy);
    if (json) out(JSON.stringify({ dryRun: true, items: n, events, imported: 0 }, null, 2));
    else out(`[dry-run] 将导入 ${n} 条事项、${events} 条时间线记录`);
    return { imported: 0, skipped: legacy.items.length, mismatches: [] };
  }

  // 迁移前备份（spec §6.1）。最自然的用法就是拿默认缓存路径当源文件，而导入
  // 结束会把它重写成 v2 缓存——不先留一份，v1 原件当场消失。
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(file, backup);
  note(`已备份旧账本 → ${backup}`);

  let maxImportedSeq = 0;
  const mapping = [];
  // 故意用一个长事务：导入是迁移期的一次性动作，此刻没有别的写者，而分成多个
  // 事务会让「中途失败」留下半份数据且没有一个自然的续作点。这条与「单次写入
  // 限定在几条语句内」的常规约束的偏离是有意的，代价是导入期间同 owner 的其它
  // 写会被阻塞——迁移现场不会有其它写。
  const stats = await store.tx(async (tx) => {
    let imported = 0;
    for (const legacyItem of legacy.items.sort((a, b) => (a.created || 0) - (b.created || 0))) {
      const num = await tx.allocateNum();
      const id = ulid(Number(legacyItem.created) || Date.now());
      const item = itemFromLegacy(legacyItem, id, num);
      await tx.saveItem(item);

      const events = legacyItem.timeline.map(entryToEvent);
      if (!events.length) {
        // 没有时间线的旧事项也要有一条 created，否则它在 show 里是空历史。
        events.push({
          kind: "created",
          data: { title: item.title, status: item.status, priority: item.priority, from_parent: null },
          actor: by,
          at: item.created,
        });
      }
      const seqs = await tx.appendEvents(item.id, events, null);
      maxImportedSeq = Math.max(maxImportedSeq, ...seqs);
      mapping.push({ from: legacyItem.id, to: id, num, title: item.title, events: events.length });
      imported++;
    }
    return { imported };
  });

  // 自检：回读并逐条比对。
  const mismatches = [];
  for (const m of mapping) {
    const dbItem = await store.getItem({ id: m.to });
    const legacyItem = legacy.items.find((x) => x.id === m.from);
    if (!dbItem) {
      mismatches.push(`${m.from} → ${m.to}：回读不到`);
      continue;
    }
    const checks = [
      ["标题", legacyItem.title, dbItem.title],
      ["状态", legacyItem.status, dbItem.status],
      ["优先级", legacyItem.priority, dbItem.priority],
      ["备注长度", legacyItem.note.length, dbItem.note.length],
      ["关联数", legacyItem.agent ? 1 : legacyItem.spaces.length, dbItem.agent ? 1 : dbItem.spaces.length],
    ];
    for (const [what, want, got] of checks) {
      if (String(want) !== String(got)) {
        mismatches.push(`${m.from} → #${m.num}：${what} 不一致（旧 ${want} / 新 ${got}）`);
      }
    }
    const timeline = (await store.fullTimeline(m.to)).length;
    if (timeline !== m.events) {
      mismatches.push(`${m.from} → #${m.num}：时间线 ${m.events} 条写成 ${timeline} 条`);
    }
  }

  const cacheItems = [];
  for (const m of mapping) {
    const dbItem = await store.getItem({ id: m.to });
    cacheItems.push(itemToCache(dbItem, await store.fullTimeline(m.to)));
  }
  if (cacheItems.length) {
    // `requireExisting`：与写命令同一条纪律（spec §4.4）。缓存文件不在时从空基线
    // 写出「只含本次导入的条目」会抹掉「缺失」这个信号——若库里还有本次没导入的
    // 事项（`--force` 重复导入），它们的事件已在游标之下、以后再也拉不回来。
    // 留空让第一次 pull 整体重建，缓存内容与库里逐条一致。
    // 缓存读不懂不该让「导入失败」：事务已经提交，真相在库里。与写命令同一条
    // 纪律（见 sync.js 的 flushToCache），留给下一次 pull 整体重建；反过来把
    // corrupt 抛出去，用户看到的是一次失败，重跑又会被「库里已有事项」拦住。
    let r;
    try {
      r = await cache.update((baseline) => {
        const byId = new Map(baseline.items.map((it) => [it.id, it]));
        for (const it of cacheItems) byId.set(it.id, it);
        // 保护戳要提到导入事件的 seq，否则下次 pull 会把这几百条事件重放一遍；
        // 它就是本次事务实际分配到的最大 seq，不能取 baseline 现有的值。
        const through = Math.max(Number(baseline.synced_through) || 0, maxImportedSeq);
        return { ...baseline, synced_through: through, synced_at: Date.now(), items: [...byId.values()] };
      }, { requireExisting: true });
    } catch (e) {
      // v1 旧账本与损坏的缓存都跳过本次预热（导入已提交，真相在库里）。
      if (e.code !== "corrupt" && e.code !== "legacy_ledger") throw e;
      note(
        e.code === "legacy_ledger"
          ? "缓存路径上是一份 v1 旧账本，本次未写入；请先把它导入或改名移走，下一次 pull 会整体重建缓存"
          : "缓存不是合法 JSON，本次未写入；第一次 pull 会整体重建（数据已在库里）",
      );
    }
    if (r?.missing) note("缓存文件不存在，本次未写入；第一次 pull 会整体重建（数据已在库里）");
  }

  const total = countEvents(legacy);
  if (json) {
    out(JSON.stringify({ imported: stats.imported, events: total, mismatches, mapping }, null, 2));
  } else {
    out(`已导入 ${stats.imported} 条事项、${total} 条时间线记录`);
    out("");
    out("  旧编号 → 新编号 / 事件数");
    for (const m of mapping) out(`  ${m.from.padEnd(4)} → #${String(m.num).padEnd(3)} ${m.events} 条  ${m.title}`);
    if (mismatches.length) {
      out("");
      out(`自检发现 ${mismatches.length} 处差异：`);
      for (const line of mismatches) out(`  ${line}`);
    } else {
      out("");
      out("自检通过：条目数、字段、关联数、时间线条数与旧账本逐条一致。");
    }
  }

  return { imported: stats.imported, skipped: 0, mismatches, mapping };
}

function countEvents(legacy) {
  return legacy.items.reduce((n, it) => n + Math.max(it.timeline.length, 1), 0);
}

export { entryToEvent, itemFromLegacy };
