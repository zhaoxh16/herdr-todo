// 侧栏待办派生：给定账本、Herdr 的 space 列表与 agent 列表，算出要画的所有分组。
//
// 只做数据整形，不碰宿主 API——所以它能在 Node 里被直接测试（tests/sidebar.test.js），
// 而渲染与 IO 都留在 main.js。
//
// 几处口径与 CLI/旧面板保持一致，不能各写一套：
//  - 归档项不进任何组（用户的意思就是「别在列表里烦我」）；
//  - 已完成/已取消不进开放的待办行，但按组分开放/已完成，供「已完成 N」展开；
//  - 关联到已不存在 space 的事项单独成组，不会被悄悄丢掉。
//
// 关联模型（用户 2026-11-19 定）：一条事项要么关联 space（可多个），要么关联
// **一个** agent，二者互斥（由 core 的写入函数强制）。agent 关掉之后 Host 不再
// 提供它属于哪个 space（`agents()` 里它就消失了），所以 item.agent 里存了关联
// 当时的 space，用于回退显示。

import { CLOSED_STATUSES, sortItems } from "./core.js";

function bucket() {
  return { open: [], closed: [] };
}

function push(b, it) {
  if (CLOSED_STATUSES.includes(it.status)) b.closed.push(it);
  else b.open.push(it);
}

function finish(b) {
  return { open: sortItems(b.open), closed: sortItems(b.closed) };
}

/**
 * 事项在侧栏里应该显示在哪些 space 下。
 *
 * 三种结果语义不同，调用方必须分开处理：
 *  - `{ at: [...] }`：显示在这些 space 组下；
 *  - `{ hidden: true }`：挂在活着的 agent 上，由 Agents 栏显示，侧栏不列；
 *  - `{ dangling: true }`：有关联但目标都不存在了（agent 与它当时的 space 都没了）。
 *
 * 用户的原话是「如果 agent 被关闭则回退到 workspace」——回退只在 agent 消失后发生，
 * 所以活着时侧栏不重复列。回退位置用关联当时记下的 space，而不是 agent 现在的
 * 所在：把它固定下来，同一条事项才不会随着 agent 搬家在两个 space 之间跳。
 */
function placeOf(it, liveAgentSpace, knownIds) {
  if (it.agent) {
    if (liveAgentSpace.has(it.agent.address)) return { hidden: true };
    const id = it.agent.space;
    return id && knownIds.has(id) ? { at: [id] } : { dangling: true };
  }
  const ids = Array.isArray(it.spaces) ? it.spaces.filter((s) => knownIds.has(s)) : [];
  if (ids.length) return { at: ids };
  return Array.isArray(it.spaces) && it.spaces.some(Boolean) ? { dangling: true } : { unlinked: true };
}

/**
 * @param {{items?: Array}} state 账本
 * @param {Array<{id: string}>} knownSpaces Herdr 当前的 space 列表（顺序即显示顺序）
 * @param {Array<{address: string, space: string}>} [knownAgents] Herdr 当前的 agent 列表
 * @returns {{
 *   unlinked: {open: Array, closed: Array},
 *   orphans: {open: Array, closed: Array},
 *   spaces: Array<{id: string, open: Array, closed: Array}>,
 * }}
 */
export function deriveSidebar(state, knownSpaces, knownAgents) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const known = Array.isArray(knownSpaces) ? knownSpaces : [];
  const liveAgentSpace = new Map(
    (Array.isArray(knownAgents) ? knownAgents : [])
      .filter((a) => a && typeof a.address === "string" && typeof a.space === "string")
      .map((a) => [a.address, a.space]),
  );

  const unlinked = bucket();
  const orphans = bucket();
  const byId = new Map(known.map((s) => [s.id, bucket()]));
  const knownIds = new Set(byId.keys());

  for (const it of items) {
    if (it.archived != null) continue;
    const place = placeOf(it, liveAgentSpace, knownIds);
    if (place.at) {
      for (const sid of place.at) {
        const b = byId.get(sid);
        if (b) push(b, it);
      }
    } else if (place.unlinked) {
      push(unlinked, it);
    } else if (place.dangling) {
      push(orphans, it);
    }
    // hidden：挂着活 agent，侧栏不显示（Agents 栏负责）。
  }

  return {
    unlinked: finish(unlinked),
    orphans: finish(orphans),
    spaces: known.map((s) => ({ id: s.id, ...finish(byId.get(s.id)) })),
  };
}

/**
 * 每个 agent 地址 → 关联到它的待办。Agents 栏据此在每个 agent 行下画待办。
 *
 * 只收**活着**的 agent：agent 关掉后那个地址在 `agents()` 里不存在，它的事项
 * 已经回退到 space 视图（见 deriveSidebar），这里再列一遍就重复了。
 */
export function deriveAgents(state, knownAgents) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const out = new Map();
  for (const a of Array.isArray(knownAgents) ? knownAgents : []) {
    if (a && typeof a.address === "string") out.set(a.address, bucket());
  }
  for (const it of items) {
    if (it.archived != null || !it.agent) continue;
    const b = out.get(it.agent.address);
    if (b) push(b, it);
  }
  const done = new Map();
  for (const [addr, b] of out) done.set(addr, finish(b));
  return done;
}
