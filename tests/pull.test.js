// pull 与缓存派生的测试（spec §7 的 F1 各行）。
//
// 大部分用例只连真库但不连「第二台设备」——设备用独立的 store 连接与独立的
// sync.json 模拟。没有可用的 MySQL 时整块跳过并给出原因。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { connect } from "../src/store/mysql.js";
import { createCache, readSync, ownerMismatch, invalidateLocalState } from "../src/cache.js";
import { updateItem, createItem, pullOnce } from "../src/sync.js";
import { applyCreate, applyStatus, applyPriority } from "../src/rules.js";
import { probe, newOwner, cleanupOwner } from "./support/db.js";
import { ulid } from "../src/ulid.js";

const P = await probe();
const skip = P.ok ? false : `集成测试跳过：${P.reason}`;
const owners = [];

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-pull-"));
}

/** 一台「设备」：自己的 store 连接、自己的缓存文件、自己的 sync.json。 */
async function device(slug, name) {
  const dir = await tmpDir();
  const store = await connect({ ...P.cfg, owner: slug });
  const cache = createCache(path.join(dir, "todos.json"));
  const syncFile = path.join(dir, "sync.json");
  return { store, cache, syncFile, name, dir };
}

function ownerSlug() {
  const s = newOwner("pull");
  owners.push(s);
  return s;
}

after(async () => {
  for (const slug of owners) await cleanupOwner(slug).catch(() => {});
});

