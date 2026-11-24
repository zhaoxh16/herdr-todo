// 克隆件（spaces-todo / menu-todo / tabs-todo）的运行时行为测试。
//
// 为什么需要这一组：这些文件是 App 自带 mod 的克隆件，改动零散地内联在上游正文里
// （import、菜单项、图标分支、choose 分支、右键菜单回退）。只靠「源码里有没有某段文本」
// 的断言挡不住真的坏法——删掉一行 import 或一行取 target，该出现的关键字全都还在源码里，
// 而 `herdr-app check` 也不报错（menu 的 choose() 不被 check 执行；spaces 的 checking()
// 让探测整段短路）。症状要等用户真点了才出现：ReferenceError，或者点了没反应。
//
// 所以这里把克隆件接上假的宿主模块，真的实例化、真的调用，断言**可观察结果**：
// 右键菜单打开哪个 mod、点 CodeBuddy 后发的是什么 exec。
//
// 宿主模块（`herdr` / `gpui-kit` / `gpui-base`）在 Node 里不存在，所以把 mod 目录复制到
// 临时位置，把 import 换成替身（与 tests/codebuddy.test.js 同一手法）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 一个「什么都能链」的假元素：上游 render 会往它身上挂几十个方法，我们只要求它不炸。
// `then` 返回 undefined，免得被当成 thenable。
const ELEMENT = `const el = new Proxy(function () {}, {
  get: (t, k) => (k === "then" ? undefined : el),
  apply: () => el,
});`;

// 假宿主。测试之间靠 globalThis.__hr 分享「当前世界」，每个 loadMod 重新建一个。
const HERDR_STUB = `
const s = globalThis.__hr ?? (globalThis.__hr = {});
s.spaces ??= []; s.panes ??= []; s.terminals ??= []; s.agents ??= [];
s.overlays ??= []; s.execs ??= []; s.runs ??= []; s.notes ??= [];
s.props ??= {}; s.files ??= {}; s.menuReads ??= 0; s.isChecking ??= false; s.closes ??= [];
export const spaces = () => s.spaces;
export const machines = () => [];
export const panes = () => s.panes;
export const terminals = () => s.terminals;
export const agents = () => s.agents;
export const run = (name, args) => { s.runs.push([name, args]); return null; };
export const props = () => s.props;
export const closeOverlay = (id) => { (s.closes ??= []).push(id); return null; };
export const openOverlay = (spec) => { s.overlays.push(spec); return "o1"; };
export const theme = () => ({ muted: "m", dim: "d", hover: "h", foreground: "f", border: "b", chrome: "c", raised: "r", selected: "s", working: "w" });
export const keys = () => [];
export const exec = async (cmd, args, opts) => { s.execs.push([cmd, args, opts]); return { code: 0, stdout: "", stderr: "" }; };
export const hc = async () => ({ code: 0, stdout: "", stderr: "" });
export const shared = () => null;
export const setShared = () => null;
// 测试里没有真实的文件监听：立刻拒绝，让上游 todoWatch 的 catch 分支接住。
export const watchFolder = () => { throw new Error("no watchers in tests"); };
export const window = () => ({ platform: "macos", buttons: false, titlebar: "none" });
export const layout = () => ({ children: [] });
export const settings = () => ({ zoom: 1 });
export const checking = () => s.isChecking;
export const appHome = () => s.appHome ?? "/tmp/herdr-app";
export const readTextFile = async (p) => { s.menuReads++; return (s.files ?? {})[p] ?? null; };
export const home = () => "/tmp/home";
export const notify = (n) => { s.notes.push(n); return "n1"; };
export const focused = () => null;
export const localStorage = { getItem: () => null, setItem: () => {} };
`;

const GPUI_KIT_STUB = `
export class View { constructor() {} }
${ELEMENT}
export const div = () => el, svg = () => el, image = () => el;`;

const GPUI_BASE_STUB = `
${ELEMENT}
export const v_flex = () => el, h_flex = () => el;
export const ScrollHandle = { new: () => ({ scroll_to_item() {} }) };`;

