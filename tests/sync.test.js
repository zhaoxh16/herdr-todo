import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src", "core.js");
const MOD = path.join(ROOT, "mod", "core.js");

/**
 * mod/ 沙箱不允许跨目录 import，所以 core.js 只能以副本形式存在。
 * 副本过期不会报错，只会让面板按旧规则读写数据（例如旧的宽松校验把坏账本
 * 静默写回）。这条测试把「副本 == 源」变成可自动检查的事实。
 */
test("mod/core.js 与 src/core.js 同步（哈希头 + 正文一致）", async () => {
  const src = await fs.readFile(SRC, "utf8");
  const mod = await fs.readFile(MOD, "utf8");
  const nl = mod.indexOf("\n");
  const nl2 = mod.indexOf("\n", nl + 1);
  const head = mod.slice(0, nl2);

  const m = /^\/\/ source-sha256: ([0-9a-f]{64})$/m.exec(head);
  assert.ok(m, "mod/core.js 头两行应包含 source-sha256 哈希");

  const want = createHash("sha256").update(src).digest("hex");
  assert.equal(m[1], want, "mod/core.js 的哈希头与 src/core.js 不符：运行 sh scripts/sync-core.sh");

  // 哈希对上了但正文被人手改过，同样是漂移。
  const body = mod.slice(nl2 + 1);
  assert.equal(body, src, "mod/core.js 正文与 src/core.js 不一致：运行 sh scripts/sync-core.sh");
});

test("mod/core.js 可被 Node 直接加载（没有导入宿主 API）", async () => {
  const m = await import(MOD);
  for (const name of ["addItem", "setStatus", "setSpaces", "archiveItem", "normalizeState"]) {
    assert.equal(typeof m[name], "function", `${name} 应从 mod/core.js 导出`);
  }
});

test("侧栏副本与 mod/core.js 一致（同源同哈希）", async () => {
  const a = await fs.readFile(MOD, "utf8");
  const b = await fs.readFile(path.join(ROOT, "mod", "spaces", "core.js"), "utf8");
  assert.equal(b, a, "mod/spaces/core.js 与 mod/core.js 不一致：运行 sh scripts/sync-core.sh");
});

test("Agents 栏副本与 mod/core.js / todo-view.js 一致（同源同哈希）", async () => {
  const core = await fs.readFile(MOD, "utf8");
  const agentsCore = await fs.readFile(path.join(ROOT, "mod", "agents", "core.js"), "utf8");
  assert.equal(agentsCore, core, "mod/agents/core.js 与 mod/core.js 不一致：运行 sh scripts/sync-core.sh");

  // todo-view.js 是不带哈希头的纯模块，但两个 mod 各有一份副本：内容一旦分叉，
  // 侧栏与 Agents 栏对「这条事项该显示在哪」的算法就不一样了。
  const view = await fs.readFile(path.join(ROOT, "mod", "spaces", "todo-view.js"), "utf8");
  const agentsView = await fs.readFile(path.join(ROOT, "mod", "agents", "todo-view.js"), "utf8");
  assert.equal(agentsView, view, "mod/agents/todo-view.js 与 mod/spaces/todo-view.js 不一致：运行 sh scripts/sync-core.sh");
});

// store.js 不参与哈希（它只依赖宿主），但沙箱禁止跨目录 import，侧栏必须有自己的
// 副本。两份不一致时，侧栏会用一套 argv 规则、详情窗用另一套——写路径就分叉了。
test("侧栏的 store.js 与 mod/store.js 一致", async () => {
  const a = await fs.readFile(path.join(ROOT, "mod", "store.js"), "utf8");
  const b = await fs.readFile(path.join(ROOT, "mod", "spaces", "store.js"), "utf8");
  assert.equal(b, a, "mod/spaces/store.js 与 mod/store.js 不一致：运行 sh scripts/sync-core.sh");
});

// 写路径只有一条（CLI），argv 的三段式约定钉在 store.js 里。Agents 栏要是用了
// 自己的副本，拖拽关联就可能用另一套参数形态写数据。
test("Agents 栏的 store.js 与 mod/store.js 一致", async () => {
  const a = await fs.readFile(path.join(ROOT, "mod", "store.js"), "utf8");
  const b = await fs.readFile(path.join(ROOT, "mod", "agents", "store.js"), "utf8");
  assert.equal(b, a, "mod/agents/store.js 与 mod/store.js 不一致：运行 sh scripts/sync-core.sh");
});

