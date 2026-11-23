// 规则层（写侧）的单测。不连库、不碰文件。
//
// 这些断言大部分是 tests/core.test.js 里写侧用例的迁移：原来的签名是
// `setStatus(state, id, ...)`（改写整份账本），现在是 `applyStatus(item, ...)`
// （只改一条事项、返回要追加的事件）。**判断标准不变**：同一个输入下，事项的
// 最终字段、时间线条目（现在的「事件」）的条数与 from/to 都必须和迁移前一致。
//
// 三项旧断言没有直接对应物，它们守护的对象已在改造中被删除，替代者如下：
//   - 「id 单调递增且不复用」：id 改由 ULID 生成、num 由 owner 行锁分配，
//     由 tests/store.test.js 的「并发 10 次 add 得到 1..10」与「ULID 不重复」承接。
//   - 「seq 只从 t<n> 推导」与「seq 溢出时拒绝分配」：`state.seq` 这个概念随
//     单机账本一起删除（v1 只由导入脚本读取）。新的对应约束是 num 必须是正整数，
//     由 tests/core.test.js 的 normalizeState 用例承接。
import { test } from "node:test";
import assert from "node:assert/strict";

import { TodoError } from "../src/core.js";
import {
  applyCreate,
  applyStatus,
  applyPriority,
  applyTitle,
  applyNote,
  applySpaces,
  applyMove,
  applyAgent,
  applyArchive,
  applyUnarchive,
  applyDelete,
  canPurge,
} from "../src/rules.js";

const T0 = 1_700_000_000_000;

function make(over = {}) {
  return {
    id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    num: 1,
    title: "修 login",
    note: "",
    priority: "P1",
    status: "todo",
    spaces: ["spA"],
    created: T0,
    updated: T0,
    ...over,
  };
}

/** 依次应用若干规则，返回最后的事项与全部事件（按调用顺序）。 */
function chain(item, steps) {
  let cur = item;
  const events = [];
  for (const [fn, input] of steps) {
    const r = fn(cur, input);
    cur = r.item;
    events.push(...r.events);
  }
  return { item: cur, events };
}

const kinds = (events) => events.map((e) => e.kind);

// ---------- 创建 ----------

test("applyCreate 建立带 created 事件的待办", () => {
  const { item, events } = applyCreate({
    id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
    num: 1,
    title: "修 login",
    priority: "P1",
    spaces: ["spA"],
    at: T0,
    by: "cli",
  });
  assert.equal(item.title, "修 login");
  assert.equal(item.status, "todo");
  assert.equal(item.priority, "P1");
  assert.deepEqual(item.spaces, ["spA"]);
  assert.equal(item.created, T0);
  assert.equal(item.updated, T0);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "created");
  assert.equal(events[0].data.to ?? events[0].data.status, "todo");
});

test("applyCreate 拒绝空标题", () => {
  const base = { id: "x", num: 1, at: T0, by: "cli" };
  assert.throws(() => applyCreate({ ...base, title: "   " }), /标题/);
  assert.throws(() => applyCreate(base), /标题/);
});

// 静默 slice 会让用户看到「已添加」而实际少了半句话，时间线又只记长度、
// 正文不可恢复，所以超限必须是一次显式失败。
test("标题与备注超限时报错，不静默截断", () => {
  const base = { id: "x", num: 1, at: T0, by: "cli" };
  const ok = applyCreate({ ...base, title: "长".repeat(200), note: "备".repeat(20000) });
  assert.equal(ok.item.title.length, 200, "恰好到上限应接受");
  assert.equal(ok.item.note.length, 20000);

  assert.throws(() => applyCreate({ ...base, title: "长".repeat(201) }), /标题最多 200 字/);
  assert.throws(() => applyCreate({ ...base, title: "a", note: "备".repeat(20001) }), /备注最多 20000 字/);

  const it = { id: "x", num: 1, title: "t", note: "", status: "todo", spaces: [], created: T0, updated: T0 };
  assert.throws(() => applyTitle(it, { title: "长".repeat(201), at: T0 + 1, by: "cli" }), /标题最多/);
  assert.throws(() => applyNote(it, { note: "备".repeat(20001), at: T0 + 1, by: "cli" }), /备注最多/);
});

test("applyCreate 拒绝非法优先级，默认 P2", () => {
  const ok = applyCreate({ id: "x", num: 1, title: "a", at: T0, by: "cli" });
  assert.equal(ok.item.priority, "P2");
  assert.throws(
    () => applyCreate({ id: "x", num: 1, title: "a", priority: "P9", at: T0, by: "cli" }),
    /优先级/,
  );
});

