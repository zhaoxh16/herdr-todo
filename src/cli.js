// 命令行入口。只做参数解析与输出，所有业务规则来自 core.js，落盘来自 io.js。

import {
  addItem,
  setStatus,
  setPriority,
  setTitle,
  setNote,
  setSpaces,
  moveSpace,
  setAgent,
  archiveItem,
  unarchiveItem,
  sortItems,
  summary,
  timelineOf,
  CLOSED_STATUSES,
  STATUSES,
  PRIORITIES,
  TodoError,
} from "./core.js";
import { createNodeStore, defaultDataPath, ConflictError } from "./io.js";

const USAGE = `herdr-todo — 记录工作事项并与 Herdr space 关联

用法：
  herdr-todo add <标题> [选项]
  herdr-todo list [选项]
  herdr-todo show <id>
  herdr-todo status <id> <状态> [--reopen]
  herdr-todo priority <id> <P0-P3>
  herdr-todo title <id> <新标题>
  herdr-todo note <id> <文本>          （文本用 - 表示从 stdin 读）
  herdr-todo link <id> <space...>
  herdr-todo unlink <id> [space...]
  herdr-todo move <id> [space] [--from <space>]
                                          从一个 space 挪到另一个（省略 = 未关联）
  herdr-todo set-spaces <id> [space...]   整体替换关联（脚本用；面板走 link/unlink）
  herdr-todo agent <id> <address> --in-space <space>
                                          关联到某个 agent（替代 space 关联）
  herdr-todo agent <id> --clear           解除 agent 关联
  herdr-todo archive <id>                 归档（从列表收起，数据仍保留）
  herdr-todo unarchive <id>               取消归档（状态回到 todo）

提示：status --reopen 也会取消归档。
  herdr-todo spaces
  herdr-todo export

选项：
  --file <路径>        使用指定数据文件（默认 ${defaultDataPath()}）
  --space <id|名称>    新建时直接关联（可重复）
  --priority <P0-P3>   新建时指定优先级（默认 P2）
  --status <状态>      新建时指定状态（默认 todo）
  --note <文本>        备注（新建时附上；note 子命令用它替换）
  --all                列表包含已完成/已取消
  --by <名字>          时间线里记录的操作者（默认 cli；面板传 panel）
  --json               输出机器可读 JSON

状态：${STATUSES.join(" / ")}
优先级：${PRIORITIES.join(" / ")}
`;

export class UsageError extends Error {}

// 带值的选项。显式列出来，是为了让 `--` 之前的位置参数（标题、备注、space id）
// 被当作数据而不是语法：`add -- --space spA` 里的 `--space` 是标题的一部分。
const VALUE_OPTIONS = new Set(["space", "file", "priority", "status", "note", "by", "in-space"]);
// `--from` 可以重复（孤儿组拖出时要一次摘掉多个已不存在的 space id），
// 所以走和 --space 一样的收集，而不是单值。
const REPEAT_OPTIONS = new Set(["from"]);
const FLAG_OPTIONS = new Set(["json", "all", "reopen", "clear"]);

