// 存储层（src/store/mysql.js）的真库集成测试。
//
// 这里验的都是「签过的验证计划里、单测关不掉」的项：事务隔离、owner 行锁串行化、
// 幂等键、编号连续性、跨 owner 游标。没有可用 MySQL 时整块跳过并给出原因
// （不是静默通过）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { connect } from "../src/store/mysql.js";
import { createCache } from "../src/cache.js";
import { updateItem, createItem } from "../src/sync.js";
import {
  applyCreate,
  applyStatus,
  applyPriority,
  applyNote,
  applyTitle,
} from "../src/rules.js";
import { probe, newOwner, cleanupOwner, rawConnection } from "./support/db.js";
import { ulid } from "../src/ulid.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const P = await probe();
const skip = P.ok ? false : `集成测试跳过：${P.reason}`;
const owners = [];

async function storeFor(slug) {
  owners.push(slug);
  const store = await connect({ ...P.cfg, owner: slug });
  return store;
}

async function tmpCache() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-db-"));
  return createCache(path.join(dir, "todos.json"));
}

after(async () => {
  for (const slug of owners) await cleanupOwner(slug).catch(() => {});
});

test("写一条事项：落行、落事件、缓存只有这一条", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    // 先 pull 建出缓存（首次 pull = 全量重建，此时为空）。
    const { pullOnce } = await import("../src/sync.js");
    const dir = path.dirname(cache.path);
    await pullOnce(store, cache, path.join(dir, "sync.json"), { deviceName: "t@test" });

    const r = await createItem(
      store, cache,
      { title: "修 login", priority: "P1", spaces: ["spA"], by: "cli" },
      { clientOpId: ulid(), applyCreate },
    );
    assert.equal(r.item.title, "修 login");
    assert.equal(r.item.num, 1, "owner 的第一个事项编号应为 1");
    assert.equal(r.item.priority, "P1");
    assert.deepEqual(r.item.spaces, ["spA"]);
    assert.ok(r.seqs.length >= 1);

    const cached = await cache.read();
    assert.equal(cached.items.length, 1);
    assert.equal(cached.items[0].num, 1);
    assert.equal(cached.items[0].title, "修 login");
    assert.equal(cached.synced_through, Math.max(...r.seqs), "本机写入把 synced_through 提到自己的 seq");

    const again = await store.getItem({ num: 1 });
    assert.equal(again.title, "修 login", "按 #1 能读到");
  } finally {
    await store.close();
  }
});

test("同一 owner 并发 add 10 次得到连续的 1..10，无重复无跳号", { skip }, async () => {
  const slug = newOwner();
  owners.push(slug);
  const stores = await Promise.all(
    Array.from({ length: 10 }, () => connect({ ...P.cfg, owner: slug })),
  );
  const cache = await tmpCache();
  try {
    await Promise.all(
      stores.map((s, i) =>
        createItem(s, cache, { title: `并发${i}`, by: "cli" }, { clientOpId: ulid(), applyCreate }),
      ),
    );
    const all = await stores[0].listItems({ includeClosed: true });
    const nums = all.map((i) => i.num).sort((a, b) => a - b);
    assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], `编号应连续唯一，实际 ${nums}`);
  } finally {
    await Promise.all(stores.map((s) => s.close()));
  }
});