test("applyCreate 保留调用方给的 id 与 num（唯一性由 ULID 与 owner 行锁保证）", () => {
  const a = applyCreate({ id: "01JAAAA", num: 1, title: "a", at: T0, by: "cli" });
  const b = applyCreate({ id: "01JBBBB", num: 2, title: "b", at: T0, by: "cli" });
  assert.notEqual(a.item.id, b.item.id);
  assert.equal(a.item.num, 1);
  assert.equal(b.item.num, 2);
});

// ---------- 状态 ----------

test("applyStatus 追加 from→to 事件", () => {
  const { item, events } = applyStatus(make(), { status: "doing", by: "cli", at: T0 + 1000 });
  assert.equal(item.status, "doing");
  assert.equal(item.updated, T0 + 1000);
  assert.equal(events.length, 1);
  assert.deepEqual({ kind: events[0].kind, from: events[0].data.from, to: events[0].data.to }, {
    kind: "status",
    from: "todo",
    to: "doing",
  });
});

test("applyStatus 相同状态不产生事件", () => {
  const { events } = applyStatus(make(), { status: "todo", at: T0 + 1 });
  assert.equal(events.length, 0);
});

test("终态不得直接改回非终态，需 reopen", () => {
  const done = applyStatus(make(), { status: "done", at: T0 + 1 }).item;
  assert.throws(() => applyStatus(done, { status: "todo", at: T0 + 2 }), /重新打开|reopen/);
  assert.throws(() => applyStatus(done, { status: "doing", at: T0 + 2 }), /重新打开|reopen/);

  const r = applyStatus(done, { status: "todo", reopen: true, at: T0 + 3 });
  assert.equal(r.item.status, "todo");
  assert.deepEqual(
    { kind: r.events.at(-1).kind, from: r.events.at(-1).data.from, to: r.events.at(-1).data.to },
    { kind: "status", from: "done", to: "todo" },
  );
});

test("closedAt 跟状态走：进入终态记时间，离开时清空", () => {
  const doing = applyStatus(make(), { status: "doing", at: T0 + 1 }).item;
  assert.equal(doing.closedAt, null, "非终态没有 closedAt");

  const done = applyStatus(doing, { status: "done", at: T0 + 2 }).item;
  assert.equal(done.closedAt, T0 + 2, "进入终态时记下时间");

  const back = applyStatus(done, { status: "todo", reopen: true, at: T0 + 3 }).item;
  assert.equal(back.closedAt, null, "重开后清空");

  // 归档会把未结束的事项顺带置成 cancelled，同样算「进入终态」。
  const archived = applyArchive(make(), { at: T0 + 4, by: "cli" }).item;
  assert.equal(archived.status, "cancelled");
  assert.equal(archived.closedAt, T0 + 4);

  // 取消归档把它退回 todo，closedAt 一并清空。
  assert.equal(applyUnarchive(archived, { at: T0 + 5, by: "cli" }).item.closedAt, null);

  // 新建即终态（`add --status done|cancelled`）：关闭时间就是创建时间。
  assert.equal(applyCreate({ title: "直接完成", at: T0 + 6, by: "cli", id: "01J0000000000000000000000A", num: 1, status: "done" }).item.closedAt, T0 + 6);
  assert.equal(applyCreate({ title: "直接取消", at: T0 + 6, by: "cli", id: "01J0000000000000000000000B", num: 2, status: "cancelled" }).item.closedAt, T0 + 6);
  assert.equal(applyCreate({ title: "普通", at: T0 + 6, by: "cli", id: "01J0000000000000000000000C", num: 3 }).item.closedAt, null);
});

test("终态之间与进入终态不需要 reopen", () => {  const done = applyStatus(make(), { status: "done", at: T0 + 1 }).item;
  const cancelled = applyStatus(done, { status: "cancelled", at: T0 + 2 }).item;
  assert.equal(cancelled.status, "cancelled");
});

test("applyStatus 拒绝未知状态", () => {
  assert.throws(() => applyStatus(make(), { status: "nope", at: T0 + 1 }), /状态/);
});

// ---------- 优先级 / 标题 / 备注 ----------