// 拖拽契约（todo-drag.js）：两个 mod 各一份副本。分叉时会出现「侧栏画了跟随
// 标签、Agents 栏不认这次拖拽」这类半边坏掉的行为——两边对「手上拿着哪条待办」
// 必须一模一样。
test("拖拽契约副本与源文件一致", async () => {
  const src = await fs.readFile(path.join(ROOT, "mod", "todo-drag.js"), "utf8");
  for (const dir of ["spaces", "agents"]) {
    const copy = await fs.readFile(path.join(ROOT, "mod", dir, "todo-drag.js"), "utf8");
    assert.equal(copy, src, `mod/${dir}/todo-drag.js 与 mod/todo-drag.js 不一致：运行 sh scripts/sync-core.sh`);
  }
});

// 「用 CodeBuddy 打开」：标签栏按钮与 space 右键菜单各一份副本。分叉时会出现
// 「按钮开对目录、菜单开错目录」，两边单独看都正常，只有并排比才能发现。
test("CodeBuddy 打开模块与源文件一致", async () => {
  const src = await fs.readFile(path.join(ROOT, "mod", "codebuddy.js"), "utf8");
  for (const dir of ["tabs", "menu"]) {
    const copy = await fs.readFile(path.join(ROOT, "mod", dir, "codebuddy.js"), "utf8");
    assert.equal(copy, src, `mod/${dir}/codebuddy.js 与 mod/codebuddy.js 不一致：运行 sh scripts/sync-core.sh`);
  }
});

test("标签栏与右键菜单 mod 的模块都能被 Node 解析（语法）", () => {
  const files = { tabs: ["main.js", "codebuddy.js"], menu: ["main.js", "codebuddy.js"] };
  for (const [dir, list] of Object.entries(files)) {
    for (const f of list) {
      const r = spawnSync(process.execPath, ["--check", path.join(ROOT, "mod", dir, f)], { encoding: "utf8" });
      assert.equal(r.status, 0, `${dir}/${f} 语法错误：${r.stderr}`);
    }
  }
});

// install.sh 的「必需文件清单」曾经手写两份（前置检查一份、拷贝一份），加新 mod 时
// 只改了拷贝那份：删掉 mod/tabs/jsconfig.json 或某个 win-*.svg，前置检查照样通过，
// 安装却在中途 die，留下「spaces-todo 已指向 menu-todo、menu-todo 却不存在」的半装
// 状态。现在清单只有一份（MOD_MANIFEST），检查 / 拷贝 / 就位后核对都从它派生。
// 这条测试钉住两件事：清单里的文件都真实存在，且 install.sh 里没有第二份文件枚举。
test("install.sh 的 mod 清单是单一事实源，且清单里的文件都存在", async () => {
  const text = await fs.readFile(path.join(ROOT, "install.sh"), "utf8");
  const m = /^MOD_MANIFEST='([\s\S]*?)'$/m.exec(text);
  assert.ok(m, "install.sh 应有 MOD_MANIFEST 清单");

  const rows = m[1].split("\n").filter((l) => l.trim());
  assert.ok(rows.length >= 5, `清单应列出全部 mod，实际 ${rows.length} 行`);
  for (const row of rows) {
    const [name, src, files] = row.split("|");
    assert.ok(name && src !== undefined && files, `清单行格式应为 name|src|files：${row}`);
    for (const f of files.split(/\s+/).filter(Boolean)) {
      const file = path.join(ROOT, "mod", src, f);
      await fs.access(file); // 缺文件时前置检查会在安装中途才炸，这里提前拦下
    }
  }

  // 第二份手写枚举的痕迹：再出现 `for f in main.js ...` 这类行就说明清单又分叉了。
  const loops = text.match(/for\s+\w+\s+in\s+main\.js[^\n;]*;\s*do/g) ?? [];
  assert.deepEqual(loops, [], `install.sh 里还有手写的拷贝清单：${loops.join(" / ")}`);
});

