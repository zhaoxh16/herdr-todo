// 本地状态：派生缓存（todos.json）与设备私有状态（sync.json）。
//
// 这两个文件都是本机私有物，不是真相。真相在 MySQL。删掉它们只会让下一次
// pull 变慢（走全量重建），不会丢数据。因此这里的复杂全部集中在两件事上：
//
// 1. **原子性**：任何时刻读到的一定是完整的 JSON，不会读到半截。
// 2. **写保护**：慢速 pull 不得把刚提交的本机写入覆盖回旧内容。判据是缓存头部的
//    `synced_through` 单调不减——这是「这份缓存不认可任何 seq 小于它的写入」
//    的意思，**不是**「缓存已包含 ≤ 该值的全部事件」（见 spec §4.4 两个游标）。
//
// 写入侧（CLI 的命令）与拉取侧（pull）都要更新缓存，两者可能在两个进程里同时
// 发生：CLI 写完数据库后更新缓存，同时面板触发的 pull 也在写。所以「读缓存 →
// 比对 synced_through → 合并 → 原子重命名」整段必须在同一把文件锁里完成。

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { normalizeState, emptyState, TodoError } from "./core.js";

let tmpCounter = 0;

/**
 * 本机私有目录。mod 沙箱读不到环境变量，只能拼固定路径，所以这里**不支持**
 * XDG_DATA_HOME：两边一旦算出不同路径就是静默 split-brain，各写各的、都不报错。
 */
export function defaultDataDir(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".local", "share", "herdr-todo");
}

export function defaultConfigDir(env = process.env) {
  const home = env.HOME || os.homedir();
  return path.join(home, ".config", "herdr-todo");
}

