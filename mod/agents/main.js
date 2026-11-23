// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, checking, watchFolder, notify } from "herdr";
import { read, command, dataDir, sync } from "./store.js";
import { deriveAgents } from "./todo-view.js";
import { readDrag, beginDrag, endDrag, staleOnPress, dragGhost, learnRoot } from "./todo-drag.js";

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

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== (l?.terminal ?? l?.address) && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    try { this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}"); } catch { this.changed = {}; }
    if (!this.changed || typeof this.changed !== "object" || Array.isArray(this.changed)) this.changed = {};
    try { this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]"); } catch { this.pendingPins = []; }
    if (!Array.isArray(this.pendingPins)) this.pendingPins = [];
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      // [herdr-todo] 子 agent 行也是投放目标（用户要求所有 agent 行下都能关联）。
      .when(this.todoDropReady(k.address) && this.dropAt === k.address,
        (el) => el.border(1).border_color(t.accent).bg(t.selected))
      .on_hover((on2) => {
        // 拖拽中途移开也要撤掉投放高亮。
        if (!on2 && this.dropAt === k.address) this.dropAt = null;
      })
      .on_mouse_move((_e, cx) => {
        if (!this.todoDropReady(k.address) || this.dropAt === k.address) return;
        this.dropAt = k.address;
        cx.notify();
      })
      .on_mouse_down("left", () => this.todoCancelDrop())
      .on_mouse_up("left", (_e, cx) => this.todoDrop({ address: k.address, space: k.space }, cx))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      // [herdr-todo] 这个 agent 名下关联的待办。折叠时与子 agent 一起收起。
      const mine = collapsed ? [] : this.todoLinesFor(a.address, t, 30);
      // 折叠时待办行一起收起（与子 agent 一致）。但收起的必须**说得出还有几条**，
      // 否则用户折叠一个 agent 后，他挂在它（或它子 agent）上面的待办就好像
      // 凭空消失了——侧栏那时也不会显示它们（agent 还活着）。
      if (this.folded.has(a.address)) {
        const n = collapsed ? 0 : this.todoCountFor(a.address, subs);
        return n > 0 ? [r, this.todoFoldedHint(a.address, n, t, 30)] : [r];
      }
      // [herdr-todo] 子 agent 也各自带自己那一行待办（用户要求所有 agent 行下都显示）。
      return [r, ...mine, ...subs.flatMap((s) => [this.subRow(t, s, shown, byPriority), ...this.todoLinesFor(s.t.address, t, 39)])];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          // [herdr-todo] 投放目标：侧栏把一条待办拖到这一行上松手就关联到它。
        // 命中测试按松开位置算（上游 space 排序的拖拽就是这么工作的），所以
        // 不需要自己跟踪指针，只要读 shared 里正在拖的东西。
        .on_mouse_move((_e, cx) => {
          if (!this.todoDropReady(a.address) || this.dropAt === a.address) return;
          this.dropAt = a.address;
          cx.notify();
        })
        .when(this.todoDropReady(a.address) && this.dropAt === a.address,
          (el) => el.border(1).border_color(t.accent).bg(t.selected))
        .on_mouse_down("left", () => this.todoCancelDrop())
        .on_mouse_up("left", (_e, cx) => this.todoDrop(a, cx))
        .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          // 拖拽中途移开也要撤掉投放高亮（见下面的 dropAt）。
          if (!on && this.dropAt === a.address) this.dropAt = null;
          cx.notify();
        })
        // [herdr-todo] 投放目标：侧栏把一条待办拖到这一行上松手就关联到它。
        // 高亮状态单独记在 this.dropAt 里，不复用上游的 this.hovered：那个字段
        // 还决定 pin 图标与时长文本显不显示，拖拽时把它们顶出来会闪。
        // 用 mouse_move 而不是 hover：按住左键拖动时 hover 不一定更新，
        // 而上游 space 排序已经证明 mouse_move 在拖拽过程中是可靠的。
        .on_mouse_move((_e, cx) => {
          if (!this.todoDropReady(a.address) || this.dropAt === a.address) return;
          this.dropAt = a.address;
          cx.notify();
        })
        .when(this.todoDropReady(a.address) && this.dropAt === a.address,
          (el) => el.border(1).border_color(t.accent).bg(t.selected))
        .on_mouse_down("left", () => this.todoCancelDrop())
        .on_mouse_up("left", (_e, cx) => {
          // 命中测试按松开位置算，所以这里不需要知道按下发生在哪个元素。
          // 同一行按下又松手（普通点击）时 shared 里没有东西，直接放行给 on_click。
          this.todoDrop(a, cx);
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}

// =====================================================================
// ====== 以上是 App 自带 agents mod 的原样克隆（升级时整段替换） ======
// =====================================================================
//
// 待办扩展（herdr-todo 维护，非上游代码）
//
// 与 `spaces-todo` 同一套做法：克隆 App 自带的 `agents`，只在**末尾**包装，
// 不改上面的任何一行。升级改动上游后需要重新克隆并重贴这一段。
//
// 依赖的上游内部结构：
//  - `Agents.prototype.init(p, cx)`：建 View 状态；
//  - `Agents.prototype.render(cx)`：返回整个侧栏块；
//  - 实例字段 this.listed / this.folded / this.folded 的 key 约定（见上）。
//
// 待办子行挂在**每个 agent 行之后**，所以「按优先级」「按 space 分组」两种视图
// 以及子 agent 行下都会出现——用户在 2026-11-19 选的就是这个行为。
// =====================================================================

const STATUS_GLYPH = { todo: "○", doing: "◐", blocked: "●", done: "✓", cancelled: "✕" };

function relTime(ms) {
  if (!ms) return "";
  const d = Math.max(0, Date.now() - ms);
  const min = Math.floor(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  return day < 30 ? `${day} 天前` : new Date(ms).toISOString().slice(0, 10);
}

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
 * 「数据库不可达，显示的是 X 前的缓存」。与侧栏同一句文案（F8）。
 * lastPullAt 取自 sync.json 的 last_pull_at = 最后一次**成功 pull** 的时间；
 * 缺失时如实说「尚未同步成功」，不编造时间。
 */
function syncStaleText(s) {
  const when = s && s.lastPullAt ? `${relTime(s.lastPullAt)}（${new Date(s.lastPullAt).toLocaleString()}）` : null;
  return when
    ? `数据库不可达，显示的是 ${when} 的缓存`
    : "数据库不可达，尚未同步成功过（显示的是本地残留缓存）";
}

const AgentsTodo = Agents.prototype;

// ---------- 数据 ----------

const upstreamRender = AgentsTodo.render;
AgentsTodo.render = function todoRender(cx) {
  // shared 一变宿主要求每个 mod 重渲染，但重渲染只重跑本函数——状态要在这里
  // 重新读一次，否则高亮条件永远停在 init 那一刻的值。
  // 用 readDrag 而不是裸 shared：它也判过期，超时的手势不该还亮着投放目标。
  const drag = readDrag();
  this.drag = drag;
  // 拖拽结束时（投放方清了 shared，或超时）投放高亮也要跟着撤掉。
  if (!drag) this.dropAt = null;

  const body = upstreamRender.call(this, cx);
  if (props()?.sortMenu) return body;
  // 拉取失败时在顶部加一行：缓存还能读，但用户需要知道看到的是旧的。
  // 不清空列表——那会把「暂时连不上」表现成「一条待办都没有」。
  const stale = this.todoSync && !this.todoSync.ok
    ? [div().id("todo-sync-error").px(6).py(3).text_size(10).text_color(theme().dim).child(syncStaleText(this.todoSync))]
    : [];
  // 与侧栏同一套：根元素 relative + 跟随标签；指针事件学习根矩形；按下作废旧手势。
  const ghost = drag ? dragGhost(drag, this.todoRoot, theme()) : null;
  return v_flex()
    // 稳定 id：on_size_change 要求「Use a stable id」才能稳定地报尺寸，
    // learnRoot 与它必须是同一个元素，否则学到的原点与宽高来自两块不同区域。
    .id("todo-root-agents")
    .size_full()
    .min_h(0)
    .relative()
    .on_mouse_down("left", () => staleOnPress())
    .on_mouse_move((ev, cx2) => {
      const learned = learnRoot(this.todoRoot, ev);
      if (learned) this.todoRoot = learned;
      // 拖拽期间每次移动都重绘：跟随标签的位置在 render 里按指针算，不重绘就冻住。
      // 不拖拽时绝不 notify——那是每次鼠标移动一次全 mod 重绘。
      if (readDrag()) cx2.notify();
    })
    .on_size_change((size) => {
      this.todoRoot = { ...(this.todoRoot ?? { x: 0, y: 0 }), w: size.width, h: size.height };
    })
    .children(stale)
    .child(body)
    .when(Boolean(ghost), (el) => el.child(ghost));
};

const upstreamInit = AgentsTodo.init;
AgentsTodo.init = function todoInit(p, cx) {
  upstreamInit.call(this, p, cx);
  // 排序菜单是本 mod 的第二个实例（overlay），它不需要账本。
  if (props()?.sortMenu) return;

  this.todoState = null;
  this.todoError = null;
  // 同步状态：{ ok, error, lastPullAt } 或 null。拉取失败不抛穿，只记下来。
  this.todoSync = null;
  // 在途标记：同一时间只跑一个 pull（两个 mod 各自持有一个，彼此独立）。
  this.todoSyncing = false;
  this.todoExpanded = new Set();
  // 正在被拖过来的待办（来自 shared）：用来高亮投放目标。
  // 侧栏写 shared 时每个 mod 都会收到重渲染，所以这里不必轮询。
  this.drag = readDrag();
  // 当前被指针悬停的投放目标；与上游的 this.hovered 分开（见 render 里的注释）。
  this.dropAt = null;
  // 本 mod 根元素在窗口坐标里的矩形（跟随标签用，见 todo-drag.js）。
  this.todoRoot = null;
  // todoByAgent 的单次渲染缓存（见该函数）。
  this._todoByAgent = null;
  this.todoLoad(cx);
  this.todoWatch(cx);
  // 先 pull 再读缓存：顺序反过来会先画上一轮的旧内容，多一次闪烁。
  cx.timer.every(10000, (cx2) => this.todoSync2(cx2));
};

/**
 * 一轮同步 + 重读。在途时直接返回，不排队——10 秒后还有下一轮。
 *
 * 单独一个方法而不是塞进 todoLoad：todoLoad 也被 watchFolder 与本 mod 自己的
 * 写后刷新调用，那些场合不需要（也不该）触发同步。
 */
AgentsTodo.todoSync2 = function todoSync2(cx) {
  if (checking()) return;
  if (this.todoSyncing) return;
  this.todoSyncing = true;
  cx.spawn(async (cx2) => {
    try {
      this.todoSync = await sync();
    } finally {
      this.todoSyncing = false;
    }
    await this.todoLoad(cx2);
  });
};

AgentsTodo.todoLoad = function todoLoad(cx) {
  if (checking()) return;
  cx.spawn(async (cx2) => {
    try {
      this.todoState = await read();
      this.todoError = null;
    } catch (e) {
      this.todoError = String(e?.message ?? e);
    }
    try {
      cx2.notify();
    } catch {
      // 这一份已经关掉了：没有界面要刷新。
    }
  });
};

AgentsTodo.todoWatch = function todoWatch(cx) {
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

/** agent 地址 → 关联到它的待办。只含活着的 agent。 */
AgentsTodo.todoByAgent = function todoByAgent() {
  // 一次渲染里 withKids 会对每个 agent、每个子 agent 各问一次；每次都重算
  // deriveAgents 会变成 agents × items 的平方级开销。缓存只对同一次渲染有效：
  // 账本或 agent 列表变了就重算（两者都以引用/长度+地址串参与比较）。
  const live = (agents() ?? []).map((a) => ({ address: a.address, space: a.space }));
  const stamp = live.map((a) => `${a.address}\u0000${a.space}`).join("\u0001");
  const cached = this._todoByAgent;
  if (cached && cached.state === this.todoState && cached.stamp === stamp) return cached.map;
  const map = deriveAgents(this.todoState ?? { items: [] }, live);
  this._todoByAgent = { state: this.todoState, stamp, map };
  return map;
};

// ---------- 行渲染 ----------

/**
 * 一条待办子行：点击打开详情窗，同时是**拖动源**。
 *
 * 它必须能拖：一条已经关联到 agent 的待办，用户在 Agents 栏里看到它，想改挂到别的
 * agent 或挪回某个 space 时，唯一的入口就是把它再拖走。只让侧栏的行可拖的话，一条
 * agent 待办拖动一次之后就再也动不了——用户报的正是这个。
 *
 * 按下即声明手势（与侧栏同一套模型，见 todo-drag.js）；松手还在这一行算点击。
 */
AgentsTodo.todoRow = function todoRow(it, t, address, indent) {
  const src = { kind: "agent", key: address, spaces: [] };
  const line = h_flex()
    .id(`atodo-${address}-${it.id}`)
    .h(20)
    .pl(indent)
    .pr(8)
    .gap(6)
    .items_center()
    .rounded(4)
    .hover((s) => s.bg(t.hover))
    .when(this.drag?.id === it.id, (el) => el.opacity(0.45))
    .on_mouse_down("left", (_e, cx) => {
      // Agents 栏的行本身点击 = 聚焦 pane；待办行不能同时做两件事。
      cx.stop_propagation();
      beginDrag(it, src);
    })
    .on_mouse_up("left", (_e, cx) => {
      // 松手仍在本行：这次手势到此为止——按下与松开都没有被目标行接走，就是一次点击。
      //
      // 点击**必须**走 mouse_up，不能用 on_click：beginDrag 写 shared 会让每个 mod
      // 重渲染，按下时这一行会被换成新元素，随后的 click（按下+松开配对的判定）
      // 就落空了。侧栏一直是这个做法，两个 mod 保持一致。
      //
      // 投放时目标行的 mouse_up 已经先跑过并清了 shared；那时这里的 this.drag
      // 仍是旧快照，靠 readDrag() 当前值区分「还拿着」和「已经被接走」。
      cx.stop_propagation();
      const holds = readDrag()?.id === it.id;
      endDrag();
      this.drag = null;
      if (holds) {
        openOverlay({
          mod: "herdr-todo",
          kind: "window",
          key: "herdr-todo-detail",
          width: 420,
          height: 520,
          props: { detail: it.id },
        });
      }
      cx.notify();
    })
    .child(div().w(10).flex_none().text_size(11).text_color(statusColor(it.status, t)).child(STATUS_GLYPH[it.status] ?? "?"))
    .child(div().w(18).flex_none().text_size(9).font_semibold().text_color(priorityColor(it.priority, t)).child(it.priority))
    .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(it.title));
  const at = relTime(it.updated);
  if (at) line.child(div().flex_none().text_size(9).text_color(t.dim).child(at));
  return line;
};

/**
 * 一个 agent 名下还有几条开放待办（折叠时用来提示「还有 N 条」）。
 *
 * 要把**子 agent** 名下的也算进来：折叠父行会把子行一起收起，那时
 * 子 agent 的待办在侧栏也看不到（它的 agent 还活着，侧栏按设计不列），
 * 只数父 agent 自己的会让它们两边都不可见且毫无提示。
 */
AgentsTodo.todoCountFor = function todoCountFor(address, subs) {
  const by = this.todoByAgent();
  let n = by.get(address)?.open.length ?? 0;
  for (const s of subs ?? []) n += by.get(s.t.address)?.open.length ?? 0;
  return n;
};

/** 折叠起来时的一行提示：告诉用户这个 agent 名下还挂着几条待办。 */
AgentsTodo.todoFoldedHint = function todoFoldedHint(address, n, t, indent) {
  return h_flex()
    // id 必须带地址：同一屏上可能有多个 agent 都以「还有 2 条」折叠着，
    // 用条数做 id 会让两条元素争同一个身份（命中测试与悬停都会错乱）。
    .id(`atodo-folded-${address}`)
    .h(18)
    .pl(indent + 12)
    .pr(8)
    .items_center()
    .child(div().text_size(10).text_color(t.dim).child(`… 还有 ${n} 条待办`));
};

/** 一个 agent 名下的待办行：开放项 + 可展开的「已完成 N」。没有则返回 []。 */
AgentsTodo.todoLinesFor = function todoLinesFor(address, t, indent) {
  const bucket = this.todoByAgent().get(address);
  if (!bucket) return [];
  if (!bucket.open.length && !bucket.closed.length) return [];
  const out = bucket.open.map((it) => this.todoRow(it, t, address, indent));
  if (bucket.closed.length) {
    const key = `agent:${address}`;
    const open = this.todoExpanded.has(key);
    out.push(
      h_flex()
        .id(`atodo-done-${address}`)
        .h(18)
        .pl(indent + 12)
        .pr(8)
        .items_center()
        .rounded(4)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          if (open) this.todoExpanded.delete(key);
          else this.todoExpanded.add(key);
          cx.notify();
        })
        .child(div().text_size(10).text_color(t.dim).child(`${open ? "▾" : "▸"} 已完成 ${bucket.closed.length}`)),
    );
    if (open) for (const it of bucket.closed) out.push(this.todoRow(it, t, address, indent + 12));
  }
  return out;
};

