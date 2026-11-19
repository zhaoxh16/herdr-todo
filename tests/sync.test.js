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
