// 命令行入口。只做参数解析与输出；规则在 rules.js，库在 store/mysql.js，
// 缓存与拉取在 cache.js / sync.js。
//
// 退出码：
//   0 成功
//   1 运行时错误（含规则拒绝：找不到事项、终态需 reopen）
//   2 用法错误（含配置文件读不懂：owner / ssl 类型不对）
//   3 本地缓存竞争（缓存被另一个进程连续改写到重试用尽）。数据库里的写入不受
//     影响——同一 owner 的并发写已由 owner 行锁串行化，旧版那种「账本冲突」
//     不存在了。
//   4 数据库不可达（网络/凭据/证书）。与 3 分开，面板才能说人话。

import path from "node:path";
import fs from "node:fs/promises";

import {
  sortItems,
  summary,
  timelineOf,
  CLOSED_STATUSES,
  STATUSES,
  PRIORITIES,
  TodoError,
} from "./core.js";
import {
  applyCreate,
  applyStatus,
  applyPriority,
  applyTitle,
  applyNote,
  applySpaces,
  applyMove,
  applyAgent,
  applyArchive,
  applyUnarchive,
  applyDelete,
} from "./rules.js";
import { connect, DbUnreachableError } from "./store/mysql.js";
import { createCache, pathsFor, ConflictError, readSync, ownerMismatch, invalidateLocalState } from "./cache.js";
import { updateItem, createItem, pullOnce, parseRef } from "./sync.js";
import { loadConfig, ConfigError } from "./config.js";
import { ulid, isUlid } from "./ulid.js";
import { importLedger } from "./import.js";

const USAGE = `herdr-todo — 记录工作事项并与 Herdr space 关联（数据在 MySQL，多端同步）

用法：
  herdr-todo add <标题> [选项]
  herdr-todo list [选项]
  herdr-todo show <编号|id>
  herdr-todo status <编号|id> <状态> [--reopen]
  herdr-todo priority <编号|id> <P0-P3>
  herdr-todo title <编号|id> <新标题>
  herdr-todo note <编号|id> <文本>       （文本用 - 表示从 stdin 读）
  herdr-todo link <编号|id> <space...>
  herdr-todo unlink <编号|id> [space...]
  herdr-todo move <编号|id> [space] [--from <space>]
  herdr-todo set-spaces <编号|id> [space...]
  herdr-todo agent <编号|id> <address> --in-space <space>
  herdr-todo agent <编号|id> --clear
  herdr-todo archive <编号|id>
  herdr-todo unarchive <编号|id>
  herdr-todo delete <编号|id>            删除（写墓碑，其它设备下次 pull 时消失）

同步与维护：
  herdr-todo pull                        拉取其它设备的改动，刷新本地缓存
  herdr-todo devices [--revoke <id>]     列出设备及其最后拉取位置
  herdr-todo import-json <旧账本.json>   一次性导入单机账本（可重复执行前先备份）
  herdr-todo spaces
  herdr-todo export

编号寻址：#12 或 12 指人读编号，26 位 id 指 ULID。旧写法 t12 已不再支持。

选项：
  --db <dsn>          覆盖数据库地址（mysql://user:pass@host:3306/db）
  --space <id>        新建时直接关联（可重复）
  --priority <P0-P3>  新建时指定优先级（默认 P2）
  --status <状态>     新建时指定状态（默认 todo）
  --note <文本>       备注（新建时附上；note 子命令用它替换）
  --all               列表包含已完成与已归档
  --by <名字>         时间线里记录的操作者（默认 cli；面板传 panel）
  --op <ulid>         幂等键。重试同一次操作时传同一个值，只生效一次
  --json              输出机器可读 JSON

状态：${STATUSES.join(" / ")}
优先级：${PRIORITIES.join(" / ")}
`;

export class UsageError extends Error {}

