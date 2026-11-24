// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
// [herdr-todo] 这一行比上游多了 checking/agents（待办扩展要用的）与
// appHome/readTextFile（右键菜单探明 menu-todo 是否装着）。重新克隆后这 4 个名字
// 必须加回去——漏掉任何一个都会在 init 或右键时抛 ReferenceError，而
// herdr-app check 因为 checking() 短路与不执行 menu() 而照样报 passed。
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, checking, agents, appHome, readTextFile } from "herdr"; // [herdr-todo]
import { read, command, dataDir, sync } from "./store.js";
import { deriveSidebar } from "./todo-view.js";
import { DRAG_KEY, readDrag, beginDrag, endDrag, staleOnPress, dragGhost, learnRoot } from "./todo-drag.js";

// [herdr-todo] menu-todo 探明的判据：这段文本像不像一个能加载的 ES 模块。
// 只做「不为空、不是纯注释、有 export」这三件判断——空文件与语法错是 present-but-broken
// 最常见的两种；不完整解析（mod 沙箱里没有解析器，写个半吊子解析器只会误判）。
function looksLoadable(text) {
  if (typeof text !== "string") return false;
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/^\s*\/\/.*$/gm, "") // 行注释
    .trim();
  if (!code) return false;
  return /\bexport\b/.test(code);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    // [herdr-todo] space 右键菜单用本仓库的 menu-todo（多了「用 CodeBuddy 打开」）。
    // 探明它是否真的装着：openOverlay 指向不存在的 mod 不报错，只是什么也不显示，
    // 那时必须退回自带 menu，否则整份 space 菜单会静默失效。
    // 默认 false（= 用自带 menu）：没探明之前退回到「一定能用」的那个。
    this.menuTodo = false;
    this.probeMenuTodo();
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    // [herdr-todo] 指向本仓库的克隆件（多了「用 CodeBuddy 打开」一项）。
    // menu-todo 没装上时必须退回 App 自带的 menu：openOverlay 指向不存在的 mod
    // 不抛错（实测返回一个 overlay id），菜单不出现，space 的整份右键菜单
    // （重命名/关闭/worktree）会一起失效。可用性在 init 时异步探明（见 probeMenuTodo()），
    // 这里同步分支，不为弹菜单引入一个「点了稍后才出现」的异步窗口。
    openOverlay({
      mod: this.menuTodo ? "menu-todo" : "menu",
      kind: "popup",
      width: 200,
      height: 260,
      props: { tab: "space", target: { id: w.id } },
    });
  }

  /**
   * [herdr-todo] 探明 menu-todo 能不能用；拿不准就保持 false，退回自带 menu。
   *
   * `openOverlay` 指向不存在的 mod 不报错、也不显示任何东西，所以判据必须自己给。
   * `herdr-app check` 不校验目标存在性，帮不上忙。
   *
   * 两层判据，都只看「文件内容像不像一个能加载的 mod」，不真去加载（mod 沙箱里没有
   * import 任意路径的能力）：
   *   1. main.js 读得到；
   *   2. 它是 ES 模块（有 export）——空文件、纯注释、JSON 片段都算坏；
   * 外加 `codebuddy.js` 也在：menu-todo 的 main.js 第一件事就是 import 它，
   * 缺了照样是「加载失败的 mod」。这三条都是「present but broken」的常见形态。
   *
   * `herdr-app check` 里不跑：那时读的是仓库里的 mod 目录而不是用户的安装目录，
   * 结果没有意义（而且 checking() 短路是本 mod 的既有约定）。
   */
  probeMenuTodo() {
    if (checking()) return;
    this.menuTodo = false;
    const dir = `${appHome()}/mods/menu-todo`;
    Promise.all([readTextFile(`${dir}/main.js`), readTextFile(`${dir}/codebuddy.js`)]).then(
      ([main, dep]) => {
        this.menuTodo = looksLoadable(main) && looksLoadable(dep);
      },
      () => { this.menuTodo = false; },
    );
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      this.activeAt = rows.findIndex(r => r.w.active);
      return rows.map(draw);
    }
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const items = [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
      const first = folded ? -1 : mine.findIndex(r => r.w.active);
      if (first >= 0) this.activeAt = before + 1 + guidance.length + first;
      before += items.length;
      return items;
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one. When the row is full, it
  // and the name both start from their text's width and give way in proportion.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        // [herdr-todo] 只在高度**真的变了**时这么做。宿主每次渲染都会用同一个尺寸再报
        // 一次 on_size_change；原样调用 scroll_to_item 会把用户滚到别处的列表静默拉回
        // 活动行——表现为滚到底、停几秒后又「弹回来」。尺寸没变，就没有行被挤出去。
        // 也不在这里 notify()：那是 render → size_change → notify 的自激循环。
        .on_size_change((size) => {
          const last = this.listHeight;
          this.listHeight = size.height;
          if (last === size.height) return;
          if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
        })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(list));
  }
}

