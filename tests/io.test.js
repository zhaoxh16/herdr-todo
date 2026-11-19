import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createNodeStore, defaultDataPath, ConflictError } from "../src/io.js";
import { emptyState, addItem, setStatus } from "../src/core.js";

async function tmpStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-test-"));
  const file = path.join(dir, "nested", "todos.json");
  return { dir, file, store: createNodeStore(file) };
}

test("默认路径固定，不受 XDG_DATA_HOME 影响", () => {
  assert.ok(defaultDataPath({ HOME: "/home/x" }).endsWith("/.local/share/herdr-todo/todos.json"));
  // mod 沙箱读不到环境变量，只能拼固定路径。CLI 若跟着 XDG 走，两边就会
  // 各写各的文件、都不报错（静默 split-brain），所以这里明确不跟随。
  assert.equal(
    defaultDataPath({ HOME: "/home/x", XDG_DATA_HOME: "/xdg" }),
    "/home/x/.local/share/herdr-todo/todos.json",
  );
});

test("空文件读取返回空状态，而不是报错", async () => {
  const { store } = await tmpStore();
  const st = await store.read();
  assert.deepEqual(st, emptyState());
});

test("写入会自动创建嵌套目录", async () => {
  const { file, store } = await tmpStore();
  await store.write(addItem(emptyState(), { title: "a" }, 1), null);
  const raw = await fs.readFile(file, "utf8");
  assert.equal(JSON.parse(raw).items[0].title, "a");
});

test("CAS：expected 不匹配时拒绝写入且不破坏原文件", async () => {
  const { file, store } = await tmpStore();
  const first = addItem(emptyState(), { title: "a" }, 1);
  const raw1 = await store.write(first, null);

  await assert.rejects(
    () => store.write(addItem(first, { title: "b" }, 2), "stale-content"),
    (e) => e instanceof ConflictError,
  );
  assert.equal(await fs.readFile(file, "utf8"), raw1);
});

test("CAS：expected 为 null 时，文件已存在则拒绝（防止覆盖别人刚写的）", async () => {
  const { store } = await tmpStore();
  await store.write(addItem(emptyState(), { title: "a" }, 1), null);
  await assert.rejects(
    () => store.write(addItem(emptyState(), { title: "b" }, 2), null),
    (e) => e instanceof ConflictError,
  );
});

test("update 在冲突时重读并重放变更，两次并发写都保留", async () => {
  const { store } = await tmpStore();
  await store.write(addItem(emptyState(), { title: "base" }, 1), null);

  // 两个独立 store 实例代表 CLI 与 mod 同时写
  const a = createNodeStore(store.path);
  const b = createNodeStore(store.path);

  await a.update((st) => addItem(st, { title: "from-a" }, 2));
  await b.update((st) => addItem(st, { title: "from-b" }, 3));

  const final = await store.read();
  const titles = final.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ["base", "from-a", "from-b"]);
});

test("update 在并发竞争下仍不丢数据（交错执行）", async () => {
  const { store } = await tmpStore();
  await store.write(emptyState(), null);

  const writers = Array.from({ length: 8 }, (_, i) => {
    const s = createNodeStore(store.path);
    return s.update((st) => addItem(st, { title: `w${i}` }, 100 + i));
  });
  await Promise.all(writers);

  const final = await store.read();
  assert.equal(final.items.length, 8);
  assert.equal(new Set(final.items.map((i) => i.id)).size, 8);
});

test("写入中途失败时抛出冲突，且原文件不变", async () => {
  const { file, store } = await tmpStore();
  const base = addItem(emptyState(), { title: "base" }, 1);
  await store.write(base, null);
  const before = await fs.readFile(file, "utf8");

  await assert.rejects(
    () =>
      store.update((st) => addItem(st, { title: "n" }, 2), {
        _beforeWrite: async () => {
          throw new ConflictError("forced");
        },
      }),
    (e) => e instanceof ConflictError,
  );
  assert.equal(await fs.readFile(file, "utf8"), before, "失败的写不应改动文件");

  // 锁必须被释放，否则下一次写会一直等。
  const after = await store.update((st) => addItem(st, { title: "ok" }, 3));
  assert.equal(after.changed, true);
});

test("损坏的 JSON 抛出可定位错误，不覆盖原文件", async () => {
  const { file, store } = await tmpStore();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{not json", "utf8");
  await assert.rejects(() => store.read(), /JSON|解析/);
  assert.equal(await fs.readFile(file, "utf8"), "{not json");
});

test("写入过程不留临时文件", async () => {
  const { dir, file, store } = await tmpStore();
  await store.write(addItem(emptyState(), { title: "a" }, 1), null);
  const entries = await fs.readdir(path.dirname(file));
  assert.deepEqual(entries, ["todos.json"]);
});