// 带值的选项。显式列出来，是为了让 `--` 之前的位置参数（标题、备注、space id）
// 被当作数据而不是语法：`add -- --space spA` 里的 `--space` 是标题的一部分。
const VALUE_OPTIONS = new Set([
  "space", "priority", "status", "note", "by", "in-space", "db", "op", "revoke", "path",
]);
// `--from` 可以重复（孤儿组拖出时要一次摘掉多个已不存在的 space id）。
const REPEAT_OPTIONS = new Set(["from"]);
const FLAG_OPTIONS = new Set(["json", "all", "reopen", "clear", "force", "dry-run"]);

function parseArgs(argv) {
  const opts = { spaces: [], from: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-") opts.stdin = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (key === "file") {
        throw new UsageError(
          "--file 已删除：数据已迁到数据库。改用 --db <dsn> 指定库，或配置 ~/.config/herdr-todo/config.json。",
        );
      }
      // 本机同步状态（todos.json / sync.json）与设备的身份、游标绑定，只有一份。
      // 「临时换个身份运行」会拿另一个 owner 的游标去增量拉、把别人的事项合进
      // 本机缓存，而且切回来时真实 owner 尚未拉取的事件已被跳过——永久漏拉。
      // 换身份必须是整体切换：改配置文件里的 owner，本机状态随之作废重建。
      if (key === "owner") {
        throw new UsageError(
          "--owner 不再支持。本机缓存与同步游标绑定在配置文件的 owner 上，" +
            "临时换身份会把它推进到另一个租户的序号、造成永久漏拉。" +
            "要换身份请改配置文件里的 owner（本机状态会自动作废重建）。",
        );
      }
      if (FLAG_OPTIONS.has(key)) {
        opts[key === "dry-run" ? "dryRun" : key] = true;
        continue;
      }
      if (!VALUE_OPTIONS.has(key) && !REPEAT_OPTIONS.has(key)) throw new UsageError(`未知选项 --${key}`);
      const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (val === undefined) throw new UsageError(`选项 --${key} 缺少值`);
      if (key === "space") opts.spaces.push(val);
      else if (REPEAT_OPTIONS.has(key)) opts[key].push(val);
      else if (key === "in-space") opts.inSpace = val;
      else opts[key] = val;
    } else opts._.push(a);
  }
  return opts;
}

function out(s) {
  // 管道下游提前退出（`| head`、`grep -q`）会触发 EPIPE；这是正常用法，不该报错。
  try {
    process.stdout.write(s.endsWith("\n") ? s : s + "\n");
  } catch (e) {
    if (e && e.code === "EPIPE") return;
    throw e;
  }
}

function fmtTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_MARK = {
  todo: "○",
  doing: "◐",
  blocked: "●",
  done: "✓",
  cancelled: "✕",
};

/** `#12` 前缀只在输出时加：输入两种写法都收。 */
function refOf(item) {
  return item.num != null ? `#${item.num}` : item.id;
}

function renderItemLine(it) {
  const mark = STATUS_MARK[it.status] ?? "?";
  const note = it.note ? `  · 备注 ${it.note.length} 字` : "";
  return `  ${mark} ${refOf(it)}  ${it.priority}  ${it.title}${note}`;
}

function linkText(item) {
  // agent 与 space 互斥（规则层强制），所以这两者是「或」不是「和」。
  if (item.agent) return `agent ${item.agent.address}（侧栏归到 ${item.agent.space}）`;
  return item.spaces.length ? item.spaces.join(", ") : "（未关联）";
}

function renderTimeline(item) {
  const lines = [`# ${refOf(item)} ${item.title}`, ""];
  lines.push(`状态：${item.status}    优先级：${item.priority}`);
  lines.push(`关联：${linkText(item)}`);
  lines.push(`创建：${fmtTime(item.created)}    更新：${fmtTime(item.updated)}`);
  if (item.archived != null) lines.push(`归档：${fmtTime(item.archived)}（reopen 可恢复）`);
  if (item.note) lines.push("", "## 备注", item.note);
  lines.push("", "## 时间线");
  for (const e of timelineOf(item)) {
    lines.push(`  ${fmtTime(e.at)}  ${describeEntry(e)}  [${e.by}]`);
  }
  return lines.join("\n");
}