// =====================================================================
// ======= 以上是 App 自带 spaces mod 的原样克隆（升级时整段替换） =======
// =====================================================================
//
// 待办扩展（herdr-todo 维护，非上游代码）
//
// App 自带的 `spaces` 是只读的、每次启动被整份替换，所以这份 mod 是它的克隆件，
// 只在**末尾**做运行时包装：不改上面的任何一行，避免升级时人工合并越滚越大。
//
// 依赖的上游内部结构（升级后改了就需重新克隆并重贴这一段）：
//  - `Spaces.prototype.row(r, t)`：r.w 是这个 space，返回一条已排版的行元素；
//  - `Spaces.prototype.grouped(t, collapsed)`：返回侧栏列表的直接子元素数组，
//    并设置 this.activeAt（活动 space 在其中的下标）；
//  - 实例字段 this.scroll 被 render() 用来 scroll_to_item。
//
// 待办子行是**追加**在 space 行后面的独立元素，不嵌进上游行内部：上游行的
// 高度是固定的 rowHeight（28/30），塞进去会互相挤压。
// =====================================================================

const STATUS_GLYPH = { todo: "○", doing: "◐", blocked: "●", done: "✓", cancelled: "✕" };
const STATUS_LABEL = { todo: "待办", doing: "进行中", blocked: "阻塞", done: "完成", cancelled: "取消" };

