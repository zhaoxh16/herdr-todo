// 用 CodeBuddy 打开一个 space 的目录（herdr-todo 维护，被 tabs-todo 与 menu-todo 各持一份副本）。
//
// 为什么不用 `open`：实测 `open -a "CodeBuddy CN" <dir>` 对第二个目录不会新开窗口，
// 只有 bundle 里的 CLI 能用。CLI 走绝对路径，因为 mod 的 exec 用的是
// `/usr/bin:/bin:/usr/sbin:/sbin`，用户 PATH 上的 `buddycn` 在那里不存在。
//
// 远程 space：CodeBuddy 用内置的 remote-ssh 扩展连过去，authority 前缀是
// `codebuddy-remote-ssh`（扩展里写死的），窗口标题形如 `SQLEngine [SSH: dev8]`。
// 这套拼法是 CodeBuddy 的内部约定，升级后若变了，只需要改本文件的 remoteUri()。

import { exec, notify, home } from "herdr";

// Bundle 内 CLI；与 apps 的安装位置绑定，不读 PATH。
export const CODEBUDDY_CLI = "/Applications/CodeBuddy CN.app/Contents/Resources/app/bin/code";
// remote-ssh 扩展的 authority 前缀（见文件头）。
export const REMOTE_AUTHORITY = "codebuddy-remote-ssh";

/**
 * 一个 space 的目录：它第一个 tab 里第一个有 cwd 的 pane，否则 space 创建时的 folder。
 * 与 spaces-todo 的 place() 同口径——切 pane 不该让按钮指向另一个目录。
 * folder 为 "" 时返回 ""（Herdr 把空 folder 定义为「那台机器的 home」），
 * 由调用方决定怎么解释；只有字段不存在/为 null 才算「没有目录」。
 */
export function spacePath(space, panes) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((c) => c.id));
  const cwd = (panes ?? []).find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
  if (cwd) return cwd;
  return space.folder ?? null;
}

/** 远程路径 → CodeBuddy 的 folder URI；本机返回 null（直接传目录即可）。 */
export function remoteUri(machine, path) {
  if (!machine) return null;
  // 必须逐段编码：encodeURI 不转义 `#` 与 `?`，它们会被 URI 解析成 fragment/query，
  // 路径被截断后 CodeBuddy 打开的是**父目录**，而且 CLI 照样退出 0、提示里还写着
  // 用户以为的那个路径（如 worktree 目录 `.../fix#42`）。encodeURIComponent 只保留
  // 非保留字符，`/` 是分隔符所以按段拆开再拼回。
  //
  // path === "" 是 space 的「空 folder = 那台机器的 home」：实测
  // `vscode-remote://codebuddy-remote-ssh+dev8` 会被 CodeBuddy 规范化成
  // `...%2Bdev8/` 并连到远端 home，正是想要的结果，所以空路径照样发。
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `vscode-remote://${REMOTE_AUTHORITY}+${machine}${encoded}`;
}

/**
 * 打开。await 到最后，失败时给一条可重试的通知。
 * 同一实例同一时刻只允许一个在飞：连点不该开出一串窗口。
 */
export async function openInCodeBuddy(host, { space, path, panes } = {}) {
  const machine = space?.machine ?? null;
  // 空 folder 是合法目录（那台机器的 home）：本机用 home()，远程由 CodeBuddy
  // 连到远端 home。只有 null / undefined 才是真的没有目录。
  const raw = path ?? spacePath(space, panes);
  const target = raw === "" ? (machine ? "" : home()) : raw;
  const where = machine ? `${machine}:${target || "~"}` : target;

  if (target === null || target === undefined) {
    notify({ level: "warning", title: "没有可打开的目录", body: "这个 space 还没有终端，也没有记录目录。" });
    return null;
  }
  if (host.opening) return null;
  host.opening = true;
  try {
    const uri = remoteUri(machine, target);
    const argv = uri ? ["--folder-uri", uri] : [target];
    const r = await exec(CODEBUDDY_CLI, argv, { timeout: 20000 });
    if (r.code === 0) {
      notify({ level: "success", title: "已在 CodeBuddy 打开", body: where, timeout: 2500 });
      return r;
    }
    notify({
      level: "error",
      title: "CodeBuddy 打开失败",
      // 远程首次连接要在那台机器上装 server，慢且可能超时；重试通常就好了。
      body: machine
        ? `${where}：${firstLine(r.stderr) || `退出码 ${r.code}`}。远程首次连接需在远端准备 CodeBuddy Server，可以再点一次。`
        : `${where}：${firstLine(r.stderr) || `退出码 ${r.code}`}`,
      timeout: 6000,
    });
    return r;
  } catch (e) {
    notify({ level: "error", title: "CodeBuddy 打开失败", body: `${where}：${firstLine(String(e?.message ?? e))}`, timeout: 6000 });
    return null;
  } finally {
    host.opening = false;
  }
}

// 通知里只放第一行：stderr 可能很长，toast 装不下。
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
}
