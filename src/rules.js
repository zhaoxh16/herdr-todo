// 规则层：单条事项的写入语义，纯函数、无 IO、不碰数据库。
//
// 与 core.js 的分工：core 是只读侧（校验、排序、分组、汇总），这里是写侧
// （状态机、终态重开、归档与取消的区分、space/agent 互斥、长度上限）。
// 两者都不 import 宿主 API，因此都能在 Node 里直接测。
//
// 输入输出都使用**面板看得见的那个事项形状**（spaces 是数组、agent 是对象），
// 而不是数据库的行形状。理由：规则测试与缓存测试共用一份数据形状，只有
// store/mysql.js 一处做行列映射——映射点越多，两处判断分叉的机会越多。
//
// 每个 applyX 返回 { item, events }：
//   - item    改后的事项（无变化时就是传入的那个对象本身）；
//   - events  这次操作要追加到 item_events 的事件，按发生顺序排列，可能为空或两条
//             （例如「重开一个已归档的终态事项」= unarchived + status）。
// 事件形状见 spec §4.2「事件词表」；这里只产数据，取号与落盘归 store。

import { STATUSES, PRIORITIES, CLOSED_STATUSES, TodoError } from "./core.js";

// 写入上限。**必须与 mod/main.js 的本地 TITLE_MAX 一致**：界面前置拦下，用户
// 不必等一次失败的写才知道超了。两处一致性由 tests/sync.test.js 守着。
//
// 超限一律报错，不做静默截断：截断会让用户看到「已添加」而实际少了半句话，
// 而时间线只记长度、正文不可恢复。标题上限同时是 `items.title` 的列宽，在
// 规则层拦下才不至于走到 INSERT 才报 `Data too long for column 'title'`。
const TITLE_MAX = 200;
const NOTE_MAX = 20000;
/** 时间戳单调不减。用 item.updated 代替旧实现的「读最后一条时间线」。 */
function stampOf(item, at) {
  const prev = Number(item.updated) || 0;
  return prev > at ? prev : at;
}

function ev(kind, at, by, data) {
  return { kind, at, by, data };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function cleanTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) throw new TodoError("标题不能为空", "invalid");
  if (t.length > TITLE_MAX) {
    // 不回显全文：超长标题可能是误粘贴的一大段，整段塞进报错反而盖住提示。
    throw new TodoError(
      `标题最多 ${TITLE_MAX} 字，收到 ${t.length} 字。请缩短后再试（没有保存任何内容）。`,
      "invalid",
    );
  }
  return t;
}

function cleanNote(note) {
  const s = String(note ?? "");
  if (s.length > NOTE_MAX) {
    throw new TodoError(
      `备注最多 ${NOTE_MAX} 字，收到 ${s.length} 字。请缩短后再试（没有保存任何内容）。`,
      "invalid",
    );
  }
  return s;
}

function cleanSpaces(spaces) {
  return [...new Set((Array.isArray(spaces) ? spaces : []).map(String).filter(Boolean))];
}

/** 无变化：返回原事项与空事件表，调用方据此跳过事务。 */
function unchanged(item) {
  return { item, events: [] };
}

/**
 * 新建事项。id 由调用方生成（ULID，多端不撞号），num 由 store 在 owner 行锁内分配。
 */
export function applyCreate(input) {
  const at = input.at;
  const by = input.by;
  const title = cleanTitle(input.title);
  const priority = input.priority != null ? input.priority : "P2";
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`未知优先级 ${priority}（可用 ${PRIORITIES.join("/")}）`, "invalid");
  }
  const status = input.status != null ? input.status : "todo";
  if (!STATUSES.includes(status)) {
    throw new TodoError(`未知状态 ${status}（可用 ${STATUSES.join("/")}）`, "invalid");
  }
  const item = {
    id: input.id,
    num: input.num,
    title,
    note: cleanNote(input.note),
    priority,
    status,
    spaces: [...new Set((Array.isArray(input.spaces) ? input.spaces : []).map(String))],
    created: at,
    updated: at,
    // `add --status done|cancelled` 一落地就是终态，关闭时间就是创建时间。
    // 漏掉它会让「按关闭时间排序 / 统计」把这类事项当成从未关闭过。
    closedAt: CLOSED_STATUSES.includes(status) ? at : null,
  };
  return {
    item,
    events: [ev("created", at, by, { title, status, priority, from_parent: null })],
  };
}