function relTime(ms) {
  if (!ms) return "";
  const d = Math.max(0, Date.now() - ms);
  const min = Math.floor(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toISOString().slice(0, 10);
}

// 只有「需要我动手」的才用强调色，其余压暗：侧栏的信息密度已经很高。
// 旧的右侧面板用 ○ 表示待办（muted），侧栏更窄，改用 dim 免得待办行整排发亮。
// 颜色名取自 theme() 的文档列表：working / blocked / done / ansi1 / ansi3。
function statusColor(status, t) {
  if (status === "blocked") return t.blocked;
  if (status === "doing") return t.working;
  return t.dim;
}
function priorityColor(p, t) {
  if (p === "P0") return t.ansi1;
  if (p === "P1") return t.ansi3;
  return t.dim;
}

/**
 * 「数据库不可达，显示的是 X 前的缓存」。
 *
 * F8 的判据：拉取失败时明确说陈旧，不清空列表，也不编造时间。`lastPullAt`
 * 来自 sync.json 的 last_pull_at（**最后一次成功 pull**），不是缓存的写入时间——
 * 本机写只让一条事项变新，不代表整份缓存新鲜。没有这个字段时如实说「尚未同步成功」。
 */
function syncStaleText(s) {
  const when = s && s.lastPullAt ? `${relTime(s.lastPullAt)}（${new Date(s.lastPullAt).toLocaleString()}）` : null;
  return when
    ? `数据库不可达，显示的是 ${when} 的缓存`
    : "数据库不可达，尚未同步成功过（显示的是本地残留缓存）";
}

const SpacesTodo = Spaces.prototype;

// ---------- 数据 ----------

  const upstreamInit = SpacesTodo.init;
SpacesTodo.init = function todoInit(p, cx) {
  upstreamInit.call(this, p, cx);

  this.todoState = null;
  this.todoError = null;
  // 鼠标停在哪个 space 行上。只用来决定该行的 ＋ 显不显示；变化时才 notify。
  this.todoHover = null;
  // 指针此刻悬在哪个投放目标上（space id、或 "unlinked"）。
  // 不能复用 todoHover：那个还决定 ＋ 显不显示，拖拽时把它顶出来会闪。
  this.todoDropAt = null;
  // 展开过「已完成 N」的 group key。默认收起：做完的事不该常驻侧栏。
  this.todoExpanded = new Set();
  // 手上拿着哪一条待办：{ id, from, at }。按下即设置，松手清掉。
  // 不记「是否移动过」——宿主不提供按键状态，那种判定会留下无法清除的残留
  // （见 todoRow 的注释）。
  this.todoDrag = null;
  // 本 mod 根元素在窗口坐标里的矩形 {x, y, w, h}。
  //
  // 跟随标签按窗口坐标定位（见 todo-drag.js 的 dragGhost）：拖拽会跨出本 mod 的
  // block 进入 Agents 栏，两边都用同一套坐标才能把标签无缝交接过去。矩形由根元素
  // 的指针事件（position − local_position）与 on_size_change 学到并缓存。
  this.todoRoot = null;

  // 同步状态：{ ok, error, lastPullAt } 或 null（还没同步过）。
  // 拉取失败不抛穿——侧栏要一直能用缓存，只在顶部显示一行「显示的是几点前的缓存」。
  this.todoSync = null;
  // 在途标记：10 秒 tick 与 watchFolder 都可能触发，同一时间只跑一个 pull，
  // 否则多个请求会在同一把本地文件锁上排队白等。
  this.todoSyncing = false;
  this.todoLoad(cx);
  this.todoWatch(cx);
  // 兜底轮询：watchFolder 在个别文件系统上可能漏事件，低频重读保证最终一致。
  //
  // 顺带做手势的过期清理。松手落在没有处理者的位置（终端区、窗口空白）时本 mod
  // 收不到 mouse_up，`shared` 也没人清——而那一刻没有任何东西会触发重渲染，把
  // 超时判定放在 render 路径上就永远等不到。
  //
  // 超时值见 todo-drag.js 的 DRAG_TTL（15 秒）。宿主不提供「左键是否仍按着」，
  // 脚本无法区分「还按着」与「已经放弃但没人通知」；取短了会在中途把正在找目标的
  // 手势静默取消，取长了残留多留一会儿。
  cx.timer.every(2000, (cx2) => {
    if (checking()) return;
    if (!shared(DRAG_KEY)) {
      if (this.todoDrag) this.todoDrag = null;
      return;
    }
    // 过期的手势（readDrag 会按 TTL 判定）连同本实例的副本一起清掉。
    if (!readDrag()) {
      this.todoDrag = null;
      setShared(DRAG_KEY, null);
      cx2.notify();
    }
  });
  // 原来的 10 秒读账本保底还得留：watchFolder 漏事件时它才是最终一致的那一环。
  // 10 秒 tick：先 pull 再读缓存。顺序不能反——先读会把上一轮的旧内容画上去，
  // 多一次闪烁；而 pull 失败时读到的仍是缓存，行为与迁移前一致。
  cx.timer.every(10000, (cx2) => this.todoSync2(cx2));
};

/**
 * 一轮同步 + 重读。**串行化**：在途时直接返回，不排队——10 秒后还有下一轮，
 * 排队只会让恢复变慢。失败时把原因记进 todoSync，由渲染层显示一行提示。
 */
SpacesTodo.todoSync2 = function todoSync2(cx) {
  if (checking()) return;
  if (this.todoSyncing) return;
  this.todoSyncing = true;
  cx.spawn(async (cx2) => {
    try {
      const r = await sync();
      this.todoSync = r;
    } finally {
      this.todoSyncing = false;
    }
    // 不论成功失败都要重读缓存：失败时缓存可能是别的路径（CLI 同机写入）刚更新的。
    await this.todoLoad(cx2);
  });
};

SpacesTodo.todoLoad = function todoLoad(cx) {
  if (checking()) return;
  cx.spawn(async (cx2) => {
    try {
      this.todoState = await read();
      this.todoError = null;
    } catch (e) {
      // 读失败单独记：面板上看到的可能是旧数据，不能当成「没有待办」。
      this.todoError = String(e?.message ?? e);
    }
    try {
      cx2.notify();
    } catch {
      // 这一份已经关掉了（切换布局）：没有界面要刷新。
    }
  });
};

SpacesTodo.todoWatch = function todoWatch(cx) {
  if (checking()) return;
  cx.spawn(async (cx2) => {
    for (;;) {
      try {
        await watchFolder(dataDir());
      } catch {
        // 目录还不存在（还没写过账本）。立刻重试会空转成上万次读取。
        await cx2.sleep(3000);
        continue;
      }
      this.todoLoad(cx2);
    }
  });
};

SpacesTodo.todoGroups = function todoGroups() {
  const known = (spaces() ?? []).map((s) => ({ id: s.id, name: s.name }));
  // agent 列表必须有：关联到活 agent 的事项侧栏不列（由 Agents 栏显示），
  // 只有 agent 关掉后才回退到它关联当时的 space。少传这个参数会让所有
  // agent 事项都被当成「已关闭」而提前回退。
  const live = (agents() ?? []).map((a) => ({ address: a.address, space: a.space, name: a.title }));
  return deriveSidebar(this.todoState ?? { items: [] }, known, live);
};

// ---------- 行渲染 ----------

/**
 * 一条待办子行：既是**拖动源**，也是点击打开详情窗的入口。
 *
 * 按下即声明「手上拿着这条待办」，松手位置决定动作——与上游 `spaces` 的拖拽
 * 排序同一套模型：松手还在这一行就是点击，松手在某个投放目标（space 行、Agents
 * 栏的 agent 行）上就是投放，松手在别处就是取消。
 *
 * **刻意不做位移阈值判定**：宿主不告诉脚本「左键是否还按着」，靠位移猜出来的
 * 拖拽态在「按下后松手在别处」时会永远残留（本行收不到 mouse_up），之后指针
 * 不按键划过就会被当成继续拖。改用按下即写入，并由收到按下的根元素作废旧手势
 * （todo-drag.js 的 staleOnPress）。
 *
 * `src` 是来源描述 `{ kind, key, spaces }`：投放时要靠它算「从哪儿挪走」。
 * 从 space 组拖走只移除该组；从孤儿组拖走则清掉那些已不存在的 id。
 */
SpacesTodo.todoRow = function todoRow(it, t, src, indent) {
  // 孤儿组要清掉的是「这条事项自己关联的全部 space」——它们都已不存在（否则
  // 它会显示在那些 space 下，而不是这里）。来源描述里放的是组的属性，不是这一
  // 条的数据，所以在这里按条补上。手改过的账本可能让 `spaces` 不是数组，退化
  // 成空数组即可，不该让整行渲染挂掉。
  const origin =
    src.kind === "orphan" && !Array.isArray(src.spaces)
      ? { ...src, spaces: Array.isArray(it.spaces) ? it.spaces : [] }
      : src;
  const line = h_flex()
    .id(`todo-${src.key}-${it.id}`)
    .h(20)
    .pl(indent)
    .pr(6)
    .gap(6)
    .items_center()
    .rounded(4)
    .hover((s) => s.bg(t.hover))
    // 拿着它的时候压暗：告诉读者「被拿起的是这一条」。
    .when(this.todoDrag?.id === it.id, (el) => el.opacity(0.45))
    .on_mouse_down("left", () => {
      this.todoDrag = { id: it.id, title: it.title, from: origin, at: Date.now() };
      // 跨 mod 传不出指针事件，用 shared 作通道：Agents 栏据此认出「手上拿着
      // 哪一条」，并在它自己的目标行上松手时关联。
      beginDrag(it, origin);
    })
    .on_mouse_up("left", (_e, cx) => {
      const drag = this.todoDrag;
      this.todoDrag = null;
      // 先清 shared：松手落在本行说明这次手势到此为止。若松开位置在别处，
      // 由收到松开事件的元素负责处置（投放），本处理根本不会被调用。
      endDrag();
      // 拿起的不是这一条、或来自别的组（重渲染后行还在但手势已换）＝不当作点击。
      if (!drag || drag.id !== it.id || drag.from?.key !== src.key) return;
      // 按下与松开在同一行 = 点击，照常打开详情。
      openOverlay({
        mod: "herdr-todo",
        kind: "window",
        key: "herdr-todo-detail",
        width: 420,
        height: 520,
        props: { detail: it.id },
      });
      cx.notify();
    })
    .child(div().w(10).flex_none().text_size(11).text_color(statusColor(it.status, t)).child(STATUS_GLYPH[it.status] ?? "?"))
    .child(div().w(18).flex_none().text_size(9).font_semibold().text_color(priorityColor(it.priority, t)).child(it.priority))
    .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(it.title));
  // 已回退到 space 的事项标出它原来挂在哪个 agent 上：否则用户只会看到一条
  // 突然出现在 space 下的待办，不知道这是一条「agent 关了」的事项。
  // 账本是用户可以手改的 JSON：`agent` 存在但 `address` 缺失时只退化成不显示
  // 标记，不能因为一条坏数据把整个侧栏渲染挂掉。
  if (it.agent) {
    const tail = typeof it.agent.address === "string" ? it.agent.address.split("/").pop() : "";
    if (tail) line.child(div().flex_none().text_size(9).text_color(t.dim).child(`↩ ${tail}`));
  }
  const at = relTime(it.updated);
  if (at) line.child(div().flex_none().text_size(9).text_color(t.dim).child(at));
  return line;
};

