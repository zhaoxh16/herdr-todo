// 模拟宿主 exec，只为断言 mod/store.js 组装的 argv 形态。
//
// 面板与 CLI 之间只有 argv 这一层契约。面板把用户文本（标题、备注）和
// 自己的选项拼进同一个数组，一旦顺序或分隔符写错，标题叫 `-h`、`--` 或
// `--space` 的用户就会遇到「静默不创建」「写到默认账本」「标题与关联对调」，
// 而且 CLI 都 exit 0。herdr-app check 不会触发这些分支，所以只能在 Node 里
// 用假 exec 把形态钉死。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORE = path.join(ROOT, "mod", "store.js");

async function loadWithExec(record) {
  const src = await fs.readFile(STORE, "utf8");
  // 把 herdr 导入换成假的；存到 /tmp 下的临时模块里加载。
  const patched = src
    .replace(/^import \{ readTextFile, exec, home \} from "herdr";$/m,
      `const home = () => "/tmp/fake-home";
       const readTextFile = async () => null;
       const exec = async (cli, argv, opts) => { globalThis.__argv = { cli, argv, opts }; return { code: 0, stdout: "{}" }; };`)
    .replace(/^import \{ normalizeState, emptyState \} from "\.\/core\.js";$/m,
      `import { normalizeState, emptyState } from "${ROOT}/mod/core.js";`);
  const tmp = path.join("/tmp", `store-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await fs.writeFile(tmp, patched);
  return import(tmp + `?v=${Math.random()}`);
}

test("面板 argv：自己的选项在前，-- 隔开位置参数", async () => {
  const m = await loadWithExec();
  await m.command(["add", "-h"], { flags: ["--space=spA"] });
  const { argv } = globalThis.__argv;
  assert.deepEqual(argv, ["--json", "--by", "panel", "--file=/tmp/fake-home/.local/share/herdr-todo/todos.json", "--space=spA", "add", "--", "-h"]);

  await m.command(["add", "--"], {});
  assert.equal(globalThis.__argv.argv.at(-2), "--");
  assert.equal(globalThis.__argv.argv.at(-1), "--");

  await m.command(["note", "t1"], { flags: ["--note=--space x"] });
  assert.ok(globalThis.__argv.argv.includes("--note=--space x"));
  assert.equal(globalThis.__argv.argv.at(-3), "note");
});
