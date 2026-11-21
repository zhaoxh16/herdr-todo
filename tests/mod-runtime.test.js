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
s.props ??= {}; s.files ??= {}; s.menuReads ??= 0; s.isChecking ??= false;
export const spaces = () => s.spaces;
export const machines = () => [];
export const panes = () => s.panes;
export const terminals = () => s.terminals;
export const agents = () => s.agents;
export const run = (name, args) => { s.runs.push([name, args]); return null; };
export const props = () => s.props;
export const closeOverlay = () => null;
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

// 侧栏分组要拿到 agent 列表：挂在活 agent 上的事项侧栏不列（由 Agents 栏显示）。
// 漏掉 `agents` 导入时 todoGroups() 直接 ReferenceError，整条侧栏渲不出来，而
// herdr-app check 只解析不渲染，照样报 passed；传空列表则会让这类事项提前回到
// space 组，与 Agents 栏重复。两种坏法都只在真正渲染时才看得见。
test("spaces-todo：侧栏分组按活 agent 隐藏事项", async () => {
  const { mod, s } = await loadMod("spaces");
  s.spaces = [{ id: "spA", name: "A" }];
  s.agents = [{ address: "dev5/t2", space: "spA", title: "claude" }];
  const inst = spacesView(mod);
  inst.todoState = {
    items: [
      { id: "t1", title: "t1", note: "", priority: "P2", status: "todo", spaces: [], agent: { address: "dev5/t2", space: "spA" }, created: 1, updated: 1, timeline: [] },
    ],
  };
  const g = inst.todoGroups();
  assert.deepEqual(
    g.spaces.flatMap((x) => x.open.map((i) => i.id)),
    [],
    "挂着活 agent 的事项不该出现在 space 组下（Agents 栏负责显示它）",
  );
  assert.deepEqual(g.unlinked.open, [], "关联了 agent 就不算未关联");
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