/**
 * 一组的待办子行：开放项逐条 + 末尾「已完成 N」（可展开）。没有开放也没有已完成时返回 []。
 *
 * `src` 见 todoRow：`{ kind, key, spaces }`。
 */
SpacesTodo.todoLines = function todoLines(bucket, t, src) {
  if (!bucket || (!bucket.open.length && !bucket.closed.length)) return [];
  const key = src.key;
  const out = bucket.open.map((it) => this.todoRow(it, t, src, 30));
  if (bucket.closed.length) {
    const open = this.todoExpanded.has(key);
    out.push(
      h_flex()
        .id(`todo-done-${key}`)
        .h(18)
        .pl(30 + 12)
        .pr(6)
        .items_center()
        .rounded(4)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (open) this.todoExpanded.delete(key);
          else this.todoExpanded.add(key);
          cx.notify();
        })
        .child(div().text_size(10).text_color(t.dim).child(`${open ? "▾" : "▸"} 已完成 ${bucket.closed.length}`)),
    );
    if (open) {
      for (const it of bucket.closed) {
        out.push(
          this.todoRow(it, t, src, 30 + 12).child(
            div()
              .flex_none()
              .text_size(9)
              .text_color(it.status === "done" ? t.done : t.dim)
              .child(STATUS_LABEL[it.status] ?? ""),
          ),
        );
      }
    }
  }
  return out;
};