export function applyStatus(item, input) {
  const { status, at, by } = input;
  if (!STATUSES.includes(status)) {
    throw new TodoError(`未知状态 ${status}（可用 ${STATUSES.join("/")}）`, "invalid");
  }
  const from = item.status;
  if (from === status) return unchanged(item);

  const leavingClosed = CLOSED_STATUSES.includes(from);
  const enteringClosed = CLOSED_STATUSES.includes(status);
  const reopen = Boolean(input.reopen);
  if (leavingClosed && !enteringClosed && !reopen) {
    throw new TodoError(
      `事项 ${item.id} 已处于终态 ${from}，改回 ${status} 需要显式重新打开（reopen）`,
      "needs_reopen",
    );
  }

  const ts = stampOf(item, at);
  const next = { ...item, status, updated: ts };
  // closed_at 与状态同步：进入终态时记时间，离开时清空（spec §4.2）。它是
  // 「最近一次结束」的查询键，与 archived_at / deleted_at 是三个独立事实。
  if (enteringClosed) next.closedAt = ts;
  else next.closedAt = null;
  const events = [];
  // 重新打开同时取消归档：否则事项状态是 doing，却因为归档标记继续不出现在
  // 任何未处理列表里——一个没有任何命令能解开的死结。
  if (reopen && next.archived != null) {
    delete next.archived;
    events.push(ev("unarchived", ts, by, {}));
  }
  events.push(ev("status", ts, by, { from, to: status }));
  return { item: next, events };
}

export function applyPriority(item, input) {
  const { priority, at, by } = input;
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`未知优先级 ${priority}（可用 ${PRIORITIES.join("/")}）`, "invalid");
  }
  const from = item.priority;
  if (from === priority) return unchanged(item);
  const ts = stampOf(item, at);
  return {
    item: { ...item, priority, updated: ts },
    events: [ev("priority", ts, by, { from, to: priority })],
  };
}

export function applyTitle(item, input) {
  const { at, by } = input;
  const clean = cleanTitle(input.title);
  const from = item.title;
  if (from === clean) return unchanged(item);
  const ts = stampOf(item, at);
  return {
    item: { ...item, title: clean, updated: ts },
    events: [ev("title", ts, by, { from, to: clean })],
  };
}

export function applyNote(item, input) {
  const { at, by } = input;
  const clean = cleanNote(input.note);
  if (item.note === clean) return unchanged(item);
  const ts = stampOf(item, at);
  // 备注可能很长：事件只记长度变化，正文留在 items.note，缓存才带上原文。
  return {
    item: { ...item, note: clean, updated: ts },
    events: [ev("note", ts, by, { from_len: item.note.length, to_len: clean.length })],
  };
}

export function applySpaces(item, input) {
  const { at, by } = input;
  const from = [...item.spaces];
  const clean = cleanSpaces(input.spaces);
  // 不变量：space 与 agent 互斥。清空 space 不算「改成 space 关联」，所以只有
  // 真的挂上至少一个 space 时才解除 agent 关联。
  if (sameSet(from, clean) && !(clean.length && item.agent)) return unchanged(item);

  const ts = stampOf(item, at);
  const next = { ...item, updated: ts };
  const events = [];
  if (clean.length && next.agent) {
    const was = next.agent.address;
    delete next.agent;
    events.push(ev("agent", ts, by, { from: was, to: null }));
  }
  if (!sameSet(from, clean)) {
    next.spaces = clean;
    events.push(ev("spaces", ts, by, { from, to: [...clean] }));
  }
  return { item: next, events };
}

/**
 * 拖拽改归属：从 from 挪到 to，一次写完成（等价于旧的 moveSpace）。
 *
 * from 为 null 表示来源不是任何 space（未关联组、或原先挂在 agent 上）；
 * to 为 null 表示挪到「未关联」。落到某个 space 上时解除 agent 关联（互斥）。
 */
export function applyMove(item, input) {
  const { at, by } = input;
  const src = typeof input.from === "string" && input.from ? input.from : null;
  const dst = typeof input.to === "string" && input.to ? input.to : null;
  if (src === dst) return unchanged(item);

  const had = [...item.spaces];
  const kept = src ? had.filter((s) => s !== src) : had;
  // 已经在目标里就不重复加（多关联的事项拖进它已关联的 space）。
  const out = dst && !kept.includes(dst) ? [...kept, dst] : kept;
  const dropAgent = Boolean(dst) && Boolean(item.agent);
  if (sameSet(had, out) && !dropAgent) return unchanged(item);

  const ts = stampOf(item, at);
  const next = { ...item, updated: ts };
  const events = [];
  if (dropAgent) {
    const was = next.agent.address;
    delete next.agent;
    events.push(ev("agent", ts, by, { from: was, to: null }));
  }
  if (!sameSet(had, out)) {
    next.spaces = out;
    events.push(ev("spaces", ts, by, { from: had, to: [...out] }));
  }
  return { item: next, events };
}

/**
 * 关联到某个 agent（agent 传 null 解除）。agent 与 space 互斥：挂上 agent 就清空
 * space 关联，反之由 applySpaces / applyMove 负责。
 *
 * `space` 是关联当时该 agent 所在的 space：侧栏按它把该事项归到对应 space 组
 * （agent 活着、搬家、关掉都用这个值，位置不跳）。agent 关掉后宿主不再报告它
 * 属于哪个 space，也只有这个值可查。
 */
