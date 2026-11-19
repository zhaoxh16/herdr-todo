// 待办面板。同一个 mod 有两种形态：
//  - 布局里的常驻块（右侧栏）：按 space 分组的完整视图 + 同屏详情区
//  - 弹窗（props().overlay 存在）：快速记录一条事项
// 数据来自 ~/.local/share/herdr-todo/todos.json，与 CLI 共用；外部改动靠 watchFolder 感知。

import { View, div, list } from "gpui-kit";
import {
  v_flex,
  h_flex,
  ScrollHandle,
  InputState,
  Input,
  TextareaState,
  Textarea,
} from "gpui-base";
import {
  spaces,
  theme,
  props,
  closeOverlay,
  run,
  watchFolder,
  checking,
  focused,
} from "herdr";

import {
  groupBySpace,
  sortItems,
  summary,
  findItem,
  timelineOf,
  CLOSED_STATUSES,
  STATUSES,
  PRIORITIES,
} from "./core.js";
// 写入一律走 CLI（见 store.js 顶部说明）：面板不自己写文件，
// 这样 CLI 的锁是唯一的互斥点，不存在两套机制互相看不见的问题。
import { read, command, dataDir } from "./store.js";

const STATUS_LABEL = {
  todo: "待办",
  doing: "进行中",
  blocked: "阻塞",
  done: "完成",
  cancelled: "取消",
};
const STATUS_GLYPH = {
  todo: "○",
  doing: "◐",
  blocked: "●",
  done: "✓",
  cancelled: "✕",
};
// 每个状态在界面上的语义色：只有"需要我动手"的才用强调色。
function statusColor(status, t) {
  if (status === "blocked") return t.blocked ?? t.red ?? t.ansi1;
  if (status === "done") return t.done ?? t.green ?? t.ansi2;
  if (status === "doing") return t.working ?? t.blue ?? t.ansi4;
  if (status === "cancelled") return t.dim;
  return t.muted;
}
function priorityColor(p, t) {
  if (p === "P0") return t.red ?? t.ansi1;
  if (p === "P1") return t.peach ?? t.yellow ?? t.ansi3;
  return t.muted;
}

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

function listText(v, sep) {
  return Array.isArray(v) ? v.join(sep) : v == null ? "" : String(v);
}

function describeEntry(e) {
  switch (e.kind) {
    case "created":
      return `创建为「${STATUS_LABEL[e.to] ?? e.to}」`;
    case "status":
      return `状态 ${STATUS_LABEL[e.from] ?? e.from} → ${STATUS_LABEL[e.to] ?? e.to}`;
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
      const f = listText(e.from, ", ") || "无";
      const g = listText(e.to, ", ") || "无";
      return `关联 ${f} → ${g}`;
    }
    default:
      return e.kind;
  }
}

/** Herdr 的 space 列表转成本面板用于分组的轻量结构。 */
function currentSpaces() {
  try {
    return (spaces() ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      machine: s.machine ?? null,
      branch: s.branch ?? null,
      tabs: (s.tabs ?? []).length,
      status: s.status ?? null,
    }));
  } catch {
    return [];
  }
}

export default class Todo extends View {
  init(p, cx) {
    this.overlayId = props()?.overlay ?? null;
    // 视图自己的长期上下文：所有异步任务都挂在它下面（见 spawn）。
    this.cx = cx;
    this.state = null;
    this.selectedId = null;
    this.showClosed = false;
    this.expanded = new Set();
    // 用户手动折叠/展开过的组：一旦点过，就以他的意见为准，不再套默认规则。
    this.override = new Set();
    this.draft = InputState.new({ placeholder: "要做什么？回车创建" });
    this.noteDraft = null;
    this.noteEditingId = null;
    // 上一次写入失败的原因。写入成功即清空——它标记的是「这次写没成」，
    // 不是「曾经出过错」；后者会让提示永远挂在界面上。
    this.writeError = null;
    // 上一次读取失败的原因。与写失败分开：读失败意味着「你看到的是旧数据」。
    this.readError = null;
    // 弹窗提交的防重复闸门：输入框在 await 之后才清空，中途再点一次会多建一条。
    this.busy = false;

    if (this.overlayId) {
      this.draft.on("submit", () => this.createFromDraft());
      if (!checking()) this.draft.focus();
    } else {
      this.scroll = ScrollHandle.new();
      this.load();
      this.watch();
      // 兜底轮询：watchFolder 在个别文件系统上可能漏事件，低频重读保证最终一致。
      cx.timer.every(10000, () => this.load());
    }
  }