// 复制某个 mod 目录到临时位置，把三个宿主模块换成本文件的替身，然后加载它。
async function loadMod(dir, { herdr = HERDR_STUB, readTextFileFails = false, gpk = GPUI_KIT_STUB, base = GPUI_BASE_STUB } = {}) {
  const tmp = path.join("/tmp", `modtest-${dir}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmp, { recursive: true });
  for (const f of await fs.readdir(path.join(ROOT, "mod", dir))) {
    if (!f.endsWith(".js")) continue;
    let src = await fs.readFile(path.join(ROOT, "mod", dir, f), "utf8");
    src = src
      .replace(/from "herdr"/g, 'from "./__herdr.mjs"')
      .replace(/from "gpui-kit"/g, 'from "./__gpui-kit.mjs"')
      .replace(/from "gpui-base"/g, 'from "./__gpui-base.mjs"');
    await fs.writeFile(path.join(tmp, f), src);
  }
  let stub = herdr;
  if (readTextFileFails) {
    // 替换那一条导出：整份 stub 里已经有 readTextFile 了，不能再 declare 一次。
    stub = stub.replace(
      /^export const readTextFile = .*$/m,
      'export const readTextFile = async () => { throw new Error("EACCES"); };',
    );
    assert.notEqual(stub, herdr, "测试替身里应有 readTextFile 供替换");
  }
  await fs.writeFile(path.join(tmp, "__herdr.mjs"), stub);
  await fs.writeFile(path.join(tmp, "__gpui-kit.mjs"), gpk);
  await fs.writeFile(path.join(tmp, "__gpui-base.mjs"), base);
  globalThis.__hr = undefined; // 每个测试一份干净的世界
  const mod = await import(`${path.join(tmp, "main.js")}?v=${Math.random()}`);
  return { mod, s: globalThis.__hr };
}

// init 只需要这些：定时器与 spawn 不真跑（要让它们跑起来反倒会引入无关的异步）。
// 只让 init 里的同步部分跑起来。定时器与 spawn 里的异步取数在测试里没有意义，
// 而 spaces 的 todoWatch() 会 await watchFolder()——替身必须立刻 reject（目录不存在
// 就是真实情况），否则那条 for(;;) 会一直挂着，整个测试进程不肯退出。
const fakeCx = () => {
  const spawn = (fn) => {
    try {
      const r = fn({ ...fakeCx(), sleep: () => Promise.reject(new Error("no timers in tests")) });
      if (r?.catch) r.catch(() => {});
    } catch {}
  };
  return {
    focus_handle: () => ({ focus() {} }),
    spawn,
    sleep: () => new Promise(() => {}),
    timer: { every() {} },
    new: () => ({}),
    notify() {},
  };
};

function instance(mod) {
  const inst = Object.create(mod.default.prototype);
  inst.init = mod.default.prototype.init;
  return inst;
}

// 探测是异步的；让它跑完再断言。
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------- spaces-todo：右键菜单用哪个 mod ----------------
//
// 不跑完整的 init()：spaces 的 init 会起真实定时器、发起异步取数（本机与各远程机器的
// git 状态），在测试里既慢又不相关，还会让进程不肯退出。右键菜单的回退只依赖
// 「menuTodo 初值 + probeMenuTodo()」，所以单独跑这两步——它们正是修复的落点。
// 走真的 init()：`this.menuTodo = false` 与 `this.probeMenuTodo()` 都在里面，
// 测试自己手动调就会漏掉「有人在 init 里把这行删了」这种回归（复核实测过）。
// init 里的定时器由 fakeCx 接住、不真跑；spawn 里的异步取数会立即 reject 并被上游
// 的 catch 吃掉，所以这里既快也不会让进程挂住。
function spacesView(mod) {
  const inst = Object.create(mod.default.prototype);
  mod.default.prototype.init.call(inst, {}, fakeCx());
  return inst;
}

test("spaces-todo：menu-todo 装着时，右键菜单用它", async () => {
  const { mod, s } = await loadMod("spaces");
  s.files = {
    "/tmp/herdr-app/mods/menu-todo/main.js": "export default class Menu extends View {}",
    "/tmp/herdr-app/mods/menu-todo/codebuddy.js": "export async function openInCodeBuddy() {}",
  };
  const inst = spacesView(mod);
  await settle();
  inst.menu({ id: "sp1" });
  assert.equal(s.overlays.at(-1).mod, "menu-todo", "menu-todo 装着时应用它（那才多一条 CodeBuddy）");
});

test("spaces-todo：menu-todo 缺失时退回自带 menu", async () => {
  const { mod, s } = await loadMod("spaces");
  s.files = {}; // 读不到 = 没装
  const inst = spacesView(mod);
  await settle();
  inst.menu({ id: "sp1" });
  assert.equal(
    s.overlays.at(-1).mod,
    "menu",
    "menu-todo 缺失时必须用自带 menu；openOverlay 指向不存在的 mod 不报错也不显示，整个 space 菜单会静默失效",
  );
});

test("spaces-todo：读盘抛错时同样退回自带 menu", async () => {
  const { mod, s } = await loadMod("spaces", { herdr: HERDR_STUB, readTextFileFails: true });
  const inst = spacesView(mod);
  await settle();
  inst.menu({ id: "sp1" });
  assert.equal(s.overlays.at(-1).mod, "menu");
});

test("spaces-todo：探测还没回来时右键，用一定能用的自带 menu", async () => {
  const { mod, s } = await loadMod("spaces");
  s.files = { "/tmp/herdr-app/mods/menu-todo/main.js": "export default class Menu {}", "/tmp/herdr-app/mods/menu-todo/codebuddy.js": "export const x = 1;" };
  const inst = spacesView(mod);
  inst.menu({ id: "sp1" }); // 不 settle：模拟探测在飞
  assert.equal(s.overlays.at(-1).mod, "menu", "未探明前应退回自带 menu，而不是赌一个可能不存在的 mod");
});

test("spaces-todo：herdr-app check 下不做探测", async () => {
  const { mod, s } = await loadMod("spaces");
  s.isChecking = true;
  const inst = spacesView(mod);
  await settle();
  assert.equal(s.menuReads, 0, "checking() 为真时不该读盘（那时没有可信的安装目录）");
  inst.menu({ id: "sp1" });
  assert.equal(s.overlays.at(-1).mod, "menu");
});

// present-but-broken：文件在、但 mod 加载不了。复核实测过，空 main.js 的 mod 在
// herdr-app check 里报 "main.js must export default a class"，此时若判为「装着」，
// 右键菜单又会静默为空——正是这次要消除的症状。
test("spaces-todo：menu-todo 的 main.js 是空文件/纯注释时，退回自带 menu", async () => {
  for (const bad of ["", "   \n\n", "// 只有注释\n", "/* 块注释 */\n"]) {
    const { mod, s } = await loadMod("spaces");
    s.files = { "/tmp/herdr-app/mods/menu-todo/main.js": bad };
    const inst = spacesView(mod);
    await settle();
    inst.menu({ id: "sp1" });
    assert.equal(s.overlays.at(-1).mod, "menu", `main.js 内容为 ${JSON.stringify(bad)} 时应判为坏 mod`);
  }
});

test("spaces-todo：menu-todo 缺 codebuddy.js 时退回自带 menu", async () => {
  const { mod, s } = await loadMod("spaces");
  s.files = { "/tmp/herdr-app/mods/menu-todo/main.js": 'import "./codebuddy.js";\nexport default class Menu {}' };
  const inst = spacesView(mod);
  await settle();
  inst.menu({ id: "sp1" });
  assert.equal(s.overlays.at(-1).mod, "menu", "menu-todo 的 main.js 第一件事就是 import ./codebuddy.js，缺了它加载会失败");
});

// 绑定 agent 的事项也要显示在 Spaces 侧栏对应 space 下（用户 2026-11-24）。
// 归组依据是事项里记下的 agent.space，与 agents() 里那个 agent 现在活不活、在
// 哪个 space 都无关——所以 todoGroups() 不需要 agent 列表。这条走真实 mod 实例：
// 漏掉归组、或又退回按「活 agent 隐藏」的旧口径，这里会红。
test("spaces-todo：绑定 agent 的事项也落进它 agent.space 的 space 组", async () => {
  const { mod, s } = await loadMod("spaces");
  s.spaces = [{ id: "spA", name: "A" }];
  // 故意把 agent 列表里那个 agent 放到别的 space：侧栏归组不该跟着它走。
  s.agents = [{ address: "dev5/t2", space: "spB", title: "claude" }];
  const inst = spacesView(mod);
  inst.todoState = {
    items: [
      { id: "t1", title: "t1", note: "", priority: "P2", status: "todo", spaces: [], agent: { address: "dev5/t2", space: "spA" }, created: 1, updated: 1, timeline: [] },
    ],
  };
  const g = inst.todoGroups();
  assert.deepEqual(
    g.spaces.flatMap((x) => x.open.map((i) => i.id)),
    ["t1"],
    "应按事项里记下的 agent.space（spA）显示，而不是 agent 现在所在的 spB",
  );
  assert.deepEqual(g.unlinked.open, [], "关联了 agent 就不算未关联");
});

// 现在 agent 待办也会画在 space 组里，而这些事项数据上的关联是 agent（spaces 为
// 空数组）。拖动源若照抄组的 kind:"space"，拖到「未关联」会走 move --from <space>，
// applyMove 对没有 space 关联的事项是空操作——用户看到「拖了没反应」。按下时写进
// shared 的 from 必须是 kind:"agent"，todoMove 才会走解除 agent 关联那条正确路径。
// 这条真的按下一条 agent 待办行，断言写入的手势形态。
test("spaces-todo：侧栏里的 agent 待办行按 agent 来源拖动（不是 space 来源）", async () => {
  const herdr = HERDR_STUB.replace(
    /^export const setShared = .*$/m,
    "export const setShared = (k, v) => { (globalThis.__hr.setShares ??= []).push([k, v]); return null; };",
  ) + `
// 记下 todoRow 挂的 on_mouse_down 回调，按元素 id 区分。
`;
  // 用一个会记录 on_mouse_down 的元素替身；其余仍是「什么都能链」的 Proxy。
  const base = `
const el = new Proxy(function () {}, {
  get: (t, k) => {
    if (k === "then") return undefined;
    if (k === "on_mouse_down") return (...a) => {
      const fn = a.filter((x) => typeof x === "function").at(-1);
      (globalThis.__downs ??= []).push([globalThis.__cur ?? null, fn]);
      return el;
    };
    if (k === "id") return (v) => { globalThis.__cur = v; return el; };
    return el;
  },
  apply: () => el,
});
export const v_flex = () => el, h_flex = () => el;
export const ScrollHandle = { new: () => ({ scroll_to_item() {} }) };`;
  // 记录用的是裸全局（不在 __hr 里），loadMod 不会重置，测试自己先清干净，
  // 免得别的用例先跑过时留下旧回调让 .find 命中错的那一个。
  globalThis.__downs = [];
  globalThis.__cur = null;
  const { mod } = await loadMod("spaces", { herdr, base, gpk: GPUI_KIT_STUB });
  const inst = Object.create(mod.default.prototype);
  inst.todoDrag = null;
  const it = { id: "t1", title: "t1", status: "todo", priority: "P2", spaces: [], agent: { address: "dev5/t2", space: "spA" }, updated: 1 };
  // src 是「它显示在的 space 组」，与真实 row 包装里传的一致。
  inst.todoRow(it, {}, { kind: "space", key: "spA", spaces: ["spA"] }, 30);
  const down = (globalThis.__downs ?? []).find(([, fn]) => typeof fn === "function");
  assert.ok(down, "todoRow 应挂 on_mouse_down");
  down[1]();
  const share = (globalThis.__hr.setShares ?? []).at(-1);
  assert.ok(share, "按下应写一次 shared 手势");
  assert.equal(share[0], "todo.drag");
  assert.equal(share[1].from.kind, "agent", "agent 待办必须按 agent 来源拖动");
  assert.equal(share[1].from.key, "dev5/t2");
});

// 绑定 agent 的事项现在也显示在侧栏的 agent.space 组里，而它的手势来源被改成
// kind:"agent"。投放端若仍只认「from.kind === space」的自投放豁免，把这条待办
// 拿起又放回自己那一行就会执行 move → applyMove 的 dropAgent，静默把 agent 关联
// 换成 space 关联（Agents 栏那条随之消失）。这两条真的调用 todoDropTo/todoDropReady：
// 落回自己组必须零写命令，落到别的 space 仍要正常 move（别把合法投放也吃掉）。
// shared 用手写的可变状态，让 readDrag() 能读到手势；exec 由替身记录。
const DROP_HERDR = `
const s = globalThis.__hr ?? (globalThis.__hr = {});
s.spaces ??= []; s.panes ??= []; s.terminals ??= []; s.agents ??= [];
s.overlays ??= []; s.execs ??= []; s.runs ??= []; s.notes ??= [];
s.props ??= {}; s.files ??= {}; s.menuReads ??= 0; s.isChecking ??= false; s.closes ??= [];
s.shared ??= null;
export const spaces = () => s.spaces;
export const machines = () => [];
export const panes = () => s.panes;
export const terminals = () => s.terminals;
export const agents = () => s.agents;
export const run = (name, args) => { s.runs.push([name, args]); return null; };
export const props = () => s.props;
export const closeOverlay = (id) => { (s.closes ??= []).push(id); return null; };
export const openOverlay = (spec) => { s.overlays.push(spec); return "o1"; };
export const theme = () => ({ muted: "m", dim: "d", hover: "h", foreground: "f", border: "b", chrome: "c", raised: "r", selected: "s", working: "w", accent: "a" });
export const keys = () => [];
export const exec = async (cmd, args, opts) => { s.execs.push([cmd, args, opts]); return { code: 0, stdout: "", stderr: "" }; };
export const hc = async () => ({ code: 0, stdout: "", stderr: "" });
export const shared = (k) => s.shared;
export const setShared = (k, v) => { s.shared = v; return null; };
export const watchFolder = () => { throw new Error("no watchers in tests"); };
export const window = () => ({ platform: "macos", buttons: false, titlebar: "none" });
export const layout = () => ({ children: [] });
export const settings = () => ({ zoom: 1 });
export const checking = () => s.isChecking;
export const appHome = () => s.appHome ?? "/tmp/herdr-app";
export const readTextFile = async (p) => { s.menuReads++; return (s.files ?? {})[p] ?? null; };
export const home = () => "/tmp/home";
export const notify = (n) => { s.notes.push(n); return "n1"; };
export const focused = () => null;
export const localStorage = { getItem: () => null, setItem: () => {} };
`;

async function dropSetup() {
  const { mod, s } = await loadMod("spaces", { herdr: DROP_HERDR });
  const inst = Object.create(mod.default.prototype);
  const it = { id: "t1", title: "t1", status: "todo", priority: "P2", spaces: [], agent: { address: "dev5/t2", space: "spA" }, created: 1, updated: 1, timeline: [] };
  inst.todoState = { items: [it] };
  // 手势就是 todoRow 对 agent 事项实际写入的形态（见上一条测试）。
  const drag = { id: "t1", title: "t1", from: { kind: "agent", key: "dev5/t2", spaces: [] }, at: Date.now() };
  inst.todoDrag = drag;
  s.shared = drag;
  return { mod, s, inst, it };
}

test("spaces-todo：agent 待办拖回它显示的 space 行＝取消，不写盘", async () => {
  const { s, inst } = await dropSetup();
  const cx = { notify() {}, spawn() {} };
  // 高亮也不该把这一行画成合法投放目标（界面主动诱导该手势是缺陷的一部分）。
  assert.equal(inst.todoDropReady("spA"), false, "自己所在组不该亮成投放目标");
  assert.equal(inst.todoDropReady("spB"), true, "别的 space 仍是合法投放目标");
  inst.todoDropTo("spA", cx);
  assert.equal(s.execs.length, 0, "落回自己组不该发任何写命令（否则会静默改写 agent 关联）");
  assert.equal(s.shared, null, "取消也要清掉 shared 手势");
});

test("spaces-todo：agent 待办拖到别的 space 行仍正常 move", async () => {
  const { s, inst } = await dropSetup();
  const cx = { notify() {}, spawn(fn) {
    // todoMove 用 cx.spawn 跑异步写；这里同步接住它以便断言 exec 记录。
    try { const r = fn({ ...cx, sleep: () => new Promise(() => {}) }); r?.catch?.(() => {}); } catch {}
  } };
  inst.todoDropTo("spB", cx);
  await settle();
  const write = s.execs.find(([, args]) => Array.isArray(args) && args.includes("move"));
  assert.ok(write, "拖到别的 space 应发 move 命令，不能被自投放判定误吃");
  assert.ok(write[1].includes("spB"), "目标应是 spB");
});

// O15 回归：多 space 事项从 spA 组拖到 spB 行是一次合法的「从 spA 移走、留在
// spB」（applyMove from=spA to=spB）。它确实也显示在 spB，但不是「拿起又放回」，
// 按「是否显示在该组」判会把它静默吃掉。这里真的调 todoDropTo 确认仍写盘。
test("spaces-todo：多 space 事项从 spA 拖到 spB 仍正常 move --from", async () => {
  const { mod, s } = await loadMod("spaces", { herdr: DROP_HERDR });
  const inst = Object.create(mod.default.prototype);
  const it = { id: "m1", title: "m1", status: "todo", priority: "P2", spaces: ["spA", "spB"], created: 1, updated: 1, timeline: [] };
  inst.todoState = { items: [it] };
  const drag = { id: "m1", title: "m1", from: { kind: "space", key: "spA", spaces: ["spA"] }, at: Date.now() };
  inst.todoDrag = drag;
  s.shared = drag;
  const cx = { notify() {}, spawn(fn) {
    try { const r = fn({ ...cx, sleep: () => new Promise(() => {}) }); r?.catch?.(() => {}); } catch {}
  } };
  assert.equal(inst.todoDropReady("spB"), true, "spB 是合法投放目标，不该被误排除");
  inst.todoDropTo("spB", cx);
  await settle();
  const write = s.execs.find(([, args]) => Array.isArray(args) && args.includes("move"));
  assert.ok(write, "从 spA 拖到 spB 必须写 move，不能被自投放判定静默吃掉");
  assert.ok(write[1].includes("--from=spA"), "应带 --from=spA 摘掉来源组");
  assert.ok(write[1].includes("spB"), "目标应是 spB");
  // 放回 spA 仍是取消。
  s.shared = drag; inst.todoDrag = drag; s.execs.length = 0;
  inst.todoDropTo("spA", { notify() {}, spawn() {} });
  assert.equal(s.execs.length, 0, "放回 spA 才算取消");
});

// ---------------- menu-todo：CodeBuddy 菜单项与点击行为 ----------------

// 菜单项顺序由 items() 决定，不在测试里硬编码下标：逐个点下去，用「exec 的参数」认出
// CodeBuddy 那一次。注意不能拿「有没有 exec」当判据——init 时 checkout() 会跑 git。
// 返回该次 exec 的 args，没有则 null。
async function clickUntilOpens(inst, s, want) {
  for (let i = 0; i < 10; i++) {
    s.execs.length = 0;
    s.runs.length = 0;
    try {
      inst.choose(i, fakeCx());
    } catch (e) {
      assert.fail(`点第 ${i} 项时抛错：${e.message}——菜单项分发坏了`);
    }
    await settle();
    const hit = s.execs.find(([, args]) => JSON.stringify(args) === JSON.stringify(want));
    if (hit) {
      assert.deepEqual(
        s.runs.filter(([name]) => name === "codebuddy"),
        [],
        '不许落到 run("codebuddy")——宿主没这个命令，表现为点了没反应',
      );
      return hit;
    }
  }
  return null;
}

test("menu-todo：点「用 CodeBuddy 打开」用该 space 第一个终端的 cwd 打开", async () => {
  const { mod, s } = await loadMod("menu");
  s.props = { tab: "space", target: { id: "sp1" }, overlay: "o9" };
  s.spaces = [{ id: "sp1", machine: null, folder: "/repo", tabs: [{ id: "tb" }] }];
  s.panes = [{ tab: "tb", cwd: "/repo/sub" }];

  const inst = instance(mod);
  inst.init({}, fakeCx());

  const hit = await clickUntilOpens(inst, s, ["/repo/sub"]);
  assert.ok(hit, "space 菜单里应有一项用 /repo/sub 打开（CodeBuddy）");
  assert.equal(s.execs.length, 1, "点一次只该发一次 exec");
});

test("menu-todo：远程 space 传的是 remote-ssh 的 folder-uri", async () => {
  const { mod, s } = await loadMod("menu");
  s.props = { tab: "space", target: { id: "s2" }, overlay: "o9" };
  s.spaces = [{ id: "s2", machine: "dev8", folder: "/data/ws", tabs: [] }];
  s.panes = [];

  const inst = instance(mod);
  inst.init({}, fakeCx());

  const want = ["--folder-uri", "vscode-remote://codebuddy-remote-ssh+dev8/data/ws"];
  const hit = await clickUntilOpens(inst, s, want);
  assert.ok(hit, "远程 space 菜单里应有一项用 remote-ssh 的 folder-uri 打开");
});

// ---------------- tabs-todo：按钮可用判据 ----------------
//
// 按钮是否可用决定两件事：颜色（t.muted 亮 / t.dim 灰）与 tooltip 文本。假元素吞掉了
// 样式，所以这里让替身把「收到的方法调用与参数」记下来——这是可观察投影，不是实现细节：
// 我们断言的就是用户能看到的那个区别（置灰 + 「还没有可打开的目录」）。

test("tabs-todo：空 folder（那台机器的 home）时按钮显示为可用", async () => {
  const { labels } = await renderTabs({ folder: "" });
  assert.ok(labels.includes("CodeBuddy"), "按钮应当存在");
  assert.equal(
    labels.includes("这个 space 还没有可打开的目录"),
    false,
    "空 folder 是那台机器的 home，是合法目录；按钮不该置灰",
  );
});

test("tabs-todo：真的没有目录时按钮置灰并说明原因", async () => {
  const { labels } = await renderTabs({ folder: null, noFolder: true });
  assert.ok(labels.includes("这个 space 还没有可打开的目录"), "没有目录时 tooltip 要说明原因，而不是静默不动作");
});

// 渲染一次标签栏，收集替身收到的所有字符串（tooltip 与按钮文字都在里面）。
async function renderTabs({ folder, noFolder }) {
  const recorder = `export class View { constructor() {} }
${ELEMENT}
const seen = (globalThis.__seen = []);
const rec = () => new Proxy(function () {}, {
  get: (t, k) => (k === "then" ? undefined : rec()),
  apply: (t, self, args) => { for (const a of args) if (typeof a === "string") seen.push(a); return rec(); },
});
export const div = () => rec(), svg = () => rec(), image = () => rec();`;
  const baseRecorder = `
${ELEMENT}
const seen = (globalThis.__seen = []);
const rec = () => new Proxy(function () {}, {
  get: (t, k) => (k === "then" ? undefined : rec()),
  apply: (t, self, args) => { for (const a of args) if (typeof a === "string") seen.push(a); return rec(); },
});
export const v_flex = () => rec(), h_flex = () => rec();
export const ScrollHandle = { new: () => ({ scroll_to_item() {}, track_scroll() {} }) };`;

  const { mod, s } = await loadMod("tabs", { gpk: recorder, base: baseRecorder });
  s.spaces = [{ id: "s1", active: true, machine: null, folder, tabs: noFolder ? [] : [{ id: "tb", name: "1", active: true }] }];
  s.panes = [];
  const Cls = mod.default;
  const inst = Object.create(Cls.prototype);
  try { Cls.prototype.init.call(inst, {}, fakeCx()); } catch {}
  Cls.prototype.render.call(inst, fakeCx());
  return { labels: globalThis.__seen };
}

// ---------------- herdr-todo（详情窗）：点标题改名 ----------------
//
// 这里断言的是用户能看见、能触发的三件事：
//   1. 详情窗头部有标题文字本身，点它才进编辑态（**没有**「改标题」按钮）；
//   2. 保存发出的命令形状正确——标题落在 `--` 之后，不会被当成选项；
//   3. 写失败时编辑态与用户输入都还在（否则用户会以为改成了，或者输入被吞）。
//
// 宿主替身要能记录「点击回调」与「输入框原文」，所以 gpui-kit 用记录型替身：
// 元素上挂的回调按注册顺序存进 __clicks，字符串参数存进 __seen。

const RECORD_KIT = `
export class View { constructor() {} }
const el = new Proxy(function () {}, {
  get: (t, k) => {
    if (k === "then") return undefined;
    if (k === "id") return (v) => { globalThis.__cur = v; (globalThis.__ids ??= []).push(v); return el; };
    if (k === "child" || k === "children") {
      return (v) => {
        // 真实宿主对 null 会抛错（child(value) expects an element, a string …），
        // 而整个窗口渲染失败。替身必须同样严格：宽松的桩会把这类错误放过去，
        // 一直留到真机上才炸。
        const list = k === "children" ? [...(v ?? [])] : [v];
        for (const x of list) {
          if (x === null || x === undefined) {
            throw new TypeError(k + "(value) expects an element, a string, or a number，收到了 " + x);
          }
        }
        const g = globalThis.__hr; (g.children ??= []).push(...list);
        for (const x of list) {
          if (typeof x === "string") (globalThis.__labels ??= []).push(x);
          // 记下「这段文本挂在哪个 id 的容器里」：错误提示必须在头部、不能落在
          // 滚动区——只断言文本存在的话，把它挪回滚动区测试也不会红。
          (globalThis.__parents ??= []).push([x, globalThis.__cur ?? null]);
        }
        return el;
      };
    }
    if (k === "on_click" || k === "on_mouse_down" || k === "on_key_down") {
      // on_mouse_down 是 (button, fn)；on_click / on_key_down 是 (fn)。
      return (...a) => {
        const fn = a.filter((x) => typeof x === "function").at(-1);
        (globalThis.__clicks ??= []).push([k, fn, globalThis.__cur ?? null, ...a.slice(0, a.indexOf(fn))]);
        return el;
      };
    }
    if (k === "hover" || k === "tooltip") {
      return (v) => { (globalThis.__styles ??= []).push([k, v, globalThis.__cur ?? null]); return el; };
    }
    return el;
  },
  apply: () => el,
});
export const div = () => (globalThis.__cur = null, el), svg = () => el, image = () => el;`;

const RECORD_BASE = `
const el = new Proxy(function () {}, {
  get: (t, k) => {
    if (k === "then") return undefined;
    if (k === "id") return (v) => { globalThis.__cur = v; (globalThis.__ids ??= []).push(v); return el; };
    if (k === "child" || k === "children") {
      return (v) => {
        // 真实宿主对 null 会抛错（child(value) expects an element, a string …），
        // 而整个窗口渲染失败。替身必须同样严格：宽松的桩会把这类错误放过去，
        // 一直留到真机上才炸。
        const list = k === "children" ? [...(v ?? [])] : [v];
        for (const x of list) {
          if (x === null || x === undefined) {
            throw new TypeError(k + "(value) expects an element, a string, or a number，收到了 " + x);
          }
        }
        const g = globalThis.__hr; (g.children ??= []).push(...list);
        for (const x of list) {
          if (typeof x === "string") (globalThis.__labels ??= []).push(x);
          // 记下「这段文本挂在哪个 id 的容器里」：错误提示必须在头部、不能落在
          // 滚动区——只断言文本存在的话，把它挪回滚动区测试也不会红。
          (globalThis.__parents ??= []).push([x, globalThis.__cur ?? null]);
        }
        return el;
      };
    }
    if (k === "on_click" || k === "on_mouse_down" || k === "on_key_down") {
      // on_mouse_down 是 (button, fn)；on_click / on_key_down 是 (fn)。
      return (...a) => {
        const fn = a.filter((x) => typeof x === "function").at(-1);
        (globalThis.__clicks ??= []).push([k, fn, globalThis.__cur ?? null, ...a.slice(0, a.indexOf(fn))]);
        return el;
      };
    }
    if (k === "hover" || k === "tooltip") {
      return (v) => { (globalThis.__styles ??= []).push([k, v, globalThis.__cur ?? null]); return el; };
    }
    return el;
  },
  apply: () => el,
});
export const v_flex = () => (globalThis.__cur = null, el), h_flex = () => (globalThis.__cur = null, el);
export class InputState {
  static new(o) {
    const st = {
      __value: o?.value ?? "",
      value() { return this.__value; },
      set_value(v) { this.__value = v; },
      focus() { globalThis.__focused = "input"; },
      on(ev, fn) { (globalThis.__submits ??= {})[ev] = fn; return true; },
    };
    (globalThis.__states ??= []).push(st);
    return st;
  }
}
export const Input = { new: (st) => { (globalThis.__inputs ??= []).push(st); return { state: st }; } };
export class TextareaState {
  static new(o) {
    const st = {
      __value: o?.value ?? "",
      value() { return this.__value; },
      set_value(v) { this.__value = v; },
      focus() { globalThis.__focused = "note"; },
      on(ev, fn) { (globalThis.__submits ??= {})[ev] = fn; return true; },
    };
    (globalThis.__states ??= []).push(st);
    return st;
  }
}
export const Textarea = { new: (st) => { (globalThis.__textareas ??= []).push(st); return { state: st }; } };
export const ScrollHandle = { new: () => ({ scroll_to_item() {}, track_scroll() {} }) };`;

// 详情窗需要一条账本。read() 走 readTextFile → normalizeState，所以写成真 JSON。
const ITEM = {
  id: "t1",
  num: 12,
  title: "原来的标题",
  note: "",
  priority: "P2",
  status: "todo",
  spaces: [],
  created: 1000,
  updated: 2000,
  timeline: [{ at: 1000, kind: "created", from: null, to: "todo", by: "panel" }],
};

/**
 * 详情窗专用的 cx：spawn 真的跑，sleep 可控。
 *
 * 通用的 fakeCx 让 sleep 直接 reject，异步循环一进第二轮就没了——「保存成功后
 * 申请焦点」与「进入编辑时作废这份申请」这类时序问题因此完全不可见。
 * `pausable` 打开时 sleep 挂起，测试用 step() 一轮一轮放行，才观察得到
 * 「谁在什么时候还活着」。focus_handle 记录谁持有键盘：这是唯一能观察到
 * takeFocus() 有没有把键盘抢走的信号。
 */
function detailCx(control = { immediate: true, pending: [] }) {
  const frame = {
    is_focused: () => globalThis.__focused === "frame",
    focus: () => { globalThis.__focused = "frame"; },
  };
  const sleep = () =>
    control.immediate ? Promise.resolve() : new Promise((r) => control.pending.push(r));
  const spawn = (fn) => {
    try {
      const r = fn({ ...detailCx(control), sleep });
      if (r?.catch) r.catch(() => {});
    } catch {}
  };
  return {
    focus_handle: () => frame,
    spawn,
    sleep,
    timer: { every() {} },
    new: () => ({}),
    notify() {},
  };
}

/** 放行一轮挂起的 sleep（pausable 模式用）。 */
async function step(control) {
  const batch = control.pending.splice(0);
  for (const r of batch) r();
  await settle();
}

async function loadDetail({ execCode = 0, stderr = "标题不能为空", slowExec = false, pausable = false } = {}) {
  const stub = HERDR_STUB.replace(
    // 监听器在这里没有意义：让 watch() 永远停在 await 上（不抛、不空转）。
    // 通用的这份替身必须抛错，否则侧栏那条 for(;;) 会立刻重进 catch 死循环。
    /^export const watchFolder = .*$/m,
    'export const watchFolder = () => new Promise(() => {});',
  ).replace(
    /^export const exec = .*$/m,
    `export const exec = async (cmd, args, opts) => { s.execs.push([cmd, args, opts]); ${slowExec ? "await globalThis.__execGate;\n" : ""}return { code: ${execCode}, stdout: "", stderr: ${JSON.stringify(execCode ? stderr : "")} }; };`,
  );
  // herdr-todo 的源文件就在 mod/ 根下。
  const { mod, s } = await loadMod(".", { herdr: stub, gpk: RECORD_KIT, base: RECORD_BASE });
  // 详情窗 props：props().detail 决定打开哪一条；read() 走 readTextFile 读账本。
  s.props = { detail: "t1", overlay: "o1" };
  s.files[`/tmp/home/.local/share/herdr-todo/todos.json`] = JSON.stringify({ v: 1, seq: 1, items: [ITEM] });
  globalThis.__seen = [];
  globalThis.__clicks = [];
  globalThis.__ids = [];
  globalThis.__labels = [];
  globalThis.__styles = [];
  globalThis.__states = [];
  globalThis.__inputs = [];
  globalThis.__textareas = [];
  globalThis.__submits = {};
  globalThis.__focused = "frame";
  const Cls = mod.default;
  const inst = Object.create(Cls.prototype);
  const control = { immediate: !pausable, pending: [] };
  Cls.prototype.init.call(inst, {}, detailCx(control));
  await settle();
  return { mod, s, inst, Cls, control };
}

// 渲染一次并返回替身记到的东西。
async function renderDetailOnce(inst, Cls) {
  globalThis.__clicks = [];
  globalThis.__ids = [];
  globalThis.__labels = [];
  globalThis.__styles = [];
  globalThis.__inputs = [];
  globalThis.__textareas = [];
  globalThis.__parents = [];
  Cls.prototype.render.call(inst, fakeCx());
  return {
    clicks: globalThis.__clicks,
    ids: globalThis.__ids,
    labels: globalThis.__labels,
    styles: globalThis.__styles,
    inputs: globalThis.__inputs,
    textareas: globalThis.__textareas,
    parents: globalThis.__parents,
  };
}

/**
 * 触发某个 id 上的事件。
 *
 * 按 id 定位而不是「挨个试所有点击回调」：后者依赖「回调之间无副作用」，
 * 而这个窗口里 ✕ 的回调就会关窗、编辑备注的回调会换编辑器——挨个试等于让
 * 测试自己制造状态污染，还会在「入口被接到错误元素上」时依然通过。
 * `__cur` 记录的是最近一次 `.id()` 的值，所以元素上的回调能对上自己的 id。
 */
function fire(clicks, id, kind = "on_click") {
  const hit = clicks.filter(([k, , at]) => k === kind && at === id);
  assert.ok(hit.length, `id=${id} 上应挂着 ${kind}（实际有：${clicks.map(([k, , a]) => `${a}:${k}`).join(", ")}）`);
  for (const [, fn] of hit) fn();
}

/** 点标题文字进编辑态。标题元素的 id 是 `todo-title-<事项 id>`。 */
async function clickTitle(inst, Cls) {
  const { clicks } = await renderDetailOnce(inst, Cls);
  fire(clicks, "todo-title-t1");
  assert.equal(inst.titleEditingId, "t1", "点标题文字应进入编辑态");
}

test("详情窗：入口是标题文字本身，没有「改标题」按钮，且看得出可点", async () => {
  const { inst, Cls } = await loadDetail();
  const { labels, ids, styles } = await renderDetailOnce(inst, Cls);
  assert.ok(labels.includes("原来的标题"), "详情窗头部应显示标题文字");
  assert.ok(
    !labels.some((s) => /改标题|编辑标题/.test(s)),
    `不该出现「改标题」按钮：入口就是标题文字本身（实际渲染到：${labels.join(" / ")}）`,
  );
  // 可点的线索：悬停底色与 tooltip。缺了它们标题看起来就是只读文字。
  const titleStyles = styles.filter(([, , at]) => at === "todo-title-t1");
  assert.ok(
    titleStyles.some(([k]) => k === "hover") && titleStyles.some(([k]) => k === "tooltip"),
    `标题元素应有 hover 与 tooltip：${JSON.stringify(titleStyles)}`,
  );
  assert.ok(ids.includes("todo-title-t1"), "标题元素应带稳定 id，否则 UI 自动化点不到它");
});

test("详情窗：显示 #编号（命令行按编号寻址，面板不给就无从照着敲）", async () => {
  const { inst, Cls } = await loadDetail();
  const { labels, ids } = await renderDetailOnce(inst, Cls);
  assert.ok(ids.includes("detail-num"), "详情窗头部应有编号元素");
  assert.ok(labels.includes("#12"), `头部应显示 #12（实际渲染：${labels.join(" / ")}）`);
});