// ---------- 包装 render ----------

/**
 * 每个 agent（含子 agent）行后面追加它的待办。
 *
 * 上游把「一个 agent 及其子 agent 的行」组装在 `withKids` 里，而那是 render 内部的
 * 局部函数，外面拿不到（`NativeElement` 的子节点也读不回来）。所以待办行是在
 * 上游正文的 `withKids` 里插进去的——这是全文件唯一改动上游正文的地方，两行都标了
 * `[herdr-todo]`。其余能力都在文件末尾用原型包装实现。
 *
 * App 升级后重新克隆 `agents` 时，这两行需要一并贴回；标了 `[herdr-todo]` 的地方
 * 就是完整清单（`grep -n '\[herdr-todo\]'`）。
 */
/**
 * 投放高亮用的「手上拿着的那条」。
 *
 * 必须比较**来源**：光看 `drag.id` 会让「本行自己那条待办被拿起」也算作拖着一条
 * 外来待办，于是自己的行亮起来。
 */
AgentsTodo.todoDropReady = function todoDropReady(ownKey) {
  const drag = this.drag;
  if (!drag) return false;
  return !(drag.from?.kind === "agent" && drag.from.key === ownKey);
};

/**
 * 在 agent 行上按下 = 上一个手势已经结束，作废它。
 *
 * 宿主不告诉脚本「左键是否仍按着」，所以拖动源只能在按下时声明、在松手时清掉；
 * 松手落在没有处理者的位置（终端区、空白处）时没人清，shared 会残留到超时。
 * 一次新的按下必然意味着上一个手势已经结束——真正从侧栏拖过来的手势是在**侧栏**
 * 按下的，agent 行不会收到那次 mouse_down——所以这里直接作废，比按时间窗口判定
 * 更可靠（时间窗口内快速连点仍会漏）。
 *
 * 有 `if (!drag) return` 保护：没有残留时绝不写 shared，否则每次点 agent 行都会
 * 触发全 mod 重渲染，那一次点击的 on_click（聚焦 pane）就会被换掉的元素吃掉。
 */
