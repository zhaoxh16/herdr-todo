// herdr-todo 的两种窗口：一条待办的详情，以及快速记录。
//
// 待办**列表**不在这里——它在左侧 Spaces 侧栏（mod/spaces/main.js），
// 由克隆的 spaces mod 渲染。这个 mod 只被侧栏按需打开：
//   props { detail: "<id>" }  → 详情窗（可拖动），改完立刻可见于侧栏
//   props { capture: true, space? } → 快速记录窗（dialog），回车创建
//
// 窗口都是新开实例、props 在创建时给定：同一 mod 已经开着时再次 openOverlay
// 不会把新 props 送给已有实例（实测 update 不被调用），所以两者都用固定 key
// 区分，侧栏每次点击都开新的一份。
//
// 数据来自 ~/.local/share/herdr-todo/todos.json，与 CLI 共用；写入一律走 CLI
// （见 store.js 顶部说明），因此侧栏与本窗看到的永远是同一份账本。

import { View, div } from "gpui-kit";
import {
  v_flex,
  h_flex,
  InputState,
  Input,
  TextareaState,
  Textarea,
} from "gpui-base";
import { spaces, agents, theme, props, closeOverlay, checking, watchFolder } from "herdr";

import { findItem, timelineOf, CLOSED_STATUSES, STATUSES, PRIORITIES } from "./core.js";
import { read, command, dataDir } from "./store.js";

const STATUS_LABEL = {
  todo: "待办",
  doing: "进行中",
  blocked: "阻塞",
  done: "完成",
  cancelled: "取消",
};

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
    case "agent":
      // agent 与 space 互斥（core 的写入函数强制），所以这一条不是在 space
      // 关联之外追加的，而是替换掉它。
      return `改挂 agent ${e.from || "无"} → ${e.to || "无"}`;
    default:
      return e.kind;
  }
}