test("详情窗：在标题上按下不会变成拖窗口（按下被拦住）", async () => {
  // 详情窗是 kind:"window"：任意未被阻止的按下都会发起窗口拖动，点标题就收不到
  // on_click。这条在真实 App 里表现为「点标题没用、窗口被拖走」，只能靠按下事件
  // 是否调用了 stop_propagation 来在测试里钉住。
  const { inst, Cls } = await loadDetail();
  const { clicks } = await renderDetailOnce(inst, Cls);
  const down = clicks.filter(([k, , at]) => k === "on_mouse_down" && at === "todo-title-t1");
  assert.ok(down.length, "标题元素应接 on_mouse_down（否则按下会变成拖窗口）");
  let stopped = 0;
  for (const [, fn] of down) fn({}, { stop_propagation: () => { stopped += 1; } });
  assert.equal(stopped, down.length, "标题上的每一次按下都应 stop_propagation");
});

test("详情窗：点标题进编辑态，输入框预填当前标题", async () => {
  const { inst, Cls } = await loadDetail();
  await clickTitle(inst, Cls);
  assert.equal(String(inst.titleDraft?.value()), "原来的标题", "输入框应预填当前标题");
  const { labels, inputs } = await renderDetailOnce(inst, Cls);
  assert.ok(labels.includes("保存") && labels.includes("取消"), "编辑态应渲染保存与取消按钮");
  // 光有「保存 / 取消」两个标签不够：编辑态必须真的把 Input 挂上去，
  // 否则画的是一段文本，用户打了字进不去。
  assert.equal(inputs.length, 1, "编辑态应渲染一个输入框");
  assert.equal(inputs[0], inst.titleDraft, "输入框应绑定到当前草稿");
});