test("applyPriority 与 applyTitle 只在变化时记事件", () => {
  const a = applyPriority(make(), { priority: "P0", at: T0 + 1 });
  assert.equal(a.item.priority, "P0");
  assert.equal(a.events.at(-1).kind, "priority");
  assert.deepEqual({ from: a.events.at(-1).data.from, to: a.events.at(-1).data.to }, { from: "P1", to: "P0" });

  const b = applyPriority(a.item, { priority: "P0", at: T0 + 2 });
  assert.equal(b.events.length, 0);

  const c = applyTitle(b.item, { title: "修 login 与注册", at: T0 + 3 });
  assert.equal(c.item.title, "修 login 与注册");
  assert.equal(c.events.at(-1).kind, "title");
  assert.throws(() => applyTitle(c.item, { title: "  ", at: T0 + 4 }), /标题/);
});

test("applyNote 只在变化时记事件，且记录长度而非全文", () => {
  const a = applyNote(make(), { note: "复现步骤：1. ...", at: T0 + 1 });
  const entry = a.events.at(-1);
  assert.equal(entry.kind, "note");
  assert.ok(!JSON.stringify(entry.data).includes("复现步骤"), "事件不应存备注全文");
  assert.equal(a.item.note, "复现步骤：1. ...");

  const b = applyNote(a.item, { note: "复现步骤：1. ...", at: T0 + 2 });
  assert.equal(b.events.length, 0);
});

// ---------- 关联 ----------

test("applySpaces 去重并记录前后差集", () => {
  const a = applySpaces(make(), { spaces: ["spA", "spB", "spA"], at: T0 + 1 });
  assert.deepEqual(a.item.spaces, ["spA", "spB"]);
  assert.deepEqual(a.events.at(-1).data.to, ["spA", "spB"]);

  const b = applySpaces(a.item, { spaces: ["spB"], at: T0 + 2 });
  assert.deepEqual(b.item.spaces, ["spB"]);
  assert.deepEqual(b.events.at(-1).data.from, ["spA", "spB"]);

  const c = applySpaces(b.item, { spaces: ["spB"], at: T0 + 3 });
  assert.equal(c.events.length, 0);
});

test("所有变更都不就地修改输入事项", () => {
  const it = make();
  const snapshot = JSON.parse(JSON.stringify(it));
  applyStatus(it, { status: "doing", at: T0 + 1 });
  applyPriority(it, { priority: "P0", at: T0 + 1 });
  applyNote(it, { note: "x", at: T0 + 1 });
  applySpaces(it, { spaces: [], at: T0 + 1 });
  applyArchive(it, { at: T0 + 1 });
  applyDelete(it, { at: T0 + 1 });
  assert.deepEqual(it, snapshot);
});

test("时间戳单调不减：时钟回拨时事件时间不倒退", () => {
  const it = make({ updated: T0 + 5000 });
  const r = applyStatus(it, { status: "blocked", at: T0 + 3000 });
  assert.equal(r.item.status, "blocked");
  assert.equal(r.events.at(-1).at, T0 + 5000);
  assert.equal(r.item.updated, T0 + 5000);
});

// ---------- 归档 / 删除 ----------

test("applyArchive：收起但保留数据，reopen 会清掉归档标记", () => {
  const a = applyArchive(make(), { at: T0 + 10 });
  assert.equal(a.item.status, "cancelled", "未结束的事项归档时顺带置为取消");
  assert.equal(a.item.archived, T0 + 10);
  const r = applyStatus(a.item, { status: "doing", reopen: true, at: T0 + 20 });
  assert.equal(r.item.status, "doing");
  assert.equal(r.item.archived, undefined, "reopen 后不应仍是归档项");
  assert.equal(r.events.at(-2).kind, "unarchived");
});

test("applyArchive：已完成的事项不因归档改状态", () => {
  const done = applyStatus(make(), { status: "done", at: T0 + 5 }).item;
  const r = applyArchive(done, { at: T0 + 10 });
  assert.equal(r.item.status, "done");
  assert.ok(r.item.archived);
});

test("归档已取消的事项不再追加空操作事件", () => {
  const cancelled = applyStatus(make(), { status: "cancelled", at: T0 + 5 }).item;
  const r = applyArchive(cancelled, { at: T0 + 10 });
  assert.equal(r.events.length, 1, "只应多一条 archived");
  assert.equal(r.events.at(-1).kind, "archived");
});

test("applyUnarchive 让事项回到未处理，并解释状态为何变回 todo", () => {
  const archived = applyArchive(make(), { at: T0 + 10 }).item;
  assert.equal(archived.status, "cancelled");

  const r = applyUnarchive(archived, { at: T0 + 20 });
  assert.equal(r.item.archived, undefined);
  assert.equal(r.item.status, "todo");
  assert.equal(r.events.at(-2).kind, "status");
  assert.equal(r.events.at(-1).kind, "unarchived");
});