test("增量拉取：两台设备交错写，各自 pull 后缓存一致；重复 pull 幂等", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  const b = await device(slug, "b@test");
  try {
    await createItem(a.store, a.cache, { title: "a 建", by: "cli" }, { clientOpId: ulid(), applyCreate });

    // b 首次 pull：拿到 a 的那条。
    const r1 = await pullOnce(b.store, b.cache, b.syncFile, { deviceName: "b@test" });
    assert.equal(r1.rebuilt, true, "首次 pull（没有 sync.json）走全量重建");
    assert.equal((await b.cache.read()).items.length, 1);

    // b 写一条、a 改 b 建的那条 —— 交错。
    const aItem = (await a.store.getItem({ num: 1 }));
    await createItem(b.store, b.cache, { title: "b 建", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await updateItem(
      a.store, a.cache, { id: aItem.id },
      (it) => applyStatus(it, { status: "doing", at: Date.now(), by: "cli" }),
      { clientOpId: ulid() },
    );

    await pullOnce(b.store, b.cache, b.syncFile, { deviceName: "b@test" });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    const ca = await a.cache.read();
    const cb = await b.cache.read();
    const strip = (st) => st.items.map((i) => `${i.num}|${i.title}|${i.status}`).sort();
    assert.deepEqual(strip(ca), strip(cb), "两端缓存最终一致（编号/标题/状态）");

    // 重复 pull：游标已到顶，什么也不该变。
    const before = JSON.stringify(await b.cache.read());
    const r3 = await pullOnce(b.store, b.cache, b.syncFile, { deviceName: "b@test" });
    assert.equal(r3.applied, 0);
    assert.equal(r3.advanced, false);
    assert.equal(JSON.stringify(await b.cache.read()), before, "重复 pull 不改变缓存");
  } finally {
    await a.store.close();
    await b.store.close();
  }
});

test("两个游标不可合并：本机写入推进 synced_through，但不推进 pull_cursor", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  const b = await device(slug, "b@test");
  try {
    // a 先 pull 一次：建好缓存与 sync.json。缓存不存在时写命令不刷缓存
    // （见 flushToCache 的 requireExisting），那条路径另有专测。
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    const cursor0 = (await readSync(a.syncFile)).pull_cursor;

    // b 先写（较小的 seq），a 后写（较大的 seq）。若两游标被合并，a 的
    // pull_cursor 会推到自己这条之上，b1 就永远拉不到了。
    await createItem(b.store, b.cache, { title: "b1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await createItem(a.store, a.cache, { title: "a1", by: "cli" }, { clientOpId: ulid(), applyCreate });

    const ac = await a.cache.read();
    assert.ok(ac.synced_through > cursor0, "本机写入应把 synced_through 提到自己的 seq");
    assert.deepEqual(ac.items.map((i) => i.title), ["a1"], "写命令只替换自己那条");
    assert.equal((await readSync(a.syncFile)).pull_cursor, cursor0, "写命令不得推进 pull_cursor");

    // a 再 pull：必须能拉到 b 的写入。
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    const titles = (await a.cache.read()).items.map((i) => i.title).sort();
    assert.deepEqual(titles, ["a1", "b1"], "a 的 pull 必须能拉到 b 的写入");
  } finally {
    await a.store.close();
    await b.store.close();
  }
});

/**
 * 写保护 × 拉取：慢 pull 不覆盖更较新的缓存，且游标只在落盘后推进。
 *
 * 走真实的 `pullOnce`，只在「取完这批事件的快照之后、合并之前」插入一次本机
 * 写入——那正是写保护要防的那个交错。手抄一份合并逻辑只能测到 `cache.update`
 * 自己的写保护，测不到 `mergeBatch` 的判据（比如把取较新那份写反了）。
 */
test("写保护 × 拉取：慢 pull 不覆盖更较新的缓存，且游标只在落盘后推进", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  const other = await device(slug, "o@test");
  try {
    // a 先全量建一次，拿到 sync.json。
    await createItem(a.store, a.cache, { title: "base", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    // 另一端写两条，a 还没拉。
    const o1 = await createItem(other.store, other.cache, { title: "o1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await createItem(other.store, other.cache, { title: "o2", by: "cli" }, { clientOpId: ulid(), applyCreate });

    // 在快照返回之后插入本机写入（seq 比这批事件更大），模拟「慢 pull」。
    const realSnapshot = a.store.snapshotFor.bind(a.store);
    let injected = false;
    a.store.snapshotFor = async (ids, limit) => {
      const snap = await realSnapshot(ids, limit);
      if (!injected) {
        injected = true;
        await updateItem(
          a.store, a.cache, { id: o1.item.id },
          (it) => applyPriority(it, { priority: "P0", at: Date.now(), by: "a" }),
          { clientOpId: ulid() },
        );
      }
      return snap;
    };

    const r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    a.store.snapshotFor = realSnapshot;

    assert.equal(r.rebuilt, false);
    assert.ok(injected, "本机写入必须发生在这一批的合并之前");

    const merged = await a.cache.read();
    assert.deepEqual(
      merged.items.map((i) => i.title).sort(),
      ["base", "o1", "o2"],
      "这一批的改动必须出现在缓存里（不能被写保护丢弃）",
    );
    assert.equal(merged.items.find((i) => i.title === "o1").priority, "P0", "本机刚写的改动不被回退");

    const sync = await readSync(a.syncFile);
    assert.ok(sync.pull_cursor >= r.cursor, "游标在缓存落盘之后推进");
  } finally {
    await a.store.close();
    await other.store.close();
  }
});

test("缓存文件被删除但 sync.json 还在：走全量重建，而不是把缓存留空", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "t1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await createItem(a.store, a.cache, { title: "t2", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal((await a.cache.read()).items.length, 2);
    const before = await readSync(a.syncFile);
    assert.ok(before.pull_cursor > 0, "前一次 pull 应已推进游标");

    // 删掉缓存、保留 sync.json —— README 承诺这会触发一次全量重建。
    await fs.rm(a.cache.path, { force: true });
    assert.equal(await a.cache.exists(), false);

    const r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal(r.rebuilt, true, "缓存不存在时必须重建，不能报「已是最新」");
    assert.deepEqual(
      (await a.cache.read()).items.map((i) => i.title).sort(),
      ["t1", "t2"],
      "重建后两条都回来（增量拉取补不回它们：事件已在游标之下）",
    );
    assert.ok(await a.cache.exists(), "重建要真的写出缓存文件");

    // 之后的本机写入 + pull 不应再让别的条目失踪。
    await createItem(a.store, a.cache, { title: "t3", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.deepEqual(
      (await a.cache.read()).items.map((i) => i.title).sort(),
      ["t1", "t2", "t3"],
      "缓存保持完整",
    );
  } finally {
    await a.store.close();
  }
});

test("缓存被删除后先发生一次写命令，pull 仍须整体重建（不能只补回被写的那条）", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "t1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await createItem(a.store, a.cache, { title: "t2", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    await fs.rm(a.cache.path, { force: true });

    // 写命令不能从空基线建出一份「只含 t3」的缓存：那样 pull 就再也看不到
    // 「文件缺失」这个信号了。
    const w = await createItem(a.store, a.cache, { title: "t3", by: "cli" }, { clientOpId: ulid(), applyCreate });
    assert.equal(w.cacheSkipped, true, "缓存缺失时写命令跳过刷缓存");
    assert.equal(await a.cache.exists(), false, "写命令不得凭空创建缓存文件");

    const r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal(r.rebuilt, true, "下一次 pull 必须整体重建");
    assert.deepEqual(
      (await a.cache.read()).items.map((i) => i.title).sort(),
      ["t1", "t2", "t3"],
      "三条都在：重建而不是只合进 t3",
    );
  } finally {
    await a.store.close();
  }
});

test("增量拉取途中缓存被删：转全量重建，不把其余事项丢掉", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  const other = await device(slug, "o@test");
  try {
    await createItem(a.store, a.cache, { title: "keep", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    // 另一端写一条，a 还没拉；此刻把缓存删掉——README 承诺删缓存只是让下一次
    // pull 变慢，所以这必须安全。
    await createItem(other.store, other.cache, { title: "later", by: "cli" }, { clientOpId: ulid(), applyCreate });

    // 在「取完快照、合并之前」删掉缓存：这就是存在性检查通过之后、真正写入
    // 之前被删掉的那个窗口。
    const realSnapshot = a.store.snapshotFor.bind(a.store);
    let deleted = false;
    a.store.snapshotFor = async (ids, limit) => {
      const snap = await realSnapshot(ids, limit);
      if (!deleted) {
        deleted = true;
        await fs.rm(a.cache.path, { force: true });
      }
      return snap;
    };
    let r;
    try {
      r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    } finally {
      a.store.snapshotFor = realSnapshot;
    }
    assert.equal(deleted, true);
    assert.equal(r.rebuilt, true, "缓存中途消失必须转全量重建");
    assert.deepEqual(
      (await a.cache.read()).items.map((i) => i.title).sort(),
      ["keep", "later"],
      "重建把两条都写回；若按增量合进空基线，keep 会永远失踪",
    );
    assert.ok(await a.cache.exists());
  } finally {
    await a.store.close();
    await other.store.close();
  }
});

test("缓存被清空成 0 字节：同样转全量重建（截断不等于合法空快照）", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "t1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await createItem(a.store, a.cache, { title: "t2", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal((await a.cache.read()).items.length, 2);
    assert.ok((await readSync(a.syncFile)).pull_cursor > 0);

    // `> todos.json` 这类写法：文件还在、内容为空。exists() 为真、read() 返回空状态，
    // 若只看存在性就会被当成「合法的空快照」增量合并，t1/t2 永远回不来。
    await fs.writeFile(a.cache.path, "", "utf8");
    assert.equal(await a.cache.exists(), true);
    assert.equal((await a.cache.read()).items.length, 0);

    const r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal(r.rebuilt, true, "缓存为空但游标已推进时，必须整体重建");
    assert.deepEqual(
      (await a.cache.read()).items.map((i) => i.title).sort(),
      ["t1", "t2"],
      "截断后两条都要回来",
    );
  } finally {
    await a.store.close();
  }
});

test("缓存被清空后再写一条，pull 仍整体重建（不留半份缓存）", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "t1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await createItem(a.store, a.cache, { title: "t2", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    await fs.writeFile(a.cache.path, "", "utf8");
    // 写命令看到的是一个空但存在的文件，会把它合进缓存（只剩自己那条）；
    // 这本身不算错——错的是 pull 之后把它当成完整缓存。
    await createItem(a.store, a.cache, { title: "t3", by: "cli" }, { clientOpId: ulid(), applyCreate });

    const r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal(r.rebuilt, true);
    assert.deepEqual(
      (await a.cache.read()).items.map((i) => i.title).sort(),
      ["t1", "t2", "t3"],
      "截断的缓存不能作为增量合并的基线",
    );
  } finally {
    await a.store.close();
  }
});