test("详情窗：回车保存走 submit，命令把标题放在 `--` 之后", async () => {
  const { inst, Cls, s } = await loadDetail();
  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("-h"); // 用户输入恰好是选项形状
  const submit = globalThis.__submits.submit;
  assert.equal(typeof submit, "function", "标题输入框应接 submit（回车才能保存）");
  submit();
  await settle();
  const [, args] = s.execs.at(-1);
  const dash = args.indexOf("--");
  assert.ok(dash > -1, `argv 里应有 -- 分隔：${JSON.stringify(args)}`);
  // `--` 之后是全部位置参数：id 与标题。两者都不是选项语法，所以 `-h` 原样保留。
  assert.deepEqual(args.slice(dash + 1), ["t1", "-h"], "标题必须是 -- 之后的位置参数");
  assert.ok(args.includes("title"), "应调用 title 子命令");
  assert.ok(args.includes("panel"), "应记录 by=panel");
  assert.equal(inst.titleEditingId, null, "写成功后应退出编辑态");
});

test("详情窗：点「取消」退出编辑，不写盘", async () => {
  const { inst, Cls, s } = await loadDetail();
  await clickTitle(inst, Cls);
  const { clicks } = await renderDetailOnce(inst, Cls);
  fire(clicks, "title-cancel");
  assert.equal(inst.titleEditingId, null, "点取消应退出编辑态");
  assert.equal(s.execs.length, 0, "点取消不该发任何写命令");
});