  async load() {
    try {
      this.state = await read();
      this.readError = null;
    } catch (e) {
      // 读失败单独记。它和写失败是两回事：读失败说明「看到的可能是旧数据」，
      // 写失败说明「刚才的操作没落盘」。
      this.readError = String(e.message ?? e);
    }
    this.cx.notify();
  }

  watch() {
    if (checking()) return;
    this.cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(dataDir());
        } catch {
          // 目录还不存在（第一次安装、还没写入过）。不能立刻重试：
          // watchFolder 会同步 reject，空转几百毫秒就是上万次读取 + 重绘。
          // 等 3 秒再试；真正的刷新由 10s 兜底轮询负责。
          await cx.sleep(3000);
          continue;
        }
        await this.load();
      }
    });
  }

  /**
   * 起一个异步任务并刷新界面。
   *
   * 用 init 收到的 cx（AsyncContext，属于视图本身），不用事件或 render 里那个：
   * Context 只对产生它的那一次宿主调用有效，render(cx) 的 cx 在 render 返回后
   * 就失效了，拿它 spawn 会抛 stale-context，而宿主会吞掉异常——表现就是
   * 「点了没反应」。AsyncContext 才能跨 await 使用。
   */
  spawn(body) {
    this.cx.spawn(async (c) => {
      try {
        await body();
        // 写入成功才清掉上次的写错误。失败的提示必须留到下一次真的写成，
        // 否则用户看不出「这次到底成没成」。
        this.writeError = null;
      } catch (e) {
        this.writeError = String(e.message ?? e);
      }
      try {
        c.notify();
      } catch {
        // 视图已经关掉（例如弹窗添加完自己关了）：没有界面要刷新。
      }
    });
  }

  /** 界面上要显示的错误：写入失败优先（它是用户刚做的操作的结果）。 */
  errorText() {
    return this.writeError ?? this.readError ?? null;
  }

  /**
   * 加/删一个 space。发的是**增量**，不是「完整的下一份列表」。
   *
   * 面板持有的 item 是上一次 render 的快照。若把「快照 + 我刚选的那个」当成
   * 绝对列表发给 CLI（set-spaces），这期间别人（另一个终端、CLI、同一个人连点
   * 两个按钮）加的关联会被静默覆盖掉。link/unlink 由 CLI 在锁内基于最新账本
   * 合并，快照只用来回答「这一次点的是增还是删」。
   */
  addSpace(item, spaceId) {
    this.mutate(["link", item.id, spaceId]);
  }

  removeSpace(item, spaceId) {
    this.mutate(["unlink", item.id, spaceId]);
  }

  /**
   * 跑一条 CLI 写命令，然后把账本重读一遍。
   *
   * opts.onDone 只在写成功后执行（调用方用它收起编辑器一类）；
   * opts.flags 是面板自己的选项（`--note=…` 等），由 command() 放到子命令之前。
   */
  mutate(args, opts = {}) {
    const { onDone, flags } = opts;
    this.spawn(async () => {
      await command(args, { flags });
      // 写已经落盘了。此后重读失败只影响显示，不能报成「写入失败」——
      // 那样用户会以为没写进去，再点一次就多出一条重复事项。
      try {
        this.state = await read();
        this.readError = null;
      } catch (e) {
        this.readError = String(e.message ?? e);
      }
      if (onDone) onDone();
    });
  }

  createFromDraft() {
    const title = String(this.draft.value?.() ?? "").trim();
    if (!title || this.busy) return;
    // 弹窗形态默认把事项挂到当前聚焦的 space，省掉一次选择。
    const here = this.overlayId ? focusedSpaceId() : null;
    // 防重复提交：输入框在 await 之后才清空，中途再点一次会多建一条。
    this.busy = true;
    // 标题作为位置参数，必须落在 -- 之后（command() 负责），否则叫 `-h`
    // 或 `--space` 的标题会被当成选项。space 用 --space=… 单 token 传入。
    const flags = here ? [`--space=${here}`] : [];
    this.spawn(async () => {
      try {
        await command(["add", title], { flags });
        // 已经落盘：先清草稿、关窗，再刷新列表。刷新失败不该让用户以为
        // 没写进去——那样他会再按一次回车，多建一条重复事项。
        this.draft.set_value("");
        if (this.overlayId) closeOverlay(this.overlayId);
        await this.load();
      } finally {
        this.busy = false;
      }
    });
  }

  // ---------- render ----------

  render(cx) {
    return this.overlayId ? this.renderCapture(cx) : this.renderPanel(cx);
  }

  renderCapture(cx) {
    const t = theme();
    const here = focusedSpaceId();
    const name = here ? (currentSpaces().find((s) => s.id === here)?.name ?? here) : null;
    return v_flex()
      .id("capture-root")
      .size_full()
      .p(14)
      .gap(8)
      .bg(t.popover)
      .rounded(10)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(13).text_color(t.muted).child("新建待办"))
          // Esc 只在 dialog 上生效；显式给一个关闭入口，避免任何情况下关不掉。
          .child(button("✕", t, false, () => closeOverlay(this.overlayId))),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .px(8)
              .py(6)
              .rounded(6)
              .bg(t.input ?? t.background)
              .border(1)
              .border_color(t.border)
              .child(Input.new(this.draft)),
          )
          .child(button("添加", t, true, () => this.createFromDraft())),
      )
      .child(
        div()
          .text_size(11)
          .text_color(t.dim)
          .child(here ? `将挂到当前 space：${name}` : "未关联 space（可在面板里补）"),
      )
      .children(this.errorText() ? [div().text_size(11).text_color(t.red ?? t.ansi1).child(this.errorText())] : []);
  }

  renderPanel(cx) {
    const t = theme();
    const st = this.state;
    const err = this.errorText();
    if (!st && err) {
      return v_flex().size_full().p(12).gap(6).bg(t.surface)
        .child(div().text_size(13).text_color(t.red ?? t.ansi1).child("数据读取失败"))
        .child(div().text_size(11).text_color(t.muted).child(err));
    }
    if (!st) {
      return v_flex().size_full().p(12).bg(t.surface).child(div().text_size(12).text_color(t.muted).child("载入中…"));
    }

    const known = currentSpaces();
    const sum = summary(st.items);
    const groups = groupBySpace(st.items, known);
    // 归档项不列进「已完成」：它已经在列表之外（用户要求的就是「别烦我」）。
    const closed = sortItems(
      st.items.filter((i) => CLOSED_STATUSES.includes(i.status) && i.archived == null),
    );
    const selected = this.selectedId ? findItem(st, this.selectedId) : null;

    const rows = [];
    rows.push(this.renderHeader(t, sum, closed, cx));

    if (err) {
      rows.push(div().text_size(11).text_color(t.red ?? t.ansi1).child(err));
    }

    // 默认只展开当前 space：别的 space 只露一行标题和计数，
    // 这样面板永远回答"我手上的这个 space 还有什么事"。
    // 当前 space 自己没事时，退回展开第一个有事的组，避免面板看起来是空的。
    const here = focusedSpaceId();
    const hereHasItems = groups.some((g) => g.key === here && g.items.length > 0);
    const fallbackKey = hereHasItems ? null : groups.find((g) => g.items.length > 0)?.key ?? null;

    for (const g of groups) {
      const folded = this.isFolded(g, here, fallbackKey);
      rows.push(this.renderGroupHeader(g, t, here, folded));
      if (folded) continue;
      if (!g.items.length) {
        rows.push(div().px(10).py(3).text_size(11).text_color(t.dim).child("（无待办）"));
        continue;
      }
      for (const it of g.items) rows.push(this.renderItemRow(it, t, cx, g.key));
    }

    rows.push(this.renderClosedSection(closed, t, cx));

    return v_flex().size_full().bg(t.surface).children([
      v_flex().flex_1().overflow_y_scrollbar().gap(1).track_scroll(this.scroll).children(rows),
      selected ? this.renderDetail(selected, t, cx, known) : div(),
    ]);
  }

  renderHeader(t, sum, closed, cx) {
    return v_flex()
      .px(10)
      .pt(8)
      .pb(6)
      .gap(2)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child("待办"))
          .child(
            button(
              "＋",
              t,
              false,
              () => run("mod.open", { name: "herdr-todo" }),
            ),
          ),
      )
      .child(
        h_flex().gap(10).text_size(11).children([
          div().text_color(t.foreground).child(`未处理 ${sum.pending}`),
          div().text_color(sum.p0 ? (t.red ?? t.ansi1) : t.dim).child(`P0 ${sum.p0}`),
          // 和底部「已完成 N」用同一个口径（done + cancelled），
          // 否则同一件事在面板上出现两个不同的数。
          div().text_color(t.dim).child(`完成 ${closed.length}`),
        ]),
      );
  }

  /**
   * 默认只展开当前 space；用户点过的组记在 expanded 里。
   *
   * 当前组与 fallback 组原先被硬性展开，点标题写进 expanded 却没人读——
   * 用户看到的是「点了没反应」。现在用一个显式的「手动覆盖」集合：
   * 点过的组以用户的意见为准，没点过才按默认规则。
   */
  isFolded(group, here, fallbackKey) {
    if (this.override.has(group.key)) return !this.expanded.has(group.key);
    if (group.key === here) return false;
    if (group.key === fallbackKey) return false;
    return !this.expanded.has(group.key);
  }

  /** 用户的点击总是覆盖默认规则。 */
  toggleGroup(key, folded) {
    this.override.add(key);
    if (folded) this.expanded.add(key);
    else this.expanded.delete(key);
  }

  renderGroupHeader(g, t, here, folded) {
    const pending = g.items.filter((i) => !CLOSED_STATUSES.includes(i.status)).length;
    const isCurrent = g.key === here;
    const label =
      g.kind === "unlinked"
        ? "未关联"
        : g.kind === "closed"
          ? "space 已不存在"
          : `${g.space?.machine ? `${g.space.machine}/` : ""}${g.label}`;
    return h_flex()
      .id(`grp-${g.key}`)
      .px(10)
      .pt(8)
      .pb(3)
      .gap(6)
      .items_center()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.toggleGroup(g.key, folded);
        cx.notify();
      })
      .child(div().text_size(10).text_color(t.dim).child(folded ? "▸" : "▾"))
      .child(
        div()
          .text_size(11)
          .font_semibold()
          .text_color(isCurrent ? t.foreground : g.kind === "closed" ? t.dim : t.muted)
          .truncate()
          .child(label),
      )
      .child(
        div()
          .text_size(10)
          .text_color(pending && isCurrent ? t.foreground : t.dim)
          .child(pending ? String(pending) : ""),
      );
  }

  renderItemRow(it, t, cx, groupKey) {
    const selected = it.id === this.selectedId;
    return h_flex()
      .id(`item-${it.id}-${groupKey}`)
      .px(10)
      .py(4)
      .gap(7)
      .items_center()
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((_e, c) => {
        this.selectedId = this.selectedId === it.id ? null : it.id;
        c.notify();
      })
      .child(
        div()
          .w(14)
          .text_size(12)
          .text_color(statusColor(it.status, t))
          .child(STATUS_GLYPH[it.status] ?? "?"),
      )
      .child(
        div()
          .w(22)
          .text_size(10)
          .font_semibold()
          .text_color(priorityColor(it.priority, t))
          .child(it.priority),
      )
      .child(
        div()
          .flex_1()
          .truncate()
          .text_size(12)
          .text_color(CLOSED_STATUSES.includes(it.status) ? t.dim : t.foreground)
          .child(it.title),
      )
      .child(div().text_size(10).text_color(t.dim).child(relTime(it.updated)));
  }

  renderClosedSection(closed, t, cx) {
    if (!closed.length) return div();
    return v_flex().children([
      h_flex()
        .id("closed-header")
        .px(10)
        .pt(10)
        .pb(3)
        .gap(6)
        .items_center()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, c) => {
          this.showClosed = !this.showClosed;
          c.notify();
        })
        .child(div().text_size(10).text_color(t.dim).child(this.showClosed ? "▾" : "▸"))
        .child(div().text_size(11).text_color(t.dim).child(`已完成 ${closed.length}`)),
      ...(this.showClosed ? closed.map((it) => this.renderItemRow(it, t, cx, "closed")) : []),
    ]);
  }

  renderDetail(item, t, cx, known) {
    const spaceNames = new Map(known.map((s) => [s.id, s.name]));
    return v_flex()
      .flex_none()
      .max_h(320)
      .border_t(1)
      .border_color(t.border)
      .bg(t.raised)
      .p(10)
      .gap(6)
      .child(
        h_flex().gap(8).items_center().child(
          div().flex_1().text_size(12).font_semibold().text_color(t.foreground).truncate().child(item.title),
        ),
      )
      .child(
        h_flex().gap(6).items_center().children([
          div().text_size(10).text_color(t.dim).child("状态"),
          ...STATUSES.map((s) =>
            button(STATUS_LABEL[s], t, item.status === s, () => {
              // 离开终态必须显式重开：面板里点就是明确意图。归档项点任意状态
              // 也带 --reopen，否则会出现「状态改成了进行中却仍在归档里」的死结。
              const reopen =
                !CLOSED_STATUSES.includes(s) &&
                (CLOSED_STATUSES.includes(item.status) || item.archived != null);
              this.mutate(["status", item.id, s], { flags: reopen ? ["--reopen"] : [] });
            }),
          ),
        ]),
      )
      .child(
        h_flex().gap(6).items_center().children([
          div().text_size(10).text_color(t.dim).child("优先级"),
          ...PRIORITIES.map((p) =>
            button(p, t, item.priority === p, () => this.mutate(["priority", item.id, p])),
          ),
        ]),
      )
      .child(
        v_flex().gap(3).children([
          h_flex().gap(6).items_center().flex_wrap().children([
            div().text_size(10).text_color(t.dim).child("关联"),
            ...item.spaces.map((sid) =>
              h_flex()
                .gap(3)
                .items_center()
                .px(5)
                .rounded(4)
                .bg(t.hover)
                .child(div().text_size(10).text_color(t.muted).child(spaceNames.get(sid) ?? sid))
                .child(
                  button("×", t, false, () => this.removeSpace(item, sid)),
                ),
            ),
          ]),
          h_flex().gap(4).flex_wrap().children([
            div().text_size(10).text_color(t.dim).child("加到"),
            ...known
              .filter((s) => !item.spaces.includes(s.id))
              .map((s) =>
                button(
                  `${s.machine ? `${s.machine}/` : ""}${s.name}`,
                  t,
                  false,
                  () => this.addSpace(item, s.id),
                ),
              ),
            ...(known.some((s) => !item.spaces.includes(s.id))
              ? []
              : [div().text_size(10).text_color(t.dim).child("（所有 space 都关联了）")]),
          ]),
        ]),
      )
      .child(
        h_flex().gap(6).items_center().children([
          div().text_size(10).text_color(t.dim).child("归档"),
          item.archived != null
            ? button("取消归档", t, true, () => this.mutate(["unarchive", item.id]))
            : button("收起", t, false, () => this.mutate(["archive", item.id])),
          div()
            .text_size(10)
            .text_color(t.dim)
            .child(item.archived != null ? "已收起（数据仍保留）" : "从列表收起，数据仍保留"),
        ]),
      )
      .child(this.renderNoteEditor(item, t, cx))
      .child(this.renderTimeline(item, t));
  }

  renderNoteEditor(item, t, cx) {
    const editing = this.noteEditingId === item.id;
    if (editing && this.noteDraft) {
      return v_flex()
        .gap(4)
        .child(div().h(64).child(Textarea.new(this.noteDraft)))
        .child(
          h_flex().gap(6).items_center().children([
            button("保存", t, true, () => this.commitNote(item.id)),
            button("取消", t, false, () => {
              this.noteEditingId = null;
              this.noteDraft = null;
              this.cx.notify();
            }),
          ]),
        );
    }
    return h_flex()
      .gap(6)
      .items_center()
      .child(
        div()
          .flex_1()
          .text_size(11)
          .text_color(item.note ? t.muted : t.dim)
          .truncate()
          .child(item.note ? item.note.split("\n")[0] : "（无备注）"),
      )
      .child(
        button("编辑备注", t, false, () => {
          // 状态在这里建：InputState/TextareaState.new 需要一次宿主调用，
          // 不能在 render 里做（宿主会直接抛错，整个面板渲染失败）。
          this.noteEditingId = item.id;
          this.noteDraft = TextareaState.new({ value: item.note ?? "", rows: 3 });
          this.noteDraft.on("submit", () => this.commitNote(item.id));
          this.noteDraft.focus();
          this.cx.notify();
        }),
      );
  }

  /**
   * 保存备注。只有写成功才收起编辑器——失败时保留用户刚输入的文本，
   * 否则一句「数据文件一直被其他进程改写」就把输入丢了。
   */
  commitNote(id) {
    const text = String(this.noteDraft?.value?.() ?? "");
    // 备注正文走 --note= 单 token：正文可能是 `--space x`、`-h` 这种文本，
    // 作为位置参数会被当成选项语法。
    this.mutate(["note", id], {
      flags: [`--note=${text}`],
      onDone: () => {
        this.noteEditingId = null;
        this.noteDraft = null;
      },
    });
  }

  renderTimeline(item, t) {
    const entries = timelineOf(item).slice(-8).reverse();
    return v_flex()
      .gap(2)
      .child(div().text_size(10).text_color(t.dim).child("时间线"))
      .children(
        entries.map((e) =>
          h_flex().gap(8).children([
            div().w(64).flex_none().text_size(10).text_color(t.dim).child(relTime(e.at)),
            div().flex_1().truncate().text_size(10).text_color(t.muted).child(describeEntry(e)),
          ]),
        ),
      );
  }
}

// 按钮的回调不接 cx：异步任务统一走 this.spawn（见上面的说明）。
// id 用「标签 + 序号」而不是随机数：随机 id 每次渲染都变，元素身份不稳定，
// 命中测试与 UI 自动化都没法按 id 定位同一个按钮。
let buttonSeq = 0;
function button(label, t, active, onClick) {
  buttonSeq += 1;
  return h_flex()
    .id(`btn-${label}-${buttonSeq}`)
    .px(6)
    .py(2)
    .rounded(4)
    .bg(active ? t.accent : t.hover)
    .hover((s) => s.bg(active ? t.accent : t.selected))
    .on_click(() => onClick())
    .child(div().text_size(10).text_color(active ? t.accent_foreground : t.muted).child(label));
}

function focusedSpaceId() {
  try {
    return focused()?.space ?? null;
  } catch {
    return null;
  }
}
