import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyState,
  addItem,
  setStatus,
  setPriority,
  setNote,
  setTitle,
  setSpaces,
  groupBySpace,
  sortItems,
  archiveItem,
  unarchiveItem,
  normalizeState,
  summary,
  findItem,
  STATUSES,
  PRIORITIES,
} from "../src/core.js";

const T0 = 1_700_000_000_000;

function seeded() {
  const s = addItem(emptyState(), { title: "修 login", priority: "P1", spaces: ["spA"] }, T0);
  return { state: s, id: s.items[0].id };
}

test("addItem 建立带 created 时间线条目的待办", () => {
  const { state, id } = seeded();
  assert.equal(state.items.length, 1);
  const item = findItem(state, id);
  assert.equal(item.title, "修 login");
  assert.equal(item.status, "todo");
  assert.equal(item.priority, "P1");
  assert.deepEqual(item.spaces, ["spA"]);
  assert.equal(item.created, T0);
  assert.equal(item.updated, T0);
  assert.equal(item.timeline.length, 1);
  assert.equal(item.timeline[0].kind, "created");
  assert.equal(item.timeline[0].to, "todo");
});

test("addItem 拒绝空标题", () => {
  assert.throws(() => addItem(emptyState(), { title: "   " }, T0), /标题/);
  assert.throws(() => addItem(emptyState(), {}, T0), /标题/);
});

test("addItem 拒绝非法优先级，默认 P2", () => {
  const s = addItem(emptyState(), { title: "a" }, T0);
  assert.equal(s.items[0].priority, "P2");
  assert.throws(() => addItem(emptyState(), { title: "a", priority: "P9" }, T0), /优先级/);
});

