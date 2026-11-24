// 由 scripts/sync-core.sh 从 src/core.js 生成，请勿手工编辑。
// source-sha256: 50700bde8e621453d49f244d86f1c97ad42ac4d57520781c7c7be15026a46c6f
// 纯数据层（只读侧）：无 IO、无宿主依赖。CLI 与 Herdr mod 共用这份逻辑
// （mod 侧是副本，由 scripts/sync-core.sh 生成，因此这里不能 import 任何东西）。
//
// 写入侧在 src/rules.js——它能 import 本文件，反向不行（副本机制要求本文件
// 自足）。分工：本文件负责「读进来的东西合不合法、怎么排序分组汇总」，
// rules.js 负责「一次操作要产生什么新状态与哪些事件」。

export const STATUSES = ["todo", "doing", "blocked", "done", "cancelled"];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const CLOSED_STATUSES = ["done", "cancelled"];

// 缓存格式版本。v1 是单机账本（已废弃，只有导入脚本还认它），v2 是云端缓存：
// 事项 id 换成 ULID、多一个 num，头部多 synced_through / synced_at。
export const SCHEMA_VERSION = 2;

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
// 同优先级下先看谁更"在手上"：doing 与 blocked 都比 todo 需要先看见。
const STATUS_RANK = { doing: 0, blocked: 1, todo: 2, done: 3, cancelled: 4 };

export class TodoError extends Error {
  constructor(message, code = "invalid") {
    super(message);
    this.name = "TodoError";
    this.code = code;
  }
}

/** 空缓存。没有账本文件、或文件为空时读到的就是这个。 */
export function emptyState() {
  return { v: SCHEMA_VERSION, synced_through: 0, synced_at: 0, items: [] };
}

/**
 * 把外部读到的任意 JSON 收敛成合法状态。坏数据不静默丢弃，而是抛出可定位的错误。
 *
 * 「收敛」只允许发生在**不会丢信息**的地方（去重 spaces、补默认值）。任何会把
 * 用户数据换成别的东西的情形——items 不是数组、状态/优先级不认识、id 重复——都
 * 抛错。静默降级的后果比报错严重得多：读到的空表会被原样写回，整份账本就没了。
 *
 * 同时接受 v1（单机账本，供导入脚本读取）与 v2（云端缓存）。两者的区别只在
 * 事项 id 的形式与 num 的有无，校验规则完全相同。
 */
