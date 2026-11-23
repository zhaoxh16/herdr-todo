// 旧账本导入（src/import.js）的真库集成测试。
//
// 只覆盖一条容易回归的语义：导入的「缓存预热」与写命令同一条纪律——缓存文件
// 不在时不创建它（spec §4.4）。否则一次 `--force` 重复导入会让库里其余事项
// 永远回不到缓存。导入的字段映射与自检已由迁移时的一次性实测覆盖（18 条，
// 逐条比对），这里不再重抄。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { connect } from "../src/store/mysql.js";
import { createCache } from "../src/cache.js";
import { importLedger } from "../src/import.js";
import { pullOnce } from "../src/sync.js";
import { probe, newOwner, cleanupOwner } from "./support/db.js";

const P = await probe();
const skip = P.ok ? false : `集成测试跳过：${P.reason}`;
const owners = [];

after(async () => {
  for (const slug of owners) await cleanupOwner(slug).catch(() => {});
});

async function legacyLedger(dir, titles) {
  const now = Date.now();
  const items = titles.map((title, i) => ({
    id: `t${i + 1}`,
    title,
    note: "",
    priority: "P2",
    status: "todo",
    spaces: [],
    created: now - (titles.length - i) * 1000,
    updated: now - (titles.length - i) * 1000,
    timeline: [{ at: now - (titles.length - i) * 1000, kind: "created", from: null, to: "todo", by: "me" }],
  }));
  const file = path.join(dir, "legacy.json");
  await fs.writeFile(file, JSON.stringify({ v: 1, seq: items.length, items }));
  return file;
}

