// mod 侧存储。读走 readTextFile（沙箱内唯一能读 home 的方式）；
// **写一律交给 herdr-todo 命令行**。
//
// 为什么不自己写：CLI 用 mkdir 锁目录串行化读-改-写，而这个 mod 过去走
// writeTextFile 的无锁 CAS。两者互不认识——CLI 读到 R、面板 CAS 提交 R'、
// CLI 比对仍是 R 于是 rename 覆盖 R'，双方都报成功，面板那条静默消失。
// 给 mod 再补一套锁只会让两个实现继续分叉。写操作只留一条路径，
// 锁与 CAS 就只有一份，这类竞争从结构上不存在。
//
// 代价：面板编辑需要 herdr-todo 装在 ~/.local/bin（install.sh 装到那里）。
// 用绝对路径而不是 PATH 上的名字：App 启动时的 PATH 与登录 shell 不一定相同。

import { readTextFile, exec, home } from "herdr";
import { normalizeState, emptyState } from "./core.js";

export const DATA_PATH = `${home()}/.local/share/herdr-todo/todos.json`;

// 只留一个候选。列两个（绝对路径 + PATH 上的名字）在默认安装下指向同一个文件，
// 一次超时会被重试成两条写操作——而写是「加一条事项」，重试就是不想要的重复。
const CLI = `${home()}/.local/bin/herdr-todo`;

export class ConflictError extends Error {}
export class CliMissingError extends Error {}

async function readRaw(path) {
  let text;
  try {
    text = await readTextFile(path);
  } catch (e) {
    // 只有「不存在」才是空账本。读失败（超 1 MiB、权限、IO 错误）必须报出去：
    // 把它当成空表会让面板显示 0 条，接着每次编辑都写不进去且原因不明。
    if (/ENOENT|no such file/i.test(String(e?.message ?? e))) return null;
    throw new Error(
      `读取数据文件失败：${e?.message ?? e}\n` +
        `面板通过 readTextFile 读取，上限 1 MiB；账本更大时请用命令行查看，` +
        `或归档/清理旧事项。`,
    );
  }
  // 宿主也可能返回 null 表示「不存在」（见 herdr.d.ts:27）。
  if (text == null) return null;
  return text;
}

const READ_LIMIT = 1024 * 1024;

function parse(raw) {
  if (raw == null || raw.trim() === "") return emptyState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch (e) {
    // 账本正好卡在 1 MiB 上限时，宿主可能拒绝、也可能截断。截断的 JSON 解析
    // 一样会失败，但要说清「可能是太大」，否则用户无从下手。
    const big = raw.length >= READ_LIMIT - 1;
    throw new Error(
      big
        ? `数据文件接近面板的 1 MiB 读取上限（${raw.length} 字符），可能被截断。` +
          `请用 herdr-todo 命令行查看或归档旧事项。`
        : e.message,
    );
  }
}

export async function read(path = DATA_PATH) {
  const raw = await readRaw(path);
  try {
    return parse(raw);
  } catch (e) {
    // 数据损坏时不让整个面板白屏：抛出带原因的错误，由 UI 显示。
    throw new Error(`数据文件有问题：${e.message}`);
  }
}

/**
 * 跑一条 herdr-todo 命令。返回 stdout；非零退出码抛出，并带上 CLI 的报错文本。
 *
 * 参数必须分成三段，顺序不能变：
 *
 *   [面板自己的选项] [子命令] -- [位置参数]
 *
 * - 面板自己的选项放在子命令**之前**：解析器扫描整个 argv，放哪都能识别，
 *   但放在前面就不会被下面那个 `--` 变成位置参数。
 * - `--` 之后的都是数据。用户标题完全可能就叫 `-h`、`--` 或 `--space`；
 *   不隔开的话这三种会分别变成「打印帮助并成功退出」「吞掉面板的选项并写到
 *   默认账本」「标题与 space 对调」，而且都 exit 0。
 * - 值里可能含 `=`/`--` 的选项一律用 `--key=value` 单 token 传入，避免
 *   用户文本被当成键。
 */
export async function command(args, options = {}) {
  const path = options.path ?? DATA_PATH;
  const flags = options.flags ?? [];
  const [sub, ...rest] = args.map(String);
  const argv = ["--json", "--by", "panel", `--file=${path}`, ...flags, sub, "--", ...rest];

  let r;
  try {
    r = await exec(CLI, argv, { timeout: 20000 });
  } catch (e) {
    // 程序不在：只有这一种情况值得报「请先运行 install.sh」。
    // 超时混在这里会让调用方以为没装，所以分开判断。
    const msg = String(e?.message ?? e);
    if (/ENOENT|no such file|not found/i.test(msg)) {
      throw new CliMissingError(`找不到 herdr-todo 命令（${CLI}）。请先运行 install.sh。`);
    }
    throw new Error(`调用 herdr-todo 失败：${msg}`);
  }
  if (r.code === 0) {
    // CLI 在 `-h`/无子命令时也会 exit 0 并打印用法。走到这里说明参数没按约定
    // 传，写操作很可能没发生——报错比静默成功好。
    if (/^herdr-todo —/.test(String(r.stdout ?? "").trimStart())) {
      throw new Error("herdr-todo 只打印了用法，没有执行操作（参数形式不对）");
    }
    return r.stdout;
  }
  const msg = (r.stderr || r.stdout || "").trim();
  // 退出码 3 是 CLI 的写入冲突（锁超时 / 比对失败），单独建模好让 UI 说人话。
  if (r.code === 3) throw new ConflictError(msg || "数据文件正在被其他进程改写");
  throw new Error(msg || `herdr-todo ${sub} 失败（退出码 ${r.code}）`);
}

export function dataDir() {
  return DATA_PATH.replace(/\/todos\.json$/, "");
}
