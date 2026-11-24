// 侧栏待办分组的可观察行为。
//
// 这些断言只喂公开输入（账本 + space 列表）并检查输出分组，不触碰渲染，
// 所以内部怎么排序、怎么建 Map 都不会让它们变红；而「归档项又冒出来」
// 「一条在多个 space 各出现一次」「关联全失效的进孤儿组」都是用户能看见的
// 行为变化，必须红。
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveSidebar, deriveAgents, isDropBackToSelf } from "../mod/spaces/todo-view.js";

const SPACES = [
  { id: "spA", name: "A" },
  { id: "spB", name: "B" },
  { id: "spC", name: "C" },
];

function item(id, over = {}) {
  return {
    id,
    title: id,
    note: "",
    priority: over.priority ?? "P2",
    status: over.status ?? "todo",
    spaces: over.spaces ?? [],
    created: 1,
    updated: over.updated ?? 1,
    ...(over.agent != null ? { agent: over.agent } : {}),
    ...(over.archived != null ? { archived: over.archived } : {}),
    timeline: [],
  };
}

const ids = (list) => list.map((i) => i.id);

// ---------- 关联到 agent ----------
//
// 一条事项要么关联 space，要么关联一个 agent（用户 2026-11-19 的决定）。
// 关联当时就把 space 存进 agent.space：agent 关掉后没有 API 能反查它属于哪个
// space，这个值既是侧栏归组的依据，也是 agent.space 搬家后位置不跳的保证。
//
// 用户 2026-11-24 补充：绑定 agent 的待办**也**显示在 Spaces 侧栏对应 space 下。
// 所以两个视图都收它——侧栏按 agent.space 归组，Agents 栏按地址挂在 agent 名下。
// 这是同一批事的两种看法，不是重复计数；deriveSidebar 因此不再需要 agent 列表。

const AGENTS = [
  { address: "dev5/t2", space: "spA", name: "claude" },
  { address: "dev8/t1", space: "spB", name: "claude" },
];

test("关联活着 agent 的事项也显示在它 agent.space 对应的 space 组下", () => {
  const it = item("t1", { agent: { address: "dev5/t2", space: "spA" } });
  const g = deriveSidebar({ items: [it] }, SPACES);
  assert.deepEqual(ids(g.spaces[0].open), ["t1"], "应出现在它 agent 所在的 spA");
  assert.deepEqual(ids(g.unlinked.open), [], "关联了 agent 就不算未关联");
  // 不应落到别的 space 组，也不应进孤儿组。
  assert.deepEqual(ids(g.spaces[1].open), []);
  assert.deepEqual(ids(g.orphans.open), []);
});

test("agent 已关掉：仍按关联当时的 space 显示在侧栏", () => {
  const it = item("t1", { agent: { address: "dev5/gone", space: "spB" } });
  const g = deriveSidebar({ items: [it] }, SPACES);
  assert.deepEqual(ids(g.spaces[1].open), ["t1"], "应显示在 spB");
  assert.deepEqual(ids(g.unlinked.open), []);
});

test("agent 关掉且它当时的 space 也没了：进孤儿组", () => {
  const it = item("t1", { agent: { address: "dev5/gone", space: "spGone" } });
  const g = deriveSidebar({ items: [it] }, SPACES);
  assert.deepEqual(ids(g.orphans.open), ["t1"]);
  assert.deepEqual(g.spaces.flatMap((s) => ids(s.open)), []);
});

// 「agent 搬家后侧栏不跟着跳」的口径在派生层结构上不可观测：deriveSidebar 只接
// (state, knownSpaces)，根本读不到 agent 当前所在 space。喂一个恒等输入再断言它
// 「没跟到 spB」是恒绿的空壳。真正的防线在 tests/mod-runtime.test.js：它把真实
// todoGroups() 的 agents() 故意放到 spB、item.agent.space 留 spA，断言仍显示 spA。
// 这里只保留纯数据层能证伪的那条：第三参不许再被赋予「归组」含义。

test("deriveSidebar 不需要 agent 列表：传不传结果一样", () => {
  // 旧实现靠 knownAgents 判断「agent 是否活着」来决定隐藏与否；现在归组只认
  // agent.space，多传一个参数不该改变结果。这里故意让第三参里的 agent **当前**
  // 在 spB（事项记下的是 spA）：若有人把第三参重新接回归组逻辑，两参/三参结果
  // 就会不同，这条会红——它是「活 agent 事项侧栏不列」旧口径在纯数据层的哨兵。
  const st = { items: [item("t1", { agent: { address: "dev5/t2", space: "spA" } })] };
  const moved = [{ address: "dev5/t2", space: "spB", name: "claude" }];
  const a = deriveSidebar(st, SPACES);
  const b = deriveSidebar(st, SPACES, moved);
  assert.deepEqual(b, a);
  // 同时钉住归组结果本身：仍按事项记下的 spA，不跟到第三参的 spB。
  assert.deepEqual(ids(a.spaces[0].open), ["t1"]);
  assert.deepEqual(ids(a.spaces[1].open), []);
});