test("详情窗：点「保存」按钮发出的 id 是事项 id，不是可变的编辑态字段", async () => {
  const { inst, Cls, s } = await loadDetail();
  await clickTitle(inst, Cls);
  const { clicks } = await renderDetailOnce(inst, Cls);
  // 模拟「编辑态在点击前被别的原因退出」：此时旧的 `this.titleEditingId` 是 null。
  inst.titleEditingId = null;
  inst.titleDraft = { value: () => "按钮点出来的标题" };
  fire(clicks, "title-save");
  await settle();
  const [, args] = s.execs.at(-1);
  assert.ok(args, "点保存应发出写命令");
  assert.ok(!args.includes("null"), `不该把 null 当事项 id 发出去：${JSON.stringify(args)}`);
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["t1", "按钮点出来的标题"]);
});

test("详情窗：空白标题在本地被拦下，不发命令、保留输入并显示原因", async () => {
  const { inst, Cls, s } = await loadDetail();
  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("   ");
  await inst.commitTitle("t1");
  await settle();
  assert.equal(s.execs.length, 0, "空白标题不该发命令（CLI 会附带整份 USAGE，提示塞不进窗口）");
  assert.equal(inst.titleEditingId, "t1", "被拦下不该退出编辑态");
  assert.equal(String(inst.titleDraft.value()), "   ", "被拦下不该吞掉用户输入");
  // 本地校验不写 writeError：那条通道的意思是「写盘失败了」，由写成功后清除。
  assert.equal(inst.writeError, null, "本地拦截没有写盘，不该占用 writeError");
  const { labels, parents } = await renderDetailOnce(inst, Cls);
  const hit = labels.filter((s) => /标题不能为空/.test(s));
  assert.equal(hit.length, 1, `原因应显示一次：${JSON.stringify(labels)}`);
  // 位置：必须在头部（挂在 id=title-error 的容器里），不能在滚动区。只断言文本
  // 存在的话，把它挪回滚动区测试照样会绿——那正是要拦的回归。
  assert.ok(
    parents.some(([txt, at]) => txt === hit[0] && at === "title-error"),
    `提示应挂在头部（title-error）而不是滚动区：${JSON.stringify(parents.filter(([x]) => x === hit[0]))}`,
  );
});

