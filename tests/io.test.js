// 缓存与文件原语（src/cache.js）的单测：原子写、写保护、锁、sync.json。
//
// 这些是「不连库也要能测」的部分，也是丢数据风险最集中的地方：写保护判断错
// 会让慢速 pull 覆盖刚提交的写入；原子写写错会留下半截 JSON。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createCache,
  defaultDataDir,
  pathsFor,
  readSync,
  writeSync,
  advanceSync,
  atomicWrite,
  withLock,
  ConflictError,
} from "../src/cache.js";

async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-cache-"));
  return { dir, file: path.join(dir, "nested", "todos.json") };
}

function cacheOf(items, through = 0) {
  return { v: 2, synced_through: through, synced_at: 0, items };
}

const item = (id, over = {}) => ({
  id,
  num: over.num ?? 1,
  title: id,
  note: "",
  priority: "P2",
  status: "todo",
  spaces: [],
  created: 1,
  updated: over.updated ?? 1,
  timeline: [],
});

test("路径固定在 ~/.local/share 与 ~/.config，不跟随 XDG", () => {
  assert.ok(defaultDataDir({ HOME: "/home/x" }).endsWith("/.local/share/herdr-todo"));
  const p = pathsFor({ HOME: "/home/x", XDG_DATA_HOME: "/xdg" });
  assert.equal(p.cache, "/home/x/.local/share/herdr-todo/todos.json");
  assert.equal(p.sync, "/home/x/.config/herdr-todo/sync.json");
  assert.equal(p.config, "/home/x/.config/herdr-todo/config.json");
});

test("空文件读成空缓存，而不是报错", async () => {
  const { file } = await tmp();
  const st = await createCache(file).read();
  assert.equal(st.v, 2);
  assert.deepEqual(st.items, []);
});

// 「不存在」与「存在但为空」必须可区分：前者要触发全量重建（否则面板会
// 永远空白），后者是一份合法的空快照。
test("exists() 区分「文件不存在」与「空文件」", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  assert.equal(await cache.exists(), false, "从未写过 → 不存在");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "", "utf8");
  assert.equal(await cache.exists(), true, "空文件是存在的缓存");
});

// 但「空文件」不能当作可合并的基线：从空基线合并只会留下本批涉及的事项。
// isBlank() 把缺失与 0 字节一并算作没有基线，而正常写出的空快照仍算有基线。
test("isBlank() 把缺失与 0 字节算作没有基线，合法空快照不算", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  assert.equal(await cache.isBlank(), true, "从未写过 → 没有基线");

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "", "utf8");
  assert.equal(await cache.isBlank(), true, "0 字节（`> todos.json`）→ 没有基线");

  await fs.writeFile(file, "  \n\t\n", "utf8");
  assert.equal(await cache.isBlank(), true, "只有空白也算没有基线");

  // 正常写出的空缓存是完整 JSON，是一份合法的空快照。
  await cache.replace(cacheOf([], 0));
  assert.equal(await cache.isBlank(), false, "完整 JSON 的空快照不是 blank");
  assert.equal((await cache.read()).items.length, 0);
});

test("原子写会自动创建嵌套目录，且不留临时文件", async () => {
  const { file } = await tmp();
  await atomicWrite(file, "hello");
  assert.equal(await fs.readFile(file, "utf8"), "hello");
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["todos.json"]);
});

test("原子写保留原文件权限（0600 不会变成 0644）", async () => {
  const { file } = await tmp();
  await atomicWrite(file, "a");
  await fs.chmod(file, 0o600);
  await atomicWrite(file, "bb");
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, "备注是明文，重写不该放宽权限");
});

// 缓存文件被做成 dotfiles 链接时，一次写入不该把链接替换成普通文件——那样
// 真相目标永远停在旧内容，而备份/同步的那一侧看到的是「没人再更新它」。
test("原子写穿过符号链接写到目标，不替换链接本身", async () => {
  const { dir } = await tmp();
  const real = path.join(dir, "dotfiles", "todos.json");
  const link = path.join(dir, "todos.json");
  await fs.mkdir(path.dirname(real), { recursive: true });
  await fs.writeFile(real, "old", "utf8");
  await fs.symlink(real, link);

  await atomicWrite(link, "new");
  assert.ok((await fs.lstat(link)).isSymbolicLink(), "链接必须还在");
  assert.equal(await fs.readFile(real, "utf8"), "new", "内容应写在链接的目标上");
});

test("悬空符号链接：写出目标文件，不把链接替换掉", async () => {
  const { dir } = await tmp();
  const real = path.join(dir, "dotfiles", "todos.json");
  const link = path.join(dir, "todos.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.symlink(real, link); // 目标还不存在

  await atomicWrite(link, "first");
  assert.ok((await fs.lstat(link)).isSymbolicLink(), "链接必须还在");
  assert.equal(await fs.readFile(real, "utf8"), "first");
});

test("cache.update 在 synced_through 前进时落盘", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  const r = await cache.update(() => cacheOf([item("a")], 5));
  assert.equal(r.written, true);
  assert.equal((await cache.read()).synced_through, 5);
});