/**
 * ＋ 按钮：给这个 space 记一条待办。
 *
 * 只在鼠标停在这一行时出现（见 row 包装里的 todoHover）。画成一个小方框、
 * 字色 dim，与上游那行裸「＋ New space there」区分开：那一行是「新建 space」，
 * 这里记的是待办，功能完全不同却在空 space 下上下紧挨着。
 */
SpacesTodo.todoAddButton = function todoAddButton(spaceId, t) {
  return div()
    .id(`todo-add-${spaceId ?? "none"}`)
    .flex_none()
    .px(4)
    .py(1)
    .rounded(5)
    .text_size(11)
    .text_color(t.dim)
    .tooltip(spaceId ? "记一条待办，挂到这个 space" : "记一条待办（暂不关联 space）")
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click(() => {
      // 用当前 space id 预填，没有就不关联。
      openOverlay({
        mod: "herdr-todo",
        kind: "dialog",
        key: "herdr-todo-capture",
        width: 460,
        height: 148,
        props: { capture: true, space: spaceId ?? null },
      });
    })
    // 画成一个小方框按钮，与上游那行裸「＋ New space there」区分开：
    // 那一行是「新建 space」，这里记的是待办，功能完全不同却上下紧挨着。
    .border(1)
    .border_color(t.border)
    .child("＋");
};