test("id 单调递增且不复用", () => {
  let s = emptyState();
  s = addItem(s, { title: "a" }, T0);
  s = addItem(s, { title: "b" }, T0);
  const ids = s.items.map((i) => i.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(s.seq >= 2);
});

test("setStatus 追加 from→to 时间线", () => {
  const { state, id } = seeded();
  const next = setStatus(state, id, "doing", { by: "cli" }, T0 + 1000);
  const item = findItem(next, id);
  assert.equal(item.status, "doing");
  assert.equal(item.updated, T0 + 1000);
  assert.equal(item.timeline.length, 2);
  assert.deepEqual(
    { kind: item.timeline[1].kind, from: item.timeline[1].from, to: item.timeline[1].to },
    { kind: "status", from: "todo", to: "doing" },
  );
});

test("setStatus 相同状态不产生时间线条目", () => {
  const { state, id } = seeded();
  const next = setStatus(state, id, "todo", {}, T0 + 1);
  assert.equal(findItem(next, id).timeline.length, 1);
});

test("终态不得直接改回非终态，需 reopen", () => {
  const { state, id } = seeded();
  const done = setStatus(state, id, "done", {}, T0 + 1);
  assert.throws(() => setStatus(done, id, "todo", {}, T0 + 2), /重新打开|reopen/);
  assert.throws(() => setStatus(done, id, "doing", {}, T0 + 2), /重新打开|reopen/);

  const reopened = setStatus(done, id, "todo", { reopen: true }, T0 + 3);
  const item = findItem(reopened, id);
  assert.equal(item.status, "todo");
  assert.deepEqual(
    { kind: item.timeline[2].kind, from: item.timeline[2].from, to: item.timeline[2].to },
    { kind: "status", from: "done", to: "todo" },
  );
});

test("终态之间与进入终态不需要 reopen", () => {
  const { state, id } = seeded();
  const done = setStatus(state, id, "done", {}, T0 + 1);
  const cancelled = setStatus(done, id, "cancelled", {}, T0 + 2);
  assert.equal(findItem(cancelled, id).status, "cancelled");
});

test("setStatus 拒绝未知状态", () => {
  const { state, id } = seeded();
  assert.throws(() => setStatus(state, id, "nope", {}, T0 + 1), /状态/);
  assert.deepEqual(STATUSES, ["todo", "doing", "blocked", "done", "cancelled"]);
});

test("setPriority 与 setTitle 只在变化时记时间线", () => {
  const { state, id } = seeded();
  const a = setPriority(state, id, "P0", {}, T0 + 1);
  assert.equal(findItem(a, id).priority, "P0");
  assert.equal(findItem(a, id).timeline.at(-1).kind, "priority");
  assert.deepEqual(
    { from: findItem(a, id).timeline.at(-1).from, to: findItem(a, id).timeline.at(-1).to },
    { from: "P1", to: "P0" },
  );

  const b = setPriority(a, id, "P0", {}, T0 + 2);
  assert.equal(findItem(b, id).timeline.length, findItem(a, id).timeline.length);

  const c = setTitle(b, id, "修 login 与注册", {}, T0 + 3);
  assert.equal(findItem(c, id).title, "修 login 与注册");
  assert.equal(findItem(c, id).timeline.at(-1).kind, "title");
  assert.throws(() => setTitle(c, id, "  ", {}, T0 + 4), /标题/);
});

test("setNote 只在变化时记时间线，且记录长度而非全文", () => {
  const { state, id } = seeded();
  const a = setNote(state, id, "复现步骤：1. ...", {}, T0 + 1);
  const entry = findItem(a, id).timeline.at(-1);
  assert.equal(entry.kind, "note");
  assert.ok(!String(entry.to).includes("复现步骤"), "时间线不应存备注全文");
  assert.equal(findItem(a, id).note, "复现步骤：1. ...");

  const b = setNote(a, id, "复现步骤：1. ...", {}, T0 + 2);
  assert.equal(findItem(b, id).timeline.length, findItem(a, id).timeline.length);
});

test("setSpaces 去重并记录前后差集", () => {
  const { state, id } = seeded();
  const a = setSpaces(state, id, ["spA", "spB", "spA"], {}, T0 + 1);
  assert.deepEqual(findItem(a, id).spaces, ["spA", "spB"]);
  assert.deepEqual(findItem(a, id).timeline.at(-1).to, ["spA", "spB"]);

  const b = setSpaces(a, id, ["spB"], {}, T0 + 2);
  assert.deepEqual(findItem(b, id).spaces, ["spB"]);
  assert.deepEqual(findItem(b, id).timeline.at(-1).from, ["spA", "spB"]);

  const c = setSpaces(b, id, ["spB"], {}, T0 + 3);
  assert.equal(findItem(c, id).timeline.length, findItem(b, id).timeline.length);
});

test("所有变更都不就地修改输入状态", () => {
  const { state, id } = seeded();
  const snapshot = JSON.parse(JSON.stringify(state));
  setStatus(state, id, "doing", {}, T0 + 1);
  setPriority(state, id, "P0", {}, T0 + 1);
  setNote(state, id, "x", {}, T0 + 1);
  setSpaces(state, id, [], {}, T0 + 1);
  assert.deepEqual(state, snapshot);
});

test("时间线按时间升序", () => {
  const { state, id } = seeded();
  let s = setStatus(state, id, "doing", {}, T0 + 3000);
  s = setPriority(s, id, "P0", {}, T0 + 1000);
  const times = findItem(s, id).timeline.map((e) => e.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

const SPACES = [
  { id: "spA", name: "api", machine: null },
  { id: "spB", name: "web", machine: "dev5" },
];

function threeItems() {
  let s = emptyState();
  s = addItem(s, { title: "无关联的事", priority: "P2" }, T0);
  s = addItem(s, { title: "跨两个 space", priority: "P0", spaces: ["spA", "spB"] }, T0);
  s = addItem(s, { title: "已关闭 space 上的事", priority: "P1", spaces: ["spGone"] }, T0);
  return s;
}

test("groupBySpace：未关联在最前，多 space 项出现在每组，未知 space 单列", () => {
  const s = threeItems();
  const groups = groupBySpace(s.items, SPACES);

  assert.equal(groups[0].key, "unlinked");
  assert.equal(groups.at(-1).key, "closed");
  assert.deepEqual(
    groups.map((g) => g.key),
    ["unlinked", "spA", "spB", "closed"],
  );

  assert.deepEqual(groups[0].items.map((i) => i.title), ["无关联的事"]);
  assert.deepEqual(groups[1].items.map((i) => i.title), ["跨两个 space"]);
  assert.deepEqual(groups[2].items.map((i) => i.title), ["跨两个 space"]);
  assert.deepEqual(groups[3].items.map((i) => i.title), ["已关闭 space 上的事"]);
  assert.deepEqual(groups[3].spaceIds, ["spGone"]);
});

test("groupBySpace：空分组默认保留已知 space，便于一眼看到哪些 space 没事项", () => {
  const s = addItem(emptyState(), { title: "只有 A", spaces: ["spA"] }, T0);
  const groups = groupBySpace(s.items, SPACES);
  const spB = groups.find((g) => g.key === "spB");
  assert.ok(spB, "spB 应作为空分组存在");
  assert.deepEqual(spB.items, []);
});

test("groupBySpace：默认不含 done/cancelled", () => {
  let s = addItem(emptyState(), { title: "完成的", spaces: ["spA"] }, T0);
  const id = s.items[0].id;
  s = setStatus(s, id, "done", {}, T0 + 1);
  const groups = groupBySpace(s.items, SPACES);
  assert.equal(groups.find((g) => g.key === "spA").items.length, 0);
});

test("groupBySpace：includeClosed 时终态出现在已完成组", () => {
  let s = addItem(emptyState(), { title: "完成的", spaces: ["spA"] }, T0);
  const id = s.items[0].id;
  s = setStatus(s, id, "done", {}, T0 + 1);
  const groups = groupBySpace(s.items, SPACES, { includeClosed: true });
  const closedItems = groups.flatMap((g) => g.items).filter((i) => i.status === "done");
  assert.equal(closedItems.length, 1);
});

test("sortItems：状态 → 优先级 → 更新时间倒序", () => {
  let s = emptyState();
  s = addItem(s, { title: "P0-todo", priority: "P0" }, T0);
  s = addItem(s, { title: "P2-todo", priority: "P2" }, T0);
  s = addItem(s, { title: "P3-doing", priority: "P3" }, T0);
  const doingId = s.items[2].id;
  s = setStatus(s, doingId, "doing", {}, T0 + 10);
  const sorted = sortItems(s.items).map((i) => i.title);
  // 状态优先：「在手上」的低优先级事项排在 P0 待办之前。
  assert.deepEqual(sorted, ["P3-doing", "P0-todo", "P2-todo"]);
});

test("summary 按唯一事项计数，不受多组重复影响", () => {
  const s = threeItems();
  const sum = summary(s.items);
  assert.equal(sum.pending, 3);
  assert.equal(sum.p0, 1);
  assert.equal(sum.done, 0);
});

test("findItem 找不到返回 null", () => {
  assert.equal(findItem(emptyState(), "nope"), null);
});

test("PRIORITIES 为 P0-P3", () => {
  assert.deepEqual(PRIORITIES, ["P0", "P1", "P2", "P3"]);
});

test("archiveItem：收起但保留数据，且不被 normalizeState 丢掉", () => {
  let s = emptyState();
  s = addItem(s, { title: "要归档的", priority: "P0" }, T0);
  s = archiveItem(s, "t1", {}, T0 + 10);
  const it = s.items[0];
  assert.equal(it.status, "cancelled");
  assert.equal(it.archived, T0 + 10);
  // 读回一遍：归档标记必须还在，否则下次读到就「复活」了。
  const round = normalizeState(JSON.parse(JSON.stringify(s)));
  assert.equal(round.items[0].archived, T0 + 10);
});

test("archiveItem：已完成的事项不因归档改状态", () => {
  let s = emptyState();
  s = addItem(s, { title: "做完了", status: "todo" }, T0);
  s = setStatus(s, "t1", "done", {}, T0 + 5);
  s = archiveItem(s, "t1", {}, T0 + 10);
  assert.equal(s.items[0].status, "done");
  assert.ok(s.items[0].archived);
});

test("时钟回拨不打乱时间线顺序（时间戳单调不减）", () => {
  let s = emptyState();
  s = addItem(s, { title: "x" }, T0);
  s = setStatus(s, "t1", "doing", {}, T0 + 5000);
  s = setStatus(s, "t1", "blocked", {}, T0 + 3000); // 时钟被回拨
  const item = findItem(s, "t1");
  assert.equal(item.status, "blocked");
  // 最后一条时间线必须对应当前状态，否则详情页会自相矛盾。
  assert.equal(item.timeline.at(-1).to, "blocked");
  assert.equal(item.timeline.at(-1).at, T0 + 5000);
});

test("seq 只从 t<n> 形式的 id 推导，导入的怪 id 不会把它推到溢出", () => {
  const raw = {
    v: 1,
    seq: 0,
    items: [
      { id: "note-20261119123456789", title: "导入的", status: "todo", priority: "P2", spaces: [], timeline: [] },
    ],
  };
  const st = normalizeState(raw);
  assert.ok(Number.isSafeInteger(st.seq), "seq 必须是安全整数");
  const next = addItem(st, { title: "新的" }, T0);
  assert.equal(next.items.at(-1).id, "t1", "应复用未被占用的序号，而不是生成一个巨大 id");
});

test("seq 已经溢出时拒绝分配新 id，而不是写坏账本", () => {
  const st = { v: 1, seq: Number.MAX_SAFE_INTEGER, items: [] };
  assert.throws(() => addItem(st, { title: "a" }, T0), /溢出/);
});

test("归档后 reopen 会清掉归档标记（不留死结）", () => {
  let s = addItem(emptyState(), { title: "a" }, T0);
  s = archiveItem(s, "t1", {}, T0 + 10);
  assert.equal(s.items[0].archived, T0 + 10);
  s = setStatus(s, "t1", "doing", { reopen: true }, T0 + 20);
  assert.equal(s.items[0].status, "doing");
  assert.equal(s.items[0].archived, undefined, "reopen 后不应仍是归档项");
  assert.equal(s.items[0].timeline.at(-2).kind, "unarchived");
});

test("归档已取消的事项不再追加空操作时间线条目", () => {
  let s = addItem(emptyState(), { title: "a" }, T0);
  s = setStatus(s, "t1", "cancelled", {}, T0 + 5);
  const n = s.items[0].timeline.length;
  s = archiveItem(s, "t1", {}, T0 + 10);
  assert.equal(s.items[0].timeline.length, n + 1, "只应多一条 archived");
  assert.equal(s.items[0].timeline.at(-1).kind, "archived");
});

test("normalizeState 不再静默丢弃信息（spaces/时间戳/时间线条目）", () => {
  const bad = (item) => () => normalizeState({ v: 1, items: [{ id: "t1", ...item }] });
  assert.throws(bad({ spaces: "spA" }), /spaces/);
  assert.throws(bad({ created: "yesterday" }), /created/);
  assert.throws(bad({ updated: "later" }), /updated/);
  assert.throws(bad({ timeline: [{ kind: "status", at: "not-a-time" }] }), /时间线/);
  assert.throws(bad({ timeline: [{ kind: "spaces", at: 1, to: "spA" }] }), /时间线/);
  assert.throws(() => normalizeState({ v: 1, items: {} }), /数组/);
});

test("normalizeState 读超长标题不截断（截断会让下一次写入把它删掉）", () => {
  const long = "长".repeat(500);
  const st = normalizeState({ v: 1, items: [{ id: "t1", title: long, spaces: [], timeline: [] }] });
  assert.equal(st.items[0].title, long);
});

test("归档项不计入统计与分组（数字要和列表行数对得上）", () => {
  let s = emptyState();
  s = addItem(s, { title: "在手上的" }, T0);
  s = addItem(s, { title: "收起来的" }, T0);
  s = archiveItem(s, "t2", {}, T0 + 1);

  const sum = summary(s.items);
  assert.equal(sum.pending, 1, "归档项不应算作未处理");
  assert.equal(sum.archived, 1);

  const groups = groupBySpace(s.items, []);
  const shown = groups.flatMap((g) => g.items).map((i) => i.title);
  assert.deepEqual(shown, ["在手上的"]);

  // 需要时（导出、审计）仍能把归档项取回来。
  const all = groupBySpace(s.items, [], { includeArchived: true, includeClosed: true });
  assert.ok(all.flatMap((g) => g.items).some((i) => i.title === "收起来的"));
});

test("unarchiveItem 让事项回到未处理，并解释状态为何变回 todo", () => {
  let s = addItem(emptyState(), { title: "a" }, T0);
  s = archiveItem(s, "t1", {}, T0 + 10);
  assert.equal(s.items[0].status, "cancelled");

  s = unarchiveItem(s, "t1", {}, T0 + 20);
  const it = s.items[0];
  assert.equal(it.archived, undefined);
  assert.equal(it.status, "todo");
  assert.equal(it.timeline.at(-2).kind, "status");
  assert.equal(it.timeline.at(-1).kind, "unarchived");
  assert.equal(summary(s.items).pending, 1);
});

// ---------- agent 关联（agent 替代 space） ----------

test("setAgent 挂上 agent 时清空 space 关联，并记一条 agent 时间线", async () => {
  const { setAgent } = await import("../src/core.js");
  const { state, id } = seeded();
  assert.deepEqual(state.items[0].spaces, ["spA"], "前提：事项原本关联 spA");

  const next = setAgent(state, id, { address: "dev5/t2", space: "spA" }, { by: "panel" }, T0 + 1);
  const it = next.items[0];
  assert.deepEqual(it.agent, { address: "dev5/t2", space: "spA" });
  assert.deepEqual(it.spaces, [], "挂上 agent 就要清掉 space，两种关联不能同时存在");
  const last = it.timeline[it.timeline.length - 1];
  assert.equal(last.kind, "agent");
  assert.equal(last.from, null);
  assert.equal(last.to, "dev5/t2");
  assert.equal(last.by, "panel");
});

test("setAgent(null) 解除关联，但不会把 space 关联凭空恢复", async () => {
  const { setAgent } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  s = setAgent(s, id, null, {}, T0 + 2);
  assert.equal(s.items[0].agent, undefined, "解除后不该留着空对象");
  assert.deepEqual(s.items[0].spaces, []);
});

test("挂 space 关联会解除 agent 关联（反向互斥）", async () => {
  const { setAgent } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  s = setSpaces(s, id, ["spB"], {}, T0 + 2);
  assert.deepEqual(s.items[0].spaces, ["spB"]);
  assert.equal(s.items[0].agent, undefined, "挂了 space 就不能再留着 agent 关联");
  const kinds = s.items[0].timeline.map((e) => e.kind);
  assert.ok(kinds.includes("agent") && kinds.includes("spaces"));
});

test("清空 space 关联不会顺手解除 agent（那是两件不同的事）", async () => {
  const { setAgent } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  s = setSpaces(s, id, [], {}, T0 + 2);
  assert.deepEqual(s.items[0].agent, { address: "dev5/t2", space: "spA" });
});

test("同一个 agent 重复挂不产生新时间线（幂等）", async () => {
  const { setAgent } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  const before = s.items[0].timeline.length;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 2);
  assert.equal(s.items[0].timeline.length, before, "同样的关联不该再记一条");
});

test("同一个 agent 换了 space：回退位置更新（那是真实变化）", async () => {
  // 回退显示的位置在「关联当时」固定，是为了不让事项随 agent 搬家在 space 之间
  // 跳；但用户重新把它挂到同一个 agent 上时，那个「当时」就变成了现在，
  // 新的 space 才是对的。
  const { setAgent } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  s = setAgent(s, id, { address: "dev5/t2", space: "spB" }, {}, T0 + 2);
  assert.equal(s.items[0].agent.space, "spB");
  assert.equal(s.items[0].timeline.at(-1).kind, "agent", "换 space 要留一条时间线");
});

test("agent 形状不对时拒绝写入", async () => {
  const { setAgent } = await import("../src/core.js");
  const { state, id } = seeded();
  for (const bad of [{ address: "a" }, { space: "spA" }, { address: "", space: "spA" }, "dev5/t2", []]) {
    assert.throws(() => setAgent(state, id, bad, {}, T0 + 1), /agent/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("normalizeState 拒绝形状不对的 agent 字段，并保留合法字段", async () => {
  const s = normalizeState({
    v: 1,
    seq: 1,
    items: [{ id: "t1", title: "x", agent: { address: "dev5/t2", space: "spA" } }],
  });
  assert.deepEqual(s.items[0].agent, { address: "dev5/t2", space: "spA" });
  assert.throws(
    () => normalizeState({ v: 1, seq: 1, items: [{ id: "t1", title: "x", agent: "dev5/t2" }] }),
    /agent/,
  );
});

test("cloneItem 深拷贝 agent：改副本不影响原状态", async () => {
  const { setAgent } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  const next = setAgent(s, id, { address: "dev5/t2", space: "spB" }, {}, T0 + 2);
  assert.deepEqual(s.items[0].agent, { address: "dev5/t2", space: "spA" }, "原状态不该被就地修改");
  assert.deepEqual(next.items[0].agent, { address: "dev5/t2", space: "spB" });
});

// ---------- moveSpace（拖拽：从一个 space 挪到另一个） ----------

test("moveSpace 从 spA 拖到 spB：去掉来源、加上目标，一次写完成", async () => {
  const { moveSpace } = await import("../src/core.js");
  const { state, id } = seeded();
  const next = moveSpace(state, id, "spA", "spB", { by: "panel" }, T0 + 1);
  const it = next.items[0];
  assert.deepEqual(it.spaces, ["spB"], "移动是替换来源，不是双关联");
  const last = it.timeline.at(-1);
  assert.equal(last.kind, "spaces");
  assert.deepEqual(last.from, ["spA"]);
  assert.deepEqual(last.to, ["spB"]);
  assert.equal(last.by, "panel");
});

test("moveSpace 不改动原 state（纯函数）", async () => {
  const { moveSpace } = await import("../src/core.js");
  const { state, id } = seeded();
  moveSpace(state, id, "spA", "spB", {}, T0 + 1);
  assert.deepEqual(state.items[0].spaces, ["spA"], "原 state 不能被就地改掉");
});

test("moveSpace 只移除被拖出的那一组，其它 space 关联保留", async () => {
  const { moveSpace } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x", spaces: ["spA", "spC"] }, T0);
  const id = s.items[0].id;
  s = moveSpace(s, id, "spA", "spB", {}, T0 + 1);
  assert.deepEqual([...s.items[0].spaces].sort(), ["spB", "spC"]);
});

test("moveSpace 到未关联（to=null）只移除来源", async () => {
  const { moveSpace } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x", spaces: ["spA", "spC"] }, T0);
  const id = s.items[0].id;
  s = moveSpace(s, id, "spA", null, {}, T0 + 1);
  assert.deepEqual(s.items[0].spaces, ["spC"]);
});

test("moveSpace 来源为 null（从未关联组拖到某个 space）只做新增", async () => {
  const { moveSpace } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = moveSpace(s, id, null, "spB", {}, T0 + 1);
  assert.deepEqual(s.items[0].spaces, ["spB"]);
});

test("moveSpace 落到 space 上会解除 agent 关联（互斥不变量）", async () => {
  const { setAgent, moveSpace } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  s = moveSpace(s, id, null, "spB", {}, T0 + 2);
  assert.deepEqual(s.items[0].spaces, ["spB"]);
  assert.equal(s.items[0].agent, undefined, "挂了 space 就不能再留着 agent 关联");
});

test("moveSpace 挪到未关联不会顺手解除 agent（那是另一件事）", async () => {
  const { setAgent, moveSpace } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x" }, T0);
  const id = s.items[0].id;
  s = setAgent(s, id, { address: "dev5/t2", space: "spA" }, {}, T0 + 1);
  s = moveSpace(s, id, "spZ", null, {}, T0 + 2);
  assert.deepEqual(s.items[0].agent, { address: "dev5/t2", space: "spA" });
});

test("moveSpace 目标与来源相同：幂等，不产生新时间线", async () => {
  const { moveSpace } = await import("../src/core.js");
  const { state, id } = seeded();
  const before = state.items[0].timeline.length;
  const next = moveSpace(state, id, "spA", "spA", {}, T0 + 1);
  assert.equal(next.items[0].timeline.length, before);
  assert.deepEqual(next.items[0].spaces, ["spA"]);
});

test("moveSpace 拖进已关联的 space：不重复添加", async () => {
  const { moveSpace } = await import("../src/core.js");
  let s = addItem(emptyState(), { title: "x", spaces: ["spA", "spB"] }, T0);
  const id = s.items[0].id;
  s = moveSpace(s, id, "spA", "spB", {}, T0 + 1);
  assert.deepEqual(s.items[0].spaces, ["spB"]);
});

test("moveSpace 找不到事项时报错，而不是静默成功", async () => {
  const { moveSpace } = await import("../src/core.js");
  assert.throws(() => moveSpace(emptyState(), "nope", "spA", "spB", {}, T0), /找不到/);
});