export function normalizeState(raw) {
  if (raw == null) return emptyState();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TodoError("数据文件顶层必须是对象", "corrupt");
  }
  if (raw.v != null && raw.v !== 1 && raw.v !== SCHEMA_VERSION) {
    throw new TodoError(`不支持的数据版本 ${raw.v}（期望 ${SCHEMA_VERSION}）`, "unsupported_version");
  }
  if (raw.items != null && !Array.isArray(raw.items)) {
    throw new TodoError("数据文件的 items 必须是数组", "corrupt");
  }
  const items = raw.items ?? [];
  const seen = new Set();
  const normalized = items.map((it, idx) => {
    const at = `第 ${idx + 1} 条事项`;
    if (!it || typeof it !== "object" || Array.isArray(it)) {
      throw new TodoError(`${at}不是对象`, "corrupt");
    }
    if (typeof it.id !== "string" || !it.id) {
      throw new TodoError(`${at}缺少 id`, "corrupt");
    }
    if (seen.has(it.id)) {
      // 重复 id 时按 id 寻址只会命中第一条，另一条永远改不到。
      throw new TodoError(`事项 id 重复：${it.id}`, "corrupt");
    }
    seen.add(it.id);
    if (it.num != null && !(Number.isInteger(Number(it.num)) && Number(it.num) > 0)) {
      throw new TodoError(`${at}（${it.id}）的 num 不是正整数：${JSON.stringify(it.num)}`, "corrupt");
    }
    if (it.status != null && !STATUSES.includes(it.status)) {
      throw new TodoError(`${at}（${it.id}）的状态 ${JSON.stringify(it.status)} 无法识别`, "corrupt");
    }
    if (it.priority != null && !PRIORITIES.includes(it.priority)) {
      throw new TodoError(`${at}（${it.id}）的优先级 ${JSON.stringify(it.priority)} 无法识别`, "corrupt");
    }
    // 关联写成字符串（"spA"）时旧实现会当成 []，等于把关联全丢，还写回文件。
    if (it.spaces != null && !Array.isArray(it.spaces)) {
      throw new TodoError(`${at}（${it.id}）的 spaces 必须是数组`, "corrupt");
    }
    // agent 关联必须是 {address, space}：address 用于「关联到哪个 agent」，
    // space 是关联当时它所在的 space，侧栏按它把该事项归到对应 space 组
    // （agent 活着、搬家、关掉都用这个值，位置不跳）。
    if (it.agent != null) {
      const a = it.agent;
      const ok =
        a && typeof a === "object" && !Array.isArray(a) &&
        typeof a.address === "string" && a.address &&
        typeof a.space === "string" && a.space;
      if (!ok) {
        throw new TodoError(`${at}（${it.id}）的 agent 必须是 {address, space}`, "corrupt");
      }
    }
    if (it.created != null && !Number.isFinite(Number(it.created))) {
      throw new TodoError(`${at}（${it.id}）的 created 不是时间戳：${JSON.stringify(it.created)}`, "corrupt");
    }
    if (it.updated != null && !Number.isFinite(Number(it.updated))) {
      throw new TodoError(`${at}（${it.id}）的 updated 不是时间戳：${JSON.stringify(it.updated)}`, "corrupt");
    }
    if (it.archived != null && !Number.isFinite(Number(it.archived))) {
      throw new TodoError(`${at}（${it.id}）的 archived 不是时间戳：${JSON.stringify(it.archived)}`, "corrupt");
    }
    if (it.timeline != null && !Array.isArray(it.timeline)) {
      throw new TodoError(`${at}（${it.id}）的 timeline 必须是数组`, "corrupt");
    }
    const timeline = it.timeline ?? [];
    timeline.forEach((e, i) => {
      // 坏条目会让 `show` 与面板渲染直接抛错（例如 spaces 条目的 to 是字符串，
      // 展示层调 `(e.to || []).join`）。读的时候就必须拒绝，不能留到渲染。
      if (!isTimelineEntry(e)) {
        throw new TodoError(`${at}（${it.id}）的时间线第 ${i + 1} 条不是合法条目`, "corrupt");
      }
    });
    return {
      id: it.id,
      ...(it.num != null ? { num: Number(it.num) } : {}),
      // 标题与备注不在这里截断：读时切片、下次无关写入再落盘，等于悄悄删掉
      // 用户的内容。长度上限只在写入入口执行。
      title: String(it.title ?? ""),
      note: String(it.note ?? ""),
      priority: it.priority ?? "P2",
      status: it.status ?? "todo",
      spaces: [...new Set((it.spaces ?? []).map(String).filter(Boolean))],
      created: Number(it.created) || 0,
      updated: Number(it.updated) || Number(it.created) || 0,
      // 时间线保持原顺序（数组顺序即事件 seq 顺序，同毫秒的先后靠它区分）。
      timeline: timeline.map((e) => ({ ...e })),
      ...(it.archived != null ? { archived: Number(it.archived) } : {}),
      // 只保留校验通过的形状，字段名照抄，不在这里改语义。
      ...(it.agent != null ? { agent: { address: it.agent.address, space: it.agent.space } } : {}),
    };
  });
  const cache = emptyState();
  return {
    ...cache,
    // v1 账本没有这两个字段；读出来按 0 处理，导入脚本不依赖它们。
    synced_through: Math.max(0, Number(raw.synced_through) || 0),
    synced_at: Math.max(0, Number(raw.synced_at) || 0),
    items: normalized,
  };
}

// 每种时间线条目对 from/to 的形状有要求。放进来不合形状的条目，展示层要么
// 抛错（`(e.to || []).join` 对字符串/数字），要么显示成乱码。
const LIST_KINDS = new Set(["spaces"]);
const TEXT_KINDS = new Set(["created", "status", "priority", "title", "archived", "agent"]);

function shapeOk(kind, v) {
  if (v == null) return true;
  if (LIST_KINDS.has(kind)) return Array.isArray(v) && v.every((x) => typeof x === "string");
  if (TEXT_KINDS.has(kind)) return typeof v === "string";
  if (kind === "note") return typeof v === "object" && !Array.isArray(v);
  return true; // 未知 kind 不猜它的形状
}