test("deriveAgents：每个 agent 名下只有关联到它的事项", () => {
  const a = item("t1", { agent: { address: "dev5/t2", space: "spA" } });
  const b = item("t2", { agent: { address: "dev8/t1", space: "spB" }, status: "doing" });
  const c = item("t3", { spaces: ["spA"] });
  const g = deriveAgents({ items: [a, b, c] }, AGENTS);
  assert.deepEqual(ids(g.get("dev5/t2").open), ["t1"]);
  assert.deepEqual(ids(g.get("dev8/t1").open), ["t2"]);
  assert.equal(g.has("t3"), false, "没关联 agent 的事项不出现在任何 agent 下");
});

/**
 * 整体不变量：一条事项在侧栏**至少**出现一次，活着的 agent 还在 Agents 栏再出现一次。
 *
 * 用户要的就是「两个视图都看得到」：侧栏按 space 归组、Agents 栏按 agent 归组，
 * 同一条事各出现一次是刻意的。这条测试守的是「任何状态下都不会两个视图都看不见」——
 * 例如 deriveSidebar 把 agent 事项吞掉、deriveAgents 又因地址不匹配把它丢掉，
 * 两个函数单测都过，用户却哪儿都看不到。三种状态各验一遍。
 */
test("不变量：每条 agent 事项在侧栏绝不丢失，活 agent 时两视图各出现一次", () => {
  const cases = [
    ["agent 活着", { address: "dev5/t2", space: "spA" }, 2],
    ["agent 关了、space 还在", { address: "dev5/gone", space: "spA" }, 1],
    ["agent 关了、space 也没了", { address: "dev5/gone", space: "spGone" }, 1],
  ];
  for (const [name, agent, want] of cases) {
    const st = { items: [item("t1", { agent })] };
    const g = deriveSidebar(st, SPACES);
    const sidebar = [
      ...ids(g.unlinked.open),
      ...ids(g.orphans.open),
      ...g.spaces.flatMap((s) => ids(s.open)),
    ];
    const agBar = [...deriveAgents(st, AGENTS).values()].flatMap((b) => ids(b.open));
    assert.deepEqual(sidebar, ["t1"], `${name}：侧栏应恰好出现一次，实际 ${JSON.stringify(sidebar)}`);
    assert.equal(sidebar.length + agBar.length, want, `${name}：两视图合计出现次数`);
  }
});

test("不变量：已完成与已归档的口径在两个视图里一致", () => {
  const st = {
    items: [
      item("live", { agent: { address: "dev5/t2", space: "spA" }, status: "done" }),
      item("arch", { agent: { address: "dev5/t2", space: "spA" }, archived: 9 }),
    ],
  };
  const g = deriveSidebar(st, SPACES);
  const ag = deriveAgents(st, AGENTS).get("dev5/t2");
  // 活 agent 的已完成事项：侧栏收在 spA 的 closed 里，Agents 栏也收在 closed 里。
  assert.deepEqual(ids(g.spaces[0].closed), ["live"]);
  assert.deepEqual(ids(g.orphans.closed), []);
  assert.deepEqual(ids(ag.closed), ["live"]);
  // 归档项两边都不出现。
  assert.deepEqual(ids(g.spaces[0].open), []);
  assert.deepEqual(ids(ag.open), []);
  assert.ok(!ag.closed.some((i) => i.id === "arch"));
});

test("未关联事项进 unlinked，且不落在任何 space 组", () => {
  const g = deriveSidebar({ items: [item("t1")] }, SPACES);
  assert.deepEqual(ids(g.unlinked.open), ["t1"]);
  for (const s of g.spaces) assert.deepEqual(ids(s.open), []);
});

test("一个事项关联多个 space 时，在每个组各出现一次", () => {
  const g = deriveSidebar({ items: [item("t1", { spaces: ["spA", "spB"] })] }, SPACES);
  assert.deepEqual(ids(g.spaces[0].open), ["t1"]);
  assert.deepEqual(ids(g.spaces[1].open), ["t1"]);
  assert.deepEqual(ids(g.spaces[2].open), []);
});

test("空 space 仍然返回一个空组（不是缺项）", () => {
  const g = deriveSidebar({ items: [] }, SPACES);
  assert.equal(g.spaces.length, 3);
  for (const s of g.spaces) {
    assert.deepEqual(ids(s.open), []);
    assert.deepEqual(ids(s.closed), []);
  }
});

test("归档项不进任何组，也不计入已完成", () => {
  const g = deriveSidebar(
    { items: [item("t1", { spaces: ["spA"], archived: 5 }), item("t2", { spaces: ["spA"] })] },
    SPACES,
  );
  assert.deepEqual(ids(g.spaces[0].open), ["t2"]);
  assert.deepEqual(ids(g.spaces[0].closed), []);
  assert.deepEqual(ids(g.unlinked.open), []);
});