export function pathsFor(env = process.env) {
  const dataDir = defaultDataDir(env);
  const configDir = defaultConfigDir(env);
  return {
    dataDir,
    cache: path.join(dataDir, "todos.json"),
    sync: path.join(configDir, "sync.json"),
    config: path.join(configDir, "config.json"),
  };
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** 文件权限跟随 umask，而不是把 0o666 原样交给内核再被静默掩码。 */
function createdMode() {
  const mask = process.umask();
  return 0o666 & ~mask;
}

/**
 * 沿符号链接链解析最终写入路径；链上的目标允许不存在（悬空链接）。
 * `fs.realpath` 在目标缺失时报 ENOENT，而这里正需要那种情形下的答案。
 *
 * 缓存与 sync.json 都在这条路径上落盘。直接 rename 会**替换链接本身**：用户把
 * 它们做成 dotfiles 链接后，一次 pull 就把链接变成普通文件，真正的目标永远停在
 * 旧内容。旧的文件 store 靠这段逻辑避免过同样的事，迁移时一并带过来。
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

/**
 * 原子写：同目录临时文件 + fsync + rename + fsync 目录。
 *
 * rename 在同一文件系统上是原子的，中途崩溃要么是旧内容要么是新内容，不会
 * 出现半截 JSON。先 fsync 临时文件再 rename，否则断电后可能看到「文件名已换成
 * 新的、内容还是旧的」或者长度是 0。目录项本身也要 fsync 才真正落盘。
 *
 * 已存在文件的权限要显式继承：rename 会整体替换 inode，不继承的话 0600 的
 * 缓存每写一次就变成 0644（备注是明文，这是隐私问题）。
 *
 * 符号链接写到它指向的真实文件上，而不是替换链接本身（见 resolveLink）。
 * 悬空链接（目标还不存在）是 dotfiles 的常态，resolveLink 已按 readlink 解析
 * 出的目标路径返回，第一次写入在那里创建文件。
 */
export async function atomicWrite(file, body) {
  const target = await resolveLink(file);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  let mode;
  try {
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    mode = createdMode();
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.${++tmpCounter}.tmp`;
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
  try {
    const d = await fs.open(dir, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } catch {
    /* 尽力而为：某些平台不允许打开目录 */
  }
}

export class ConflictError extends Error {
  constructor(message = "数据已被其他进程修改") {
    super(message);
    this.name = "ConflictError";
    this.code = "conflict";
  }
}

/**
 * 跨进程互斥：mkdir 是原子的（已存在则 EEXIST），用它当锁目录。
 *
 * 锁目录里放一个 owner 文件记持有者 token。释放前核对 token：如果锁被判定为
 * 陈旧、被别人抢占重建，原持有者恢复后按路径删除，会把新持有者的锁删掉，
 * 让第三个人进来——两个写者同时在临界区。
 */
export async function withLock(lockPath, fn, options = {}) {
  const lockDir = `${lockPath}.lock`;
  const ownerFile = path.join(lockDir, "owner");
  const timeoutMs = options.lockTimeoutMs ?? 5000;
  const staleMs = options.staleLockMs ?? 10000;
  const started = Date.now();
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      await fs.mkdir(lockDir);
      try {
        await fs.writeFile(ownerFile, token, "utf8");
      } catch (e) {
        // 锁建好了但身份写不进去：既无法安全释放，也只能等 10 s 陈旧回收。
        // 直接拆掉自己刚建的锁并如实报错。
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
        continue; // 锁刚好被释放，直接重试
      }
      if (Date.now() - started > timeoutMs) throw new ConflictError(`等待文件锁超时（${lockDir}）`);
      await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
    }
  }

  try {
    return await fn();
  } finally {
    let mine = false;
    try {
      mine = (await fs.readFile(ownerFile, "utf8")) === token;
    } catch {
      /* owner 不见了：锁可能已被别人清掉，不要再动它 */
    }
    if (mine) await fs.rm(lockDir, { recursive: true, force: true });
  }
}

/**
 * 缓存读写。所有方法都是「文件级」的，不理解事件；派生逻辑在 pull/写入命令里。
 *
 * 读缓存**不持锁**：读到的东西要么是完整旧版要么是完整新版，最坏情况是比
 * 内存里的旧一份，调用方在写入时由 synced_through 兜住。
 */
export function createCache(file) {
  /**
   * 缓存文件是否存在。
   *
   * 「不存在」与「存在但为空」不是一回事：前者说明有人删了派生文件（README
   * 承诺删缓存会触发全量重建），后者是一份合法但暂无事项的快照。read() 对两者
   * 都返回 emptyState，调用方无法区分，所以存在性单独问。
   *
   * 但「空文件」与「合法空快照」确实不同，判断「有没有可合并的基线」要用
   * `isBlank()`——它把缺失与 0 字节一并算作没有基线。
   */
  async function exists() {
    try {
      await fs.stat(file);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }

  /**
   * 缓存是否「没有可用的基线」。
   *
   * 三种情形等价：文件不存在、存在但内容为空、内容只有空白。第三种来自
   * `> todos.json` 这类清空写法、编辑器重写中途被打断、恢复工具留下的 0 字节
   * 文件。它们都不能作为增量合并的基线——从空基线合并只会留下本次涉及的事项，
   * 其余事项的事件早已在游标之下、再也不会被拉到。
   *
   * 「存在但内容为空的合法快照」不是这个意思：正常写出的空缓存仍是一份完整
   * JSON（`{"v":2,...,"items":[]}`），不会被判成 blank。
   */
  async function isBlank() {
    const raw = await readText(file);
    return raw == null || raw.trim() === "";
  }

  async function read() {
    const raw = await readText(file);
    if (raw == null || raw.trim() === "") return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new TodoError(`缓存不是合法 JSON：${file}（${e.message}）`, "corrupt");
    }
    // `normalizeState` 同时接受 v1——那是给导入脚本读旧账本用的。缓存路径读到
    // v1 是另一回事：这里的文件本该是**派生物**，而一份 v1 账本是唯一真相。
    // 若把它当合法基线，`pull` 会拿空快照整体覆盖它、写命令会往里合并，两种
    // 都会毁掉那份唯一的旧数据。
    //
    // 所以单独报一个错误码，并且**不能**用 `corrupt`：`corrupt` 会触发全量重建，
    // 那正是要防的销毁动作。调用方看到 `legacy_ledger` 必须停下让人先导入。
    if (parsed && typeof parsed === "object" && parsed.v === 1) {
      throw new TodoError(
        `缓存路径（${file}）上是一份单机旧账本（v1），不是派生缓存。` +
          `它可能是唯一一份旧数据：先跑 herdr-todo import-json 导入，或把它改名移走后再继续。`,
        "legacy_ledger",
      );
    }
    return normalizeState(parsed);
  }

  /**
   * 覆盖前留一份副本。只用于会**整体替换**缓存的动作（全量重建），因为那一步
   * 会丢掉旧文件里的一切。文件不存在或内容为空白时没有可备份的东西，返回 null。
   *
   * 备份失败必须让调用方中止：宁可这轮 pull 不成功（下次再来），也不能在
   * 「以为留了后路其实没有」的状态下覆盖。
   */
  async function backup(label = "bak") {
    if (await isBlank()) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const to = `${file}.${label}-${stamp}`;
    const from = await resolveLink(file);
    await fs.copyFile(from, to);
    return to;
  }

  /**
   * 受写保护的缓存重写。mutate 接收「当前磁盘上的缓存」，返回要写的新缓存，
   * 或返回 null 表示不写。
   *
   * 写保护：新缓存的 synced_through 若小于磁盘上现有的值，说明这次要写的是
   * 一份更旧的世界观，必须**换到较新基线重来**而不是覆盖。所以 mutate 会被
   * 反复调用，每次拿到的是最新基线——调用方要做的是「把本批变更合并进这份
   * 基线」，而不是「用我手里那份替换掉它」。
   *
   * 合并与落盘在同一把锁里：读在锁外时，读完之后另一进程可能已更新缓存，
   * 本次合并会把它盖掉。
   *
   * 返回值：{ written: boolean, state, missing? }，state 是最终落盘（或判定无需
   * 落盘）的缓存。`requireExisting` 打开时，文件不存在就直接返回
   * { written: false, missing: true }，不创建文件——写命令靠它避开「从空基线
   * 写出一份只含本次改动的缓存」，那会让全量重建永远失去触发条件。
   */
  async function update(mutate, options = {}) {
    const maxAttempts = options.maxAttempts ?? 8;
    // 锁与落盘必须用**同一个**路径：写入会穿过符号链接落到目标文件（见
    // atomicWrite），锁却建在 `${lockPath}.lock`。两者拼写不一致时（缓存是
    // 符号链接，或调用方用链接名与真实名各写一次）各锁各的，写保护就形同虚设。
    // 先把链接解析一次，锁与写都以它为准。
    const target = await resolveLink(file);
    return withLock(target, async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // 「缺失」先问：文件不在时 read() 会返回空状态，基于它合并会写出
        // 「只含本次改动」的缓存。检查与后面的落盘同在这把锁里，所以查到
        // 什么就是写到什么——不会「锁外探到不存在、拿到锁后别人已建好文件」。
        if (options.requireExisting && (await isBlank())) {
          return { written: false, missing: true, state: emptyState() };
        }
        let baseline;
        try {
          baseline = await read();
        } catch (e) {
          // 只有全量重建能走到这里：缓存读不懂就没有「较新基线」可保护，
          // 空基线起步、整体替换才是它该做的事。其余调用方必须看到错误，
          // 否则损坏会被一次盲写掩盖成数据丢失。
          if (e.code !== "corrupt" || !options.fromCorrupt) throw e;
          baseline = emptyState();
        }
        const next = await mutate(baseline);
        if (next == null) return { written: false, state: baseline };
        const nextThrough = Number(next.synced_through) || 0;
        const baseThrough = Number(baseline.synced_through) || 0;
        if (nextThrough < baseThrough) {
          // 这次要写入的缓存比磁盘上的旧：换用新基线重来。
          // （调用方每次都拿到最新 baseline，所以重试一定收敛。）
          continue;
        }
        await atomicWrite(target, JSON.stringify(next, null, 2) + "\n");
        return { written: true, state: next };
      }
      throw new ConflictError(
        `缓存写了 ${maxAttempts} 次仍被更新的版本覆盖（${file}）。稍后重试。`,
      );
    });
  }

  /**
   * 删掉缓存文件（连同符号链接的目标）。删派生缓存是文档承诺的合法操作
   * （下一次 pull 会整体重建），这里只把它变成可调用的动作。
   *
   * 唯一的生产调用方是「sync.json 记的 owner 与当前配置不符」：那份缓存的
   * `synced_through` 来自另一个 owner，是不可比的全局 seq，整体重建会被自己的
   * 写保护挡住、永远替换不掉。先备份再删，重建从空基线起步。
   */
  async function remove() {
    await fs.rm(await resolveLink(file), { force: true });
  }

  /**
   * 无保护地整体替换缓存，不做 synced_through 比对。
   *
   * 生产路径不用它：全量重建也必须与写保护相遇（冲突时重取快照重做），所以
   * 走的是 update({ fromCorrupt: true })。保留它是给测试注入任意缓存状态用
   * （例如伪造一份「库里已不存在」的条目、把 synced_through 归位）。
   */
  async function replace(state) {
    await atomicWrite(file, JSON.stringify(state, null, 2) + "\n");
    return state;
  }

  return { path: file, exists, isBlank, read, update, replace, backup, remove };
}

/**
 * sync.json：本机私有状态。里面的 pull_cursor 只由 pull 推进。
 *
 * 读失败（损坏、缺字段）时抛错并**保留文件**，由调用方决定是否归零重建——
 * 静默当成 0 也能恢复，但那会让「缓存与游标不一致」的真相被掩盖掉一层。
 */
export async function readSync(file) {
  const raw = await readText(file);
  if (raw == null || raw.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { corrupt: true, raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { corrupt: true, raw };
  return {
    device_id: typeof parsed.device_id === "string" ? parsed.device_id : null,
    // 这份本机状态属于哪个 owner。缓存与游标都是「这个 owner 的视图」，换了
    // 身份还沿用它们就会跨租户混数据、并把游标推过对方尚未拉到的事件。
    // 旧文件没有这个字段（null），按「不确定」处理，由调用方决定是否重建。
    owner: typeof parsed.owner === "string" && parsed.owner ? parsed.owner : null,
    pull_cursor: Number.isFinite(Number(parsed.pull_cursor)) ? Number(parsed.pull_cursor) : 0,
    last_pull_at: Number.isFinite(Number(parsed.last_pull_at)) ? Number(parsed.last_pull_at) : null,
    revoked: parsed.revoked === true,
    // 「上一次全量重建没有成功完成」。游标已归零落盘，但增量拉取无法让
    // 「库里已不存在的事项」从缓存消失（它们的事件早被清掉，不会再被拉到），
    // 所以下次必须重做全量重建，而不是从 0 增量拉。
    rebuild_required: parsed.rebuild_required === true,
  };
}

export async function writeSync(file, state) {
  await atomicWrite(file, JSON.stringify(state, null, 2) + "\n");
  return state;
}

/**
 * 本机状态（缓存 + 游标）是否属于另一个 owner。
 *
 * `pull_cursor` 与 `synced_through` 都是全局 `AUTO_INCREMENT` 的序号，两个租户的
 * 号段不可比：沿用上一个 owner 的游标去增量拉会跨过新 owner 尚未拉取的事件
 * （永久漏拉）；沿用它那份缓存则会把别人的条目留在本租户的视图里。旧版
 * `sync.json` 没有 `owner` 字段（读出来是 null），按「未知」处理、不算不符。
 */
export function ownerMismatch(sync, owner) {
  return Boolean(sync && !sync.corrupt && sync.owner && sync.owner !== owner);
}

/**
 * 身份变了：整份本机状态作废。缓存先备份再删（它属于上一个 owner，其
 * `synced_through` 与本 owner 的序号不可比，留着会让写保护拒绝整体替换），
 * `sync.json` 一并删掉——下一次 pull 会按新 owner 生成新的设备 id 并从零重建。
 *
 * 幂等：并发两次调用时，第二次备份得到 null、删除是无操作。
 */
export async function invalidateLocalState(cache, syncFile) {
  const backup = await cache.backup("owner-switch");
  await cache.remove();
  await fs.rm(syncFile, { force: true });
  return backup;
}

/**
 * 推进 `pull_cursor`，单调不减。
 *
 * 同一台设备可能有两个 `pull` 在跑（两个侧栏各起一个），两者都读自己的
 * `sync.json` 副本、各自写回：后写的一方会把游标退回自己那份较小的值。回退
 * 本身不丢数据（下次会重复拉），但 spec 要求它单调，且 `devices` 的位点会与
 * 真实进度分叉。所以「读现值 → 取较大值 → 落盘」在同一把文件锁里完成。
 */
export async function advanceSync(file, state) {
  const target = await resolveLink(file);
  return withLock(target, async () => {
    const cur = await readSync(target);
    const mine = Number(state.pull_cursor) || 0;
    const onDisk = cur && !cur.corrupt ? Number(cur.pull_cursor) || 0 : 0;
    const next = { ...state, pull_cursor: Math.max(mine, onDisk) };
    await atomicWrite(target, JSON.stringify(next, null, 2) + "\n");
    return next;
  });
}

export { readText };
