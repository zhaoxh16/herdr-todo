// 纯数据层：无 IO、无宿主依赖。CLI 与 Herdr mod 共用这份逻辑（mod 侧是副本，
// 由 scripts/sync-core.sh 生成，因此这里不能 import 任何东西）。

export const STATUSES = ["todo", "doing", "blocked", "done", "cancelled"];
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
export const CLOSED_STATUSES = ["done", "cancelled"];
export const SCHEMA_VERSION = 1;

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };
// 同优先级下先看谁更"在手上"：doing 与 blocked 都比 todo 需要先看见。
const STATUS_RANK = { doing: 0, blocked: 1, todo: 2, done: 3, cancelled: 4 };

const TITLE_MAX = 200;
const NOTE_MAX = 20000;

export class TodoError extends Error {
  constructor(message, code = "invalid") {
    super(message);
    this.name = "TodoError";
    this.code = code;
  }
}

export function emptyState() {
  return { v: SCHEMA_VERSION, seq: 0, items: [] };
}

/**
 * 把外部读到的任意 JSON 收敛成合法状态。坏数据不静默丢弃，而是抛出可定位的错误。
 *
 * 「收敛」只允许发生在**不会丢信息**的地方（去重 spaces、补默认值）。任何会把
 * 用户数据换成别的东西的情形——items 不是数组、状态/优先级不认识、id 重复——都
 * 抛错。静默降级的后果比报错严重得多：读到的空表会被原样写回，整份账本就没了。
 */
export function normalizeState(raw) {
  if (raw == null) return emptyState();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TodoError("数据文件顶层必须是对象", "corrupt");
  }
  if (raw.v != null && raw.v !== SCHEMA_VERSION) {
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
    // space 是关联当时它所在的 space，agent 关掉后靠它回退显示。
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
      // 标题与备注不在这里截断：读时切片、下次无关写入再落盘，等于悄悄删掉
      // 用户的内容。长度上限只在写入入口执行。
      title: String(it.title ?? ""),
      note: String(it.note ?? ""),
      priority: it.priority ?? "P2",
      status: it.status ?? "todo",
      spaces: [...new Set((it.spaces ?? []).map(String).filter(Boolean))],
      created: Number(it.created) || 0,
      updated: Number(it.updated) || Number(it.created) || 0,
      timeline: timeline.map((e) => ({ ...e })),
      ...(it.archived != null ? { archived: Number(it.archived) } : {}),
      // 只保留校验通过的形状，字段名照抄，不在这里改语义。
      ...(it.agent != null ? { agent: { address: it.agent.address, space: it.agent.space } } : {}),
    };
  });
  // seq 只从形如 t12 的 id 推导。旧实现把任意 id 里的所有数字都算进去，
  // 一次导入 `note-20261119123456789` 就能把 seq 推到 2^53 之外，此后每次
  // add 都生成同一个 id，账本因「id 重复」而永久不可读。
  const maxSeq = normalized.reduce((m, it) => {
    const hit = /^t(\d+)$/.exec(it.id);
    return hit ? Math.max(m, Number(hit[1])) : m;
  }, 0);
  return {
    v: SCHEMA_VERSION,
    seq: Math.max(Math.min(Number(raw.seq) || 0, Number.MAX_SAFE_INTEGER), maxSeq),
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

function nowOf(explicit) {
  return Number.isFinite(explicit) ? explicit : Date.now();
}

function actorOf(opts) {
  const by = opts && opts.by;
  return typeof by === "string" && by.trim() ? by.trim().slice(0, 40) : "user";
}

function logEntry(kind, at, from, to, by) {
  return { at, kind, from: from ?? null, to: to ?? null, by };
}

function cloneState(state) {
  return { v: state.v, seq: state.seq, items: state.items.map(cloneItem) };
}

function cloneItem(item) {
  return {
    ...item,
    spaces: [...item.spaces],
    timeline: item.timeline.map((e) => ({ ...e })),
    // 深拷贝：调用方会就地改 agent 字段，浅拷贝会让两份状态共享同一个对象。
    ...(item.agent ? { agent: { ...item.agent } } : {}),
  };
}

/**
 * 时钟回拨保护：新时间戳不早于最后一条时间线。
 *
 * 时间线按时间升序是既定展示约定，而系统时钟可能被 NTP 回拨；回拨后如果再
 * 按真实时间写入，排序会把刚发生的变更塞到中间，出现「状态是 blocked、最后
 * 一条时间线却是 doing」的自相矛盾记录。这里让时间戳单调不减——事件顺序以
 * 发生顺序为准，时间只作为近似刻度。
 */
function stamp(item, at) {
  const last = item.timeline[item.timeline.length - 1];
  return last && last.at > at ? last.at : at;
}

/** 时间线按时间升序；同一毫秒内的多次变更保持产生顺序（稳定排序）。 */
function pushEntry(item, entry) {
  const timeline = [...item.timeline, entry];
  timeline.sort((a, b) => a.at - b.at);
  item.timeline = timeline;
}

function replaceItem(state, id, mutate) {
  const idx = state.items.findIndex((it) => it.id === id);
  if (idx < 0) throw new TodoError(`找不到事项 ${id}`, "not_found");
  const item = cloneItem(state.items[idx]);
  mutate(item);
  state.items[idx] = item;
  return state;
}

function cleanTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) throw new TodoError("标题不能为空", "invalid");
  return t.slice(0, TITLE_MAX);
}

