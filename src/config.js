// 配置解析。优先级：--db <dsn> > 环境变量 HERDR_TODO_DSN > 配置文件。
//
// 三者只决定「连哪里」；owner 始终取自配置文件的 owner 字段——它标识「我是谁」，
// 不从连接串推断（DSN 里写 owner 会让「换一台机器用同一个库」变成「改了身份」）。
//
// 口令落在各设备 0600 的配置文件里是已批准的代价（spec §8）。这里只保证：
// 缺失/不可读时给出能照着做的报错，而不是抛一个 ECONNREFUSED。

import fs from "node:fs";
import os from "node:os";

import { TodoError } from "./core.js";
import { pathsFor } from "./cache.js";

export class ConfigError extends TodoError {
  constructor(message) {
    super(message, "config");
    this.name = "ConfigError";
  }
}

/** 与 `db/schema.sql` 的 `owners.slug VARCHAR(64)` 一致。 */
const OWNER_MAX = 64;

function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new ConfigError(`读不了配置文件 ${file}：${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`配置文件 ${file} 不是合法 JSON：${e.message}`);
  }
}

/**
 * 解析 mysql:// 形式的连接串。密码里可能有 `@`/`:`，所以用 URL 解析而不是
 * 正则切分。
 */
export function parseDsn(dsn) {
  let u;
  try {
    u = new URL(dsn);
  } catch {
    throw new ConfigError(
      `数据库地址格式不对：${dsn}\n应形如 mysql://user:pass@host:3306/database`,
    );
  }
  if (!/^mysql:$/.test(u.protocol)) {
    throw new ConfigError(`只支持 mysql:// 开头的地址，收到 ${u.protocol}`);
  }
  const database = u.pathname.replace(/^\//, "");
  if (!database) throw new ConfigError(`数据库地址缺少库名：${dsn}`);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(database),
  };
}

/**
 * owner slug 在边界处一次性校验：`owners.slug` 是 VARCHAR(64)，超长值到 INSERT
 * 才失败时用户看到的是「Data too long for column 'slug'」，既不知道哪个配置项
 * 错了，也不知道该改成什么。这里给出能照着改的报错。
 */
export function readOwner(value, configPath) {
  const owner = typeof value === "string" ? value.trim() : "";
  if (!owner) {
    throw new ConfigError(
      `配置文件 ${configPath} 缺少 owner（应为字符串，例如 "owner": "me"）。` +
        `owner 标识你是谁，同一 owner 的多台设备共享同一份数据。`,
    );
  }
  if (owner.length > OWNER_MAX) {
    throw new ConfigError(
      `owner 太长（${owner.length} 字符，上限 ${OWNER_MAX}）：${JSON.stringify(owner)}。` +
        `它对应数据库 owners.slug 列宽，超长会让每条命令都在建号时失败。`,
    );
  }
  return owner;
}

/**
 * 读出「连哪里」与「我是谁」。
 *
 * `--db` 与 `HERDR_TODO_DSN` 只覆盖连接部分；ssl 与 owner 永远来自配置文件，
 * 因为它们是本机属性（哪张证书、这个人在这个库里的身份）。
 */
export function loadConfig({ env = process.env, dsn = null } = {}) {
  const paths = pathsFor(env);
  const file = readJsonFile(paths.config);
  const fromFile = file && typeof file === "object" && !Array.isArray(file) ? file : {};

  const owner = readOwner(fromFile.owner, paths.config);

  const explicit = dsn || (typeof env.HERDR_TODO_DSN === "string" && env.HERDR_TODO_DSN.trim())
    ? dsn || env.HERDR_TODO_DSN
    : null;

  let conn;
  if (explicit) {
    conn = parseDsn(explicit);
  } else if (fromFile.host && fromFile.database && fromFile.user) {
    conn = {
      host: String(fromFile.host),
      port: fromFile.port ? Number(fromFile.port) : 3306,
      user: String(fromFile.user),
      password: String(fromFile.password ?? ""),
      database: String(fromFile.database),
    };
  } else {
    throw new ConfigError(
      `没有数据库地址。三选一：\n` +
        `  1. 命令行给 --db mysql://user:pass@host:3306/db\n` +
        `  2. 设置环境变量 HERDR_TODO_DSN\n` +
        `  3. 在 ${paths.config} 写 host / port / database / user / password`,
    );
  }

  // TLS 默认开启：直连公有云、口令在本地文件里，明文连接等于把口令交给网络。
  // `ssl: false` 只能用于本机回环测试库，且要显式写出来。
  //
  // 默认值必须是**对象**而不是 `true`：mysql2 的 `ssl: true` 会在建连接时抛
  // `TypeError: SSL profile must be an object`，且不带稳定 code，一路冒到用户
  // 面前变成退出码 1。这里在边界一次定形，驱动只收对象或 false。
  let ssl = { rejectUnauthorized: true };
  if (fromFile.ssl === false) ssl = false;
  else if (fromFile.ssl != null) {
    if (typeof fromFile.ssl !== "object" || Array.isArray(fromFile.ssl)) {
      throw new ConfigError(
        `配置文件 ${paths.config} 的 ssl 必须是 false 或对象（如 {"rejectUnauthorized": true, "ca": "~/ca.pem"}），` +
          `收到 ${JSON.stringify(fromFile.ssl)}。省略该项即为默认开启 TLS。`,
      );
    }
    ssl = { rejectUnauthorized: fromFile.ssl.rejectUnauthorized !== false };
    if (fromFile.ssl.ca) {
      const ca = String(fromFile.ssl.ca).replace(/^~(?=$|\/)/, os.homedir());
      try {
        ssl.ca = fs.readFileSync(ca, "utf8");
      } catch (e) {
        throw new ConfigError(`读不了 ssl.ca 指定的证书 ${ca}：${e.message}`);
      }
    }
  }

  return { ...conn, ssl, owner, paths };
}