/** Herdr 的 space 列表转成本面板用于显示名字的轻量结构。 */
function currentSpaces() {
  try {
    return (spaces() ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      machine: s.machine ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * agent 地址 → 人能读的名字。
 *
 * 用 `title`（终端标题，Agents 栏那一行显示的就是它）：`space_name` 是它所在
 * **space** 的名字，两个 agent 在同一个 space 里就会显示成同一个名字，反而
 * 认不出是哪一条。agent 关掉之后它不在列表里了，退回地址——地址里带着 space
 * 前缀，仍然能看出它原来在哪。
 */
function agentName(address) {
  try {
    const a = (agents() ?? []).find((x) => x.address === address);
    return a?.title || a?.program?.name || address;
  } catch {
    return address;
  }
}

export default class Todo extends View {
  init(p, cx) {
    // 视图自己的长期上下文：所有异步任务都挂在它下面（见 spawn）。
    this.cx = cx;
    this.overlayId = props()?.overlay ?? null;
    // 有 detail 就是详情窗，其余一律是快速记录：
    // ctrl-alt-n 走的是 mod.open，宿主只给 props().overlay，不带 capture 标记。
    this.detailId = props()?.detail ?? null;
    this.mode = this.detailId ? "detail" : "capture";

    this.state = null;
    // 上一次写入失败的原因。写入成功即清空——它标记的是「这次写没成」，
    // 不是「曾经出过错」；后者会让提示永远挂在界面上。
    this.writeError = null;
    // 上一次读取失败的原因。与写失败分开：读失败意味着「你看到的是旧数据」。
    this.readError = null;
    this.noteDraft = null;
    this.noteEditingId = null;

    if (this.mode === "capture") {
      this.draft = InputState.new({ placeholder: "要做什么？回车创建" });
      // 弹窗提交的防重复闸门：输入框在 await 之后才清空，中途再点一次会多建一条。
      this.busy = false;
      this.draft.on("submit", () => this.createFromDraft());
      if (!checking()) this.draft.focus();
    } else {
      // 详情窗是 kind:"window"：Esc 不会被宿主自动处理，得自己接。
      // 键盘只落在 track_focus 的元素上，所以窗口打开时主动拿一次焦点。
      this.focusHandle = cx.focus_handle();
      this.load();
      // 账本是共享文件：CLI、另一个详情窗、侧栏的 ＋ 都可能改它。窗开着时不
      // 重读，用户看到的就一直是打开那一刻的快照（侧栏却已经变了）。
      // 与侧栏同一套口径：watchFolder 驱动 + 10 秒兜底轮询。
      this.watch(cx);
      cx.timer.every(10000, () => this.load());
      this.takeFocus();
    }
  }

  /**
   * 把键盘收回窗口本身。
   *
   * window 形态打开时不自动拿键盘（herdr.d.ts：It doesn't take the keyboard
   * when it opens），而 FocusHandle.focus() 只对**已经渲染出来**的元素生效。
   * 所以不能「等固定毫秒再 focus 一次」：慢机器上那一刻元素还没画出来，快机器
   * 上又白等；而且载入中/读失败/事项不存在这几个分支以前根本没有 track_focus，
   * 等多久都拿不到键盘。这里改成重试到 is_focused() 为真或次数用完，
   * 各分支统一都挂同一个 focusHandle。
   */
  takeFocus() {
    if (checking() || !this.focusHandle) return;
    this.cx.spawn(async (c) => {
      for (let i = 0; i < 20; i++) {
        try {
          if (this.focusHandle.is_focused()) return;
          this.focusHandle.focus();
        } catch {
          // 还没渲染出来时可能直接抛；窗口关掉时也一样。两种情况都靠下一轮重试
          // 区分——重试到上限就安静放弃（窗口多半已经不在了）。
        }
        await c.sleep(30);
      }
    });
  }

  /** 退出备注编辑：清掉草稿，把键盘从输入框收回窗口（否则 Esc 要按两次）。 */
  leaveNote() {
    this.noteEditingId = null;
    this.noteDraft = null;
    this.takeFocus();
    this.cx.notify();
  }

  async load() {
    try {
      this.state = await read();
      this.readError = null;
    } catch (e) {
      this.readError = String(e.message ?? e);
    }
    try {
      this.cx.notify();
    } catch {
      // 窗口已经关掉：没有界面要刷新。
    }
  }

  /** 账本目录变动就重读。目录还不存在时等 3 秒再试，避免空转。 */
  watch(cx) {
    if (checking()) return;
    this.cx.spawn(async (c) => {
      for (;;) {
        try {
          await watchFolder(dataDir());
        } catch {
          // 还没写过账本，目录不存在。watchFolder 会立刻 reject，
          // 空转几百毫秒就是上万次读取 + 重绘。
          await c.sleep(3000);
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
        // 视图已经关掉（例如记录完自己关了）：没有界面要刷新。
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
   * 本窗持有的 item 是上一次读取的快照。若把「快照 + 我刚选的那个」当成
   * 绝对列表发给 CLI（set-spaces），这期间别人（另一个终端、CLI、同一个
   * space 的另一次点击）加的关联会被静默覆盖掉。link/unlink 由 CLI 在锁内
   * 基于最新账本合并，快照只用来回答「这一次点的是增还是删」。
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
   * opts.flags 是本窗自己的选项（`--note=…` 等），由 command() 放到子命令之前。
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
    // 只有明确传了 space 才挂上去。**不**退回「当前聚焦的 space」：
    // 从「未关联」那一行的 ＋ 或 ctrl-alt-n 打开时没有 space，若默认挂到
    // 屏幕上正开着的 space 上，用户就再也建不出未关联的事项了。
    const here = props()?.space ?? null;
    this.busy = true;
    // 标题作为位置参数，必须落在 -- 之后（command() 负责），否则叫 `-h`
    // 或 `--space` 的标题会被当成选项。space 用 --space=… 单 token 传入。
    const flags = here ? [`--space=${here}`] : [];
    this.spawn(async () => {
      try {
        await command(["add", title], { flags });
        // 已经落盘：先清草稿、关窗，再刷新。刷新失败不该让用户以为
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
    // 按钮 id 按「标签 + 本次渲染内的序号」生成（见文件末尾的 button()）。
    // 序号每次渲染从头数：同一份状态下渲染出的按钮顺序是稳定的，id 也就稳定；
    // 若让计数器跨渲染累加，每次重绘 id 都变，元素身份不稳，悬停状态会丢。
    buttonSeq = 0;
    return this.mode === "capture" ? this.renderCapture(cx) : this.renderDetailWindow(cx);
  }

  renderCapture() {
    const t = theme();
    // 与 createFromDraft 同一口径：没预填就是「不关联」，不猜当前 space。
    const here = props()?.space ?? null;
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
              .bg(t.input)
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
          .child(here ? `将挂到 space：${name}` : "未关联 space（可在详情里补）"),
      )
      .children(
        this.errorText()
          ? [div().text_size(11).text_color(t.ansi1).child(this.errorText())]
          : [],
      );
  }

  renderDetailWindow(cx) {
    const t = theme();
    const err = this.errorText();
    const header = (title, body) =>
      v_flex()
        .px(12)
        .pt(10)
        .pb(8)
        .gap(2)
        .border_b(1)
        .border_color(t.border)
        .child(
          h_flex()
            .items_center()
            .gap(8)
            .child(div().flex_1().truncate().text_size(13).font_semibold().text_color(t.foreground).child(title))
            .child(button("✕", t, false, () => closeOverlay(this.overlayId))),
        )
        .children(body ?? []);

    if (!this.state && err) {
      return this.detailFrame(t, [
        header("待办详情"),
        v_flex().p(12).gap(6)
          .child(div().text_size(12).text_color(t.ansi1).child("数据读取失败"))
          .child(div().text_size(11).text_color(t.muted).child(err)),
      ]);
    }
    if (!this.state) {
      return this.detailFrame(t, [
        header("待办详情"),
        v_flex().p(12).child(div().text_size(12).text_color(t.muted).child("载入中…")),
      ]);
    }

    const item = this.detailId ? findItem(this.state, this.detailId) : null;
    if (!item) {
      // 只有删掉才会让 findItem 落空——归档只是打标记，事项还在。
      // 说清楚，别显示一个空窗。
      return this.detailFrame(t, [
        header("待办详情"),
        v_flex().p(12).child(div().text_size(12).text_color(t.muted).child("这条待办已不存在（可能刚被删除）。")),
      ]);
    }

    return this.detailFrame(
      t,
      [
        header(item.title, [
          div().text_size(10).text_color(t.dim).child(`更新于 ${relTime(item.updated)}`),
        ]),
        v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(8).children(
          [
            err ? div().text_size(11).text_color(t.ansi1).child(err) : null,
            this.renderDetail(item, t, cx),
          ].filter(Boolean),
        ),
      ],
    );
  }

  /**
   * 详情窗的外框：每个分支都用它，因为键盘只有在**这条分支画出来的元素**上
   * 才落得下去。载入中、读失败、事项不存在这几个态也必须是可聚焦的窗口——
   * 否则 takeFocus() 重试到上限也拿不到键盘，用户只能靠 ✕ 关窗。
   */
  detailFrame(t, children) {
    return v_flex()
      .size_full()
      .bg(t.popover)
      .rounded(10)
      .track_focus(this.focusHandle)
      .on_key_down((e) => {
        if (e.key !== "escape") return;
        // 先结束备注编辑再关窗：备注没保存就关掉会丢掉刚输入的内容。
        if (this.noteEditingId) {
          this.leaveNote();
          return;
        }
        closeOverlay(this.overlayId);
      })
      .children(children);
  }

  renderDetail(item, t, cx) {
    const spaceNames = new Map(currentSpaces().map((s) => [s.id, s.name]));
    return v_flex()
      .gap(8)
      .child(
        h_flex().gap(6).items_center().flex_wrap().children([
          div().text_size(10).text_color(t.dim).child("状态"),
          ...STATUSES.map((s) =>
            button(STATUS_LABEL[s], t, item.status === s, () => {
              // 离开终态必须显式重开：在这里点就是明确意图。归档项点任意状态
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
        h_flex().gap(6).items_center().flex_wrap().children([
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
                .child(button("×", t, false, () => this.removeSpace(item, sid))),
            ),
            // agent 关联与 space 关联互斥（core 强制），所以两者不会同时非空；
            // 这里照样分开画，是为了让「这条挂在哪」一眼能读出来。
            ...(item.agent
              ? [
                  h_flex()
                    .gap(3)
                    .items_center()
                    .px(5)
                    .rounded(4)
                    .bg(t.hover)
                    .child(
                      div()
                        .text_size(10)
                        .text_color(t.muted)
                        .child(`agent ${agentName(item.agent.address)}`),
                    )
                    .child(
                      button("×", t, false, () =>
                        this.mutate(["agent", item.id], { flags: ["--clear"] }),
                      ),
                    ),
                ]
              : []),
            ...(item.spaces.length || item.agent
              ? []
              : [div().text_size(10).text_color(t.dim).child("（未关联）")]),
          ]),
          h_flex().gap(4).flex_wrap().children([
            div().text_size(10).text_color(t.dim).child("加到"),
            ...currentSpaces()
              .filter((s) => !item.spaces.includes(s.id))
              .map((s) =>
                button(`${s.machine ? `${s.machine}/` : ""}${s.name}`, t, false, () => this.addSpace(item, s.id)),
              ),
            // 挂着 agent 时说明清楚：点任一 space 会顶掉 agent 关联（互斥）。
            ...(currentSpaces().some((s) => !item.spaces.includes(s.id))
              ? item.agent
                ? [div().text_size(10).text_color(t.dim).child("（挂到 space 会解除 agent 关联）")]
                : []
              : [div().text_size(10).text_color(t.dim).child("（所有 space 都关联了）")]),
          ]),
        ]),
      )
      .child(
        h_flex().gap(6).items_center().flex_wrap().children([
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

  renderNoteEditor(item, t) {
    const editing = this.noteEditingId === item.id;
    if (editing && this.noteDraft) {
      return v_flex()
        .gap(4)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().h(80).child(Textarea.new(this.noteDraft)))
        .child(
          h_flex().gap(6).items_center().children([
            button("保存", t, true, () => this.commitNote(item.id)),
            button("取消", t, false, () => this.leaveNote()),
          ]),
        );
    }
    return h_flex()
      .gap(6)
      .items_center()
      .child(
        div()
          .flex_1()
          .truncate()
          .text_size(11)
          .text_color(item.note ? t.muted : t.dim)
          .child(item.note ? item.note.split("\n")[0] : "（无备注）"),
      )
      .child(
        button("编辑备注", t, false, () => {
          // 状态在这里建：InputState/TextareaState.new 需要一次宿主调用，
          // 不能在 render 里做（宿主会直接抛错，整个窗口渲染失败）。
          this.noteEditingId = item.id;
          this.noteDraft = TextareaState.new({ value: item.note ?? "", rows: 4 });
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
      onDone: () => this.leaveNote(),
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
// id 用「标签 + 本次渲染内的序号」而不是随机数：随机 id 每次渲染都变，元素身份
// 不稳定，命中测试与 UI 自动化都没法按 id 定位同一个按钮。序号在 render()
// 开头归零，所以同一份状态下渲染出的 id 逐次一致。
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
    // window 形态的拖动由任意未被阻止的按下发起（herdr.d.ts）。不拦住按下，
    // 点按钮会变成拖窗口，点击本身反而收不到。
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(() => onClick())
    .child(div().text_size(10).text_color(active ? t.accent_foreground : t.muted).child(label));
}