export function addItem(state, input, atRaw, opts) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const title = cleanTitle(input && input.title);
  const priority = input && input.priority != null ? input.priority : "P2";
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`未知优先级 ${priority}（可用 ${PRIORITIES.join("/")}）`, "invalid");
  }
  const status = input && input.status != null ? input.status : "todo";
  if (!STATUSES.includes(status)) {
    throw new TodoError(`未知状态 ${status}（可用 ${STATUSES.join("/")}）`, "invalid");
  }
  const spaces = Array.isArray(input && input.spaces) ? [...new Set(input.spaces.map(String))] : [];
  const note = String((input && input.note) ?? "").slice(0, NOTE_MAX);

  const next = cloneState(state);
  next.seq = Number(next.seq || 0) + 1;
  if (!Number.isSafeInteger(next.seq)) {
    // 走到这里说明 seq 已被外部数据污染；继续下去会生成重复 id，整个账本
    // 因「id 重复」而不可读。宁可这一次失败，也不写坏数据。
    throw new TodoError("账本序号已溢出，无法安全分配新 id", "corrupt");
  }
  const item = {
    id: `t${next.seq}`,
    title,
    note,
    priority,
    status,
    spaces,
    created: at,
    updated: at,
    timeline: [logEntry("created", at, null, status, by)],
  };
  next.items.push(item);
  return next;
}

export function setStatus(state, id, status, opts, atRaw) {
  if (!STATUSES.includes(status)) {
    throw new TodoError(`未知状态 ${status}（可用 ${STATUSES.join("/")}）`, "invalid");
  }
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const reopen = Boolean(opts && opts.reopen);
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    const from = item.status;
    if (from === status) return;
    const ts = stamp(item, at);
    const leavingClosed = CLOSED_STATUSES.includes(from);
    const enteringClosed = CLOSED_STATUSES.includes(status);
    if (leavingClosed && !enteringClosed && !reopen) {
      throw new TodoError(
        `事项 ${id} 已处于终态 ${from}，改回 ${status} 需要显式重新打开（reopen）`,
        "needs_reopen",
      );
    }
    item.status = status;
    item.updated = ts;
    // 重新打开同时取消归档：否则事项状态是 doing，却因为 archived 标记继续
    // 不出现在任何未处理列表里——一个没有任何命令能解开的死结。
    if (reopen && item.archived != null) {
      delete item.archived;
      pushEntry(item, logEntry("unarchived", ts, null, null, by));
    }
    pushEntry(item, logEntry("status", ts, from, status, by));
  });
}

export function setPriority(state, id, priority, opts, atRaw) {
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`未知优先级 ${priority}（可用 ${PRIORITIES.join("/")}）`, "invalid");
  }
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    const from = item.priority;
    if (from === priority) return;
    const ts = stamp(item, at);
    item.priority = priority;
    item.updated = ts;
    pushEntry(item, logEntry("priority", ts, from, priority, by));
  });
}