function parseArgs(argv) {
  const opts = { spaces: [], from: [], _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      // `--` 之后一律是位置参数。调用方（面板）用它把用户输入与自己的选项隔开。
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-") opts.stdin = true;
    else if (a.startsWith("--")) {
      // 支持 --key=value 与 --key value 两种写法。
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (FLAG_OPTIONS.has(key)) {
        opts[key === "json" ? "json" : key === "all" ? "all" : key === "reopen" ? "reopen" : "clear"] = true;
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

function renderItemLine(it) {
  const mark = STATUS_MARK[it.status] ?? "?";
  const note = it.note ? `  · 备注 ${it.note.length} 字` : "";
  return `  ${mark} ${it.id}  ${it.priority}  ${it.title}${note}`;
}

function linkText(item) {
  // agent 与 space 互斥（core 的写入函数强制），所以这两者是「或」不是「和」。
  if (item.agent) return `agent ${item.agent.address}（关掉后回退到 ${item.agent.space}）`;
  return item.spaces.length ? item.spaces.join(", ") : "（未关联）";
}

function renderTimeline(item) {
  const lines = [`# ${item.id} ${item.title}`, ""];
  lines.push(`状态：${item.status}    优先级：${item.priority}`);
  lines.push(`关联：${linkText(item)}`);
  lines.push(`创建：${fmtTime(item.created)}    更新：${fmtTime(item.updated)}`);
  if (item.archived != null) lines.push(`归档：${fmtTime(item.archived)}（reopen 可恢复）`);
  if (item.note) {
    lines.push("", "## 备注", item.note);
  }
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
    case "spaces": {
      // 数据层已经拒绝形状不对的条目；这里再容一次，是为了让历史账本里
      // 残留的畸形条目只显示成一行怪文本，而不是把 `show` 整个弄挂。
      const f = listText(e.from, ",") || "无";
      const t = listText(e.to, ",") || "无";
      return `关联 ${f} → ${t}`;
    }
    case "agent":
      // agent 与 space 互斥（core 的写入函数强制），这一条不是追加而是替换。
      return `agent ${e.from || "无"} → ${e.to || "无"}`;
    default:
      return e.kind;
  }
}

function actorOf(opts) {
  return (opts && opts.by) || "cli";
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

export async function main(argv, env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help || opts._.length === 0) {
    out(USAGE);
    return 0;
  }
  const [cmd, ...rest] = opts._;
  // --file= 是空串时不能回退默认账本：用户明确写了 --file，静默写到别处
  // 等于把数据分流到他自己都不知道的文件里。
  if (opts.file !== undefined && !String(opts.file).trim()) {
    throw new UsageError("--file 需要一个路径（不能为空）");
  }
  const store = createNodeStore(opts.file ?? defaultDataPath(env));
  const by = actorOf(opts);

  switch (cmd) {
    case "add": {
      const title = rest.join(" ").trim();
      if (!title) throw new UsageError("add 需要标题");
      const note = opts.stdin ? await readStdin() : opts.note;
      const spaces = opts.spaces.map(cleanSpaceArg);
      const result = await store.update((st) =>
        addItem(
          st,
          { title, note: note ?? "", spaces, priority: opts.priority, status: opts.status },
          undefined,
          { by },
        ),
      );
      const item = result.state.items.at(-1);
      if (opts.json) out(JSON.stringify(item, null, 2));
      else out(`已添加 ${item.id}  ${item.priority}  ${item.title}`);
      return 0;
    }

    case "list": {
      // CLI 不连接 Herdr，拿不到 space 的名称/存活状态，所以不做分组；
      // 按 space 分组是面板的职责（那里有实时空间数据）。
      const st = await store.read();
      // --all 含已完成与已归档；默认只列还在手上的。归档项在详情里仍可查。
      const pool = opts.all
        ? st.items
        : st.items.filter((i) => !CLOSED_STATUSES.includes(i.status) && !i.archived);
      if (opts.json) {
        out(JSON.stringify(sortItems(pool), null, 2));
        return 0;
      }
      if (!pool.length) {
        out("（没有未完成的事项）");
        return 0;
      }
      const sum = summary(st.items);
      out(`未处理 ${sum.pending} · P0 ${sum.p0} · 已完成 ${sum.done}`);
      out("");
      for (const it of sortItems(pool)) {
        out(renderItemLine(it));
        // agent 关联不打印成「关联：…」的 space 列表：它不是 space。
        if (it.agent) out(`       关联：agent ${it.agent.address}（关掉后回退到 ${it.agent.space}）`);
        else if (it.spaces.length) out(`       关联：${it.spaces.join(", ")}`);
      }
      return 0;
    }

    case "show": {
      const id = rest[0];
      if (!id) throw new UsageError("show 需要 id");
      const st = await store.read();
      const item = st.items.find((i) => i.id === id);
      if (!item) throw new UsageError(`找不到事项 ${id}`);
      out(opts.json ? JSON.stringify(item, null, 2) : renderTimeline(item));
      return 0;
    }

    case "status": {
      const [id, status] = rest;
      if (!id || !status) throw new UsageError(`status 需要 id 和状态（${STATUSES.join("/")}）`);
      const r = await store.update((st) => setStatus(st, id, status, { by, reopen: opts.reopen }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 状态 → ${item.status}`);
      return 0;
    }

    case "priority": {
      const [id, p] = rest;
      if (!id || !p) throw new UsageError(`priority 需要 id 和 P0-P3`);
      const r = await store.update((st) => setPriority(st, id, p.toUpperCase(), { by }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 优先级 → ${item.priority}`);
      return 0;
    }

    case "title": {
      const [id, ...words] = rest;
      const title = words.join(" ").trim();
      if (!id || !title) throw new UsageError("title 需要 id 和新标题");
      const r = await store.update((st) => setTitle(st, id, title, { by }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 标题 → ${item.title}`);
      return 0;
    }

    case "note": {
      const id = rest[0];
      if (!id) throw new UsageError("note 需要 id");
      const text = opts.stdin ? await readStdin() : (opts.note ?? rest.slice(1).join(" "));
      // 省略文本会被当成「清空备注」，而时间线只记字数、正文不可恢复。
      // 清空是需要明说的动作，不是敲错命令的副作用。
      if (!opts.stdin && opts.note === undefined && text === "") {
        throw new UsageError(
          "note 需要备注文本；确实要清空请用 --note \"\"（传空串）",
        );
      }
      const r = await store.update((st) => setNote(st, id, text, { by }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 备注已更新（${item.note.length} 字）`);
      return 0;
    }

    case "link": {
      const [id, ...pos] = rest;
      // --space 与位置参数等价。只读 rest 会让 `link t1 --space spC` 静默失败。
      const spaces = [...pos, ...opts.spaces];
      if (!id || !spaces.length) throw new UsageError("link 需要 id 和一个以上 space");
      const r = await store.update((st) => {
        const item = st.items.find((i) => i.id === id);
        if (!item) throw new TodoError(`找不到事项 ${id}`, "not_found");
        return setSpaces(st, id, [...item.spaces, ...spaces], { by });
      });
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 关联 → ${item.spaces.join(", ")}`);
      return 0;
    }

    case "unlink": {
      const [id, ...pos] = rest;
      const spaces = [...pos, ...opts.spaces];
      if (!id) throw new UsageError("unlink 需要 id");
      const r = await store.update((st) => {
        const item = st.items.find((i) => i.id === id);
        if (!item) throw new TodoError(`找不到事项 ${id}`, "not_found");
        const remove = new Set(spaces);
        const keep = spaces.length ? item.spaces.filter((s) => !remove.has(s)) : [];
        return setSpaces(st, id, keep, { by });
      });
      const item = r.state.items.find((i) => i.id === id);
      out(
        opts.json
          ? JSON.stringify(item, null, 2)
          : `${id} 关联 → ${item.spaces.length ? item.spaces.join(", ") : "（未关联）"}`,
      );
      return 0;
    }

    case "unarchive": {
      const id = rest[0];
      if (!id) throw new UsageError("unarchive 需要 id");
      const r = await store.update((st) => unarchiveItem(st, id, { by }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 已取消归档（状态 ${item.status}）`);
      return 0;
    }

    case "archive": {
      const id = rest[0];
      if (!id) throw new UsageError("archive 需要 id");
      const r = await store.update((st) => archiveItem(st, id, { by }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 已归档（状态 ${item.status}，数据保留）`);
      return 0;
    }

    case "agent": {
      // CLI 不连 Herdr，所以「agent 在哪个 space」必须由调用方（面板）传进来。
      // 这个 space 会在 agent 关掉后承担回退显示，是关联的一部分而不是可选装饰——
      // 缺了它，那条事项在 agent 消失后就无处可归。--clear 用于解除关联。
      const [id, address] = rest;
      if (!id) throw new UsageError("agent 需要 id");
      if (opts.clear) {
        if (address) throw new UsageError("--clear 不接受 address");
        const r = await store.update((st) => setAgent(st, id, null, { by }));
        out(opts.json ? JSON.stringify(r.state.items.find((i) => i.id === id), null, 2) : `${id} 已解除 agent 关联`);
        return 0;
      }
      if (!address) throw new UsageError("agent 需要 id 和 address（或 --clear）");
      if (!opts.inSpace) throw new UsageError("agent 需要 --in-space <space>：agent 关掉后靠它回退显示");
      const link = { address: String(address).trim(), space: String(opts.inSpace).trim() };
      if (!link.address || !link.space) throw new UsageError("agent 的 address 与 --in-space 都不能为空");
      const r = await store.update((st) => setAgent(st, id, link, { by }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 关联 → agent ${link.address}（回退 space ${link.space}）`);
      return 0;
    }

    case "move": {
      // 拖拽用：把事项从一个 space 挪到另一个（或挪到未关联）。
      // 与 link+unlink 的两次写不同，这是一次加锁的读改写，中间不会被并发写覆盖；
      // 而且「移走」的语义是替换来源，不会留下两个 space 同时显示它。
      // `--from` 省略表示来源不是某个 space（未关联组、或原先挂在 agent 上）。
      // 可重复：孤儿组清理要一次摘掉多个已不存在的 space id。
      const [id, ...pos] = rest;
      const to = pos[0] ?? opts.spaces[0] ?? null;
      if (!id) throw new UsageError("move 需要 id");
      if (pos.length > 1) throw new UsageError("move 只接受一个目标 space");
      // 来源里的目标本身要去掉：`move t1 spB --from spB` 若照做会先删再加，
      // 结果虽然一样，却在时间线上多记两条「改了又改回来」，读起来像出过问题。
      const froms = [...new Set(opts.from)].filter((s) => s && s !== to);
      const r = await store.update((st) => {
        // 依次摘来源再落目标，全在同一次加锁的读改写里：多次写会留下中间态，
        // 也会让并发的另一条写插在中间。
        let next = st;
        for (const from of froms) next = moveSpace(next, id, from, null, { by });
        return moveSpace(next, id, null, to, { by });
      });
      const item = r.state.items.find((i) => i.id === id);
      out(
        opts.json
          ? JSON.stringify(item, null, 2)
          : `${id} 关联 → ${item.spaces.length ? item.spaces.join(", ") : item.agent ? `agent ${item.agent.address}` : "（未关联）"}`,
      );
      return 0;
    }

    case "set-spaces": {
      // 整体替换关联列表。脚本里「这组 space 就是全部」的场合用它；
      // 面板不用它——面板手里的列表是 render 快照，拿它做绝对值会覆盖掉
      // 并发新增的关联（见 mod/main.js 的 addSpace/removeSpace 注释）。
      const [id, ...pos] = rest;
      if (!id) throw new UsageError("set-spaces 需要 id");
      // 两个来源都算：只读位置参数时，`set-spaces t1 --space spC` 会被当成
      // 「清空全部关联」并 exit 0 —— 一条命令静默改错用户数据。
      const all = [...pos, ...opts.spaces];
      const next = [...new Set(all.map((s) => String(s).trim()).filter(Boolean))];
      const r = await store.update((st) => setSpaces(st, id, next, { by }));
      const item = r.state.items.find((i) => i.id === id);
      out(opts.json ? JSON.stringify(item, null, 2) : `${id} 关联 → ${next.join(", ") || "（未关联）"}`);
      return 0;
    }

    case "spaces": {
      // 数据文件里出现过的 space id 及计数：CLI 不连 Herdr，只反映账本自身。
      // 关联到 agent 的事项按它的**回退 space** 计数：agent 关掉后它就显示在
      // 那个 space 下，脚本按本命令规划 space 时不该漏掉它。
      const st = await store.read();
      const counts = new Map();
      for (const it of st.items) {
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
      const st = await store.read();
      out(JSON.stringify(st, null, 2));
      return 0;
    }

    default:
      throw new UsageError(`未知命令 ${cmd}`);
  }
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
    } else if (e instanceof ConflictError) {
      process.stderr.write(`herdr-todo: ${e.message}（其他进程正在写入，请重试）\n`);
      process.exitCode = 3;
    } else {
      process.stderr.write(`herdr-todo: ${e.message}\n`);
      process.exitCode = 1;
    }
  }
}