test("cache.update 拒绝把缓存写旧（synced_through 倒退）", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  await cache.update(() => cacheOf([item("a")], 10));

  // 模拟慢速 pull：它手里的世界观停在 seq=5。
  let calls = 0;
  const r = await cache.update((baseline) => {
    calls++;
    // 第一次想写回 5（被拒），第二次拿到新基线后按纪律合并。
    if (baseline.synced_through >= 10) {
      return cacheOf([...baseline.items, item("b")], 10);
    }
    return cacheOf([item("a")], 5);
  });
  assert.equal(r.written, true);
  assert.ok(calls >= 1, "mutate 应被调用");
  const final = await cache.read();
  assert.equal(final.synced_through, 10, "游标不得倒退");
  assert.deepEqual(final.items.map((i) => i.id).sort(), ["a", "b"], "合并进较新基线，不覆盖");
});

test("cache.update 重试用尽时抛 ConflictError，而不是静默丢写入", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  await cache.update(() => cacheOf([item("a")], 100));
  await assert.rejects(
    () => cache.update(() => cacheOf([item("z")], 1), { maxAttempts: 3 }),
    (e) => e instanceof ConflictError,
  );
  const final = await cache.read();
  assert.equal(final.synced_through, 100);
  assert.deepEqual(final.items.map((i) => i.id), ["a"], "被拒的写入不该留下痕迹");
});

test("cache.update 返回 null 表示不写", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  const r = await cache.update(() => null);
  assert.equal(r.written, false);
  await assert.rejects(() => fs.stat(file), /ENOENT/, "不写就不该创建文件");
});

// 写命令走这一条：缓存文件被删掉时不能从空基线写出一份「只含本条」的缓存，
// 否则下一次 pull 会认为缓存可合并、其余事项（事件已在游标之下）永不回来。
test("requireExisting：缓存文件不存在时不创建，交回 missing", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  const r = await cache.update(() => cacheOf([item("a")], 5), { requireExisting: true });
  assert.equal(r.written, false);
  assert.equal(r.missing, true);
  await assert.rejects(() => fs.stat(file), /ENOENT/, "缺文件时不得创建");

  // 文件存在时照常写。
  const c2 = await cache.update(() => cacheOf([item("b")], 6));
  assert.equal(c2.written, true);
  const c3 = await cache.update(() => cacheOf([item("c")], 7), { requireExisting: true });
  assert.equal(c3.written, true);
  assert.equal(c3.missing, undefined);
});

test("同一文件上的两个 cache 实例串行执行，不互相覆盖", async () => {
  const { file } = await tmp();
  const a = createCache(file);
  const b = createCache(file);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? a : b).update((baseline) => {
        const items = [...baseline.items, item(`i${i}`)];
        return { ...baseline, items };
      }),
    ),
  );
  const final = await a.read();
  assert.equal(final.items.length, 8);
  assert.equal(new Set(final.items.map((i) => i.id)).size, 8);
});

test("withLock 在函数抛错后仍释放锁", async () => {
  const { file } = await tmp();
  await assert.rejects(() => withLock(file, () => { throw new Error("boom"); }), /boom/);
  // 锁没释放的话这里会等 5 秒然后超时。
  await withLock(file, async () => {});
  assert.ok(true);
});

test("withLock 会回收陈旧的锁目录", async () => {
  const { file } = await tmp();
  const lockDir = `${file}.lock`;
  await fs.mkdir(lockDir, { recursive: true });
  const old = Date.now() - 60_000;
  await fs.utimes(lockDir, old / 1000, old / 1000);
  // staleLockMs 默认 10 s，60 s 前的锁应被回收。
  await withLock(file, async () => {});
  assert.ok(true);
});

test("缓存路径上是 v1 旧账本：报 legacy_ledger，且绝不按 corrupt 处理", async () => {
  const { file } = await tmp();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const ledger = JSON.stringify({
    v: 1,
    items: [{ id: "t1", title: "唯一一份旧数据", status: "todo", priority: "P2", spaces: [], timeline: [] }],
  });
  await fs.writeFile(file, ledger, "utf8");
  const cache = createCache(file);

  await assert.rejects(
    () => cache.read(),
    (e) => e.code === "legacy_ledger",
    "必须是专门错误码：corrupt 会触发全量重建，那正好是销毁动作",
  );

  // 写命令的合并路径同样不能碰它；从这里抛出去，调用方跳过缓存而不是覆盖。
  await assert.rejects(() => cache.update(() => cacheOf([item("x")], 1)), (e) => e.code === "legacy_ledger");
  // 即便是「从损坏恢复」，v1 也不是损坏：整体替换同样被拦下。
  await assert.rejects(
    () => cache.update(() => cacheOf([item("y")], 7), { fromCorrupt: true }),
    (e) => e.code === "legacy_ledger",
  );
  assert.equal(await fs.readFile(file, "utf8"), ledger, "一次都不许改动它");
});