test("sync.json 丢失：走全量重建，且归零后的游标已落盘", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  const b = await device(slug, "b@test");
  try {
    await createItem(a.store, a.cache, { title: "keep", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const gone = await createItem(b.store, b.cache, { title: "gone", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const { applyDelete } = await import("../src/rules.js");
    await updateItem(b.store, b.cache, { id: gone.item.id }, (it) => applyDelete(it, { at: Date.now(), by: "cli" }), { clientOpId: ulid() });

    // a 先正常 pull 一次（拿到 keep，也拿到 gone 然后被删掉）。
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.deepEqual((await a.cache.read()).items.map((i) => i.title), ["keep"]);

    // 故意在缓存里塞一条「库里已不存在」的旧事项 + 删掉 sync.json。
    await a.cache.replace({
      v: 2,
      synced_through: 0,
      synced_at: 0,
      items: [
        ...(await a.cache.read()).items,
        { id: "01JSTALE000000000000000000", num: 99, title: "库里没有", note: "", priority: "P2", status: "todo", spaces: [], created: 1, updated: 1, timeline: [] },
      ],
    });
    await fs.rm(a.syncFile, { force: true });

    const r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal(r.rebuilt, true);
    const final = await a.cache.read();
    assert.deepEqual(final.items.map((i) => i.title), ["keep"], "全量重建整体替换：库里没有的旧条目消失");

    const sync = await readSync(a.syncFile);
    assert.ok(sync && sync.device_id, "重建后应重写 sync.json");
    assert.ok(sync.pull_cursor > 0, "重建成功后游标推进到快照上限");
  } finally {
    await a.store.close();
    await b.store.close();
  }
});

test("游标丢失且重建被本机写入打断：放弃且不推进游标，下次重来", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "base", by: "cli" }, { clientOpId: ulid(), applyCreate });

    // 重建：第一次快照期间让缓存 synced_through 跳到快照之上（模拟并发写入）。
    await fs.rm(a.syncFile, { force: true });
    const realSnapshot = a.store.fullSnapshot.bind(a.store);
    let n = 0;
    a.store.fullSnapshot = async (opts) => {
      const snap = await realSnapshot(opts);
      n++;
      if (n <= 2) {
        // 每次快照后都制造一次「更较新的缓存」，逼重建重试。
        await a.cache.update((b) => ({ ...b, synced_through: snap.maxSeq + 1000 }));
      }
      return snap;
    };

    await assert.rejects(
      () => pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" }),
      /重建连着 .* 次被本机写入打断|放弃/,
    );
    const sync = await readSync(a.syncFile);
    assert.equal(sync.pull_cursor, 0, "重试耗尽时游标必须停在 0（已落盘），下次仍从 0 重建");

    // 恢复正常后下一次 pull 应成功。先把缓存里那个「不可能出现」的注入值
    // 归位：真实世界里 synced_through 不可能长期高于快照上限（本机写入的 seq
    // 一定在下一份快照里），这里注入的是 +1000 的假值。
    a.store.fullSnapshot = realSnapshot;
    await a.cache.replace({ ...(await a.cache.read()), synced_through: 0 });
    const r = await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    assert.equal(r.rebuilt, true);
    assert.ok((await readSync(a.syncFile)).pull_cursor > 0);
  } finally {
    await a.store.close();
  }
});