test("详情窗：超长标题在本地被拦下并说明字数，不发命令", async () => {
  const { inst, Cls, s } = await loadDetail();
  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("x".repeat(250));
  await inst.commitTitle("t1");
  await settle();
  assert.equal(s.execs.length, 0, "超长标题不该发命令：CLI 会静默截到 200，用户看不到自己打的字");
  assert.equal(inst.titleEditingId, "t1", "被拦下不该退出编辑态");
  assert.match(inst.titleProblem, /200/);
});

test("详情窗：本地拦截的提示在退出编辑后消失", async () => {
  const { inst, Cls } = await loadDetail();
  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("   ");
  await inst.commitTitle("t1");
  await settle();
  assert.ok(inst.titleProblem, "被拦下后应有一次提示");
  const { clicks } = await renderDetailOnce(inst, Cls);
  fire(clicks, "title-cancel");
  assert.equal(inst.titleProblem, null, "退出编辑后不该还挂着「标题不能为空」：那时并没有写入失败");
  const { labels } = await renderDetailOnce(inst, Cls);
  assert.ok(!labels.some((s) => /标题不能为空/.test(s)), `提示应已消失：${JSON.stringify(labels)}`);
});

test("详情窗：Esc 退出编辑同样清掉本地拦截的提示", async () => {
  const { inst, Cls } = await loadDetail();
  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("x".repeat(250));
  await inst.commitTitle("t1");
  await settle();
  const { clicks } = await renderDetailOnce(inst, Cls);
  clicks.find(([k]) => k === "on_key_down")[1]({ key: "escape" });
  assert.equal(inst.titleProblem, null, "Esc 退出编辑后提示应消失");
});

