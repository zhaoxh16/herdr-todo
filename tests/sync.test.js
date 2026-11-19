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

test("安装脚本语法合法（sh -n）", () => {
  for (const f of ["install.sh", "scripts/sync-core.sh", "tests/cli.test.sh"]) {
    const r = spawnSync("sh", ["-n", path.join(ROOT, f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f} 语法错误：${r.stderr}`);
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