function isTimelineEntry(e) {
  if (!e || typeof e !== "object" || typeof e.kind !== "string") return false;
  if (!Number.isFinite(Number(e.at))) return false;
  return shapeOk(e.kind, e.from) && shapeOk(e.kind, e.to);
}

export function findItem(state, id) {
  if (!state || !Array.isArray(state.items)) return null;
  return state.items.find((it) => it.id === id) || null;
}

/**
 * 组内排序：状态 → 优先级 → 更新时间。顺序取自 plan 的已批准约定；
 * 先看状态是因为「进行中 / 阻塞」比「P0 待办」更需要立刻看见。
 */
export function sortItems(items) {
  return [...items].sort((a, b) => {
    const s = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (s !== 0) return s;
    const p = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (p !== 0) return p;
    return (b.updated || 0) - (a.updated || 0);
  });
}

/**
 * 按 space 分组。顺序固定为：未关联 → 已知 space（按 spaces 传入顺序）→ 关联到已消失 space 的事项。
 * 一个事项关联多个 space 时在每个组各出现一次（调用方按 id 去重）。
 * 已知 space 即使没有事项也保留空组，让"这个 space 现在没事"本身可见。
 */
export function groupBySpace(items, knownSpaces, options) {
  const includeClosed = Boolean(options && options.includeClosed);
  const includeArchived = Boolean(options && options.includeArchived);
  const pool = items.filter((it) => {
    if (!includeArchived && it.archived != null) return false;
    return includeClosed || !CLOSED_STATUSES.includes(it.status);
  });
  const known = Array.isArray(knownSpaces) ? knownSpaces : [];
  const knownIds = new Set(known.map((s) => s.id));

  const unlinked = [];
  const byId = new Map(known.map((s) => [s.id, []]));
  const orphanSpaces = new Set();

  for (const it of pool) {
    if (!it.spaces || it.spaces.length === 0) {
      unlinked.push(it);
      continue;
    }
    for (const sid of it.spaces) {
      if (byId.has(sid)) byId.get(sid).push(it);
      else orphanSpaces.add(sid);
    }
  }

  const groups = [];
  if (unlinked.length) {
    groups.push({ key: "unlinked", kind: "unlinked", label: "未关联", items: sortItems(unlinked) });
  }
  for (const s of known) {
    groups.push({
      key: s.id,
      kind: "space",
      label: s.name || s.id,
      space: s,
      items: sortItems(byId.get(s.id) || []),
    });
  }
  if (orphanSpaces.size) {
    const orphanItems = pool.filter((it) => it.spaces.some((sid) => orphanSpaces.has(sid)));
    groups.push({
      key: "closed",
      kind: "closed",
      label: "space 已不存在",
      spaceIds: [...orphanSpaces].sort(),
      items: sortItems(orphanItems),
    });
  }
  return groups;
}

/**
 * 每个事项只计一次，不因多组重复而虚高。
 *
 * 归档项不计入任何一个数：它在库里仍在（`--all`/`export` 可读），但对
 * 「我现在还有什么事」而言已经收起来了。否则顶部会显示「未处理 3」而列表
 * 里只有 2 行——数字对不上会让人以为面板丢数据。
 */
export function summary(items) {
  let pending = 0;
  let done = 0;
  let p0 = 0;
  let archived = 0;
  for (const it of items) {
    if (it.archived != null) {
      archived++;
      continue;
    }
    if (it.status === "done") done++;
    else if (it.status === "cancelled") {
      /* 取消既不算待处理也不算完成 */
    } else {
      pending++;
      if (it.priority === "P0") p0++;
    }
  }
  return { pending, done, p0, archived, total: items.length };
}

export function sortByRecent(items) {
  return [...items].sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

/**
 * 时间线顺序。**权威是事件序号 `seq`**（spec §6.3）：`at` 是客户端时钟，跨设备
 * 存在偏差，只用于展示；同一条事项在本机连续写时还有 `stampOf` 兜底，但跨设备
 * 只能靠库分配的单调序号。
 *
 * 缓存条目自 v2 起带 `seq`；从旧账本导入的条目没有它（那时也没有这个概念），
 * 退回按 `at`，并在同一 `at` 内保持数组顺序（旧账本数组顺序即当时的事件顺序）。
 */
export function timelineOf(item) {
  return [...item.timeline].sort((a, b) => {
    if (a.seq != null && b.seq != null && a.seq !== b.seq) return a.seq - b.seq;
    return a.at - b.at;
  });
}
