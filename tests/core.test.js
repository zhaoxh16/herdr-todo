// 只读侧（core.js）的单测：缓存校验、排序、分组、汇总、时间线顺序。
// 写入侧的断言在 tests/rules.test.js。
//
// 与迁移前的差别：原来这里的写侧用例（addItem/setStatus/...）整体搬到 rules.test.js，
// 判断标准未放宽。只读侧用例原样保留，另外补了两处由格式版本变化引出的新约束：
// 缓存里事项必须带 num（面板要显示 #12），且同一毫秒的事件按数组顺序（即事件 seq）
// 定先后。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyState,
  normalizeState,
  groupBySpace,
  sortItems,
  sortByRecent,
  summary,
  findItem,
  timelineOf,
  STATUSES,
  PRIORITIES,
  SCHEMA_VERSION,
} from "../src/core.js";

const T0 = 1_700_000_000_000;

function item(id, over = {}) {
  return {
    id,
    num: over.num ?? 1,
    title: over.title ?? id,
    note: over.note ?? "",
    priority: over.priority ?? "P2",
    status: over.status ?? "todo",
    spaces: over.spaces ?? [],
    created: over.created ?? T0,
    updated: over.updated ?? T0,
    timeline: over.timeline ?? [{ at: T0, kind: "created", from: null, to: "todo", by: "cli" }],
    ...(over.agent != null ? { agent: over.agent } : {}),
    ...(over.archived != null ? { archived: over.archived } : {}),
  };
}

const SPACES = [
  { id: "spA", name: "api", machine: null },
  { id: "spB", name: "web", machine: "dev5" },
];

function threeItems() {
  return [
    item("01JA1", { title: "无关联的事", num: 1 }),
    item("01JA2", { title: "跨两个 space", priority: "P0", spaces: ["spA", "spB"], num: 2 }),
    item("01JA3", { title: "已关闭 space 上的事", priority: "P1", spaces: ["spGone"], num: 3 }),
  ];
}

// ---------- 缓存格式 ----------

test("空缓存带 v2 与两个游标字段", () => {
  const st = emptyState();
  assert.equal(st.v, 2);
  assert.equal(st.synced_through, 0);
  assert.equal(st.synced_at, 0);
  assert.deepEqual(st.items, []);
});

test("normalizeState 接受 v1（供导入）与 v2，拒绝其它版本", () => {
  assert.equal(normalizeState({ v: 1, items: [] }).v, 2);
  assert.equal(normalizeState({ v: 2, items: [] }).v, 2);
  assert.throws(() => normalizeState({ v: 3, items: [] }), /版本/);
});

test("normalizeState 保留 synced_through 与 synced_at", () => {
  const st = normalizeState({ v: 2, synced_through: 412, synced_at: 1794997750119, items: [] });
  assert.equal(st.synced_through, 412);
  assert.equal(st.synced_at, 1794997750119);
});

test("normalizeState 保留 num（面板要显示 #12）", () => {
  const st = normalizeState({ v: 2, items: [item("01JA1", { num: 12 })] });
  assert.equal(st.items[0].num, 12);
});

test("normalizeState 拒绝非法 num", () => {
  for (const bad of [0, -1, 1.5, "abc"]) {
    assert.throws(() => normalizeState({ v: 2, items: [{ id: "x", num: bad }] }), /num/, `应拒绝 ${bad}`);
  }
});

test("normalizeState 不再静默丢弃信息（spaces/时间戳/时间线条目）", () => {
  const bad = (over) => () => normalizeState({ v: 2, items: [{ id: "01JA1", ...over }] });
  assert.throws(bad({ spaces: "spA" }), /spaces/);
  assert.throws(bad({ created: "yesterday" }), /created/);
  assert.throws(bad({ updated: "later" }), /updated/);
  assert.throws(bad({ timeline: [{ kind: "status", at: "not-a-time" }] }), /时间线/);
  assert.throws(bad({ timeline: [{ kind: "spaces", at: 1, to: "spA" }] }), /时间线/);
  assert.throws(() => normalizeState({ v: 2, items: {} }), /数组/);
});

test("normalizeState 读超长标题不截断（截断会让下一次写入把它删掉）", () => {
  const long = "长".repeat(500);
  const st = normalizeState({ v: 2, items: [{ id: "01JA1", title: long, spaces: [], timeline: [] }] });
  assert.equal(st.items[0].title, long);
});

test("normalizeState 拒绝形状不对的 agent 字段，并保留合法字段", () => {
  const s = normalizeState({
    v: 2,
    items: [{ id: "01JA1", title: "x", agent: { address: "dev5/t2", space: "spA" } }],
  });
  assert.deepEqual(s.items[0].agent, { address: "dev5/t2", space: "spA" });
  assert.throws(
    () => normalizeState({ v: 2, items: [{ id: "01JA1", title: "x", agent: "dev5/t2" }] }),
    /agent/,
  );
});

test("normalizeState 保留归档标记（否则下次读到就「复活」了）", () => {
  const st = normalizeState({
    v: 2,
    items: [{ id: "01JA1", title: "x", archived: T0 + 10, status: "cancelled", spaces: [], timeline: [] }],
  });
  assert.equal(st.items[0].archived, T0 + 10);
});

// ---------- 时间线顺序 ----------