// tabs-todo 曾经是「旧版遗留、装完就移走」的目录，现在它是布局指向的正式 mod。
// 移除逻辑若回来，装完就会把刚装好的 mod 删掉，App 重启后标签栏整个消失。
// 匹配面放宽到「任何针对 tabs-todo 的删除/移动」，不只历史上那一种字面写法。
test("install.sh 不删除也不移走已安装的 tabs-todo", async () => {
  const text = await fs.readFile(path.join(ROOT, "install.sh"), "utf8");
  const suspects = text.split("\n").filter((line) => {
    if (line.trim().startsWith("#")) return false; // 注释里讲历史可以
    const touches = /tabs-todo/.test(line) || /\$TABS_DIR/.test(line);
    return touches && /\brm\s+-|\bmv\s/.test(line);
  });
  assert.deepEqual(suspects, [], `install.sh 里有针对 tabs-todo 的删除/移动：\n${suspects.join("\n")}`);
});

// 克隆件（tabs-todo / menu-todo）的非上游改动必须带 `[herdr-todo]` 标记。
// 为什么值得一条测试：按 README 的升级流程「重新克隆上游文件、再贴回扩展段」时，
// 用上游 main.js 整份覆盖会静默删掉功能——npm test 全绿、两个 herdr-app check 全过、
// grep 不到 codebuddy，功能却没了。menu 的那几处是内联改动（import、菜单项、
// 图标、choose 分支），标记是唯一能让人搜回来的线索。
test("克隆件的非上游改动都带 [herdr-todo] 标记", async () => {
  for (const dir of ["tabs", "menu"]) {
    const text = await fs.readFile(path.join(ROOT, "mod", dir, "main.js"), "utf8");
    const lines = text.split("\n");
    // 「以上是 App 自带 … 的原样克隆」这一行是上游正文与扩展段的分界：分界之上
    // 每处改动都得能被搜回来，分界之下整段都是本项目的扩展。
    const boundary = lines.findIndex((l) => /以上是 App 自带/.test(l));
    assert.ok(boundary > 0, `mod/${dir}/main.js 应有「以上是 App 自带 … 的原样克隆」分界注释`);
    const unmarked = lines.slice(0, boundary).filter((line) => {
      if (!/codebuddy/i.test(line)) return false;
      if (/^\s*(\*|\/\/)/.test(line)) return false; // 注释不算改动
      return !line.includes("[herdr-todo]");
    });
    assert.deepEqual(unmarked, [], `mod/${dir}/main.js 有未标记的改动行：\n${unmarked.join("\n")}`);
  }

  // 标记本身也可能被「只删了那一行、标记留在别处」骗过，所以直接钉住三件事：
  // menu 的菜单项与图标分支在、choose() 真的把它分发出去（否则走 run("codebuddy")
  // 这个不存在的命令，表现为点了没反应）；tabs 的按钮真的绑上了打开动作。
  const menu = await fs.readFile(path.join(ROOT, "mod", "menu", "main.js"), "utf8");
  assert.match(menu, /\["用 CodeBuddy 打开",\s*"codebuddy"/, "menu 的 space 分支应有一条 CodeBuddy 菜单项");
  assert.match(menu, /command === "codebuddy"\s*\?\s*"[a-z-]+"/, "menuIcon 应知道 codebuddy 用什么图标");
  assert.match(menu, /it\[1\] === "codebuddy"[\s\S]{0,120}openInCodeBuddy\(/, "choose() 应把 codebuddy 分发给 openInCodeBuddy");

  const tabs = await fs.readFile(path.join(ROOT, "mod", "tabs", "main.js"), "utf8");
  assert.match(tabs, /openInCodeBuddy\(this,/, "tabs 的按钮应调用 openInCodeBuddy");
  // 按钮的可用判据不能用 Boolean(path)：空 folder 是「那台机器的 home」，是合法目录。
  // 写成 Boolean 时这类 space 的按钮会永远置灰，而 openInCodeBuddy 自己反而会打开 home。
  assert.match(
    tabs,
    /const ready = path !== null && path !== undefined/,
    "按钮可用判据必须区分空字符串（合法目录）与 null/undefined（没有目录）",
  );
});

// spaces-todo 的 space 右键菜单优先用 menu-todo（多了 CodeBuddy 一项）。openOverlay
// 指向不存在的 mod 不抛错、也不显示任何东西（实测返回一个 overlay id），所以
// menu-todo 一旦缺失，丢的是整个 space 右键菜单（重命名/关闭/worktree 全部），
// 而 herdr-app check 不校验目标存在性。这里钉住两层保障：
//   1. 安装清单里必须有 menu-todo（装了 spaces-todo 就装了它）；
//   2. 代码里必须有退回自带 menu 的分支（用户手工删掉时菜单仍然能用）。
test("spaces-todo 对 menu-todo 的依赖既有安装保障也有运行时回退", async () => {
  const spacesSrc = await fs.readFile(path.join(ROOT, "mod", "spaces", "main.js"), "utf8");
  assert.match(spacesSrc, /"menu-todo"/, "spaces-todo 应把 space 菜单指向 menu-todo");
  assert.match(
    spacesSrc,
    /this\.menuTodo\s*\?\s*"menu-todo"\s*:\s*"menu"/,
    "menu-todo 缺失时必须退回自带 menu，否则整份 space 右键菜单静默失效",
  );
  // 探明结果必须来自真实安装目录，而不是常量 true。
  assert.match(spacesSrc, /probeMenuTodo\(\)/, "应有探明 menu-todo 是否装着的逻辑");
  assert.match(spacesSrc, /this\.menuTodo = (false|true)/, "menuTodo 必须有初始值（默认退回自带 menu）");

  const install = await fs.readFile(path.join(ROOT, "install.sh"), "utf8");
  const manifest = /^MOD_MANIFEST='([\s\S]*?)'$/m.exec(install)[1];
  assert.ok(
    manifest.split("\n").some((row) => row.startsWith("menu-todo|")),
    "spaces-todo 依赖 menu-todo，但 install.sh 的清单里没有它",
  );
});

test("侧栏 mod 的模块都能被 Node 解析（语法）", () => {
  for (const f of ["main.js", "store.js", "core.js", "todo-view.js", "todo-drag.js"]) {
    const file = path.join(ROOT, "mod", "spaces", f);
    // node --check 对 ESM 也适用；它只解析不执行，不会碰宿主 API。
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f} 语法错误：${r.stderr}`);
  }
});

test("Agents 栏 mod 的模块都能被 Node 解析（语法）", () => {
  for (const f of ["main.js", "store.js", "core.js", "todo-view.js", "todo-drag.js"]) {
    const file = path.join(ROOT, "mod", "agents", f);
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f} 语法错误：${r.stderr}`);
  }
});

test("安装脚本语法合法（sh -n）", () => {
  for (const f of ["install.sh", "scripts/sync-core.sh", "tests/cli.test.sh"]) {
    const r = spawnSync("sh", ["-n", path.join(ROOT, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f} 语法错误：${r.stderr}`);
  }
});

/**
 * macOS 的 /bin/sh 是 bash 3.2：它按字节解析，`"$X）"` 里的全角右括号会被
 * 并进变量名，set -u 下直接 unbound variable 退出（dash 不会，Linux 上测不出来）。
 * 这类字符串都出现在报错/提示行里，平时跑不到，正好藏在升级路径上。
 */
test("shell 脚本里变量后面不紧跟全角字符", async () => {
  const files = ["install.sh", "scripts/sync-core.sh", "tests/cli.test.sh"];
  for (const f of files) {
    const text = await fs.readFile(path.join(ROOT, f), "utf8");
    text.split("\n").forEach((line, i) => {
      const m = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.exec(line);
      assert.equal(m, null, `${f}:${i + 1} 变量 ${m?.[0]} 后紧跟非 ASCII 字符：改用 \${VAR}`);
    });
  }
});

test("python 安装脚本语法合法", () => {
  for (const f of ["scripts/install-layout.py", "scripts/install-keys.py"]) {
    const r = spawnSync("python3", ["-c", "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())", path.join(ROOT, f)], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `${f} 语法错误：${r.stderr}`);
  }
});