test("墓碑：一端删除，另一端 pull 后从缓存移除", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  const b = await device(slug, "b@test");
  try {
    const item = await createItem(a.store, a.cache, { title: "会被删", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(b.store, b.cache, b.syncFile, { deviceName: "b@test" });
    assert.equal((await b.cache.read()).items.length, 1);

    const { applyDelete } = await import("../src/rules.js");
    await updateItem(a.store, a.cache, { id: item.item.id }, (it) => applyDelete(it, { at: Date.now(), by: "cli" }), { clientOpId: ulid() });

    await pullOnce(b.store, b.cache, b.syncFile, { deviceName: "b@test" });
    assert.deepEqual((await b.cache.read()).items, [], "另一端 pull 后该条消失");
  } finally {
    await a.store.close();
    await b.store.close();
  }
});

test("设备登记与 last_pull_seq 只在缓存落盘之后推进", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "x", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@device" });

    const devices = await a.store.listDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, "a@device");
    const sync = await readSync(a.syncFile);
    assert.equal(devices[0].lastPullSeq, sync.pull_cursor, "本机 pull 位点与服务端登记一致");
    assert.equal(devices[0].revoked, false);
  } finally {
    await a.store.close();
  }
});

test("吊销设备后不再计入墓碑 GC 的最小位点", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "x", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@device" });
    const [d] = await a.store.listDevices();
    assert.equal(await a.store.minPulledSeq(), d.lastPullSeq);

    await a.store.revokeDevice(d.id);
    // 只剩吊销设备时 MIN 为 null（视为「没有设备会再拉」）。
    assert.equal(await a.store.minPulledSeq(), null);
  } finally {
    await a.store.close();
  }
});