test("已完成/已取消单独成列，不混进开放行", () => {
  const g = deriveSidebar(
    {
      items: [
        item("t1", { spaces: ["spA"] }),
        item("t2", { spaces: ["spA"], status: "done" }),
        item("t3", { spaces: ["spA"], status: "cancelled" }),
      ],
    },
    SPACES,
  );
  assert.deepEqual(ids(g.spaces[0].open), ["t1"]);
  assert.deepEqual(new Set(ids(g.spaces[0].closed)), new Set(["t2", "t3"]));
});

test("关联的 space 全部不存在时进孤儿组，且不出现在任何 space 组", () => {
  const g = deriveSidebar({ items: [item("t1", { spaces: ["gone"] })] }, SPACES);
  assert.deepEqual(ids(g.orphans.open), ["t1"]);
  for (const s of g.spaces) assert.deepEqual(ids(s.open), []);
});

test("部分关联失效：有落脚处就不重复进孤儿组", () => {
  const g = deriveSidebar({ items: [item("t1", { spaces: ["gone", "spB"] })] }, SPACES);
  assert.deepEqual(ids(g.spaces[1].open), ["t1"]);
  assert.deepEqual(ids(g.orphans.open), []);
});

test("组内排序：进行中先于待办，同级看优先级", () => {
  const g = deriveSidebar(
    {
      items: [
        item("todoP2", { spaces: ["spA"], status: "todo", priority: "P2" }),
        item("doingP3", { spaces: ["spA"], status: "doing", priority: "P3" }),
        item("todoP0", { spaces: ["spA"], status: "todo", priority: "P0" }),
      ],
    },
    SPACES,
  );
  assert.deepEqual(ids(g.spaces[0].open), ["doingP3", "todoP0", "todoP2"]);
});

test("坏输入不炸：items 缺失或 space 列表缺失时返回空结构", () => {
  assert.deepEqual(deriveSidebar({}, SPACES).unlinked, { open: [], closed: [] });
  const g = deriveSidebar({ items: [item("t1")] }, undefined);
  assert.deepEqual(ids(g.unlinked.open), ["t1"]);
  assert.deepEqual(g.spaces, []);
});

// ---------- 投放端「落回自己组＝取消」的判定 ----------
//
// 问的是「手势的来源组」，不是「事项是否也显示在该组」。后者对多 space 事项会
// 把一次合法的「从 A 组拖到 B 行（从 A 移走、留在 B）」静默吃掉（O15 回归）。

test("isDropBackToSelf：space 来源放回原组＝取消，拖到别的 space＝不取消", () => {
  const from = { kind: "space", key: "spA", spaces: ["spA"] };
  assert.equal(isDropBackToSelf({ from }, item("t1", { spaces: ["spA"] }), "spA"), true);
  assert.equal(isDropBackToSelf({ from }, item("t1", { spaces: ["spA"] }), "spB"), false);
});

test("isDropBackToSelf：多 space 事项从 spA 拖到 spB，不取消（合法移走）", () => {
  const it = item("m1", { spaces: ["spA", "spB"] });
  const from = { kind: "space", key: "spA", spaces: ["spA"] };
  // 事项确实也显示在 spB，但那不是「拿起又放回」——这次拖拽要把 spA 摘掉。
  assert.equal(isDropBackToSelf({ from }, it, "spA"), true, "放回 spA 才算取消");
  assert.equal(isDropBackToSelf({ from }, it, "spB"), false, "拖到 spB 必须正常 move");
});

test("isDropBackToSelf：agent 来源按 agent.space 判，含从 Agents 栏拖来", () => {
  const it = item("a1", { agent: { address: "dev5/t2", space: "spA" } });
  const from = { kind: "agent", key: "dev5/t2", spaces: [] };
  assert.equal(isDropBackToSelf({ from }, it, "spA"), true, "放回自己 agent.space＝取消");
  assert.equal(isDropBackToSelf({ from }, it, "spB"), false, "拖到别的 space 正常 move");
  // 事项找不到（并发删除）时退化成不取消，不静默吞掉合法投放。
  assert.equal(isDropBackToSelf({ from }, null, "spA"), false);
});

test("isDropBackToSelf：未关联 / 孤儿 / 坏手势 / 空目标都不取消", () => {
  assert.equal(isDropBackToSelf({ from: { kind: "unlinked", key: "unlinked" } }, item("t1"), "spA"), false);
  assert.equal(isDropBackToSelf({ from: { kind: "orphan", key: "orphan" } }, item("t1"), "spA"), false);
  assert.equal(isDropBackToSelf(null, item("t1"), "spA"), false);
  assert.equal(isDropBackToSelf({ from: { kind: "space", key: "spA" } }, item("t1"), null), false);
});