export function setTitle(state, id, title, opts, atRaw) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const clean = cleanTitle(title);
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    const from = item.title;
    if (from === clean) return;
    const ts = stamp(item, at);
    item.title = clean;
    item.updated = ts;
    pushEntry(item, logEntry("title", ts, from, clean, by));
  });
}

export function setNote(state, id, note, opts, atRaw) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const clean = String(note ?? "").slice(0, NOTE_MAX);
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    if (item.note === clean) return;
    const from = item.note;
    const ts = stamp(item, at);
    item.note = clean;
    item.updated = ts;
    // 备注可能很长：时间线只记长度变化，正文留在 item.note。
    pushEntry(
      item,
      logEntry("note", ts, { length: from.length }, { length: clean.length }, by),
    );
  });
}

export function setSpaces(state, id, spaces, opts, atRaw) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const clean = [...new Set((Array.isArray(spaces) ? spaces : []).map(String).filter(Boolean))];
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    const from = [...item.spaces];
    // 不变量：space 与 agent 互斥。清空 space 不算「改成 space 关联」，
    // 所以只有真的挂上至少一个 space 时才解除 agent 关联。
    if (sameSet(from, clean) && !(clean.length && item.agent)) return;
    const ts = stamp(item, at);
    if (clean.length && item.agent) {
      const was = item.agent.address;
      delete item.agent;
      pushEntry(item, logEntry("agent", ts, was, null, by));
    }
    if (!sameSet(from, clean)) {
      item.spaces = clean;
      pushEntry(item, logEntry("spaces", ts, from, [...clean], by));
    }
    item.updated = ts;
  });
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/**
 * 把事项从一个 space 挪到另一个 space（拖拽的主要用法）。
 *
 * 与 `setSpaces` 的区别是这个动作**有来源**：从 space A 拖到 space B 时，用户
 * 的意思是「换到 B」，不是「同时挂在 A 和 B 上」。一条事项可以关联多个 space
 * （`spaces` 是数组），所以「先 link 后 unlink」两次写会留下中间态；而且面板
 * 手里的是渲染快照，用两次绝对值写很容易把并发新增的关联覆盖掉。这里在**一次**
 * 加锁的读改写里完成：去掉 from、加上 to。
 *
 * `from` 为 null 表示来源不是任何 space（未关联组、或原先挂在 agent 上），此时
 * 只做新增。`to` 为 null 表示挪到「未关联」，只做移除。
 *
 * 与 `setSpaces` 一样遵守「space 与 agent 互斥」：落到某个 space 上时解除
 * agent 关联；挪到未关联（to 为 null）不算挂上 space，所以不动 agent——那种
 * 情况该调用方用 `setAgent(state, id, null)` 明说。
 *
 * 多种来源共存时不会留下死关联：`from` 可以是任意一个现存 space id，也可以
 * 是已不存在 space 的 id（孤儿组清理正是这么用的），后者只是从 `spaces` 里
 * 摘掉它。调用方若要从孤儿组拖出，把那些死 id 逐个作为 `from` 传一次即可。
 */
export function moveSpace(state, id, from, to, opts, atRaw) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const src = typeof from === "string" && from ? from : null;
  const dst = typeof to === "string" && to ? to : null;
  if (src === dst) return state;
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    const had = [...item.spaces];
    const kept = src ? had.filter((s) => s !== src) : had;
    // 已经在目标里就不重复加（多关联的事项拖进它已关联的 space）。
    const out = dst && !kept.includes(dst) ? [...kept, dst] : kept;
    // 来源是 agent 关联：拖到某个 space 上就是「换挂 space」，互斥要求同时摘掉
    // agent。从 Agents 栏拖到 space 行走的正是这条；只靠 UI 先跑一次 --clear
    // 的话，「清成功、挂失败」会把事项留在未关联里，用户看不出发生过什么。
    const dropAgent = Boolean(dst) && Boolean(item.agent);
    if (sameSet(had, out) && !dropAgent) return;
    const ts = stamp(item, at);
    if (dropAgent) {
      const was = item.agent.address;
      delete item.agent;
      pushEntry(item, logEntry("agent", ts, was, null, by));
    }
    if (!sameSet(had, out)) {
      item.spaces = out;
      pushEntry(item, logEntry("spaces", ts, had, [...out], by));
    }
    item.updated = ts;
  });
}