const upstreamRow = SpacesTodo.row;
SpacesTodo.row = function todoRowWrap(r, t) {
  const el = upstreamRow.call(this, r, t);
  const groups = this.todoGroups?.();
  if (!groups) return el;
  // 窄栏是 32px 的图标条，塞不下任何待办文本。
  if (narrow()) return el;

  // ＋ 只在鼠标停在这一行时出现（用户选的就是「悬停 ＋」）。
  //
  // 悬停判定挂在外层 row 上而不是上游那条行元素上：＋ 是 row 的兄弟节点，
  // 若挂在内层，指针移到 ＋ 上会先触发内层的离开事件 → 重绘 → ＋ 消失 →
  // 指针落空 → 又进入……表现为按钮闪个不停。
  const hovered = this.todoHover === r.w.id;
  const dropAt = this.todoDropAt === r.w.id;
  const row = h_flex()
    // 外包一层需要自己的 id：上游那条行已有 `space-<id>`，重名会让两条元素
    // 争同一个身份。稳定 id 是悬停状态与命中测试的前提。
    .id(`space-row-${r.w.id}`)
    .gap(2)
    .items_center()
    // 投放目标：把一条待办拖到 space 行上松手，就挪到这个 space。
    //
    // 这是「space 之间来回拖动」缺的那一半——上游这一行只有它自己的排序手势，
    // 接不住外来的待办。注册在外层而不是内层：内层已被上游占满（排序的
    // mouse_down/move/up），同一元素上重复注册同类处理器会互相覆盖。
    .on_mouse_move((_e, cx) => {
      if (!this.todoDropReady(r.w.id) || this.todoDropAt === r.w.id) return;
      this.todoDropAt = r.w.id;
      cx.notify();
    })
    .on_mouse_up("left", (_e, cx) => this.todoDropTo(r.w.id, cx))
    // 高亮画在这一层，而不是给内层换底色：内层是上游的行，底色换掉会把它的
    // 「当前 space」底色连同排序落点线一起盖住。描边只叠一圈，读得出来又不动内容。
    .when(this.todoDropReady(r.w.id) && dropAt, (e) => e.rounded(8).border_1().border_color(t.accent))
    .on_hover((now, cx) => {
      // 离开事件只清「自己」：从 A 移到 B 时，A 的退出事件可能晚于 B 的
      // 进入事件到达。若无条件清零，B 的 ＋ 会刚出现就被抹掉，直到指针
      // 再动一下才回来。
      const next = now ? r.w.id : this.todoHover === r.w.id ? null : this.todoHover;
      let changed = false;
      if (this.todoHover !== next) {
        this.todoHover = next;
        changed = true;
      }
      // 拖拽中途移开也要撤掉投放高亮。
      if (!now && this.todoDropAt === r.w.id) {
        this.todoDropAt = null;
        changed = true;
      }
      if (changed) cx.notify();
    })
    .child(div().flex_1().min_w(0).child(el))
    // ＋ 不能浮在上游行上：那行右侧已有 git 分支/仓库名（flex_auto 占满剩余宽度），
    // 浮上去会盖掉一半；作为 flex 兄弟，行自己会收窄让位。
    .when(hovered, (e) => e.child(this.todoAddButton(r.w.id, t)));

  const bucket = groups.spaces.find((g) => g.id === r.w.id) ?? { open: [], closed: [] };
  const src = { kind: "space", key: r.w.id, spaces: [r.w.id] };
  const lines = this.todoLines({ open: bucket.open, closed: bucket.closed }, t, src);
  if (!lines.length) return row;
  return v_flex().children([row, v_flex().pb(2).children(lines)]);
};

/**
 * 本行该不该画投放高亮。
 *
 * 来源要与目标比较，而不是「手上有没有东西」：拖着的就是本行自己那条时，高亮
 * 自己毫无意义。高亮数据来自实例上缓存的那份手势（每帧由 render 从 shared 刷新），
 * 所以从 Agents 栏拖过来的手势在这里也认得。
 */
SpacesTodo.todoDropReady = function todoDropReady(ownKey) {
  const drag = this.todoDrag;
  if (!drag) return false;
  return !(drag.from?.kind === "space" && drag.from.key === ownKey);
};

/**
 * 在某个 space 行上松手：把手上那条待办挪过来。
 *
 * 只在自己真的拿着东西时动作——上游这条行同时承担「点击切换 space」与「拖拽排序」，
 * 不能因为注册了投放处理就把那两件事吃掉（没有 todoDrag 时直接放行）。
 *
 * 来源是另一个 space 时用 `move`：一次加锁的读改写，去掉来源加上目标。用
 * unlink+link 两次写会在中间留下「两边都没有」或「两边都有」的状态，也会拿渲染
 * 快照做绝对值而覆盖并发修改。
 */
SpacesTodo.todoDropTo = function todoDropTo(spaceId, cx) {
  const drag = readDrag();
  this.todoDropAt = null;
  if (!drag) return;
  const from = drag.from;
  // 落到自己身上：当作取消，不写盘（上游的排序/切换点击照常生效，这是把待办
  // 拿起又放回，用户没表达任何意图）。
  if (from?.kind === "space" && from.key === spaceId) {
    endDrag();
    this.todoDrag = null;
    cx.notify();
    return;
  }
  endDrag();
  this.todoDrag = null;
  this.todoMove(drag, spaceId, cx);
};

/** 把手上那条待办放回「未关联」：拖到「未关联」分组标题上松手。 */
SpacesTodo.todoDropUnlinked = function todoDropUnlinked(cx) {
  const drag = readDrag();
  if (!drag) return;
  endDrag();
  this.todoDrag = null;
  this.todoMove(drag, null, cx);
};

