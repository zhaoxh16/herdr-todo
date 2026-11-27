// 「用编辑器打开」的行为测试。
//
// 这里测的是合同的三个可观察结果，而不是内部实现：
//  1. 打开哪个目录（space 第一个终端的 cwd，回退到 space.folder）——切 pane 不该改变它；
//  2. 每台编辑器本机与远程分别发什么 argv/URI（authority 不能串台）；
//  3. 失败时不静默（有通知）、连点只开一次、没有目录时不发请求、两台编辑器的锁互不干扰。
//
// 宿主的 `herdr` 模块在 Node 里不存在，所以像 argv.test.js 那样把 import 换掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "mod", "codebuddy.js");

// 把 herdr 的三个导入换成可观察的替身；返回加载好的模块与记录器。
async function load({ code = 0, stderr = "", throws = null, hang = false } = {}) {
  const src = await fs.readFile(SRC, "utf8");
  const rec = { execs: [], notes: [] };
  const patched = src.replace(
    /^import \{ exec, notify, home \} from "herdr";$/m,
    `const exec = async (cmd, args, opts) => {
       globalThis.__rec.execs.push({ cmd, args, opts });
       ${hang ? "await new Promise((r) => setTimeout(r, 50));" : ""}
       ${throws ? `throw new Error(${JSON.stringify(throws)});` : ""}
       return { code: ${code}, stdout: "", stderr: ${JSON.stringify(stderr)} };
     };
     const notify = (n) => { globalThis.__rec.notes.push(n); return "n1"; };
     const home = () => "/Users/me";`,
  );
  assert.notEqual(patched, src, "codebuddy.js 的 herdr 导入形态变了：测试的替换没生效");
  const tmp = path.join("/tmp", `codebuddy-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await fs.writeFile(tmp, patched);
  globalThis.__rec = rec;
  const mod = await import(`${tmp}?v=${Math.random()}`);
  return { mod, rec };
}

const pane = (tab, cwd) => ({ tab, cwd });
const space = (over = {}) => ({ id: "s1", folder: "/fallback", machine: null, tabs: [{ id: "tb1" }, { id: "tb2" }], ...over });
// 每台编辑器的锁在宿主视图上；测试用同一形状的最小对象。
const host = () => ({ opening: {} });

test("空间目录：取第一个 tab 里有 cwd 的 pane，切 pane 不改变结果", async () => {
  const { mod } = await load();
  const s = space();
  // 第二个 pane（属于 tab2、cwd 不同）排在前面：算法必须按 space 的 tab 集合
  // 找到第一个有 cwd 的那个，而不是「panes() 里的第一个」。
  const panes = [pane("other", "/elsewhere"), pane("tb2", "/second"), pane("tb1", "/first")];
  assert.equal(mod.spacePath(s, panes), "/second");
  // 一条空间的 pane 都没有 cwd → 回退到 space.folder。
  assert.equal(mod.spacePath(s, [pane("other", "/x")]), "/fallback");
  // 没有 space → null（调用方据此不发请求）。
  assert.equal(mod.spacePath(null, panes), null);
  // 有 cwd 时优先用 cwd，而不是 folder。
  assert.equal(mod.spacePath(space({ folder: "/f" }), [pane("tb1", "/cwd")]), "/cwd");
});

test("编辑器表：两台编辑器的 CLI 与远程 authority 都是各自的那一份", async () => {
  const { mod } = await load();
  assert.match(mod.EDITORS.codebuddy.cli, /CodeBuddy CN\.app\/Contents\/Resources\/app\/bin\/code$/);
  assert.equal(mod.EDITORS.codebuddy.authority, "codebuddy-remote-ssh");
  assert.match(mod.EDITORS.cursor.cli, /Cursor\.app\/Contents\/Resources\/app\/bin\/cursor$/);
  assert.equal(mod.EDITORS.cursor.authority, "ssh-remote");
  assert.notEqual(mod.EDITORS.cursor.cli, mod.EDITORS.codebuddy.cli);
});

test("本机 space：直接传目录，不加 --folder-uri（两台编辑器各自用自己的 CLI）", async () => {
  for (const key of ["codebuddy", "cursor"]) {
    const { mod, rec } = await load();
    const h = host();
    await mod.openInEditor(h, key, { space: space(), path: "/Users/me/proj" });
    assert.equal(rec.execs.length, 1, `${key} 应发一次 exec`);
    assert.deepEqual(rec.execs[0].args, ["/Users/me/proj"]);
    assert.equal(rec.execs[0].cmd, mod.EDITORS[key].cli);
    assert.equal(rec.notes[0].level, "success");
    // 打开完成后锁必须释放，否则第二次点永远没反应。
    assert.equal(h.opening[key], false);
  }
});

test("远程 space：用编辑器自己的 remote-ssh authority，带机器名与原路径", async () => {
  const cb = await load();
  await cb.mod.openInEditor(host(), "codebuddy", { space: space({ machine: "dev8" }), path: "/data/workspace/SQLEngine" });
  assert.deepEqual(cb.rec.execs[0].args, [
    "--folder-uri",
    "vscode-remote://codebuddy-remote-ssh+dev8/data/workspace/SQLEngine",
  ]);

  const cur = await load();
  await cur.mod.openInEditor(host(), "cursor", { space: space({ machine: "dev8" }), path: "/data/workspace/SQLEngine" });
  assert.deepEqual(cur.rec.execs[0].args, [
    "--folder-uri",
    "vscode-remote://ssh-remote+dev8/data/workspace/SQLEngine",
  ]);
  // 两台编辑器不能共用同一个 authority：写成一样的话 Cursor 会认出 CodeBuddy 的前缀，
  // 连不上（反之亦然），而 CLI 照样可能退出 0。
  assert.notEqual(cb.mod.EDITORS.codebuddy.authority, cur.mod.EDITORS.cursor.authority);
});

test("远程路径里的空格与非 ASCII 被编码，不会拆坏 URI", async () => {
  const { mod } = await load();
  assert.equal(
    mod.remoteUri(mod.EDITORS.cursor, "dev8", "/data/my project/中文"),
    "vscode-remote://ssh-remote+dev8/data/my%20project/%E4%B8%AD%E6%96%87",
  );
  // 本机不需要 URI。
  assert.equal(mod.remoteUri(mod.EDITORS.cursor, null, "/x"), null);
});

// `#` 与 `?` 在 URI 里是 fragment / query 的分隔符。整串 encodeURI 不转义它们，
// 编辑器解析后 path 被截断、打开的是父目录，而 CLI 退出码是 0、提示里写的还是
// 用户以为的路径——静默开错目录。git 的 worktree 目录允许 `#`（如 `fix#42`），
// 所以这不是纯理论场景。
test("远程路径里的 # 与 ? 被编码，不会被当成 fragment / query", async () => {
  const { mod } = await load();
  const uri = mod.remoteUri(mod.EDITORS.cursor, "dev8", "/data/worktrees/repo/fix#42");
  assert.equal(uri, "vscode-remote://ssh-remote+dev8/data/worktrees/repo/fix%2342");
  // 按 URI 规则解析回来，path 必须完整——这是「打开的是这个目录」的实际判据。
  const parsed = new URL(uri);
  assert.equal(parsed.pathname, "/data/worktrees/repo/fix%2342");
  assert.equal(parsed.hash, "", "路径里的 # 不能变成 fragment");
  assert.equal(parsed.search, "", "路径里的 ? 不能变成 query");
  assert.equal(decodeURIComponent(parsed.pathname), "/data/worktrees/repo/fix#42");

  const withQuery = mod.remoteUri(mod.EDITORS.cursor, "dev8", "/data/issue?123/files");
  const q = new URL(withQuery);
  assert.equal(q.pathname, "/data/issue%3F123/files");
  assert.equal(q.search, "");
  assert.equal(decodeURIComponent(q.pathname), "/data/issue?123/files");
});

// `%` 本身也必须被编码成 %25。漏掉它时产出的 URI 里 `/data/100%`
// 会带着一个孤立的 `%`，编辑器解析时 decodeURIComponent 直接抛 URI malformed
// ——CLI 可能照样退出 0，而目录根本没被打开。`/data/100%` 与 `/data/%20literal`
// 两个输入同时钉住「编码一次」和「不重复编码」。
test("远程路径里的 % 被编码成 %25，且不会二次解码出错", async () => {
  const { mod } = await load();
  const uri = mod.remoteUri(mod.EDITORS.cursor, "dev8", "/data/100%");
  assert.equal(uri, "vscode-remote://ssh-remote+dev8/data/100%25");
  assert.equal(decodeURIComponent(new URL(uri).pathname), "/data/100%");

  // 路径里本来就有 %20 这种字面量时，要变成 %2520——解码一次得到原样，而不是空格。
  const literal = mod.remoteUri(mod.EDITORS.cursor, "dev8", "/data/%20literal");
  assert.equal(literal, "vscode-remote://ssh-remote+dev8/data/%2520literal");
  assert.equal(decodeURIComponent(new URL(literal).pathname), "/data/%20literal");
});

test("没有目录：不发请求，给出说明用的通知", async () => {
  const { mod, rec } = await load();
  // 字段不存在 / 为 null 才是「没有目录」。
  const h = host();
  await mod.openInEditor(h, "cursor", { space: space({ folder: null, tabs: [] }), panes: [] });
  assert.equal(rec.execs.length, 0);
  assert.equal(rec.notes.length, 1);
  assert.equal(rec.notes[0].level, "warning");
  // 这个分支在取锁之前返回。若有人把「设锁」提到判空之前，按钮会永久卡死：
  // 一次没有目录的点击之后，所有后续点击都被锁吃掉。
  assert.deepEqual(h.opening, {}, "没有目录时不该动锁：否则按钮会永久失效");
  // 没有 space 也不发请求（按钮在 space 为空时不该崩）。
  const { mod: m2, rec: r2 } = await load();
  await m2.openInEditor(host(), "cursor", { space: null, panes: [] });
  assert.equal(r2.execs.length, 0);
  assert.equal(r2.notes[0].level, "warning");
});

// Herdr 把空 folder 文档化成「那台机器的 home」（herdr.d.ts:131）。旧实现用
// `|| space.folder || null` 把 "" 折叠成「没有目录」，于是这类 space 的按钮永远点不动。
test("空 folder 是合法目录：本机开 home，远程开机器上的 home", async () => {
  const s = space({ folder: "", tabs: [], machine: null });
  assert.equal((await load()).mod.spacePath(s, []), "");

  for (const key of ["codebuddy", "cursor"]) {
    const local = await load();
    await local.mod.openInEditor(host(), key, { space: s, panes: [] });
    assert.deepEqual(local.rec.execs[0].args, ["/Users/me"], "本机空 folder → home()");
    assert.equal(local.rec.notes[0].level, "success");

    const remote = await load();
    await remote.mod.openInEditor(host(), key, { space: space({ folder: "", tabs: [], machine: "dev8" }), panes: [] });
    assert.deepEqual(remote.rec.execs[0].args, [
      "--folder-uri",
      `vscode-remote://${remote.mod.EDITORS[key].authority}+dev8`,
    ], "远程空 folder → authority 后不带路径，编辑器连到该机器的 home");
  }
});

test("非 0 退出：发错误通知，远程额外提示可重试", async () => {
  const { mod, rec } = await load({ code: 1, stderr: "boom\nsecond line" });
  await mod.openInEditor(host(), "cursor", { space: space({ machine: "dev8" }), path: "/data/x" });
  const note = rec.notes.find((n) => n.level === "error");
  assert.ok(note, "非 0 退出必须有一条 error 通知");
  assert.match(note.title, /Cursor/, "通知标题要写明是哪个编辑器失败");
  assert.match(note.body, /boom/, "stderr 的第一行应出现在通知里");
  assert.equal(note.body.includes("second line"), false, "通知里只放第一行");
  assert.match(note.body, /再点一次/, "远程失败要提示可重试（首次装 server 会超时）");
});

test("exec 抛错（超时 / 程序不存在）：同样发错误通知，锁被释放", async () => {
  const { mod, rec } = await load({ throws: "timed out" });
  const h = host();
  await mod.openInEditor(h, "cursor", { space: space(), path: "/x" });
  assert.equal(rec.notes.at(-1).level, "error");
  assert.match(rec.notes.at(-1).body, /timed out/);
  assert.equal(h.opening.cursor, false, "抛错后锁必须释放，否则按钮永久失效");
});

test("连点：同一编辑器只发出一次 exec", async () => {
  const { mod, rec } = await load({ hang: true });
  const h = host();
  const [a, b] = await Promise.all([
    mod.openInEditor(h, "cursor", { space: space(), path: "/x" }),
    mod.openInEditor(h, "cursor", { space: space(), path: "/x" }),
  ]);
  assert.equal(rec.execs.length, 1, "并发的第二次点击不该再开一个窗口");
  assert.equal([a, b].filter((r) => r === null).length, 1, "被挡下的那次返回 null");
});

// 两台编辑器的锁必须独立：Cursor 正在开远程（首次要装 server，可能几秒），
// 这时点 CodeBuddy 不该被吞——它们是两个不同的动作。
test("两台编辑器的锁互不干扰", async () => {
  const { mod, rec } = await load({ hang: true });
  const h = host();
  await Promise.all([
    mod.openInEditor(h, "cursor", { space: space(), path: "/x" }),
    mod.openInEditor(h, "codebuddy", { space: space(), path: "/y" }),
  ]);
  assert.equal(rec.execs.length, 2, "Cursor 在飞时 CodeBuddy 仍应能打开");
  assert.deepEqual(rec.execs.map((e) => e.args[0]).sort(), ["/x", "/y"]);
});

test("未知编辑器：抛错而不是静默什么都不做", async () => {
  const { mod, rec } = await load();
  await assert.rejects(() => mod.openInEditor(host(), "vscode", { space: space(), path: "/x" }));
  assert.equal(rec.execs.length, 0);
});

// 右键菜单的视图实例没有 init 里预建锁表（只有 tabs 预建），所以 openInEditor 必须
// 自己惰性创建。若它直接读写 host.opening[key]，菜单第一次点击就会在 undefined 上取键抛错。
test("宿主没有锁表时惰性创建（菜单视图不预建锁）", async () => {
  const { mod, rec } = await load();
  const h = {}; // 没有 opening 字段
  await mod.openInEditor(h, "cursor", { space: space(), path: "/x" });
  assert.equal(rec.execs.length, 1);
  assert.deepEqual(h.opening, { cursor: false }, "第一次点击应建出锁表并释放锁");
});
