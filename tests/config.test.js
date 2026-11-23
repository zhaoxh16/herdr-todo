// 配置解析（src/config.js）的单测。
//
// 这里最关键的一条是 TLS 默认值：省略 `ssl` 时**不能**把布尔 `true` 交给
// mysql2，它会抛 `TypeError: SSL profile must be an object`，不带稳定 code，
// 于是所有命令都变成「退出码 1 的运行时错误」，而配置本身其实是对的。这条
// 缺陷曾经只在手工复现里出现过（端到端脚本每组都显式写 `"ssl": false`），
// 所以在这里钉死默认分支。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig, parseDsn, readOwner, ConfigError } from "../src/config.js";

async function homeWith(config) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-todo-cfg-"));
  const dir = path.join(home, ".config", "herdr-todo");
  await fs.mkdir(dir, { recursive: true });
  if (config !== undefined) {
    await fs.writeFile(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
  }
  return home;
}

const BASE = {
  owner: "me",
  host: "db.example.com",
  port: 3306,
  database: "herdr_todo",
  user: "herdr_todo",
  password: "pw",
};

test("省略 ssl：默认必须是对象（驱动不接受布尔 true）", async () => {
  const home = await homeWith(BASE);
  const cfg = loadConfig({ env: { HOME: home } });
  assert.deepEqual(cfg.ssl, { rejectUnauthorized: true });
});

test("ssl: false 表示明文连接，原样传成 false", async () => {
  const home = await homeWith({ ...BASE, ssl: false });
  assert.equal(loadConfig({ env: { HOME: home } }).ssl, false);
});

test("ssl 对象：rejectUnauthorized 默认 true，显式 false 才放宽", async () => {
  const a = await homeWith({ ...BASE, ssl: {} });
  assert.deepEqual(loadConfig({ env: { HOME: a } }).ssl, { rejectUnauthorized: true });
  const b = await homeWith({ ...BASE, ssl: { rejectUnauthorized: false } });
  assert.deepEqual(loadConfig({ env: { HOME: b } }).ssl, { rejectUnauthorized: false });
});

test("ssl 写成布尔或字符串：报配置错误（退出码 2），不能走到驱动才炸", async () => {
  for (const bad of [true, "yes", 1, ["a"]]) {
    const home = await homeWith({ ...BASE, ssl: bad });
    assert.throws(
      () => loadConfig({ env: { HOME: home } }),
      (e) => e instanceof ConfigError && /ssl/.test(e.message),
      `ssl=${JSON.stringify(bad)} 应报配置错误`,
    );
  }
});

test("ssl.ca 读不到时是配置错误，消息里带得出路径", async () => {
  const home = await homeWith({ ...BASE, ssl: { ca: "/nonexistent/ca.pem" } });
  assert.throws(
    () => loadConfig({ env: { HOME: home } }),
    (e) => e instanceof ConfigError && /ca\.pem/.test(e.message),
  );
});

test("owner 缺失或超长是配置错误（--owner 已移除，只有配置这一条来源）", async () => {
  const missing = await homeWith({ ...BASE, owner: undefined });
  assert.throws(() => loadConfig({ env: { HOME: missing } }), /owner/);
  assert.throws(() => readOwner("x".repeat(65), "config.json"), /太长/);
  assert.equal(readOwner("  me  ", "x"), "me", "两端空白要去掉");
});

test("连接参数优先级：--db > 环境变量 > 配置文件", async () => {
  const home = await homeWith(BASE);
  const env = { HOME: home, HERDR_TODO_DSN: "mysql://u2@h2:3307/db2" };
  const fromEnv = loadConfig({ env });
  assert.equal(fromEnv.host, "h2");
  assert.equal(fromEnv.database, "db2");

  const fromFlag = loadConfig({ env, dsn: "mysql://u3@h3:3308/db3" });
  assert.equal(fromFlag.host, "h3");
  assert.equal(fromFlag.database, "db3");
  // owner 只来自配置文件：连接串里写的不算。
  assert.equal(fromFlag.owner, "me");
});

test("parseDsn 接受密码里的 @ 与 :，拒绝非 mysql 协议与缺库名", () => {
  const c = parseDsn("mysql://u:p%40ss%3A1@h:3306/db");
  assert.equal(c.password, "p@ss:1");
  assert.equal(c.host, "h");
  assert.throws(() => parseDsn("postgres://h/db"), /mysql/);
  assert.throws(() => parseDsn("mysql://h"), /库名/);
  assert.throws(() => parseDsn("not a url"), /格式/);
});