test("applyDelete 写墓碑并记一条 deleted 事件，重复删除无事件", () => {
  const a = applyDelete(make(), { at: T0 + 30, by: "cli" });
  assert.equal(a.item.deletedAt, T0 + 30);
  assert.deepEqual(kinds(a.events), ["deleted"]);
  const b = applyDelete(a.item, { at: T0 + 31 });
  assert.equal(b.events.length, 0);
});

test("canPurge 需要同时满足保留期与所有未吊销设备已拉取", () => {
  const now = T0 + 200 * 86400_000;
  const retentionMs = 180 * 86400_000;
  const base = { deletedAt: T0, deleteSeq: 50, minPulledSeq: 50, now, retentionMs };
  assert.equal(canPurge(base), true);
  assert.equal(canPurge({ ...base, deletedAt: now }), false, "保留期内不清理");
  assert.equal(canPurge({ ...base, minPulledSeq: 49 }), false, "有设备没拉过该删除事件");
  assert.equal(canPurge({ ...base, minPulledSeq: null }), true, "没有设备时会再拉，可以清");
  assert.equal(canPurge({ ...base, deletedAt: null }), false);
});

// ---------- agent 关联（agent 替代 space） ----------

test("applyAgent 挂上 agent 时清空 space 关联，并记一条 agent 事件", () => {
  const { item, events } = applyAgent(make(), {
    agent: { address: "dev5/t2", space: "spA" },
    by: "panel",
    at: T0 + 1,
  });
  assert.deepEqual(item.agent, { address: "dev5/t2", space: "spA" });
  assert.deepEqual(item.spaces, [], "挂上 agent 就要清掉 space，两种关联不能同时存在");
  const last = events.at(-1);
  assert.equal(last.kind, "agent");
  assert.equal(last.data.from, null);
  assert.equal(last.data.to, "dev5/t2");
  assert.equal(last.by, "panel");
});

test("applyAgent(null) 解除关联，但不会把 space 关联凭空恢复", () => {
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const r = applyAgent(linked, { agent: null, at: T0 + 2 });
  assert.equal(r.item.agent, undefined, "解除后不该留着空对象");
  assert.deepEqual(r.item.spaces, []);
});

test("挂 space 关联会解除 agent 关联（反向互斥）", () => {
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const r = applySpaces(linked, { spaces: ["spB"], at: T0 + 2 });
  assert.deepEqual(r.item.spaces, ["spB"]);
  assert.equal(r.item.agent, undefined, "挂了 space 就不能再留着 agent 关联");
  assert.deepEqual(kinds(r.events), ["agent", "spaces"]);
});

test("清空 space 关联不会顺手解除 agent（那是两件不同的事）", () => {
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const r = applySpaces(linked, { spaces: [], at: T0 + 2 });
  assert.deepEqual(r.item.agent, { address: "dev5/t2", space: "spA" });
});

test("同一个 agent 重复挂不产生新事件（幂等）", () => {
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const r = applyAgent(linked, { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 2 });
  assert.equal(r.events.length, 0, "同样的关联不该再记一条");
});

test("同一个 agent 换了 space：回退位置更新（那是真实变化）", () => {
  // 回退显示的位置在「关联当时」固定，是为了不让事项随 agent 搬家在 space 之间
  // 跳；但用户重新把它挂到同一个 agent 上时，那个「当时」就变成了现在，
  // 新的 space 才是对的。
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const r = applyAgent(linked, { agent: { address: "dev5/t2", space: "spB" }, at: T0 + 2 });
  assert.equal(r.item.agent.space, "spB");
  assert.deepEqual(kinds(r.events), ["agent"], "换 space 要留一条事件");
});

