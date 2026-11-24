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
// **一个** agent，二者互斥（由 core 的写入函数强制）。item.agent.space 记的是
// 关联当时那个 agent 所在的 space，由写入端存下、不随 agent 之后搬家或关闭而改。
//
// 两个视图都显示 agent 事项（用户 2026-11-24 补充）：一条关联 agent 的事项既在
// Agents 栏挂在它名下，也在侧栏按 agent.space 归到对应 space 组。这不是「重复
// 显示」——两个视图本来就是同一批事的两种看法，Agent 栏按「谁在做」、侧栏按
// 「在哪个 space」。deriveAgents 与 deriveSidebar 各自独立地收它，互不裁剪。

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
 * 这条事项在侧栏里显示在哪些 space 组下（只看当前存在的 space）。
 *
 * 这是「它显示在哪」的**单一事实源**：派生（placeOf）用它归组；投放端的
 * 「落回自己组＝取消」判定（isDropBackToSelf）刻意**不**复用它——那个判定问的是
 * 「手势的来源组」，对多 space 事项这两者不同，复用会把一次合法的移走当成取消。
 * 关联 agent 的事项特别容易踩这个：它显示在 agent.space 组里，数据关联却是 agent。
 *
 * 关联 agent 的事项一律按 `agent.space`（关联当时记下的 space）归组，无论那个
 * agent 现在还活着、关了、还是搬去了别的 space。这个值是写入时固定的，所以同一条
 * 事项不会随 agent 搬家在两个 space 之间跳，agent 关掉后也不会突然换位置；同时它与
 * `herdr-todo spaces` 的计数口径（cli.js 按 agent.space 计）一致。
 *
 * 于是这里不需要 agent 列表：活不活着只影响 Agents 栏，不影响侧栏归组。
 */
function spaceIdsOf(it, knownIds) {
  if (it.agent) {
    const id = it.agent.space;
    return id && knownIds.has(id) ? [id] : [];
  }
  const raw = Array.isArray(it.spaces) ? it.spaces : [];
  // 有关联但全是已不存在的 space：返回空数组，由 placeOf 归到孤儿组（不丢事项）。
  return raw.filter((s) => knownIds.has(s));
}

/** 关联本身是否有效（未关联 / 死关联 → false）。用于 placeOf 区分孤儿组。 */
function hasLink(it) {
  if (it.agent) return true;
  return Array.isArray(it.spaces) && it.spaces.some(Boolean);
}

/**
 * 事项在侧栏里应该显示在哪。
 *
 * 三种结果语义不同，调用方必须分开处理：
 *  - `{ at: [...] }`：显示在这些 space 组下；
 *  - `{ dangling: true }`：有关联但目标 space 都不存在了；
 *  - `{ unlinked: true }`：没有任何关联。
 */
function placeOf(it, knownIds) {
  const at = spaceIdsOf(it, knownIds);
  if (at.length) return { at };
  return hasLink(it) ? { dangling: true } : { unlinked: true };
}

/**
 * 松手落在 `spaceId` 这一行，算不算「拿起又放回自己那个组」＝取消。
 *
 * 问的是**手势的来源组**，不是「这条事项是否也显示在这个组」：两者对多 space
 * 事项不同。`spaces:["spA","spB"]` 的事项从 spA 组拖起、落到 spB 行，是一次
 * 合法的「从 spA 移走、留在 spB」（applyMove from=spA to=spB）；若按「显示在
 * spB」判成取消，这个手势就会静默失效。
 *
 * 两种来源各有精确的「自己组」：
 *  - space 来源：`from.key`（就是被拖出的那一组，多 space 也只认这一组）；
 *  - agent 来源：事项的 `agent.space`（agent 事项只显示在唯一那个组），且从
 *    Agents 栏拖来的手势同样走这一支。
 * 其余来源（未关联 / 孤儿 / 找不到事项 / 坏数据）一律不取消。
 */
export function isDropBackToSelf(drag, it, spaceId) {
  if (!drag || !spaceId) return false;
  const from = drag.from;
  if (from?.kind === "space") return from.key === spaceId;
  if (from?.kind === "agent") return Boolean(it?.agent && it.agent.space === spaceId);
  return false;
}

/**
 * @param {{items?: Array}} state 账本
 * @param {Array<{id: string}>} knownSpaces Herdr 当前的 space 列表（顺序即显示顺序）
 * @returns {{
 *   unlinked: {open: Array, closed: Array},
 *   orphans: {open: Array, closed: Array},
 *   spaces: Array<{id: string, open: Array, closed: Array}>,
 * }}
 */
export function deriveSidebar(state, knownSpaces) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const known = Array.isArray(knownSpaces) ? knownSpaces : [];

  const unlinked = bucket();
  const orphans = bucket();
  const byId = new Map(known.map((s) => [s.id, bucket()]));
  const knownIds = new Set(byId.keys());

  for (const it of items) {
    if (it.archived != null) continue;
    const place = placeOf(it, knownIds);
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
 * 只收**活着**的 agent：agent 关掉后那个地址在 `agents()` 里不存在，Agents 栏
 * 没有行可挂，它的待办由侧栏按 agent.space 显示（见 deriveSidebar）。
 * 活着的 agent 两边都显示是刻意的：同一条事按「谁在做」和「在哪个 space」
 * 各看一次，不是重复计数。
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