export function applyAgent(item, input) {
  const { at, by } = input;
  let next = null;
  if (input.agent != null) {
    const a = input.agent;
    const ok =
      typeof a === "object" && !Array.isArray(a) &&
      typeof a.address === "string" && a.address &&
      typeof a.space === "string" && a.space;
    if (!ok) throw new TodoError("agent 关联必须是 {address, space}", "invalid");
    next = { address: a.address, space: a.space };
  }
  const from = item.agent?.address ?? null;
  const to = next?.address ?? null;
  // address 没变、且「都没有关联」或「space 也没变」时无事可做。这里要比 space：
  // agent 在同一地址下换了 space 时，侧栏归组位置应该更新，那是真实变化。
  // 「都没有关联」与「都有关联且 address 相同」两种情形才算 from === to；
  // 只比 address 会把「本来没有、现在也没有」误判成有变化。
  const samePresence = (next == null) === (item.agent == null);
  const sameSpace = next == null || item.agent?.space === next.space;
  if (from === to && samePresence && sameSpace) return unchanged(item);

  const ts = stampOf(item, at);
  const updated = { ...item, updated: ts };
  if (next) {
    updated.agent = next;
    // 替代关系：挂上 agent 就清掉 space 关联。「这条事的数据挂在哪」永远只有
    // 一个答案；显示上侧栏（按 agent 的 space）与 Agents 栏（按 agent）仍各列
    // 一次，那是两种口径，不是两份冲突的关联。
    updated.spaces = [];
  } else {
    delete updated.agent;
  }
  return { item: updated, events: [ev("agent", ts, by, { from, to })] };
}

/**
 * 归档 = 从「未处理」列表里收起来，数据仍完整保留。
 *
 * 刻意不做成「就是 cancelled」：cancelled 是用户表达的「这件事不做了」，是能被
 * reopen 的正常状态；归档是「别在列表里烦我」。两者混用会出现「reopen 之后事项
 * 仍然消失」这种无法解释的现象，所以归档有独立标记，reopen 会清掉它。
 */
export function applyArchive(item, input) {
  const { at, by } = input;
  if (item.archived != null) return unchanged(item);
  const ts = stampOf(item, at);
  const next = { ...item, archived: ts, updated: ts };
  const events = [];
  // 已完成/已取消的保持原状态；还没结束的顺带置为取消，否则它既不在未处理列表里，
  // 也没有任何办法表达「结束了」。
  if (!CLOSED_STATUSES.includes(item.status)) {
    next.status = "cancelled";
    next.closedAt = ts;
    events.push(ev("status", ts, by, { from: item.status, to: "cancelled" }));
  }
  events.push(ev("archived", ts, by, {}));
  return { item: next, events };
}

/**
 * 取消归档。事项回到「未处理」列表；状态若是归档时被动置成的 cancelled，一并退回
 * todo —— 用户此刻的意图是「重新开始处理它」。
 */
export function applyUnarchive(item, input) {
  const { at, by } = input;
  if (item.archived == null) return unchanged(item);
  const ts = stampOf(item, at);
  const next = { ...item, updated: ts };
  delete next.archived;
  const events = [];
  if (next.status === "cancelled") {
    // 时间线要能解释「为什么它又变成 todo 了」。
    next.status = "todo";
    next.closedAt = null;
    events.push(ev("status", ts, by, { from: "cancelled", to: "todo" }));
  }
  events.push(ev("unarchived", ts, by, {}));
  return { item: next, events };
}

/** 删除写墓碑。物理清除不在这里，见 canPurge。 */
export function applyDelete(item, input) {
  const { at, by } = input;
  if (item.deletedAt != null) return unchanged(item);
  const ts = stampOf(item, at);
  return {
    item: { ...item, deletedAt: ts, updated: ts },
    events: [ev("deleted", ts, by, {})],
  };
}

/**
 * 墓碑能否物理清除。两个条件缺一不可（spec §4.4 删除与墓碑）：
 *   1. 删除早于保留期；
 *   2. 同一 owner 下所有未吊销设备都已拉过该删除事件。
 * 第二个条件防的是「一台设备离线两个月后回来，把已删事项重新拉进缓存」。
 *
 * `minPulledSeq` 是该 owner 未吊销设备的 last_pull_seq 最小值；没有设备时为
 * Infinity（无人会再拉，可以清）。
 */
export function canPurge({ deletedAt, deleteSeq, minPulledSeq, now, retentionMs }) {
  if (deletedAt == null) return false;
  if (now - deletedAt < retentionMs) return false;
  return minPulledSeq == null || minPulledSeq >= deleteSeq;
}