test("agent 形状不对时拒绝写入", () => {
  for (const bad of [{ address: "a" }, { space: "spA" }, { address: "", space: "spA" }, "dev5/t2", []]) {
    assert.throws(() => applyAgent(make(), { agent: bad, at: T0 + 1 }), /agent/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("事项对象不被就地修改：agent 深拷贝语义", () => {
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const snapshot = JSON.parse(JSON.stringify(linked));
  const r = applyAgent(linked, { agent: { address: "dev5/t2", space: "spB" }, at: T0 + 2 });
  assert.deepEqual(linked, snapshot, "原事项不该被就地修改");
  assert.deepEqual(r.item.agent, { address: "dev5/t2", space: "spB" });
});

// ---------- applyMove（拖拽：从一个 space 挪到另一个） ----------

test("applyMove 从 spA 拖到 spB：去掉来源、加上目标，一次写完成", () => {
  const { item, events } = applyMove(make(), { from: "spA", to: "spB", by: "panel", at: T0 + 1 });
  assert.deepEqual(item.spaces, ["spB"], "移动是替换来源，不是双关联");
  const last = events.at(-1);
  assert.equal(last.kind, "spaces");
  assert.deepEqual(last.data.from, ["spA"]);
  assert.deepEqual(last.data.to, ["spB"]);
  assert.equal(last.by, "panel");
});

test("applyMove 不改动原事项（纯函数）", () => {
  const it = make();
  applyMove(it, { from: "spA", to: "spB", at: T0 + 1 });
  assert.deepEqual(it.spaces, ["spA"], "原事项不能被就地改掉");
});

test("applyMove 只移除被拖出的那一组，其它 space 关联保留", () => {
  const it = make({ spaces: ["spA", "spC"] });
  const r = applyMove(it, { from: "spA", to: "spB", at: T0 + 1 });
  assert.deepEqual([...r.item.spaces].sort(), ["spB", "spC"]);
});

test("applyMove 到未关联（to=null）只移除来源", () => {
  const it = make({ spaces: ["spA", "spC"] });
  const r = applyMove(it, { from: "spA", to: null, at: T0 + 1 });
  assert.deepEqual(r.item.spaces, ["spC"]);
});

test("applyMove 来源为 null（从未关联组拖到某个 space）只做新增", () => {
  const it = make({ spaces: [] });
  const r = applyMove(it, { from: null, to: "spB", at: T0 + 1 });
  assert.deepEqual(r.item.spaces, ["spB"]);
});

test("applyMove 落到 space 上会解除 agent 关联（互斥不变量）", () => {
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const r = applyMove(linked, { from: null, to: "spB", at: T0 + 2 });
  assert.deepEqual(r.item.spaces, ["spB"]);
  assert.equal(r.item.agent, undefined, "挂了 space 就不能再留着 agent 关联");
});

test("applyMove 挪到未关联不会顺手解除 agent（那是另一件事）", () => {
  const linked = applyAgent(make(), { agent: { address: "dev5/t2", space: "spA" }, at: T0 + 1 }).item;
  const r = applyMove(linked, { from: "spZ", to: null, at: T0 + 2 });
  assert.deepEqual(r.item.agent, { address: "dev5/t2", space: "spA" });
});

test("applyMove 目标与来源相同：幂等，不产生新事件", () => {
  const r = applyMove(make(), { from: "spA", to: "spA", at: T0 + 1 });
  assert.equal(r.events.length, 0);
  assert.deepEqual(r.item.spaces, ["spA"]);
});

test("applyMove 拖进已关联的 space：不重复添加", () => {
  const it = make({ spaces: ["spA", "spB"] });
  const r = applyMove(it, { from: "spA", to: "spB", at: T0 + 1 });
  assert.deepEqual(r.item.spaces, ["spB"]);
});

test("chain 组合出的事件顺序与旧实现一致（摘来源再落目标）", () => {
  // CLI 的 move 是「依次摘来源再落目标」：一次命令摘两个死来源、再落到目标，
  // 恰好产生三条 spaces 事件——与迁移前的 moveSpace 逐步调用完全一致。
  const r = chain(make({ spaces: ["spDEAD1", "spDEAD2", "spB"] }), [
    [applyMove, { from: "spDEAD1", to: null, at: T0 + 1 }],
    [applyMove, { from: "spDEAD2", to: null, at: T0 + 1 }],
    [applyMove, { from: null, to: "spC", at: T0 + 1 }],
  ]);
  assert.deepEqual([...r.item.spaces].sort(), ["spB", "spC"]);
  assert.deepEqual(kinds(r.events), ["spaces", "spaces", "spaces"]);
});

test("规则层错误类型是 TodoError，带稳定的 code", () => {
  const err = (() => {
    try {
      applyStatus(make(), { status: "nope", at: T0 });
    } catch (e) {
      return e;
    }
    return null;
  })();
  assert.ok(err instanceof TodoError);
  assert.equal(err.code, "invalid");

  const done = applyStatus(make(), { status: "done", at: T0 + 1 }).item;
  try {
    applyStatus(done, { status: "todo", at: T0 + 2 });
    assert.fail("应当抛出");
  } catch (e) {
    assert.equal(e.code, "needs_reopen");
  }
});