/**
 * 拖拽落盘：把 `drag` 拿着的事项挪到 `to`（null = 未关联）。
 *
 * 分三种来源：
 *  - 从某个 space 组出来：`move --from <该 space>`，一次加锁的读改写完成替换；
 *  - 挂在某个 agent 上：先去 agent 关联（`agent --clear`），再按需挂 space——
 *    互斥不变量在 core 里也强制，但这里显式写出来，读者不用去翻 core 才知道
 *    为什么拖到 space 上会把 agent 摘掉；
 *  - 从「未关联」或「孤儿」组出来：只挂目标。
 *
 * 写路径仍是 CLI 唯一：CLI 的 mkdir 锁是唯一互斥点。
 */
SpacesTodo.todoMove = function todoMove(drag, to, cx) {
  const from = drag.from;
  cx.spawn(async (cx2) => {
    try {
      if (from?.kind === "agent") {
        // 拖到「未关联」＝解除 agent 关联；拖到 space 则由 moveSpace 自己在
        // 同一次读改写里摘掉 agent（互斥不变量在 core 里强制），不必先跑一次
        // --clear——两次写会在中间留下「已摘 agent 但还没挂上 space」的状态。
        //
        // `--clear` 必须走 flags：flag 放在 `--` 之后会被当成位置参数（那之后
        // 一切都是数据），CLI 会报「agent 需要 --in-space」而不是清掉关联。
        if (to) await command(["move", drag.id, to], {});
        else await command(["agent", drag.id], { flags: ["--clear"] });
      } else if (from?.kind === "orphan") {
        // 孤儿组里的事项关联的全是已不存在的 space。它们的 id 由 `todoGroups`
        // 一并放进 from.spaces，这里逐个用 --from 摘掉——`moveSpace` 会把
        // 出现在 had 里的来源过滤掉，死 id 于是被真正清掉，而不是留成
        // 「拖到新 space 后仍显示在 space 已不存在下」。
        const flags = (from.spaces ?? []).filter(Boolean).map((s) => `--from=${s}`);
        await command(to ? ["move", drag.id, to] : ["move", drag.id], { flags });
      } else {
        // space 组带上 --from（去掉来源）；未关联组没有可删的现有关联。
        const flags = from?.kind === "space" ? [`--from=${from.key}`] : [];
        await command(to ? ["move", drag.id, to] : ["move", drag.id], { flags });
      }
      this.todoError = null;
      // 写完立刻重读：watchFolder 的事件到得晚，界面会先闪一下旧分组。
      this.todoState = await read();
    } catch (e) {
      this.todoError = String(e?.message ?? e);
    }
    try {
      cx2.notify();
    } catch {
      // 这一份已经关掉了。
    }
  });
};