test("详情窗：写失败时保留编辑态与用户输入，并把 CLI 报错显示在窗口里", async () => {
  // CLI 的用法类错误带整份 USAGE（实测 40 来行）：窗口只能显示第一行。
  const usages = "herdr-todo: 标题不能为空\n\nherdr-todo — 记录工作事项\n" + "用法行\n".repeat(40);
  const { inst, Cls } = await loadDetail({ execCode: 2, stderr: usages });
  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("写不进去的标题");
  await inst.commitTitle("t1");
  await settle();
  assert.equal(inst.titleEditingId, "t1", "写失败不该退出编辑态");
  assert.equal(String(inst.titleDraft.value()), "写不进去的标题", "写失败不该吞掉用户输入");
  const { labels, parents } = await renderDetailOnce(inst, Cls);
  const hit = labels.filter((s) => /^herdr-todo: 标题不能为空$/.test(s));
  assert.equal(hit.length, 1, `应只显示报错第一行：${JSON.stringify(labels)}`);
  assert.ok(!labels.some((s) => /用法行/.test(s)), "整份 USAGE 不该进窗口");
  assert.ok(
    parents.some(([txt, at]) => txt === hit[0] && at === "title-error"),
    "CLI 报错也必须挂在头部（滚动区里看不见）",
  );
});