/**
 * 把事项关联到某个 agent，或解除关联（agent 传 null）。
 *
 * 「agent 替代 space」是用户定的模型：一条事项要么挂在 space 上，要么挂在
 * 某一个 agent 上，不能同时挂在两者上。这个不变量在这里强制，不靠调用方自觉——
 * 调用方有侧栏拖拽、详情窗按钮、CLI 三条路径，漏一条就会写出两种状态都有的数据。
 *
 * space 参数是**关联当时**该 agent 所在的 space。agent 关掉之后 Host 不提供
 * 任何反查 lineage 的手段（`agents()` 里它就消失了），回退显示只能靠这里存下的值。
 */
export function setAgent(state, id, agent, opts, atRaw) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  let next = null;
  if (agent != null) {
    const ok =
      typeof agent === "object" && !Array.isArray(agent) &&
      typeof agent.address === "string" && agent.address &&
      typeof agent.space === "string" && agent.space;
    if (!ok) throw new TodoError("agent 关联必须是 {address, space}", "invalid");
    next = { address: agent.address, space: agent.space };
  }
  const s = cloneState(state);
  return replaceItem(s, id, (item) => {
    const from = item.agent?.address ?? null;
    const to = next?.address ?? null;
    // address 没变就什么都不做。这里不比 space：agent 在同一地址下换了 space
    // 时，回退位置应该更新，那是真实变化。
    if (from === to && (next == null) === (item.agent == null) &&
        (next == null || (item.agent.space === next.space))) return;
    const ts = stamp(item, at);
    if (next) {
      item.agent = next;
      // 替代关系：挂上 agent 就清掉 space 关联，否则两个视图会各显示一份。
      item.spaces = [];
    } else {
      delete item.agent;
    }
    item.updated = ts;
    pushEntry(item, logEntry("agent", ts, from, to, by));
  });
}

/**
 * 归档 = 从「未处理」列表里收起来，数据仍完整保留（仍在文件里，`--all` 可读，
 * 可导出回溯）。实现是给事项打 `archived` 时间戳，需要时顺带把它移到终态。
 *
 * 刻意**不做成「就是 cancelled」**：cancelled 是用户表达的「这件事不做了」，
 * 是一个能被 reopen 的正常状态；归档是「别在列表里烦我」。两者混用会出现
 * 「reopen 之后事项仍然消失」这种无法解释的现象，所以归档有独立标记，
 * reopen 会清掉它。
 */
export function archiveItem(state, id, opts, atRaw) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    if (item.archived) return;
    const ts = stamp(item, at);
    item.archived = ts;
    item.updated = ts;
    // 已完成/已取消的保持原状态；还没结束的顺带置为取消，否则它既不在未处理
    // 列表里，也没有任何办法表达「结束了」。
    if (!CLOSED_STATUSES.includes(item.status)) {
      const from = item.status;
      item.status = "cancelled";
      pushEntry(item, logEntry("status", ts, from, item.status, by));
    }
    pushEntry(item, logEntry("archived", ts, null, null, by));
  });
}

/**
 * 取消归档。事项回到「未处理」列表；状态若是归档时被动置成的 cancelled，
 * 一并退回 todo —— 用户此刻的意图是「重新开始处理它」。
 */
export function unarchiveItem(state, id, opts, atRaw) {
  const at = nowOf(atRaw);
  const by = actorOf(opts);
  const next = cloneState(state);
  return replaceItem(next, id, (item) => {
    if (item.archived == null) return;
    const ts = stamp(item, at);
    delete item.archived;
    item.updated = ts;
    if (item.status === "cancelled") {
      // 时间线要能解释「为什么它又变成 todo 了」。
      const before = item.status;
      item.status = "todo";
      pushEntry(item, logEntry("status", ts, before, item.status, by));
    }
    pushEntry(item, logEntry("unarchived", ts, null, null, by));
  });
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
 * 归档项不计入任何一个数：它在文件里仍在（`--all`/`export` 可读），但对
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

export function timelineOf(item) {
  return [...item.timeline].sort((a, b) => a.at - b.at);
}