test("timelineOf 按发生时间升序，同一毫秒的条目保持数组顺序", () => {
  const it = item("01JA1", {
    timeline: [
      { at: T0, kind: "created", from: null, to: "todo", by: "panel" },
      { at: T0, kind: "status", from: "todo", to: "doing", by: "panel" },
      { at: T0 + 5, kind: "priority", from: "P2", to: "P0", by: "panel" },
    ],
  });
  const kinds = timelineOf(it).map((e) => e.kind);
  assert.deepEqual(kinds, ["created", "status", "priority"]);

  // 反过来传入（代表读到时顺序被打乱）也必须按 at 排回来，
  // 同毫秒的两条按数组顺序保留——数组顺序就是 seq 顺序。
  const shuffled = { ...it, timeline: [it.timeline[2], it.timeline[1], it.timeline[0]] };
  const out = timelineOf(shuffled).map((e) => e.kind);
  assert.deepEqual(out, ["status", "created", "priority"], "同毫秒两条保持数组内的相对顺序");
});

test("timelineOf 有 seq 时按 seq 排，不按时钟（跨设备时钟偏差不能改顺序）", () => {
  // 第二台设备的时钟慢 5 秒：它的那条 at 更小，但 seq 更大——真实顺序是后发生的。
  const it = item("01JA1", {
    timeline: [
      { at: T0, kind: "created", from: null, to: "todo", by: "a", seq: 100 },
      { at: T0 - 5000, kind: "status", from: "todo", to: "doing", by: "b", seq: 101 },
      { at: T0 + 5000, kind: "priority", from: "P2", to: "P0", by: "a", seq: 102 },
    ],
  });
  const shuffled = { ...it, timeline: [it.timeline[2], it.timeline[0], it.timeline[1]] };
  assert.deepEqual(
    timelineOf(shuffled).map((e) => e.kind),
    ["created", "status", "priority"],
    "顺序的权威是事件序号，不是客户端时钟",
  );

  // 导入的旧条目没有 seq：仍按 at，不能因为缺字段就抛错或乱序。
  const legacy = item("01JA2", {
    timeline: [
      { at: T0, kind: "created", from: null, to: "todo", by: "a" },
      { at: T0 - 1, kind: "status", from: "todo", to: "doing", by: "a" },
    ],
  });
  assert.deepEqual(timelineOf(legacy).map((e) => e.kind), ["status", "created"]);
});

// ---------- 分组 ----------

test("groupBySpace：未关联在最前，多 space 项出现在每组，未知 space 单列", () => {
  const groups = groupBySpace(threeItems(), SPACES);

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
  const groups = groupBySpace([item("01JA1", { spaces: ["spA"] })], SPACES);
  const spB = groups.find((g) => g.key === "spB");
  assert.ok(spB, "spB 应作为空分组存在");
  assert.deepEqual(spB.items, []);
});

test("groupBySpace：默认不含 done/cancelled", () => {
  const groups = groupBySpace([item("01JA1", { spaces: ["spA"], status: "done" })], SPACES);
  assert.equal(groups.find((g) => g.key === "spA").items.length, 0);
});

test("groupBySpace：includeClosed 时终态出现", () => {
  const groups = groupBySpace(
    [item("01JA1", { spaces: ["spA"], status: "done" })],
    SPACES,
    { includeClosed: true },
  );
  const closed = groups.flatMap((g) => g.items).filter((i) => i.status === "done");
  assert.equal(closed.length, 1);
});

test("归档项不计入分组，除非显式 includeArchived", () => {
  const items = [item("01JA1", { title: "在手上的" }), item("01JA2", { title: "收起来的", archived: T0 + 1 })];
  const shown = groupBySpace(items, []).flatMap((g) => g.items).map((i) => i.title);
  assert.deepEqual(shown, ["在手上的"]);

  const all = groupBySpace(items, [], { includeArchived: true, includeClosed: true });
  assert.ok(all.flatMap((g) => g.items).some((i) => i.title === "收起来的"));
});

// ---------- 排序 / 汇总 ----------

test("sortItems：状态 → 优先级 → 更新时间倒序", () => {
  const items = [
    item("01JA1", { title: "P0-todo", priority: "P0" }),
    item("01JA2", { title: "P2-todo", priority: "P2" }),
    item("01JA3", { title: "P3-doing", priority: "P3", status: "doing", updated: T0 + 10 }),
  ];
  // 状态优先：「在手上」的低优先级事项排在 P0 待办之前。
  assert.deepEqual(sortItems(items).map((i) => i.title), ["P3-doing", "P0-todo", "P2-todo"]);
});

test("sortItems 不变更输入数组", () => {
  const items = [item("01JA1", { priority: "P3" }), item("01JA2", { priority: "P0" })];
  const before = items.map((i) => i.id);
  sortItems(items);
  assert.deepEqual(items.map((i) => i.id), before);
});

test("sortByRecent 按 updated 倒序", () => {
  const items = [item("01JA1", { updated: T0 }), item("01JA2", { updated: T0 + 10 })];
  assert.deepEqual(sortByRecent(items).map((i) => i.id), ["01JA2", "01JA1"]);
});

test("summary 按唯一事项计数，不受多组重复影响", () => {
  const sum = summary(threeItems());
  assert.equal(sum.pending, 3);
  assert.equal(sum.p0, 1);
  assert.equal(sum.done, 0);
});

test("归档项不计入统计（数字要和列表行数对得上）", () => {
  const sum = summary([item("01JA1"), item("01JA2", { archived: T0 + 1 })]);
  assert.equal(sum.pending, 1, "归档项不应算作未处理");
  assert.equal(sum.archived, 1);
});

test("findItem 找不到返回 null", () => {
  assert.equal(findItem(emptyState(), "nope"), null);
});

test("STATUSES / PRIORITIES / SCHEMA_VERSION 取值固定", () => {
  assert.deepEqual(STATUSES, ["todo", "doing", "blocked", "done", "cancelled"]);
  assert.deepEqual(PRIORITIES, ["P0", "P1", "P2", "P3"]);
  assert.equal(SCHEMA_VERSION, 2);
});