test("导入不创建缺失的缓存文件，下一次 pull 整体重建", { skip }, async () => {
  const slug = newOwner("imp");
  owners.push(slug);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-imp-"));
  const store = await connect({ ...P.cfg, owner: slug });
  const cache = createCache(path.join(dir, "cache", "todos.json"));
  const syncFile = path.join(dir, "sync.json");
  try {
    const ledger = await legacyLedger(dir, ["一", "二", "三"]);
    const lines = [];
    const r = await importLedger(store, cache, ledger, { out: (s) => lines.push(s), note: (s) => lines.push(s) });
    assert.deepEqual(r.mismatches, [], "自检应无差异");
    assert.equal(r.imported, 3);

    assert.equal(await cache.exists(), false, "缓存不在时导入不得凭空创建它");
    assert.ok(
      lines.some((l) => l.includes("缓存文件不存在")),
      `应提示缓存留给下一次 pull，实际输出：${lines.join(" / ")}`,
    );

    // 真相已经在库里：pull 整体重建后三条都在。
    const p = await pullOnce(store, cache, syncFile, { deviceName: "imp@test" });
    assert.equal(p.rebuilt, true);
    const st = await cache.read();
    assert.deepEqual(st.items.map((i) => i.title), ["一", "二", "三"]);
    assert.ok(st.synced_through > 0, "重建后 synced_through 应等于快照上限");
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("缓存路径上就是 v1 旧账本、且它就是导入源：预热跳过它，绝不改写源文件", { skip }, async () => {
  const slug = newOwner("imp");
  owners.push(slug);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-imp-"));
  const store = await connect({ ...P.cfg, owner: slug });
  // 最自然的用法：源文件就是默认缓存路径。
  const cache = createCache(path.join(dir, "todos.json"));
  const syncFile = path.join(dir, "sync.json");
  const source = cache.path;
  try {
    const ledger = await legacyLedger(dir, ["一"]);
    const raw = await fs.readFile(ledger, "utf8");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, raw, "utf8");

    const notes = [];
    const r = await importLedger(store, cache, source, { out: () => {}, note: (s) => notes.push(s) });
    assert.equal(r.imported, 1, "导入本身必须成功（真相在库）");
    assert.equal(await fs.readFile(source, "utf8"), raw, "v1 源文件一个字节都不能变");
    assert.ok(
      notes.some((l) => l.includes("v1 旧账本")),
      `应提示缓存留给下一次 pull，实际：${notes.join(" / ")}`,
    );

    // 用户按提示把源文件改名移走后，pull 能正常重建。
    await fs.rename(source, path.join(dir, "moved.v1.json"));
    const p = await pullOnce(store, cache, syncFile, { deviceName: "imp@test" });
    assert.equal(p.rebuilt, true);
    assert.deepEqual((await cache.read()).items.map((i) => i.title), ["一"]);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("缓存已存在时，导入把条目合进去并把 synced_through 提到导入的 seq", { skip }, async () => {
  const slug = newOwner("imp");
  owners.push(slug);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-imp-"));
  const store = await connect({ ...P.cfg, owner: slug });
  const cache = createCache(path.join(dir, "cache", "todos.json"));
  const syncFile = path.join(dir, "sync.json");
  try {
    // 先 pull 一次把缓存建出来（空库 → 空快照）。
    await pullOnce(store, cache, syncFile, { deviceName: "imp@test" });
    const before = await cache.read();
    assert.equal(before.items.length, 0);
    assert.equal(await cache.exists(), true);

    const ledger = await legacyLedger(dir, ["甲", "乙"]);
    await importLedger(store, cache, ledger, { out: () => {}, note: () => {} });

    const after = await cache.read();
    assert.deepEqual(after.items.map((i) => i.title), ["甲", "乙"], "导入应把条目合进已有缓存");
    assert.ok(after.synced_through > before.synced_through, "保护戳提到导入事件的实际 seq");

    const [rows] = await store.conn.execute(
      "SELECT MAX(seq) AS m FROM item_events WHERE owner_id = (SELECT id FROM owners WHERE slug = ?)",
      [slug],
    );
    assert.equal(after.synced_through, Number(rows[0].m), "与库里实际最大 seq 相等，下次 pull 不会重放");
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("--json 时 stdout 只有一份可解析的 JSON，过程提示走 note", { skip }, async () => {
  const slug = newOwner("imp");
  owners.push(slug);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-imp-"));
  const store = await connect({ ...P.cfg, owner: slug });
  const cache = createCache(path.join(dir, "cache", "todos.json"));
  try {
    const ledger = await legacyLedger(dir, ["甲"]);

    // dry-run：一次调用只写一行 JSON。
    const dry = [];
    const notesDry = [];
    await importLedger(store, cache, ledger, {
      dryRun: true, json: true, out: (s) => dry.push(s), note: (s) => notesDry.push(s),
    });
    assert.equal(dry.length, 1, `--json 的 dry-run 只该输出一行，实际：${dry.join(" / ")}`);
    const parsedDry = JSON.parse(dry[0]);
    assert.equal(parsedDry.dryRun, true);
    assert.equal(parsedDry.items, 1);

    // 真导入：过程的「已备份」「缓存跳过」不许混进 stdout。
    const real = [];
    const notesReal = [];
    await importLedger(store, cache, ledger, {
      json: true, out: (s) => real.push(s), note: (s) => notesReal.push(s),
    });
    const parsedReal = JSON.parse(real.join("\n"));
    assert.equal(parsedReal.imported, 1);
    assert.deepEqual(parsedReal.mismatches, []);
    assert.ok(
      notesReal.some((l) => l.includes("已备份")),
      `备份提示应走 note，实际 note：${notesReal.join(" / ")}`,
    );
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("缓存损坏时导入仍算成功（事务已提交），留给下一次 pull 重建", { skip }, async () => {
  const slug = newOwner("imp");
  owners.push(slug);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-imp-"));
  const store = await connect({ ...P.cfg, owner: slug });
  const cache = createCache(path.join(dir, "cache", "todos.json"));
  const syncFile = path.join(dir, "sync.json");
  try {
    await pullOnce(store, cache, syncFile, { deviceName: "imp@test" });
    await fs.writeFile(cache.path, "{not json", "utf8");

    const notes = [];
    const r = await importLedger(store, cache, await legacyLedger(dir, ["甲"]), {
      out: () => {}, note: (s) => notes.push(s),
    });
    assert.equal(r.imported, 1, "数据已提交，导入不能被缓存问题判成失败");
    assert.ok(
      notes.some((l) => l.includes("缓存不是合法 JSON")),
      `应提示缓存留给下一次 pull，实际：${notes.join(" / ")}`,
    );

    const p = await pullOnce(store, cache, syncFile, { deviceName: "imp@test" });
    assert.equal(p.rebuilt, true, "下一次 pull 应识别损坏并整体重建");
    assert.deepEqual((await cache.read()).items.map((i) => i.title), ["甲"]);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