test("并发改同一条事项：两次改动都留痕，不丢更新", { skip }, async () => {
  const slug = newOwner();
  owners.push(slug);
  const a = await connect({ ...P.cfg, owner: slug });
  const b = await connect({ ...P.cfg, owner: slug });
  const cache = await tmpCache();
  try {
    const created = await createItem(a, cache, { title: "并发", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const ref = { id: created.item.id };
    const [ra, rb] = await Promise.all([
      updateItem(a, cache, ref, (it) => applyPriority(it, { priority: "P0", at: Date.now(), by: "a" }), { clientOpId: ulid() }),
      updateItem(b, cache, ref, (it) => applyNote(it, { note: "来自 b", at: Date.now(), by: "b" }), { clientOpId: ulid() }),
    ]);
    const final = await a.getItem(ref);
    assert.equal(final.priority, "P0", "a 的改动应保留");
    assert.equal(final.note, "来自 b", "b 的改动应保留（后到者基于前者的结果）");
    assert.ok(final.rev >= 3, `rev 应反映三次写入，实际 ${final.rev}`);

    const [rows] = await a.conn.execute(
      "SELECT kind FROM item_events WHERE item_id = ? ORDER BY seq",
      [ref.id],
    );
    const kinds = rows.map((r) => r.kind);
    assert.deepEqual(kinds, ["created", "priority", "note"], `时间线应三条，实际 ${kinds}`);
  } finally {
    await a.close();
    await b.close();
  }
});

test("幂等：同一 client_op_id 提交两次只落一条事件", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    const created = await createItem(store, cache, { title: "幂等", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const op = ulid();
    const ref = { id: created.item.id };
    const first = await updateItem(store, cache, ref, (it) => applyStatus(it, { status: "doing", at: Date.now(), by: "cli" }), { clientOpId: op });
    assert.equal(first.changed, true);

    // 第二次：同一条事项、同一个幂等键，但规则层要写的是另一个状态。
    // 事务会撞 uk_op 并回滚，然后读回第一次的结果——第二次的 blocked 不该生效。
    const second = await updateItem(store, cache, ref, (it) => applyStatus(it, { status: "blocked", at: Date.now(), by: "cli" }), { clientOpId: op });
    assert.equal(second.changed, false, "幂等重放不该再写一遍");
    assert.equal(second.replayed, true);
    assert.equal(second.item.status, "doing", "返回的是首次调用生效后的当前状态");

    const [rows] = await store.conn.execute(
      "SELECT kind, data FROM item_events WHERE item_id = ? AND kind = 'status'",
      [ref.id],
    );
    assert.equal(rows.length, 1, "幂等键相同的两次提交只能留一条 status 事件");
    const data = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
    assert.equal(data.to, "doing", "留下的是第一次的结果");

    // 事项状态也必须是 doing —— 第二次的 blocked 不该生效。
    const final = await store.getItem(ref);
    assert.equal(final.status, "doing");
  } finally {
    await store.close();
  }
});

test("单调写入与时间线：事件 seq 严格递增，时间线按 seq 排列", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    const created = await createItem(store, cache, { title: "序列", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const ref = { id: created.item.id };
    await updateItem(store, cache, ref, (it) => applyStatus(it, { status: "doing", at: Date.now(), by: "cli" }), { clientOpId: ulid() });
    await updateItem(store, cache, ref, (it) => applyTitle(it, { title: "改了", at: Date.now(), by: "cli" }), { clientOpId: ulid() });

    const [rows] = await store.conn.execute(
      "SELECT seq FROM item_events WHERE item_id = ? ORDER BY seq",
      [ref.id],
    );
    const seqs = rows.map((r) => Number(r.seq));
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq 应严格递增：${seqs}`);
  } finally {
    await store.close();
  }
});

test("租户隔离：第二个 owner 的存在不影响第一个 owner 的编号与列表", { skip }, async () => {
  const a = await storeFor(newOwner("a"));
  const b = await storeFor(newOwner("b"));
  const cache = await tmpCache();
  try {
    const ca = await createItem(a, cache, { title: "a1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const cb = await createItem(b, cache, { title: "b1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const cb2 = await createItem(b, cache, { title: "b2", by: "cli" }, { clientOpId: ulid(), applyCreate });
    assert.equal(ca.item.num, 1);
    assert.equal(cb.item.num, 1, "b 的第一个也是 1：编号按 owner 各自分配");
    assert.equal(cb2.item.num, 2);

    const listA = await a.listItems({ includeClosed: true });
    assert.deepEqual(listA.map((i) => i.title), ["a1"], "a 看不到 b 的事项");
    const listB = await b.listItems({ includeClosed: true });
    assert.deepEqual(listB.map((i) => i.title).sort(), ["b1", "b2"]);
  } finally {
    await a.close();
    await b.close();
  }
});

test("跨 owner 交错提交不漏拉：游标只推进到本 owner 实际取到的最大 seq", { skip }, async () => {
  const a = await storeFor(newOwner("a"));
  const b = await storeFor(newOwner("b"));
  const cache = await tmpCache();
  const pending = await rawConnection();
  try {
    const a1 = await createItem(a, cache, { title: "a1", by: "cli" }, { clientOpId: ulid(), applyCreate });

    // 造出真实交错：A 在自己的事务里写一条事件、**取到号但不提交**，B 随后
    // 提交一条更大的号。这正是「全局 MAX(seq) 不能当游标」失效的那个窗口。
    const ownerA = await a.ownerId();
    await pending.query("BEGIN");
    await pending.query("SELECT item_num FROM owners WHERE id = ? FOR UPDATE", [ownerA]);
    const [ins] = await pending.query(
      "INSERT INTO item_events (owner_id, item_id, kind, data, actor, occurred_at) " +
        "VALUES (?, ?, 'priority', '{\"from\":\"P2\",\"to\":\"P1\"}', 'test', NOW(3))",
      [ownerA, a1.item.id],
    );
    const pendingSeq = Number(ins.insertId);

    await createItem(b, cache, { title: "b1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const [globalRows] = await b.conn.query("SELECT MAX(seq) AS m FROM item_events");
    const globalMax = Number(globalRows[0].m);
    assert.ok(globalMax > pendingSeq, "B 已提交的号应大于 A 未提交的号，否则这条用例没构造出交错");

    // A 此刻 pull：只看得到已提交的 a1，游标必须停在它，不能取全局 MAX。
    const first = await a.pullEvents(0, 500);
    assert.equal(first.maxSeq, a1.seqs.at(-1), "游标取本次结果的最大值");
    assert.ok(first.maxSeq < globalMax, "游标不得推进到全局 MAX(seq)");

    // A 提交那条挂起的事件；若游标先前取过 globalMax，这里就永远拉不到了。
    await pending.query("COMMIT");
    const second = await a.pullEvents(first.maxSeq, 500);
    assert.deepEqual(
      second.events.map((e) => e.seq),
      [pendingSeq],
      "A 提交后仍能拉到（游标没有越过它）",
    );
  } finally {
    await pending.query("ROLLBACK").catch(() => {});
    await pending.end().catch(() => {});
    await a.close();
    await b.close();
  }
});

test("没有新事件时 pullEvents 返回 maxSeq=null（游标不动的判据）", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    await createItem(store, cache, { title: "x", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const first = await store.pullEvents(0, 500);
    assert.ok(first.maxSeq > 0);
    const second = await store.pullEvents(first.maxSeq, 500);
    assert.equal(second.maxSeq, null, "没有事件时必须返回 null，让调用方不动游标");
    assert.deepEqual(second.events, []);
  } finally {
    await store.close();
  }
});

test("全量快照读到的游标上限等于快照开始时的 MAX(seq)", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    await createItem(store, cache, { title: "a", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await createItem(store, cache, { title: "b", by: "cli" }, { clientOpId: ulid(), applyCreate });

    const snap = await store.fullSnapshot({ pageSize: 1 });
    assert.equal(snap.items.length, 2, "分页读要读完（pageSize=1 也要两条）");

    const [rows] = await store.conn.execute(
      "SELECT MAX(seq) AS m FROM item_events WHERE owner_id = (SELECT id FROM owners WHERE slug = ?)",
      [store.ownerSlug],
    );
    // 快照期间没有写入，所以两者应相等。
    assert.equal(snap.maxSeq, Number(rows[0].m));
  } finally {
    await store.close();
  }
});

test("已删除的事项不进列表，但按 id 仍可读到（墓碑要能判断删除）", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    const c = await createItem(store, cache, { title: "待删", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const { applyDelete } = await import("../src/rules.js");
    await updateItem(store, cache, { id: c.item.id }, (it) => applyDelete(it, { at: Date.now(), by: "cli" }), { clientOpId: ulid() });

    const list = await store.listItems({ includeClosed: true });
    assert.equal(list.length, 0, "墓碑不该出现在列表里");
    const gone = await store.getItem({ id: c.item.id });
    assert.ok(gone, "按 id 仍可读到墓碑行");
    assert.ok(gone.deletedAt, "墓碑行带 deletedAt");

    const cached = await cache.read();
    assert.equal(cached.items.length, 0, "写命令后的缓存也应移除它");
  } finally {
    await store.close();
  }
});

test("墓碑回收：两个条件缺一不可", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    const c = await createItem(store, cache, { title: "待回收", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const { applyDelete, canPurge } = await import("../src/rules.js");
    const del = await updateItem(store, cache, { id: c.item.id }, (it) => applyDelete(it, { at: Date.now(), by: "cli" }), { clientOpId: ulid() });

    const delSeq = await store.deleteEventSeq(c.item.id);
    assert.equal(delSeq, Math.max(...del.seqs));

    // 设备还没拉过 → 不能清。
    const deviceId = ulid();
    await store.ensureDevice(deviceId, "test@dev");
    let min = await store.minPulledSeq();
    assert.equal(min, 0);
    assert.equal(
      canPurge({ deletedAt: del.item.deletedAt, deleteSeq: delSeq, minPulledSeq: min, now: Date.now() + 200 * 86400_000, retentionMs: 180 * 86400_000 }),
      false,
      "有设备没拉过该删除事件时不得清理",
    );

    // 设备拉过、且过了保留期 → 可以清。
    await store.setDevicePullSeq(deviceId, delSeq);
    min = await store.minPulledSeq();
    assert.equal(min, delSeq);
    assert.equal(
      canPurge({ deletedAt: del.item.deletedAt, deleteSeq: delSeq, minPulledSeq: min, now: Date.now() + 200 * 86400_000, retentionMs: 180 * 86400_000 }),
      true,
    );

    await store.purgeItem(c.item.id);
    assert.equal(await store.getItem({ id: c.item.id }), null, "物理清除后读不到");
  } finally {
    await store.close();
  }
});

test("时区：写入与读回的时间戳是同一个时刻（不是偏 8 小时的假时间）", { skip }, async () => {
  const store = await storeFor(newOwner());
  const cache = await tmpCache();
  try {
    const before = Date.now();
    const c = await createItem(store, cache, { title: "时区", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const after = Date.now();
    assert.ok(c.item.created >= before - 1000 && c.item.created <= after + 1000,
      `created 应按真实时刻读回，实际 ${new Date(c.item.created).toISOString()}（now ${new Date().toISOString()}）`);

    const [rows] = await store.conn.execute(
      "SELECT UNIX_TIMESTAMP(created_at)*1000 AS ms FROM items WHERE id = ?",
      [c.item.id],
    );
    const fromSql = Number(rows[0].ms);
    assert.ok(Math.abs(fromSql - c.item.created) < 1000, "SQL 侧读到的时刻应与驱动侧一致");
  } finally {
    await store.close();
  }
});