test("cache.backup 留副本，空白文件没有可备份的东西", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  assert.equal(await cache.backup("bak"), null, "文件不存在时不造空备份");

  await cache.update(() => cacheOf([item("a")], 3));
  const to = await cache.backup("bak");
  assert.ok(to && to.includes(".bak-"), `应返回备份路径，收到 ${to}`);
  assert.equal(await fs.readFile(to, "utf8"), await fs.readFile(file, "utf8"), "备份内容与原文件一致");
});

test("cache.remove 删掉缓存文件（重建前清掉上一租户的基线）", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  await cache.update(() => cacheOf([item("a")], 3));
  await cache.remove();
  assert.equal(await cache.exists(), false);
  await cache.remove(); // 幂等：文件本来就不在也不报错
});

test("sync.json 读写出入一致；损坏时返回 corrupt 而不是当成空", async () => {  const { dir } = await tmp();
  const f = path.join(dir, "sync.json");
  assert.equal(await readSync(f), null, "文件不存在返回 null");

  await writeSync(f, { device_id: "01JDEV", pull_cursor: 42, last_pull_at: 123 });
  const got = await readSync(f);
  assert.equal(got.device_id, "01JDEV");
  assert.equal(got.pull_cursor, 42);
  assert.equal(got.last_pull_at, 123);

  await fs.writeFile(f, "{not json", "utf8");
  const bad = await readSync(f);
  assert.equal(bad.corrupt, true, "损坏必须如实报告，不能静默当成 0");
  assert.equal(await fs.readFile(f, "utf8"), "{not json", "读失败不该改动文件");
});

test("sync.json 缺字段时按 0/null 补齐（旧版本写的文件仍可读）", async () => {
  const { dir } = await tmp();
  const f = path.join(dir, "sync.json");
  await fs.writeFile(f, JSON.stringify({ device_id: "x" }), "utf8");
  const got = await readSync(f);
  assert.equal(got.pull_cursor, 0);
  assert.equal(got.last_pull_at, null);
  assert.equal(got.owner, null, "旧文件没有 owner：读成 null（未知），不是空串");
});

test("sync.json 记下的 owner 原样读回（换身份要靠它判断）", async () => {
  const { dir } = await tmp();
  const f = path.join(dir, "sync.json");
  await writeSync(f, { device_id: "x", owner: "me", pull_cursor: 1, last_pull_at: 1 });
  assert.equal((await readSync(f)).owner, "me");
});

test("advanceSync 单调：并发 pull 交错写不会把游标写小", async () => {
  const { dir } = await tmp();
  const f = path.join(dir, "sync.json");
  // 两个 pull 各自读到旧值 10，一个要写到 12、一个（较慢/较旧的那批）要写 11。
  await writeSync(f, { device_id: "d", owner: "me", pull_cursor: 10, last_pull_at: 1 });
  await advanceSync(f, { device_id: "d", owner: "me", pull_cursor: 12, last_pull_at: 2 });
  const after = await advanceSync(f, { device_id: "d", owner: "me", pull_cursor: 11, last_pull_at: 3 });
  assert.equal(after.pull_cursor, 12, "返回的是落盘值");
  assert.equal((await readSync(f)).pull_cursor, 12, "较旧的写入不能把游标退回去");

  // 前进照常生效。
  await advanceSync(f, { device_id: "d", owner: "me", pull_cursor: 20, last_pull_at: 4 });
  assert.equal((await readSync(f)).pull_cursor, 20);
});

test("cache.replace 整体替换（供全量重建），不做写保护", async () => {
  const { file } = await tmp();
  const cache = createCache(file);
  await cache.update(() => cacheOf([item("a"), item("b")], 50));
  await cache.replace(cacheOf([item("c")], 50));
  const final = await cache.read();
  assert.deepEqual(final.items.map((i) => i.id), ["c"], "整体替换才让「库里已不存在的事项」消失");
});

test("损坏的缓存 JSON 抛出可定位错误，不覆盖原文件", async () => {
  const { file } = await tmp();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{not json", "utf8");
  await assert.rejects(() => createCache(file).read(), /JSON|缓存/);
  assert.equal(await fs.readFile(file, "utf8"), "{not json");
});

test("损坏的缓存：普通 update 拒绝写入，fromCorrupt 才允许整体重建", async () => {
  const { file } = await tmp();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{not json", "utf8");
  const cache = createCache(file);

  // 写命令的合并路径：不能把损坏文件当成空缓存再往上叠，否则别的条目全丢。
  await assert.rejects(
    () => cache.update(() => cacheOf([item("x")], 1)),
    (e) => e.code === "corrupt",
  );
  assert.equal(await fs.readFile(file, "utf8"), "{not json", "拒绝时不得改动文件");

  // 全量重建：允许从空基线起步并整体替换。
  const res = await cache.update(() => cacheOf([item("y")], 7), { fromCorrupt: true });
  assert.equal(res.written, true);
  const final = await cache.read();
  assert.deepEqual(final.items.map((i) => i.id), ["y"]);
  assert.equal(final.synced_through, 7);
});