AgentsTodo.todoCancelDrop = function todoCancelDrop() {
  this.dropAt = null;
  if (!readDrag()) return;
  endDrag();
  this.drag = null;
};

/**
 * 在一个 agent 行上松手：如果手上正拖着一条待办，就关联过来。
 *
 * 命中测试按**松开位置**算，所以每个投放目标都要挂这个处理；没有正在拖的
 * 东西时它什么都不做，普通点击照常落到上游的 on_click（聚焦 pane）。
 * `a` 是 `agents()` 里的一项或 `tree()` 里的子 agent：两者都有 address，
 * 但只有真正在 `agents()` 里的才有 space。
 */
AgentsTodo.todoDrop = function todoDrop(a, cx) {
  const drag = readDrag();
  this.dropAt = null;
  // 手上没有待办时什么都不做，普通点击照常落到上游的 on_click（聚焦 pane）。
  if (!drag) return;
  // 从这条待办自己身上松开（拿起又放回）= 取消，不重复写盘。
  // 也要拦下松开：否则上游这一行的 on_click 会把 pane 聚焦走——用户只是把
  // 待办拿起来又放下，不该顺带切换焦点。
  if (drag.from?.kind === "agent" && drag.from.key === a.address) {
    cx.stop_propagation();
    endDrag();
    this.drag = null;
    cx.notify();
    return;
  }
  // 拦下这次松开：否则它同时会触发 on_click 把 pane 聚焦走，侧栏还留在
  // 「正拿着」的状态里，下一次点击会误投放。
  cx.stop_propagation();
  endDrag();
  this.drag = null;
  // 子 agent 行来自 `terminals()` 里的一棵树，它未必是 `agents()` 的一项，
  // 所以 space 要按「agent → terminal」两级找：关联后要靠它回退显示，
  // 取不到就不写（写在 todoLink 里处理）。
  const space =
    a.space ??
    (agents() ?? []).find((x) => x.address === a.address)?.space ??
    (terminals() ?? []).find((x) => x.address === a.address)?.space;
  // 写失败会写进 this.todoError，但 Agents 栏没有一个地方显示它——投放完看
  // 起来像什么都没发生。失败的写必须说出来，否则用户会以为关联成功。
  // 判据是「本次结束后的 todoError 非空」而不是「与之前不同」：上一次的失败
  // 没有任何地方能清掉，用它做基线时下一次成功（null !== 旧错误）反而会误报。
  this.todoLink(drag.id, a.address, space, cx, () => {
    if (this.todoError) {
      notify({ title: "关联失败", body: this.todoError, level: "error" });
    }
  });
};