test("写入两条事件的命令（move 摘来源+落目标）在缓存里只算一次更新", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    // 先 pull 建好缓存：写命令只在已有缓存上做增量替换（缺失时留给 pull 重建）。
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    const c = await createItem(a.store, a.cache, { title: "多事件", spaces: ["spA", "spB"], by: "cli" }, { clientOpId: ulid(), applyCreate });
    const { applyMove } = await import("../src/rules.js");
    const r = await updateItem(
      a.store, a.cache, { id: c.item.id },
      (item) => {
        const s1 = applyMove(item, { from: "spA", to: null, at: Date.now(), by: "cli" });
        const s2 = applyMove(s1.item, { from: null, to: "spC", at: Date.now(), by: "cli" });
        return { item: s2.item, events: [...s1.events, ...s2.events] };
      },
      { clientOpId: ulid() },
    );
    assert.equal(r.seqs.length, 2, "两条事件各自取号");
    const cached = (await a.cache.read()).items[0];
    assert.deepEqual([...cached.spaces].sort(), ["spB", "spC"]);
    assert.equal(cached.timeline.filter((e) => e.kind === "spaces").length, 2, "时间线两条 spaces 事件");
  } finally {
    await a.store.close();
  }
});

test("pull 不把已删除的事项留在缓存里，也不会把已物理清除的当新条目拉进来", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  const b = await device(slug, "b@test");
  try {
    const c = await createItem(a.store, a.cache, { title: "会消失", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(b.store, b.cache, b.syncFile, { deviceName: "b@test" });
    assert.equal((await b.cache.read()).items.length, 1);

    // 直接从库里物理清除（模拟保留期已过且设备都拉过）。
    await a.store.purgeItem(c.item.id);
    await pullOnce(b.store, b.cache, b.syncFile, { deviceName: "b@test" });
    // 没有新事件，游标不动；b 的缓存里那条仍是旧的——这是「事件已不存在」的
    // 已知边界：物理清除前必须先确认所有设备都拉过（canPurge），b 正是靠
    // 那时已经拉到 delete 事件把条目移掉的。这里断言的是**不新增**。
    assert.equal((await b.cache.read()).items.length, 1);
  } finally {
    await a.store.close();
    await b.store.close();
  }
});

test("空写命令不产生事件，也不动缓存游标", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    const c = await createItem(a.store, a.cache, { title: "x", priority: "P1", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    const before = await readSync(a.syncFile);
    const beforeCache = await a.cache.read();

    // 把优先级改成它已经是的值：规则层判定无变化。
    const r = await updateItem(
      a.store, a.cache, { id: c.item.id },
      (it) => applyPriority(it, { priority: "P1", at: Date.now(), by: "cli" }),
      { clientOpId: ulid() },
    );
    assert.equal(r.changed, false);
    assert.equal(r.events.length, 0);
    assert.deepEqual(await readSync(a.syncFile), before, "无变化不推进 pull_cursor");
    assert.equal((await a.cache.read()).synced_through, beforeCache.synced_through);
  } finally {
    await a.store.close();
  }
});

test("缓存里的时间线带事件 seq：跨设备时钟偏差不能改变展示顺序", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    const c = await createItem(a.store, a.cache, { title: "x", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });
    await updateItem(
      a.store, a.cache, { id: c.item.id },
      (it) => applyStatus(it, { status: "doing", at: Date.now(), by: "cli" }),
      { clientOpId: ulid() },
    );
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    const st = await a.cache.read();
    const tl = st.items[0].timeline;
    assert.ok(tl.length >= 2, `应至少两条时间线，实际 ${tl.length}`);
    assert.ok(tl.every((e) => Number.isInteger(e.seq)), "每条都要带 seq——面板只读缓存，缺了就只能按时钟排");
    assert.deepEqual([...tl].map((e) => e.seq).sort((x, y) => x - y), tl.map((e) => e.seq), "按 seq 升序");
  } finally {
    await a.store.close();
  }
});

