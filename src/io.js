// 存储层：文件读写与并发收敛。core.js 只管数据，这里只管"怎么安全落盘"。

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { normalizeState, emptyState } from "./core.js";

let tmpCounter = 0;

export class ConflictError extends Error {
  constructor(message = "数据已被其他进程修改") {
    super(message);
    this.name = "ConflictError";
    this.code = "conflict";
  }
}

/**
 * 数据文件位置。mod 沙箱读不到环境变量，只能拼固定路径，所以 CLI 这边
 * **不支持** XDG_DATA_HOME：两边一旦算出不同路径就是静默 split-brain，
 * 各写各的、都不报错。要换位置一律用 --file，且两边同时指定。
 */
export function defaultDataPath(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".local", "share", "herdr-todo", "todos.json");
}

/**
 * 沿符号链接链解析最终写入路径；链上的目标允许不存在（悬空链接）。
 * `fs.realpath` 在目标缺失时报 ENOENT，而这里正需要那种情形下的答案。
 */
async function resolveLink(linkPath) {
  let cur = linkPath;
  for (let i = 0; i < 32; i++) {
    let lst;
    try {
      lst = await fs.lstat(cur);
    } catch (e) {
      if (e.code === "ENOENT") return cur; // 悬空：写到这个（尚不存在的）目标
      throw e;
    }
    if (!lst.isSymbolicLink()) return cur;
    const to = await fs.readlink(cur);
    cur = path.resolve(path.dirname(cur), to);
  }
  throw new Error(`符号链接层数过多：${linkPath}`);
}

/** 新文件权限：尊重 umask，而不是把 0o666 原样交给内核再被静默掩码。 */
function createdMode() {
  const mask = process.umask();
  return 0o666 & ~mask;
}

/**
 * 文件存储。所有写入都是"读-改-写"的完整循环：
 * 先记住读到的原始字节，落盘前用 CAS 比对；不一致就重读重放，避免覆盖别人刚写的内容。
 */