test("详情窗：编辑态按 Esc 只退编辑，再按一次才关窗", async () => {
  const { inst, Cls, s } = await loadDetail();
  await clickTitle(inst, Cls);
  const { clicks } = await renderDetailOnce(inst, Cls);
  const esc = clicks.find(([k]) => k === "on_key_down");
  assert.ok(esc, "窗口应接 on_key_down（否则 Esc 关不掉窗）");
  esc[1]({ key: "escape" });
  assert.equal(inst.titleEditingId, null, "第一次 Esc 应退出标题编辑");
  assert.equal(s.closes.length, 0, "第一次 Esc 不该关窗");
  esc[1]({ key: "escape" });
  assert.deepEqual(s.closes, ["o1"], "第二次 Esc 才关窗");
});

test("详情窗：标题编辑与备注编辑互斥（两个方向）", async () => {
  const { inst, Cls } = await loadDetail();
  await clickTitle(inst, Cls);

  // 方向一：标题编辑中点「编辑备注」——两个草稿不能同时活着。
  // 按 id 精确触发：挨个试回调会先点到「取消」，把标题编辑退掉了再进备注，
  // 断言就永远成立（这正是它必须按 id 定位的原因）。
  let { clicks, labels } = await renderDetailOnce(inst, Cls);
  assert.ok(labels.includes("编辑备注"), "详情窗应有「编辑备注」入口");
  fire(clicks, "note-edit");
  assert.equal(inst.noteEditingId, "t1", "点「编辑备注」应进入备注编辑");
  assert.equal(inst.titleEditingId, null, "进备注编辑时应退出标题编辑，否则两个草稿同时活着");

  // 方向二：备注编辑中点标题。
  ({ clicks } = await renderDetailOnce(inst, Cls));
  fire(clicks, "todo-title-t1");
  assert.equal(inst.titleEditingId, "t1", "点标题应进入标题编辑");
  assert.equal(inst.noteEditingId, null, "进标题编辑时应退出备注编辑");
});

test("详情窗：窗口一旦拿到键盘，抢焦点的重试就停，不再反复 focus()", async () => {
  // 拿不到键盘才需要重试。拿到以后还在继续 focus()，等于在后半秒里反复把键盘
  // 拽回窗口——期间用户切到别的输入框或别的应用都会被抢回来。
  const { inst, control } = await loadDetail({ pausable: true });
  let calls = 0;
  let focused = false;
  inst.focusHandle = {
    is_focused: () => focused,
    focus: () => { calls += 1; focused = true; },
  };
  inst.takeFocus();
  for (let i = 0; i < 5; i++) await step(control);
  assert.equal(calls, 1, "第一次 focus() 生效后就该退出循环，不该再调用");
});

test("详情窗：点进标题输入框后，在途的抢焦点重试不会再抢走键盘", async () => {
  // 把键盘交给窗口本身（保存成功后的行为），但让它的重试还没跑完；
  // 此时用户点标题进编辑，之后的每一轮都必须放弃——否则用户打的字进不去。
  const { inst, Cls, control } = await loadDetail({ pausable: true });
  globalThis.__focused = "frame"; // 窗口已拿到键盘：下一轮循环直接 return
  inst.focusHandle = { is_focused: () => false, focus: () => { globalThis.__focused = "frame"; } };
  inst.takeFocus();
  assert.ok(control.pending.length, "应有在途的重试循环");

  // 移开窗口焦点，让在途循环的下一轮确实会去抢。
  globalThis.__focused = "input";
  await clickTitle(inst, Cls);
  for (let i = 0; i < 3; i++) await step(control);
  assert.equal(globalThis.__focused, "input", "点进输入框后，在途的 takeFocus() 不该把键盘抢回窗口");
});

test("详情窗：备注保存回来时不再抢走标题编辑的键盘", async () => {
  // 备注回车保存在途时点标题进编辑：备注那一轮的 onDone 到达时不能再调
  // leaveNote()，否则 takeFocus 会把键盘从标题输入框里拉回窗体。
  let release;
  globalThis.__execGate = new Promise((r) => { release = r; });
  const { inst, Cls } = await loadDetail({ slowExec: true });

  const { clicks } = await renderDetailOnce(inst, Cls);
  fire(clicks, "note-edit");
  assert.equal(inst.noteEditingId, "t1", "应进入备注编辑");
  const noteDraft = inst.noteDraft;
  inst.commitNote("t1"); // 在途
  await settle();

  // 用户切到标题编辑
  const r2 = await renderDetailOnce(inst, Cls);
  fire(r2.clicks, "todo-title-t1");
  assert.equal(inst.titleEditingId, "t1", "应进入标题编辑");
  assert.notEqual(inst.noteDraft, noteDraft, "标题编辑应已收掉备注草稿");

  release(); // 备注那一轮写回完成
  await settle();
  await settle();
  assert.equal(inst.noteEditingId, null, "备注不该被「重新打开」");
  assert.equal(inst.titleEditingId, "t1", "标题编辑态应还在");
  assert.equal(globalThis.__focused, "input", "键盘应仍在标题输入框，不能被备注的 onDone 抢走");
});

test("详情窗：上一轮保存回来时不再清掉用户正在编辑的新草稿", async () => {
  // exec 挂着不返回：用户在第一轮保存「版本A」期间又点开标题、输入「版本B」。
  // 第一轮的 onDone 到达时不能把第二轮的草稿当成「保存完成」收掉。
  let release;
  globalThis.__execGate = new Promise((r) => { release = r; });
  const { inst, Cls, s } = await loadDetail({ slowExec: true });

  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("版本A");
  inst.commitTitle("t1"); // 在途
  await settle();

  // 清除编辑态，模拟第一轮已经离开（用户点开标题重新编辑）。
  inst.titleEditingId = null;
  inst.titleDraft = null;
  await clickTitle(inst, Cls);
  inst.titleDraft.set_value("版本B");

  release(); // 第一轮写回完成
  await settle();
  await settle();
  assert.ok(s.execs.length >= 1, "第一轮应已发出命令");
  assert.equal(inst.titleDraft?.value?.(), "版本B", "第一轮的 onDone 不能吞掉第二轮输入");
  assert.equal(inst.titleEditingId, "t1", "第二轮编辑态应还活着");
});