test("写命令的缓存刷新：缓存里那条更新时不覆盖它（与 pull 用同一条判据）", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    const x = await createItem(a.store, a.cache, { title: "旧标题", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    // 模拟：本事务提交之后、拿到缓存锁之前，另一个 pull 已把这份事项的**更新
    // 版本**合进缓存。调用方手里那份（本事务的快照）因此比缓存旧。
    const realUpdate = a.cache.update.bind(a.cache);
    let armed = true;
    a.cache.update = async (mutate, opts) => {
      if (armed) {
        armed = false;
        const st = await a.cache.read();
        // 同伴的更新提交在本事务之后，所以它的 updated 比本事务写下的那个更大。
        const later = Date.now() + 60_000;
        await a.cache.replace({
          ...st,
          synced_through: st.synced_through + 1000,
          items: st.items.map((it) => (it.id === x.item.id ? { ...it, title: "同伴的新标题", updated: later } : it)),
        });
      }
      return realUpdate(mutate, opts);
    };
    await updateItem(
      a.store, a.cache, { id: x.item.id },
      (it) => applyStatus(it, { status: "doing", at: Date.now(), by: "cli" }),
      { clientOpId: ulid() },
    );
    a.cache.update = realUpdate;

    const st = await a.cache.read();
    assert.equal(
      st.items.find((it) => it.id === x.item.id).title,
      "同伴的新标题",
      "缓存里较新的内容不能被本事务的旧快照覆盖（否则之后 pull 全是 applied:0，永远不自愈）",
    );
  } finally {
    await a.store.close();
  }
});

test("写命令的缓存刷新：同伴已删除的事项不能重新插回缓存", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    const x = await createItem(a.store, a.cache, { title: "会先被删", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" });

    // 模拟：本事务提交之后，pull 处理了同伴的删除事件——缓存里已没有这一条，
    // 而 synced_through 已越过本事务的 seq。
    const realUpdate = a.cache.update.bind(a.cache);
    let armed = true;
    a.cache.update = async (mutate, opts) => {
      if (armed) {
        armed = false;
        const st = await a.cache.read();
        await a.cache.replace({
          ...st,
          synced_through: st.synced_through + 1000,
          items: st.items.filter((it) => it.id !== x.item.id),
        });
      }
      return realUpdate(mutate, opts);
    };
    await updateItem(
      a.store, a.cache, { id: x.item.id },
      (it) => applyPriority(it, { priority: "P0", at: Date.now(), by: "cli" }),
      { clientOpId: ulid() },
    );
    a.cache.update = realUpdate;

    assert.deepEqual(
      (await a.cache.read()).items,
      [],
      "删除事件已在游标之下、pull 不会再碰这个 id：插回去就永久残留，面板会显示一条库里已删的事项",
    );
  } finally {
    await a.store.close();
  }
});

test("缓存路径上是 v1 旧账本：pull 停下并提示先导入，绝不覆盖", { skip }, async () => {
  const slug = ownerSlug();
  const a = await device(slug, "a@test");
  try {
    await createItem(a.store, a.cache, { title: "库里已有", by: "cli" }, { clientOpId: ulid(), applyCreate });
    // 用户把唯一一份旧账本放在缓存路径上，还没 import-json。
    const ledger = JSON.stringify({
      v: 1,
      items: [{ id: "t1", title: "没导入的旧数据", status: "todo", priority: "P2", spaces: [], timeline: [] }],
    });
    await fs.mkdir(path.dirname(a.cache.path), { recursive: true });
    await fs.writeFile(a.cache.path, ledger, "utf8");
    await fs.rm(a.syncFile, { force: true }); // 新装的第一轮 pull：sync.json 也没有

    await assert.rejects(
      () => pullOnce(a.store, a.cache, a.syncFile, { deviceName: "a@test" }),
      (e) => e.code === "legacy_ledger" && /import-json/.test(e.message),
      "必须停下并告诉用户先导入，而不是当成损坏去重建",
    );
    assert.equal(await fs.readFile(a.cache.path, "utf8"), ledger, "旧账本一个字节都不能变");
  } finally {
    await a.store.close();
  }
});