export function createNodeStore(filePath = defaultDataPath()) {
  const abs = path.resolve(filePath);

  async function readRaw() {
    try {
      return await fs.readFile(abs, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }

  async function read() {
    const raw = await readRaw();
    if (raw == null || raw.trim() === "") return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`数据文件不是合法 JSON：${abs}（${e.message}）`);
    }
    return normalizeState(parsed);
  }

  /** 返回写入后的字节串，供后续 CAS 使用。expected 为读到的原始内容（null=文件不存在）。 */
  async function write(state, expected) {
    const body = JSON.stringify(state, null, 2) + "\n";
    const current = await readRaw();
    if (current !== expected) throw new ConflictError();
    await fs.mkdir(path.dirname(abs), { recursive: true });

    // rename 会整体替换 inode，因此要显式继承原文件的权限：否则 0600 的账本
    // 每写一次就变成 0644（备注是明文，这是隐私问题）。
    // 符号链接要写到它指向的真实文件上，否则链接被换成普通文件、真正的账本
    // 永远停在旧内容（dotfiles / 备份场景下非常隐蔽）。
    //
    // 悬空链接（目标还不存在）是 dotfiles 的常态：只建链接、目标稍后才由第一次
    // 写入创建。此时 realpath 抛 ENOENT，**不能**退回 abs——那会把链接本身
    // rename 成普通文件，链接消失、目标永远不被创建。这里按 readlink 解析出的
    // 路径继续写。
    let target = abs;
    let mode = null;
    try {
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) {
        target = await resolveLink(abs);
        try {
          mode = (await fs.stat(target)).mode & 0o777;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          mode = createdMode();
        }
      } else {
        mode = lst.mode & 0o777;
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      // 新文件：跟 umask 走，保持和普通命令一致
      mode = createdMode();
    }
    await fs.mkdir(path.dirname(target), { recursive: true });

    // 同目录临时文件 + rename：rename 在同一文件系统上是原子的，
    // 中途崩溃要么是旧内容要么是新内容，不会出现半截 JSON。
    // 名字必须唯一：同一进程的两个写入者可能落在同一毫秒，共用名字会让
    // 先完成的那个把临时文件 rename 走，另一个 rename 时源文件已不存在。
    const tmp = `${target}.${process.pid}.${Date.now()}.${++tmpCounter}.tmp`;
    // 先 fsync 临时文件，再 rename，最后 fsync 目录：否则断电后可能看到
    // 「文件名已换成新的、内容还是旧的」或者文件长度是 0，JSON 直接解析失败。
    const fh = await fs.open(tmp, "w", mode);
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.rename(tmp, target);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    // rename 的目录项本身也要落盘。目录 fd 打不开（平台限制）不算失败。
    try {
      const dir = await fs.open(path.dirname(target), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      /* 尽力而为 */
    }
    return body;
  }

  /**
   * 跨进程互斥：mkdir 是原子的（已存在则 EEXIST），用它当锁目录。
   * 只靠"读到的字节"做 CAS 不够——两个写入者可能在同一窗口内读到相同内容，
   * 双双通过比对后各自 rename，后到的覆盖先到的。锁把读-改-写整段包起来才能真正排他。
   *
   * 锁目录里放一个 owner 文件记持有者 token。释放前先核对 token：
   * 如果锁被判定为陈旧、被别人抢占重建，原来的持有者恢复后按路径删除，
   * 会把新持有者的锁删掉，让第三个人进来——两个写者同时在临界区。
   */
  async function withLock(fn, options = {}) {
    const lockDir = `${abs}.lock`;
    const ownerFile = path.join(lockDir, "owner");
    const timeoutMs = options.lockTimeoutMs ?? 5000;
    const staleMs = options.staleLockMs ?? 10000;
    const started = Date.now();
    const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await fs.mkdir(path.dirname(abs), { recursive: true });

    for (;;) {
      try {
        await fs.mkdir(lockDir);
        try {
          await fs.writeFile(ownerFile, token, "utf8");
        } catch (e) {
          // 锁目录建好了但 owner 写不进去：这个锁没有身份，既无法安全释放，
          // 也只会靠 10 s 陈旧回收才解开（期间所有写入者都在等）。直接拆掉
          // 自己刚建的锁并如实报错，好过留一个孤儿锁。
          await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
          throw e;
        }
        break;
      } catch (e) {
        if (e.code === "ENOENT" || e.code === "EACCES" || e.code === "ENOSPC" || e.code === "EROFS") throw e;
        if (e.code !== "EEXIST") throw e;
        try {
          const st = await fs.stat(lockDir);
          if (Date.now() - st.mtimeMs > staleMs) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // 锁刚好被别人释放了，直接重试
          continue;
        }
        if (Date.now() - started > timeoutMs) {
          throw new ConflictError(`等待数据文件锁超时（${lockDir}）`);
        }
        await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
      }
    }

    try {
      return await fn();
    } finally {
      // 只删自己的锁。读到别人的 token 说明已被抢占，此时删锁会放第三个人进来。
      let mine = false;
      try {
        mine = (await fs.readFile(ownerFile, "utf8")) === token;
      } catch {
        // owner 不见了：锁目录可能已被别人清掉，不要再动它。
      }
      if (mine) await fs.rm(lockDir, { recursive: true, force: true });
    }
  }

  /**
   * 读-改-写。mutate 必须是同步纯函数：返回新状态或 null（无变更）。
   * 它不接受 async 函数——`JSON.stringify(Promise)` 是 `"{}"`，会把整份账本
   * 写成一个空对象，所以这里显式拒绝而不是相信调用方。
   *
   * 锁把整个读-改-写包起来，因此并发写入者串行看到彼此的结果。CAS 比对
   * 保留作第二道校验：它还能挡住**不持锁**的写入者（例如旧版面板副本）。
   */
  async function update(mutate, options = {}) {
    return withLock(async () => {
      const raw = await readRaw();
      let state;
      if (raw == null || raw.trim() === "") state = emptyState();
      else {
        try {
          state = normalizeState(JSON.parse(raw));
        } catch (e) {
          if (e.code === "unsupported_version" || e.code === "corrupt") throw e;
          throw new Error(`数据文件不是合法 JSON：${abs}（${e.message}）`);
        }
      }
      const result = mutate(state);
      if (result && typeof result.then === "function") {
        throw new Error("update 的 mutate 必须同步返回新状态，不能是 Promise");
      }
      if (result == null) return { state, changed: false };
      if (options._beforeWrite) await options._beforeWrite();
      const body = await write(result, raw);
      return { state: result, changed: true, raw: body };
    }, options);
  }

  return { path: abs, read, readRaw, write, update, withLock };
}
