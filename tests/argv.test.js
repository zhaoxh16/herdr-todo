// 模拟宿主 exec，只为断言 mod/store.js 组装的 argv 形态。
//
// 面板与 CLI 之间只有 argv 这一层契约。面板把用户文本（标题、备注）和
// 自己的选项拼进同一个数组，一旦顺序或分隔符写错，标题叫 `-h`、`--` 或
// `--space` 的用户就会遇到「静默不创建」「标题与关联对调」，而且 CLI 都
// exit 0。herdr-app check 不会触发这些分支，所以只能在 Node 里用假 exec
// 把形态钉死。
//
// 数据迁到 MySQL 后有一处必须一起钉住：**argv 里不能再出现 --file 或任何
// 连接参数**。面板没有、也不该有数据库口令；它靠 CLI 读本机配置文件。
// 一旦有人把 --file 加回来，写路径就会退回到「另写一个文件」，两条路径分叉。
import { test } from "node:test";
import assert from "node:assert/strict";
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
       const readTextFile = async (p) => (globalThis.__files ?? {})[p] ?? null;
       const exec = async (cli, argv, opts) => { globalThis.__argv = { cli, argv, opts }; return (globalThis.__execResult ?? { code: 0, stdout: "{}" }); };`)
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
  assert.deepEqual(argv, ["--json", "--by", "panel", "--space=spA", "add", "--", "-h"]);

  await m.command(["add", "--"], {});
  assert.equal(globalThis.__argv.argv.at(-2), "--");
  assert.equal(globalThis.__argv.argv.at(-1), "--");

  await m.command(["note", "#1"], { flags: ["--note=--space x"] });
  assert.ok(globalThis.__argv.argv.includes("--note=--space x"));
  assert.equal(globalThis.__argv.argv.at(-3), "note");
});

test("面板 argv 里没有 --file、--db 或任何口令：连接参数只从本机配置读", async () => {
  const m = await loadWithExec();
  for (const args of [["add", "x"], ["status", "#1", "doing"], ["pull"], ["move", "#1", "spB"]]) {
    await m.command(args, { flags: ["--space=spA"] });
    const { argv } = globalThis.__argv;
    for (const a of argv) {
      assert.ok(!String(a).startsWith("--file"), `argv 不该带 --file：${JSON.stringify(argv)}`);
      assert.ok(!String(a).startsWith("--db"), `argv 不该带 --db：${JSON.stringify(argv)}`);
      assert.ok(!/mysql:\/\//.test(String(a)), `argv 不该带连接串：${JSON.stringify(argv)}`);
    }
  }
});

test("退出码 4 映射成 UnreachableError，3 映射成 ConflictError", async () => {
  const m = await loadWithExec();
  globalThis.__execResult = { code: 4, stdout: "", stderr: "连不上数据库" };
  await assert.rejects(() => m.command(["add", "x"]), (e) => e instanceof m.UnreachableError);

  globalThis.__execResult = { code: 3, stdout: "", stderr: "锁超时" };
  await assert.rejects(() => m.command(["add", "x"]), (e) => e instanceof m.ConflictError);

  globalThis.__execResult = { code: 1, stdout: "", stderr: "找不到事项" };
  await assert.rejects(() => m.command(["add", "x"]), /找不到事项/);
  globalThis.__execResult = undefined;
});

test("sync() 不抛错：拉取失败时返回原因与上次成功时间", async () => {
  const m = await loadWithExec();
  globalThis.__files = {
    "/tmp/fake-home/.config/herdr-todo/sync.json": JSON.stringify({
      device_id: "01JDEVICE",
      pull_cursor: 42,
      last_pull_at: 1794997750119,
    }),
  };
  globalThis.__execResult = { code: 0, stdout: "已是最新" };
  const ok = await m.sync();
  assert.equal(ok.ok, true);
  assert.equal(ok.lastPullAt, 1794997750119);

  globalThis.__execResult = { code: 4, stdout: "", stderr: "连不上数据库" };
  const bad = await m.sync();
  assert.equal(bad.ok, false, "拉取失败必须如实返回 ok=false，不能抛穿");
  assert.match(bad.error, /连不上/);
  assert.equal(bad.lastPullAt, 1794997750119, "失败时仍要给出上次成功时间");

  globalThis.__execResult = undefined;
  globalThis.__files = {};
});

// exec 自己抛错（CLI 不在、宿主超时）时，sync() 仍必须返回原因而不是抛穿：
// 面板的轮询循环靠它每 10 秒决定「显示缓存 + 一行提示」，抛出去就整个侧栏报错。
test("sync() 在 exec 抛错时不抛：分别报「找不到命令」与普通失败", async () => {
  const m = await loadWithExec();
  const src = await fs.readFile(STORE, "utf8");
  // 单独换一份「exec 会 throw」的模块：这套替身必须覆盖真实宿主的行为差异。
  const patched = src
    .replace(/^import \{ readTextFile, exec, home \} from "herdr";$/m,
      `const home = () => "/tmp/fake-home";
       const readTextFile = async (p) => (globalThis.__files ?? {})[p] ?? null;
       const exec = async () => { throw new Error(globalThis.__execThrow ?? "boom"); };`)
    .replace(/^import \{ normalizeState, emptyState \} from "\.\/core\.js";$/m,
      `import { normalizeState, emptyState } from "${ROOT}/mod/core.js";`);
  const tmp = path.join("/tmp", `store-throw-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await fs.writeFile(tmp, patched);
  const t = await import(tmp + `?v=${Math.random()}`);

  globalThis.__execThrow = "spawn herdr-todo ENOENT";
  const missing = await t.sync();
  assert.equal(missing.ok, false, "命令不在也不能抛穿轮询循环");
  assert.match(missing.error, /install\.sh/, "「没装」要能在提示里看出来");

  // command() 是那个区分「没装」与「其它失败」的地方：前者单独一个错误类型，
  // 让界面可以说「请先运行 install.sh」而不是一句笼统的失败。
  await assert.rejects(() => t.command(["pull"]), (e) => e instanceof t.CliMissingError);

  globalThis.__execThrow = "操作超时";
  await assert.rejects(() => t.command(["pull"]), /操作超时/);
  globalThis.__execThrow = undefined;
  void m;
});