test("换 owner：没先 pull 的写命令也不会把对方的事项留在本机视图里", { skip }, async () => {
  const slugA = ownerSlug();
  const slugB = ownerSlug();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-pull-"));
  const cache = createCache(path.join(dir, "todos.json"));
  const syncFile = path.join(dir, "sync.json");
  const storeA = await connect({ ...P.cfg, owner: slugA });
  const storeB = await connect({ ...P.cfg, owner: slugB });
  try {
    await createItem(storeA, cache, { title: "A 的事", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(storeA, cache, syncFile, { deviceName: "a@test" });

    // 改配置换成 B，**不先 pull**：写命令必须自己看懂身份。
    assert.equal(ownerMismatch(await readSync(syncFile), slugB), true);
    await invalidateLocalState(cache, syncFile);
    assert.equal(await cache.exists(), false, "别人的缓存要删掉（其 synced_through 与本 owner 的序号不可比）");
    assert.equal(await readSync(syncFile), null, "sync.json 一并作废，下一次 pull 按新身份重新生成");

    await createItem(storeB, cache, { title: "B 的事", by: "cli" }, { clientOpId: ulid(), applyCreate });
    // 写命令不建缓存（没有基线），B 的条目只在库里；pull 重建后缓存里只有 B 的。
    const r = await pullOnce(storeB, cache, syncFile, { deviceName: "b@test" });
    assert.equal(r.rebuilt, true);
    assert.deepEqual((await cache.read()).items.map((i) => i.title), ["B 的事"], "A 的事项不能留在 B 的视图里");
    assert.equal((await readSync(syncFile)).owner, slugB);
  } finally {
    await storeA.close();
    await storeB.close();
  }
});

test("换 owner（改配置）：整份本机状态作废重建，不把对方的事项留在缓存里", { skip }, async () => {
  const slugA = ownerSlug();
  const slugB = ownerSlug();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-pull-"));
  const cache = createCache(path.join(dir, "todos.json"));
  const syncFile = path.join(dir, "sync.json");
  const storeA = await connect({ ...P.cfg, owner: slugA });
  const storeB = await connect({ ...P.cfg, owner: slugB });
  try {
    await createItem(storeA, cache, { title: "A 的事", by: "cli" }, { clientOpId: ulid(), applyCreate });
    await pullOnce(storeA, cache, syncFile, { deviceName: "a@test" });
    await createItem(storeB, createCache(path.join(dir, "b.json")), { title: "B 的事", by: "cli" }, { clientOpId: ulid(), applyCreate });
    const cursorA = (await readSync(syncFile)).pull_cursor;

    // 改配置换成 B，同一份缓存与 sync.json。
    const r = await pullOnce(storeB, cache, syncFile, { deviceName: "b@test" });
    assert.equal(r.rebuilt, true, "身份变了必须整体重建");
    assert.equal(r.ownerSwitch, true);
    const st = await cache.read();
    assert.deepEqual(st.items.map((i) => i.title), ["B 的事"], "A 的事项不能留在 B 的视图里");

    const sync = await readSync(syncFile);
    assert.equal(sync.owner, slugB, "sync.json 记下当前身份");
    assert.match(sync.device_id, /^[0-9A-Z]{26}$/, "设备 id 是 ULID（换身份时按新 owner 重新生成）");

    // 切回 A：A 的缓存与游标从零重建，B 写的事件不会让它漏拉 A 的旧数据。
    const back = await pullOnce(storeA, cache, syncFile, { deviceName: "a@test" });
    assert.equal(back.rebuilt, true);
    assert.deepEqual((await cache.read()).items.map((i) => i.title), ["A 的事"]);
    assert.equal((await readSync(syncFile)).owner, slugA);
    assert.ok(cursorA > 0, "前一次 pull 确实推进过 A 的游标（否则本用例没测到复用）");
  } finally {
    await storeA.close();
    await storeB.close();
  }
});

test("设备 id 已登记在别的 owner 名下：ensureDevice 明确报错，不静默改写别人那行", { skip }, async () => {
  const slugA = ownerSlug();
  const slugB = ownerSlug();
  const storeA = await connect({ ...P.cfg, owner: slugA });
  const storeB = await connect({ ...P.cfg, owner: slugB });
  try {
    const devId = ulid();
    await storeA.ensureDevice(devId, "a@test");
    const before = await storeA.listDevices();
    assert.equal(before.length, 1);

    await assert.rejects(
      () => storeB.ensureDevice(devId, "b@test"),
      /另一个 owner/,
      "撞上别人的设备行必须报错：静默 ODKU 会让 B 永远没有登记行，GC 判据对着不存在的设备算",
    );
    assert.deepEqual(await storeB.listDevices(), [], "B 不会因此凭空得到一台设备");
    assert.equal((await storeA.listDevices())[0].lastSeen, before[0].lastSeen, "A 那行不被改写");

    // 同一 owner 重复登记是正常的（每次 pull 都会调）。
    await storeA.ensureDevice(devId, "a@test");
    assert.equal((await storeA.listDevices()).length, 1);
  } finally {
    await storeA.close();
    await storeB.close();
  }
});
