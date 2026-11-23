// 真库集成测试的共用夹具。
//
// 没有可用的 MySQL 时**跳过并说明原因**——不是静默通过。判据：连接不上就
// 报一条 `# SKIP 集成测试：<原因>`，让「没跑」与「跑了且通过」在输出里可区分。
//
// 用法：
//   HERDR_TODO_TEST_DSN=mysql://root@127.0.0.1:3306/herdr_todo_test npm run test:db
//
// `npm test` 下连不上就跳过；`npm run test:db` 会设 HERDR_TODO_REQUIRE_DB=1，
// 此时连不上直接报错——「我明明要跑集成测试」与「顺手跑单测」是两种意图，
// 前者静默跳过等于假绿。
//
// 每条用例用独立 owner（随机 slug），互不干扰；需要干净状态的用例调 resetOwner。

import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";

export const DEFAULT_DSN =
  process.env.HERDR_TODO_TEST_DSN ?? "mysql://root@127.0.0.1:3306/herdr_todo_test";

export function parseTestDsn(dsn = DEFAULT_DSN) {
  const u = new URL(dsn);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    ssl: false, // 本机测试库不走 TLS；生产配置默认要求 TLS
    timezone: "Z",
  };
}

/** 探测可用性。返回 { ok, reason, cfg }。REQUIRE_DB 下不可用则直接抛错。 */
export async function probe() {
  const cfg = parseTestDsn();
  let conn;
  try {
    conn = await mysql.createConnection({ ...cfg, connectTimeout: 3000 });
    await conn.query("SELECT 1 FROM meta WHERE k = 'schema_version'");
    return { ok: true, cfg };
  } catch (e) {
    const reason =
      `连不上测试库 ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}（${e.code ?? e.message}）。` +
      `设置 HERDR_TODO_TEST_DSN 指向已建好表的库；未建时：sh db/create.sh herdr_todo_test`;
    if (process.env.HERDR_TODO_REQUIRE_DB === "1") {
      throw new Error(`要求跑集成测试（HERDR_TODO_REQUIRE_DB=1），但${reason}`);
    }
    return { ok: false, cfg, reason: `集成测试跳过：${reason}` };
  } finally {
    await conn?.end().catch(() => {});
  }
}

/** 随机 owner slug，避免用例互相看见对方的数据。 */
export function newOwner(prefix = "t") {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** 删除一个 owner 及其全部数据。用例结束时调用，保持测试库可重复使用。 */
export async function cleanupOwner(ownerSlug, dsn = DEFAULT_DSN) {
  const cfg = parseTestDsn(dsn);
  const conn = await mysql.createConnection(cfg);
  try {
    const [rows] = await conn.query("SELECT id FROM owners WHERE slug = ?", [ownerSlug]);
    if (!rows.length) return;
    const id = rows[0].id;
    await conn.query(
      "DELETE e FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.owner_id = ?",
      [id],
    );
    await conn.query(
      "DELETE p FROM item_places p JOIN items i ON i.id = p.item_id WHERE i.owner_id = ?",
      [id],
    );
    await conn.query("DELETE FROM items WHERE owner_id = ?", [id]);
    await conn.query("DELETE FROM devices WHERE owner_id = ?", [id]);
    await conn.query("DELETE FROM owners WHERE id = ?", [id]);
  } finally {
    await conn.end().catch(() => {});
  }
}

/** 直接开一条裸连接，用来在测试里制造「另一个客户端」看到的世界。 */
export async function rawConnection(dsn = DEFAULT_DSN) {
  const conn = await mysql.createConnection(parseTestDsn(dsn));
  await conn.query("SET SESSION time_zone = '+00:00'");
  return conn;
}