/**
 * 把一条待办关联到这个 agent。
 *
 * 写路径仍是 CLI 唯一（与详情窗、侧栏同一个理由：CLI 的 mkdir 锁是唯一互斥点）。
 * `--in-space` 是这台 agent **当前**所在的 space：agent 关掉后 Host 不再提供
 * 反查 lineage 的手段，回退显示只能靠关联当时存下的这个值。所以 space 为空的
 * agent（理论上不该有，但 `agents()` 的类型是 string 而非非空）不接投放。
 */
AgentsTodo.todoLink = function todoLink(id, address, space, cx, done) {
  if (!address || !space) {
    this.todoError = "这个 agent 没有所属 space，无法关联（关掉后无处回退）";
    cx.notify();
    if (done) done();
    return;
  }
  cx.spawn(async (cx2) => {
    try {
      // 走 store.js 的 command()：argv 形态（[选项] 子命令 -- 位置参数）在那里
      // 钉死并被 tests/argv.test.js 守着，不在这里另写一套。
      await command(["agent", id, address], { flags: [`--in-space=${space}`] });
      this.todoError = null;
      // 写成功后立刻重读：watchFolder 也能带来这次变化，但事件到得比这次
      // 重读晚，界面会先闪一下旧状态（事项还在原来的 space 组里）。
      this.todoState = await read();
    } catch (e) {
      this.todoError = String(e?.message ?? e);
    }
    try {
      cx2.notify();
    } catch {
      // 已经关掉了。
    }
    if (done) done();
  });
};