function listText(v, sep) {
  return Array.isArray(v) ? v.join(sep) : v == null ? "" : String(v);
}

function describeEntry(e) {
  switch (e.kind) {
    case "created":
      return `创建为 ${e.to}`;
    case "status":
      return `状态 ${e.from} → ${e.to}`;
    case "priority":
      return `优先级 ${e.from} → ${e.to}`;
    case "title":
      return `标题改为「${e.to}」`;
    case "note":
      return `备注 ${e.from?.length ?? 0} → ${e.to?.length ?? 0} 字`;
    case "archived":
      return "归档";
    case "unarchived":
      return "取消归档";
    case "deleted":
      return "删除";
    case "spaces": {
      const f = listText(e.from, ",") || "无";
      const t = listText(e.to, ",") || "无";
      return `关联 ${f} → ${t}`;
    }
    case "agent":
      return `agent ${e.from || "无"} → ${e.to || "无"}`;
    default:
      // 未知 kind（将来新增的 parent / progress）降级显示原文，不抛错。
      return e.kind;
  }
}

/**
 * 时间线里的操作者。在边界处一次性收敛：去空白、限长到与 `item_events.actor`
 * （VARCHAR(64)）一致。不在这里收，超长值会一路到 INSERT，用户看到的将是
 * 「Data too long for column 'actor'」这种内部报错，而不是能照着改的提示。
 */
