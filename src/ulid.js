// ULID：26 字符，前 10 位是毫秒时间戳、后 16 位是随机数，Crockford base32。
//
// 为什么不用数据库自增做主键：多端创建不能等数据库发号（一条命令一次往返，
// 而面板要在本地先渲染），也不能用「设备前缀 + 计数器」（设备数不定、前缀
// 要人工分配）。ULID 客户端可生成、字典序即时间序、26 字符塞得进 CHAR(26)。
//
// 为什么不用 uuid v4：它是纯随机，按主键插入会在 B+ 树里随机散布；ULID 的
// 时间前缀让写入集中在尾部，缓存局部性更好。对本项目的数据量这不是决定性
// 因素，但代价为零。
//
// 不用第三方依赖：一个 ULID 只需要 26 个字符的编码表与 crypto 的随机字节，
// 而 mysql2 已经是首个运行时依赖了（spec §8 已记录这个代价）。

import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32：去掉 I L O U
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * 生成一个 ULID。`now` 可注入，供测试断言时间前缀。
 *
 * 同一毫秒内不做单调递增保证。旧实现用 `stamp()` 时钟单调化补丁来保证时间线
 * 有序，多端之后顺序的权威来源是事件 `seq`，不是 id——所以这里不需要维护
 * 「上一个 id」这类跨调用状态（那在并发进程里也维护不住）。
 */
export function ulid(now = Date.now()) {
  let time = Math.floor(now);
  if (!Number.isSafeInteger(time) || time < 0) throw new Error(`ULID 需要非负毫秒时间戳：${now}`);

  const chars = new Array(26);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    chars[i] = ENCODING[time % 32];
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(RANDOM_LEN);
  for (let i = 0; i < RANDOM_LEN; i++) {
    // 每个字符只用 5 位（32 个取值），剩下的 3 位丢弃。
    chars[TIME_LEN + i] = ENCODING[bytes[i] & 31];
  }
  return chars.join("");
}

/** 是否像一个 ULID。用于区分「ULID」与「#12 / 12」两种寻址方式。 */
export function isUlid(s) {
  return typeof s === "string" && ULID_RE.test(s);
}

/** 取回 ULID 里的时间（毫秒）。只用于诊断与排序展示，不参与同步。 */
export function ulidTime(id) {
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = ENCODING.indexOf(id[i]);
    if (v < 0) throw new Error(`不是合法 ULID：${id}`);
    t = t * 32 + v;
  }
  return t;
}
