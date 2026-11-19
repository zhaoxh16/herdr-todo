// 侧栏待办分组的可观察行为。
//
// 这些断言只喂公开输入（账本 + space 列表）并检查输出分组，不触碰渲染，
// 所以内部怎么排序、怎么建 Map 都不会让它们变红；而「归档项又冒出来」
// 「一条在多个 space 各出现一次」「关联全失效的进孤儿组」都是用户能看见的
// 行为变化，必须红。
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveSidebar, deriveAgents } from "../mod/spaces/todo-view.js";

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
// agent 关掉之后没有 API 能反查它属于哪个 space，所以关联当时就把 space 存进
// agent.space；它只用于回退显示，不是「同时关联了那个 space」。

const AGENTS = [
  { address: "dev5/t2", space: "spA", name: "claude" },
  { address: "dev8/t1", space: "spB", name: "claude" },
];

test("关联活着 agent 的事项不进任何 space 组", () => {
  const it = item("t1", { agent: { address: "dev5/t2", space: "spA" } });
  const g = deriveSidebar({ items: [it] }, SPACES, AGENTS);
  assert.deepEqual(ids(g.spaces[0].open), [], "不该出现在它 agent 所在的 spA");
  assert.deepEqual(ids(g.unlinked.open), [], "关联了 agent 就不算未关联");
});

test("agent 已关闭：回退显示在它当时所在的 space", () => {
  const it = item("t1", { agent: { address: "dev5/gone", space: "spB" } });
  const g = deriveSidebar({ items: [it] }, SPACES, AGENTS);
  assert.deepEqual(ids(g.spaces[1].open), ["t1"], "应回退到 spB");
  assert.deepEqual(ids(g.unlinked.open), []);
});

test("agent 关闭且它当时的 space 也没了：进孤儿组", () => {
  const it = item("t1", { agent: { address: "dev5/gone", space: "spGone" } });
  const g = deriveSidebar({ items: [it] }, SPACES, AGENTS);
  assert.deepEqual(ids(g.orphans.open), ["t1"]);
  assert.deepEqual(g.spaces.flatMap((s) => ids(s.open)), []);
});

test("agent 从 spA 搬到 spB 后仍然只挂在 agent 上，不落到 space 组", () => {
  // 回退位置在「关联当时」就固定下来了；agent 之后换 space 不改它，
  // 否则同一条事项会随着 agent 移动在两个 space 之间跳。
  const it = item("t1", { agent: { address: "dev5/t2", space: "spA" } });
  const moved = [{ address: "dev5/t2", space: "spB", name: "claude" }, AGENTS[1]];
  const g = deriveSidebar({ items: [it] }, SPACES, moved);
  assert.deepEqual(g.spaces.flatMap((s) => ids(s.open)), [], "agent 还活着就不该出现在任何 space 组");
  assert.deepEqual(ids(g.unlinked.open), []);
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
 * 整体不变量：一条事项在「侧栏 + Agents 栏」里恰好出现一次。
 *
 * 这是两个视图各自看起来都对、合起来却会重复或丢失的唯一防线——例如
 * deriveSidebar 让活 agent 的事项 hidden、deriveAgents 又因为地址不匹配
 * 把它丢掉，两个函数单测都过，用户却看不见那条待办。三种状态各验一遍。
 */
test("不变量：每条事项在侧栏与 Agents 栏合计恰好出现一次", () => {
  const cases = [
    ["agent 活着", { address: "dev5/t2", space: "spA" }],
    ["agent 关了、space 还在", { address: "dev5/gone", space: "spA" }],
    ["agent 关了、space 也没了", { address: "dev5/gone", space: "spGone" }],
  ];
  for (const [name, agent] of cases) {
    const st = { items: [item("t1", { agent })] };
    const g = deriveSidebar(st, SPACES, AGENTS);
    const sidebar = [
      ...ids(g.unlinked.open),
      ...ids(g.orphans.open),
      ...g.spaces.flatMap((s) => ids(s.open)),
    ];
    const agents = [...deriveAgents(st, AGENTS).values()].flatMap((b) => ids(b.open));
    const all = [...sidebar, ...agents];
    assert.deepEqual(all, ["t1"], `${name}：应恰好出现一次，实际 ${JSON.stringify(all)}`);
  }
});

test("不变量：已完成与已归档的口径在两个视图里一致", () => {
  const st = {
    items: [
      item("live", { agent: { address: "dev5/t2", space: "spA" }, status: "done" }),
      item("arch", { agent: { address: "dev5/t2", space: "spA" }, archived: 9 }),
    ],
  };
  const g = deriveSidebar(st, SPACES, AGENTS);
  const ag = deriveAgents(st, AGENTS).get("dev5/t2");
  // 活 agent 的已完成事项：侧栏不列（hidden），Agents 栏收在 closed 里。
  assert.deepEqual(ids(g.spaces.flatMap((s) => s.closed)), []);
  assert.deepEqual(ids(ag.closed), ["live"]);
  // 归档项两边都不出现。
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