function actorOf(opts) {
  const by = typeof opts?.by === "string" ? opts.by.trim() : "";
  return by ? by.slice(0, 64) : "cli";
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// CLI 不连接 Herdr（拿不到 space 列表），所以只做规整：空值拒绝（存 ["", ]
// 会让事项落到「space 已不存在」组），其余原样当 id。
function cleanSpaceArg(arg) {
  const s = String(arg ?? "").trim();
  if (!s) throw new UsageError("--space 不能为空");
  return s;
}

/**
 * 打开数据库与缓存。命令都在需要时才连库：`--help` 与用法错误不该因为
 * 配置缺失而报「连不上数据库」。
 *
 * 身份检查放在这里：`sync.json` 记的 owner 与配置不一致时，本机的缓存与游标
 * 属于别人，必须先作废——否则写命令会把别人的事项合进本机视图，而 `pull_cursor`
 * 已经被推到对方租户的号段上。`pull` 自己也会查一次（面板直接跑 CLI，不经过
 * 这里），但写命令不能指望用户先跑过 pull：两边都要在动手前看懂身份。
 *
 * `importSource` 是 import-json 的源文件：它可能就是缓存路径上的那份旧账本，
 * 那时绝不能为了清身份把它删掉——那正好是要保护的数据。
 */
/**
 * 两个路径是否指向同一个文件。
 *
 * 不能用字符串比较：缓存路径可能是符号链接（dotfiles），而用户给导入源时往往给
 * 链接指向的真实路径。那样判成「不是同一个」就会把导入源当成别人的缓存删掉——
 * 正好销毁要保护的那份数据。按 inode 比，链接与硬链接都能认出来；文件不存在时
 * 返回 false（导入随后会以「读不了旧账本」失败）。
 */
async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

async function open(opts, env, { importSource = null } = {}) {
  const cfg = loadConfig({ env, dsn: opts.db ?? null });
  const store = await connect(cfg);
  const paths = pathsFor(env);
  const cache = createCache(paths.cache);
  const sync = await readSync(paths.sync);
  if (ownerMismatch(sync, cfg.owner)) {
    // 导入源可能就是缓存路径上的那份旧账本：那时绝不能为了清身份把它删掉。
    const sameAsSource = importSource != null && (await sameFile(importSource, cache.path));
    if (!sameAsSource) {
      const backup = await invalidateLocalState(cache, paths.sync);
      process.stderr.write(
        `herdr-todo: 本机缓存属于另一个 owner（${sync.owner}），已作废并重建` +
          `${backup ? `（旧缓存备份在 ${backup}）` : ""}。下一次 pull 会从库里重新生成。\n`,
      );
    }
  }
  return { cfg, store, cache, paths };
}

/**
 * 每条写命令一个幂等键。调用方显式传 --op 时沿用它（面板重试的场合）。
 *
 * 幂等键落到 `item_events.client_op_id CHAR(26)`。超长或含非法字符的值必须
 * 在这里拒绝：让它到 INSERT 才失败，用户看到的是「Data too long for column
 * 'client_op_id'」，且事务已回滚、拿不到任何可用提示。
 */
function opIdOf(opts) {
  if (!opts.op) return ulid();
  const op = String(opts.op).trim();
  if (!isUlid(op)) {
    throw new UsageError(
      `--op 必须是 26 位 ULID（大写字母与数字），收到 ${JSON.stringify(opts.op)}。` +
        `它用于重试去重：同一次操作重发时传同一个值。`,
    );
  }
  return op;
}

function jsonOut(opts, value, text) {
  out(opts.json ? JSON.stringify(value, null, 2) : text);
}

export async function main(argv, env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help || opts._.length === 0) {
    out(USAGE);
    return 0;
  }
  const [cmd, ...rest] = opts._;
  const by = actorOf(opts);

  // 不需要数据库的命令先处理，免得配置有问题时连 `--help` 都用不了。
  if (cmd === "import-json") {
    const file = rest[0] ?? opts.path;
    if (!file) throw new UsageError("import-json 需要旧账本路径");
    const ctx = await open(opts, env, { importSource: path.resolve(String(file)) });
    try {
      const r = await importLedger(ctx.store, ctx.cache, file, {
        by,
        force: Boolean(opts.force),
        dryRun: Boolean(opts.dryRun),
        json: Boolean(opts.json),
        out: (line) => out(line),
        note: (line) => process.stderr.write(`${line}\n`),
      });
      return 0;
    } finally {
      await ctx.store.close();
    }
  }

  const ctx = await open(opts, env);
  const { store, cache, paths } = ctx;
  try {
    switch (cmd) {
      case "add": {
        const title = rest.join(" ").trim();
        if (!title) throw new UsageError("add 需要标题");
        const note = opts.stdin ? await readStdin() : opts.note;
        const prio = opts.priority != null ? String(opts.priority) : undefined;
        const status = opts.status != null ? String(opts.status) : undefined;
        const r = await createItem(
          store,
          cache,
          {
            title,
            note: note ?? "",
            spaces: opts.spaces.map(cleanSpaceArg),
            priority: prio,
            status,
            by,
          },
          { clientOpId: opIdOf(opts), applyCreate },
        );
        jsonOut(opts, r.item, `已添加 ${refOf(r.item)}  ${r.item.priority}  ${r.item.title}`);
        return 0;
      }

      case "list": {
        // CLI 不连接 Herdr，拿不到 space 的名称/存活状态，所以不做分组；
        // 按 space 分组是面板的职责（那里有实时空间数据）。
        const all = await store.listItems({ includeClosed: true });
        const pool = opts.all
          ? all
          : all.filter((i) => !CLOSED_STATUSES.includes(i.status) && i.archived == null);
        if (opts.json) {
          out(JSON.stringify(sortItems(pool), null, 2));
          return 0;
        }
        if (!pool.length) {
          out("（没有未完成的事项）");
          return 0;
        }
        const sum = summary(all);
        out(`未处理 ${sum.pending} · P0 ${sum.p0} · 已完成 ${sum.done}`);
        out("");
        for (const it of sortItems(pool)) {
          out(renderItemLine(it));
          if (it.agent) out(`       关联：agent ${it.agent.address}（侧栏归到 ${it.agent.space}）`);
          else if (it.spaces.length) out(`       关联：${it.spaces.join(", ")}`);
        }
        return 0;
      }

      case "show": {
        const ref = parseRef(rest[0]);
        const item = await loadOne(store, ref);
        if (item.timeline == null) item.timeline = await storeTimeline(store, item.id);
        const shown = { ...item, timeline: (item.timeline ?? []).filter(Boolean) };
        out(opts.json ? JSON.stringify(shown, null, 2) : renderTimeline(shown));
        return 0;
      }

      case "status": {
        const [id, status] = rest;
        if (!id || !status) throw new UsageError(`status 需要编号和状态（${STATUSES.join("/")}）`);
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyStatus(item, { status, reopen: Boolean(opts.reopen), at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 状态 → ${r.item.status}`);
        return 0;
      }

      case "priority": {
        const [id, p] = rest;
        if (!id || !p) throw new UsageError("priority 需要编号和 P0-P3");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyPriority(item, { priority: p.toUpperCase(), at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 优先级 → ${r.item.priority}`);
        return 0;
      }

      case "title": {
        const [id, ...words] = rest;
        const title = words.join(" ").trim();
        if (!id || !title) throw new UsageError("title 需要编号和新标题");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyTitle(item, { title, at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 标题 → ${r.item.title}`);
        return 0;
      }

      case "note": {
        const id = rest[0];
        if (!id) throw new UsageError("note 需要编号");
        const text = opts.stdin ? await readStdin() : (opts.note ?? rest.slice(1).join(" "));
        // 省略文本会被当成「清空备注」，而时间线只记字数、正文不可恢复。
        // 清空是需要明说的动作，不是敲错命令的副作用。
        if (!opts.stdin && opts.note === undefined && text === "") {
          throw new UsageError('note 需要备注文本；确实要清空请用 --note ""（传空串）');
        }
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyNote(item, { note: text, at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 备注已更新（${r.item.note.length} 字）`);
        return 0;
      }

      case "link": {
        const [id, ...pos] = rest;
        // --space 与位置参数等价。只读 rest 会让 `link #1 --space spC` 静默失败。
        const spaces = [...pos, ...opts.spaces].map(cleanSpaceArg);
        if (!id || !spaces.length) throw new UsageError("link 需要编号和一个以上 space");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applySpaces(item, { spaces: [...item.spaces, ...spaces], at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 关联 → ${r.item.spaces.join(", ") || "（未关联）"}`);
        return 0;
      }

      case "unlink": {
        const [id, ...pos] = rest;
        const spaces = [...pos, ...opts.spaces];
        if (!id) throw new UsageError("unlink 需要编号");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => {
            const remove = new Set(spaces);
            const keep = spaces.length ? item.spaces.filter((s) => !remove.has(s)) : [];
            return applySpaces(item, { spaces: keep, at: Date.now(), by });
          },
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 关联 → ${r.item.spaces.length ? r.item.spaces.join(", ") : "（未关联）"}`);
        return 0;
      }

      case "unarchive": {
        const id = rest[0];
        if (!id) throw new UsageError("unarchive 需要编号");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyUnarchive(item, { at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 已取消归档（状态 ${r.item.status}）`);
        return 0;
      }

      case "archive": {
        const id = rest[0];
        if (!id) throw new UsageError("archive 需要编号");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyArchive(item, { at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 已归档（状态 ${r.item.status}，数据保留）`);
        return 0;
      }

      case "delete": {
        const id = rest[0];
        if (!id) throw new UsageError("delete 需要编号");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyDelete(item, { at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 已删除（其它设备下次同步时消失）`);
        return 0;
      }

      case "agent": {
        // CLI 不连 Herdr，所以「agent 在哪个 space」必须由调用方（面板）传进来。
        const [id, address] = rest;
        if (!id) throw new UsageError("agent 需要编号");
        if (opts.clear) {
          if (address) throw new UsageError("--clear 不接受 address");
          const r = await updateItem(
            store, cache, parseRef(id),
            (item) => applyAgent(item, { agent: null, at: Date.now(), by }),
            { clientOpId: opIdOf(opts) },
          );
          jsonOut(opts, r.item, `${refOf(r.item)} 已解除 agent 关联`);
          return 0;
        }
        if (!address) throw new UsageError("agent 需要编号和 address（或 --clear）");
        if (!opts.inSpace) throw new UsageError("agent 需要 --in-space <space>：侧栏按它把事项归到对应 space");
        const link = { address: String(address).trim(), space: String(opts.inSpace).trim() };
        if (!link.address || !link.space) throw new UsageError("agent 的 address 与 --in-space 都不能为空");
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applyAgent(item, { agent: link, at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 关联 → agent ${link.address}（侧栏归到 ${link.space}）`);
        return 0;
      }

      case "move": {
        // 拖拽用：把事项从一个 space 挪到另一个（或挪到未关联）。
        // 与 link+unlink 的两次写不同，这是一次事务：中间不会被并发写覆盖，
        // 而且「移走」的语义是替换来源，不会留下两个 space 同时显示它。
        const [id, ...pos] = rest;
        const to = pos[0] ?? opts.spaces[0] ?? null;
        if (!id) throw new UsageError("move 需要编号");
        if (pos.length > 1) throw new UsageError("move 只接受一个目标 space");
        // 来源里的目标本身要去掉：`move #1 spB --from spB` 若照做会先删再加，
        // 结果一样却多记两条「改了又改回来」，读起来像出过问题。
        const froms = [...new Set(opts.from)].filter((s) => s && s !== to);
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => {
            // 依次摘来源再落目标，全在同一次事务里：多次写会留下中间态，
            // 也会让并发的另一条写插在中间。
            let cur = item;
            const events = [];
            const at = Date.now();
            for (const from of froms) {
              const step = applyMove(cur, { from, to: null, at, by });
              cur = step.item;
              events.push(...step.events);
            }
            const last = applyMove(cur, { from: null, to, at, by });
            return { item: last.item, events: [...events, ...last.events] };
          },
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(
          opts,
          r.item,
          `${refOf(r.item)} 关联 → ${r.item.spaces.length ? r.item.spaces.join(", ") : r.item.agent ? `agent ${r.item.agent.address}` : "（未关联）"}`,
        );
        return 0;
      }

      case "set-spaces": {
        // 整体替换关联列表。脚本里「这组 space 就是全部」的场合用它；
        // 面板不用它——面板手里的列表是 render 快照，拿它做绝对值会覆盖掉
        // 并发新增的关联。
        const [id, ...pos] = rest;
        if (!id) throw new UsageError("set-spaces 需要编号");
        const all = [...pos, ...opts.spaces];
        const next = [...new Set(all.map((s) => String(s).trim()).filter(Boolean))];
        const r = await updateItem(
          store, cache, parseRef(id),
          (item) => applySpaces(item, { spaces: next, at: Date.now(), by }),
          { clientOpId: opIdOf(opts) },
        );
        jsonOut(opts, r.item, `${refOf(r.item)} 关联 → ${next.join(", ") || "（未关联）"}`);
        return 0;
      }

      case "spaces": {
        // 库里出现过的 space id 及计数：CLI 不连 Herdr，只反映库自身。
        // 关联到 agent 的事项按它记下的 agent.space 计数：侧栏会显示它（该 space
        // 已不存在时归入「space 已不存在」组），CLI 不连 Herdr、无从判断存活，
        // 脚本按本命令规划 space 时不该漏掉它。
        const all = await store.listItems({ includeClosed: true });
        const counts = new Map();
        for (const it of all) {
          if (CLOSED_STATUSES.includes(it.status) || it.archived != null) continue;
          const ids = it.agent ? [it.agent.space] : it.spaces;
          for (const s of ids) counts.set(s, (counts.get(s) || 0) + 1);
        }
        if (opts.json) {
          out(JSON.stringify([...counts].map(([id, pending]) => ({ id, pending })), null, 2));
          return 0;
        }
        if (!counts.size) {
          out("（没有事项关联到任何 space）");
          return 0;
        }
        for (const [id, n] of [...counts].sort()) out(`${id}  ${n} 项未处理`);
        return 0;
      }

      case "export": {
        // 完整账本（含全部时间线）。脚本 / 备份 / 迁移用。
        const all = await store.listItems({ includeClosed: true });
        const items = [];
        for (const it of all.sort((a, b) => a.num - b.num)) {
          items.push({ ...it, timeline: await storeTimeline(store, it.id) });
        }
        out(JSON.stringify({ v: 2, items }, null, 2));
        return 0;
      }

      case "pull": {
        const r = await pullOnce(store, cache, paths.sync, { deviceName: deviceName() });
        // 重建要单独说：它不是「已是最新」，也是排查缓存问题时要看的那一行。
        jsonOut(
          opts,
          r,
          r.rebuilt
            ? `已重建缓存：${r.itemCount} 条事项，游标 → ${r.cursor}`
            : r.advanced
              ? `已同步：拉取 ${r.applied} 条事件，游标 → ${r.cursor}，缓存 ${r.itemCount} 条`
              : `已是最新：游标 ${r.cursor}，缓存 ${r.itemCount} 条`,
        );
        return 0;
      }

      case "devices": {
        if (opts.revoke) {
          await store.revokeDevice(String(opts.revoke));
          jsonOut(
            opts,
            { revoked: String(opts.revoke) },
            `已吊销设备 ${opts.revoke}（不再计入墓碑回收的安全判定）`,
          );
          return 0;
        }
        const list = await store.listDevices();
        if (opts.json) {
          out(JSON.stringify(list, null, 2));
          return 0;
        }
        if (!list.length) {
          out("（还没有设备登记；本机首次 pull 时会登记）");
          return 0;
        }
        for (const d of list) {
          const mark = d.revoked ? "（已吊销）" : "";
          out(`  ${d.id}  ${d.name}  最后拉取 seq=${d.lastPullSeq}  ${fmtTime(d.lastSeen)}${mark}`);
        }
        return 0;
      }

      default:
        throw new UsageError(`未知命令 ${cmd}`);
    }
  } finally {
    await store.close();
  }
}

function deviceName() {
  try {
    return `${require0("os").hostname()}@cli`;
  } catch {
    return "cli";
  }
}

// ESM 里没有 require；用 createRequire 只为拿 hostname，避免为一个字符串引入
// 顶层依赖。找不到 hostname 时退回固定名——设备名只是给人看的标签。
import { createRequire } from "node:module";
const require0 = createRequire(import.meta.url);

async function loadOne(store, ref) {
  const item = ref.id ? await store.getItem({ id: ref.id }) : await store.getItem({ num: ref.num });
  if (!item) {
    throw new TodoError(
      ref.id ? `找不到事项 ${ref.id}` : `找不到编号 #${ref.num} 的事项`,
      "not_found",
    );
  }
  if (item.deletedAt != null) {
    throw new TodoError(`事项 ${refOf(item)} 已被删除（${fmtTime(item.deletedAt)}）`, "not_found");
  }
  return item;
}

async function storeTimeline(store, itemId) {
  // 用 sync.js 的同一个转换，保证 show / export 与面板看到的形状一致。
  const { eventToTimeline } = await import("./sync.js");
  return (await store.fullTimeline(itemId)).map(eventToTimeline);
}

export async function run() {
  // 上游关闭管道时进程应安静退出，而不是打一堆堆栈。
  process.stdout.on("error", (e) => {
    if (e && e.code === "EPIPE") process.exit(0);
  });
  try {
    const code = await main(process.argv.slice(2));
    process.exitCode = code;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`herdr-todo: ${e.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else if (e instanceof DbUnreachableError) {
      process.stderr.write(`herdr-todo: ${e.message}\n`);
      process.exitCode = 4;
    } else if (e instanceof ConflictError) {
      process.stderr.write(`herdr-todo: ${e.message}（其他进程正在写入，请重试）\n`);
      process.exitCode = 3;
    } else if (e instanceof ConfigError) {
      process.stderr.write(`herdr-todo: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`herdr-todo: ${e.message}\n`);
      process.exitCode = 1;
    }
  }
}