const upstreamGrouped = SpacesTodo.grouped;
SpacesTodo.grouped = function todoGroupedWrap(t, collapsed) {
  // 手势收尾不在这里做：render（一定先于本函数运行）已经把 shared 同步到
  // this.todoDrag，并在没有手势时清掉 todoDrag 与 todoDropAt。这里不再重复一遍，
  // 免得两处各写一套「什么时候算结束」。
  const items = upstreamGrouped.call(this, t, collapsed);
  const groups = this.todoGroups?.();
  if (!groups || collapsed || narrow()) return items;

  // 顶部先答「还没归到任何 space 的事」：这类事项最容易被忘掉。
  //
  // 这个标题同时是「挪到未关联」的投放目标：把一个已关联的事项拖到这里松手，
  // 就从它的 space 上摘下来。没有这个目标的话，误挂到某个 space 的事项只能靠
  // 打开详情窗逐个解除。
  const unlinkedDrop = this.todoDropAt === "unlinked";
  const head = [
    h_flex()
      .id("todo-unlinked-head")
      .h(22)
      .px(8)
      .gap(6)
      .items_center()
      .text_size(10)
      .text_color(unlinkedDrop ? t.foreground : t.dim)
      .when(unlinkedDrop, (e) => e.bg(t.selected).rounded(4))
      .on_mouse_move((_e, cx) => {
        if (!this.todoDrag || this.todoDropAt === "unlinked") return;
        this.todoDropAt = "unlinked";
        cx.notify();
      })
      .on_hover((now, cx) => {
        if (!now && this.todoDropAt === "unlinked") {
          this.todoDropAt = null;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => this.todoDropUnlinked(cx))
      .child(div().flex_1().truncate().child("未关联"))
      .child(this.todoAddButton(null, t)),
    ...this.todoLines(groups.unlinked, t, { kind: "unlinked", key: "unlinked", spaces: [] }),
  ];

  // 「space 已不存在」放在列表末尾：它不该挤掉当前在用的 space。
  const orphanHead = groups.orphans.open.length || groups.orphans.closed.length
    ? [
        h_flex()
          .id("todo-orphan-head")
          .h(22)
          .px(8)
          .items_center()
          .text_size(10)
          .text_color(t.dim)
          .child("space 已不存在"),
        ...this.todoLines(groups.orphans, t, { kind: "orphan", key: "orphan", spaces: null }),
      ]
    : [];

  const errorLine = this.todoError
    ? [div().id("todo-error").px(8).py(3).text_size(10).text_color(t.ansi1).child(this.todoError)]
    : [];
  // 拉取失败单独一行：缓存本身可能读得好好的，用户需要知道「看到的是旧的」。
  // 不清空列表——那会把「暂时连不上」表现成「一条待办都没有」。
  if (this.todoSync && !this.todoSync.ok) {
    errorLine.push(
      div()
        .id("todo-sync-error")
        .px(8)
        .py(3)
        .text_size(10)
        .text_color(t.dim)
        .child(syncStaleText(this.todoSync)),
    );
  }

  // 上游用 this.activeAt 告诉 render()「活动 space 是第几个直接子元素」，
  // 由它 scroll_to_item 滚进视野。这里在前面插了 errorLine + head 两段，
  // 下标整体后移；不补偿就会滚到别的行（顶部待办越多偏得越远）。
  // 注意：上游每行一个元素，本包装的 space 行仍是一个元素（待办子行包在
  // 同一个 v_flex 里），所以只有前置插入需要补偿，行内追加不影响计数。
  const pre = [...errorLine, ...head];
  if (this.activeAt >= 0) this.activeAt += pre.length;

  return [...pre, ...items, ...orphanHead];
};

/**
 * 根元素：承接拖拽。
 *
 * 上游 `render` 返回一个 `v_flex().size_full()`。这里在它外面再包一层，做三件上游
 * 不关心的事：
 *  1. `relative()` + 跟随标签 —— 绝对定位的标签需要一个定位上下文，否则会跑到
 *     窗口左上角（GPUI 里 absolute 是相对最近的 relative 祖先）；
 *  2. 学习根矩形 —— 指针事件同时给窗口坐标与元素坐标，相减就是原点；宽高来自
 *     `on_size_change`。跟随标签按窗口坐标定位，才能和 Agents 栏无缝交接；
 *  3. 按下时作废旧手势 —— 在终端区松手没人收到，残留靠这一下清掉。
 */
const upstreamRender = SpacesTodo.render;
SpacesTodo.render = function todoRender(cx) {
  const drag = readDrag();
  // 每帧把 shared 里的手势同步到实例上——投放高亮与跟随标签都读这个字段。
  // 只在 render 里同步（而不是各处分别读 shared）是为了让所有读点看到同一个值。
  this.todoDrag = drag;
  // 手势结束后（投放方清了 shared，或超时）高亮一起收尾。
  if (!drag && this.todoDropAt) this.todoDropAt = null;
  const body = upstreamRender.call(this, cx);
  const ghost = drag ? dragGhost(drag, this.todoRoot, theme()) : null;
  return v_flex()
    // 稳定 id：on_size_change 要求「Use a stable id」才能稳定地报尺寸，
    // learnRoot 与它必须是同一个元素，否则学到的原点与宽高来自两块不同区域。
    .id("todo-root-spaces")
    .size_full()
    .min_h(0)
    .relative()
    .on_mouse_down("left", () => staleOnPress())
    .on_mouse_move((ev, cx2) => {
      const learned = learnRoot(this.todoRoot, ev);
      if (learned) this.todoRoot = learned;
      // 拖拽期间每次移动都要重绘：跟随标签的位置是在 render 里按指针位置算的，
      // 不重绘就会冻在按下那一刻（用户说的「没有悬浮动画」正是这个）。
      // 不拖拽时绝不 notify——那是每一次鼠标移动一次全 mod 重绘。
      if (readDrag()) cx2.notify();
    })
    .on_size_change((size) => {
      // 注意这是 { width, height }，与缓存的 { w, h } 不同名。
      this.todoRoot = { ...(this.todoRoot ?? { x: 0, y: 0 }), w: size.width, h: size.height };
    })
    .child(body)
    .when(Boolean(ghost), (el) => el.child(ghost));
};
