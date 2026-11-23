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

// 标题长度上限。**必须与 src/rules.js 的 TITLE_MAX 一致**：规则层对超长标题会
// 拒绝，界面前置拦下只是让用户不必等一次失败的写。为什么不从 core 导出：那会
// 给数据层加一个只服务界面的公开常量。两处一致性由 tests/sync.test.js 的用例
// 守着，改一处漏改另一处会直接红。
const TITLE_MAX = 200;

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

/**
 * CLI 报错的第一行。
 *
 * 用法类错误（空标题就是）会附带整份 USAGE，一千多字、四十来行；原样塞进窗口
 * 就是一面字墙，用户连「这次成没成」都读不出来。第一行（`herdr-todo: …`）才是
 * 这次失败的原因，其余是帮终端用户查语法的。
 */
function firstLine(msg) {
  return String(msg ?? "").split("\n")[0].trim();
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
    // 标题编辑态。与备注编辑互斥，见 enterTitle() / enterNote()。
    this.titleDraft = null;
    this.titleEditingId = null;
    // 本地校验（空 / 超长）的提示。与 writeError 分开：它标记的不是「写盘失败」，
    // 退出编辑或下一次提交时就该消失，见 leaveTitle()。
    this.titleProblem = null;
    // takeFocus() 的令牌：每申请一次焦点自增。用户点进某个输入框时它一增，
    // 在途的重试循环就作废——否则那几轮会把键盘从刚点开的输入框里抢回去。
    this.focusSeq = 0;

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
    // 令牌：用户点进输入框时 relinquishFocus() 会把它加一，这里在途的循环立刻作废。
    // 没有它，保存成功后申请的那几轮重试会把键盘从用户刚点开的输入框里抢回来。
    const seq = ++this.focusSeq;
    this.cx.spawn(async (c) => {
      for (let i = 0; i < 20; i++) {
        if (seq !== this.focusSeq) return;
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

  /** 把键盘让给某个输入框：作废在途的 takeFocus() 重试（见那里的令牌注释）。 */
  relinquishFocus() {
    this.focusSeq += 1;
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
   * 详情窗头部那条提示。本地校验排在写盘错误之前：它总是「刚刚这一次提交」
   * 的结论，比上一次写盘失败更贴近用户当下的动作。
   */
  shownError() {
    return this.titleProblem ?? this.errorText();
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
    // `title` 是固定文本（载入中/读失败/事项不存在三个分支），`titleEl` 是可编辑的
    // 标题元素（详情主分支才有）。二者只传其一，避免三个分支也长出编辑入口。
    // `badge` 是 `#12` 形式的编号：命令行按编号寻址，面板不显示它，用户就无从
    // 知道该敲哪个号（spec §4.2 要求编号进缓存正是为了这里）。
    const header = ({ title, titleEl, editing, badge }, body) =>
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
            .children(
              badge
                ? [
                    div()
                      .id("detail-num")
                      .flex_shrink_0()
                      .text_size(11)
                      .text_color(t.dim)
                      .tooltip("命令行里用它指这条事项")
                      .child(badge),
                  ]
                : [],
            )
            .child(div().flex_1().min_w(0).child(editing ? titleEl : (titleEl ?? title)))
            .child(button("✕", t, false, () => closeOverlay(this.overlayId))),
        )
        .children((body ?? []).filter(Boolean));

    if (!this.state && err) {
      return this.detailFrame(t, [
        header({ title: "待办详情" }),
        v_flex().p(12).gap(6)
          .child(div().text_size(12).text_color(t.ansi1).child("数据读取失败"))
          .child(div().text_size(11).text_color(t.muted).child(err)),
      ]);
    }
    if (!this.state) {
      return this.detailFrame(t, [
        header({ title: "待办详情" }),
        v_flex().p(12).child(div().text_size(12).text_color(t.muted).child("载入中…")),
      ]);
    }

    const item = this.detailId ? findItem(this.state, this.detailId) : null;
    if (!item) {
      // 只有删掉才会让 findItem 落空——归档只是打标记，事项还在。
      // 说清楚，别显示一个空窗。
      return this.detailFrame(t, [
        header({ title: "待办详情" }),
        v_flex().p(12).child(div().text_size(12).text_color(t.muted).child("这条待办已不存在（可能刚被删除）。")),
      ]);
    }

    const editing = this.titleEditingId === item.id && this.titleDraft;
    return this.detailFrame(
      t,
      [
        header({
          editing: Boolean(editing),
          badge: item.num != null ? `#${item.num}` : null,
          titleEl: editing ? this.renderTitleEditor(item, editing, t) : this.renderTitleText(item, t),
        }, [
          div().text_size(10).text_color(t.dim).child(`更新于 ${relTime(item.updated)}`),
          // 错误提示挂在头部（滚动区之外）：写失败时窗口的滚动位置在顶部，
          // 放在滚动区里用户根本看不到「保存被拒了」。只显示第一行——CLI 的
          // 用法类错误会附带整份 USAGE，四十来行塞进来等于没有提示。
          // `titleProblem` 是本地校验（空 / 超长）的结果，与写盘失败分开：
          // 两者都只显示第一行，且都在这个固定可见的位置。
          this.shownError()
            ? div()
                .id("title-error")
                .text_size(11)
                .text_color(t.ansi1)
                .child(firstLine(this.shownError()))
            : null,
        ]),
        v_flex()
          .id("detail-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(12)
          .gap(8)
          .child(this.renderDetail(item, t, cx)),
      ],
    );
  }

  /**
   * 详情窗头部的标题（非编辑态）：**点它自己**就进编辑态，没有单独的按钮。
   *
   * `on_mouse_down` + `stop_propagation` 不是可选的：window 形态的拖动由任意
   * 未被阻止的按下发起（见文件末尾 button() 的注释），不拦住按下，点标题会被
   * 当成拖窗口，`on_click` 根本收不到。
   * 悬停底色与 tooltip 让「可点」在点之前就看得出来——否则它看起来和只读文字一样。
   */
  renderTitleText(item, t) {
    return div()
      .id(`todo-title-${item.id}`)
      .flex_1()
      .min_w(0)
      .truncate()
      .text_size(13)
      .font_semibold()
      .text_color(t.foreground)
      .rounded(4)
      .px(2)
      .hover((s) => s.bg(t.hover))
      .tooltip("点击修改标题")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.enterTitle(item))
      .child(item.title);
  }

  /**
   * 编辑态：输入框 + 保存 / 取消。
   *
   * 输入框要画自己的底色与边框（与快速记录窗同一个形状）：`Input` 本身没有
   * 可见边界，不画的话编辑态看起来还是那行文字，用户不知道字打到哪里去了。
   *
   * `stop_propagation` 与标题文字同理——输入框里按下不能被当成拖窗口。
   */
  renderTitleEditor(item, draft, t) {
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(6)
      .items_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(
        div()
          .flex_1()
          .min_w(0)
          .px(6)
          .py(3)
          .rounded(6)
          .bg(t.input)
          .border(1)
          .border_color(t.border)
          .child(Input.new(draft)),
      )
      // 按 id 而不是 this.titleEditingId：回调在点击时求值，那时编辑态可能已经
      // 因为别的原因退出，this.titleEditingId 是 null，会发出 `title null …`。
      .child(button("保存", t, true, () => this.commitTitle(item.id), "title-save"))
      .child(button("取消", t, false, () => this.leaveTitle(), "title-cancel"));
  }

  /**
   * 进入标题编辑。与备注编辑互斥（两个方向都要拦，见 enterNote）。两个草稿同时
   * 活着时，Esc 该先收哪一个会变得不可解释，而且两者的「保存」按钮长得一样，
   * 用户分不清按了哪个。
   *
   * InputState.new 需要一次宿主调用，所以只能在事件处理器里建（与备注一致）。
   */
  enterTitle(item) {
    if (this.titleEditingId) return;
    // 切换编辑器时直接清掉另一份草稿，不走 leaveNote()：那个函数会把键盘还给
    // 窗口，而这里紧接着就要交给新的输入框。
    this.noteEditingId = null;
    this.noteDraft = null;
    this.titleProblem = null;
    this.titleEditingId = item.id;
    this.titleDraft = InputState.new({ value: item.title ?? "" });
    this.titleDraft.on("submit", () => this.commitTitle(item.id));
    this.titleDraft.focus();
    // 键盘已经交给输入框：作废在途的 takeFocus()，否则它下一轮又把键盘抢回去。
    this.relinquishFocus();
    this.cx.notify();
  }

  /**
   * 退出标题编辑：清草稿，把键盘收回窗口（否则 Esc 要按两次）。
   *
   * 同时清掉本地拦截留下的提示：那是「这次输入不符合要求」，只在编辑态里有
   * 意义。留着它，用户点「取消」之后窗口还会一直说「标题不能为空」——而那时
   * 根本没有一次失败的写入。
   */
  leaveTitle() {
    this.titleEditingId = null;
    this.titleDraft = null;
    this.titleProblem = null;
    this.takeFocus();
    this.cx.notify();
  }

  /**
   * 保存标题。只有写成功才收起编辑器——失败时保留用户刚输入的内容，
   * 否则一句「标题不能为空」就把输入丢了。
   *
   * 空标题与超长标题在这里就拦下，不发进程：CLI 把「空标题」当用法错误
   * （UsageError），stderr 会附带整份 USAGE，一千多字塞进窗口等于没有提示；
   * 超长标题 CLI 也会拒绝，前置拦下只是让提示留在输入框旁边。
   * 上限只从 core 取，不在这里再写一遍 200。
   *
   * 标题走 `--` 之后的位置参数（command() 负责），所以叫 `-h` 或 `--space`
   * 的标题也能原样保存，不会被当成选项。
   */
  commitTitle(id) {
    // draft 是这一轮渲染时挂上的那个草稿对象；id 由调用方捕获，不读可变字段
    // this.titleEditingId（点击时它可能已经是 null，会发出 `title null …`）。
    const draft = this.titleDraft;
    if (!draft) return;
    const text = String(draft.value?.() ?? "").trim();
    const problem = !text
      ? "标题不能为空"
      : text.length > TITLE_MAX
        ? `标题最多 ${TITLE_MAX} 字（当前 ${text.length} 字），没有保存`
        : null;
    if (problem) {
      // 单独存，不塞进 writeError：那条通道的语义是「某次写盘失败了」，
      // 由 spawn 成功后清除。本地拦截压根没发命令，混进去会让提示赖着不走。
      this.titleProblem = problem;
      this.cx.notify();
      return;
    }
    this.mutate(["title", id, text], {
      onDone: () => {
        // 写回期间用户可能又点开标题重新编辑（保存慢时）。那时新草稿还活着，
        // 这一轮的 onDone 不能当成「当前编辑结束了」，否则会吞掉新输入。
        if (this.titleDraft !== draft) return;
        this.leaveTitle();
      },
    });
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
        // 先结束编辑再关窗：没保存就关掉会丢掉刚输入的内容。标题与备注互斥，
        // 但两个分支都留着——用户可能在两次编辑之间切换过。
        if (this.titleEditingId) {
          this.leaveTitle();
          return;
        }
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
        button("编辑备注", t, false, () => this.enterNote(item), "note-edit"),
      );
  }

  /**
   * 进入备注编辑。`InputState`/`TextareaState.new` 需要一次宿主调用，所以
   * 只能在事件处理器里建（render 里做宿主会直接抛错，整个窗口渲染失败）。
   *
   * 与标题编辑互斥，两个方向都要拦：只拦「进标题时退备注」，标题编辑中再点
   * 这里就会两个编辑器同时活着——Esc 一次收掉两个、备注输入被后来保存的那次覆盖。
   */
  enterNote(item) {
    if (this.noteEditingId) return;
    this.titleEditingId = null;
    this.titleDraft = null;
    this.titleProblem = null;
    this.noteEditingId = item.id;
    this.noteDraft = TextareaState.new({ value: item.note ?? "", rows: 4 });
    this.noteDraft.on("submit", () => this.commitNote(item.id));
    this.noteDraft.focus();
    // 与 enterTitle 同理：键盘已交给输入框，作废在途的 takeFocus()。
    this.relinquishFocus();
    this.cx.notify();
  }

  /**
   * 保存备注。只有写成功才收起编辑器——失败时保留用户刚输入的文本，
   * 否则一句「数据文件一直被其他进程改写」就把输入丢了。
   */
  commitNote(id) {
    const draft = this.noteDraft;
    if (!draft) return;
    const text = String(draft.value?.() ?? "");
    // 备注正文走 --note= 单 token：正文可能是 `--space x`、`-h` 这种文本，
    // 作为位置参数会被当成选项语法。
    this.mutate(["note", id], {
      flags: [`--note=${text}`],
      onDone: () => {
        // 与 commitTitle 同一套身份检查：写回期间用户可能已经切到标题编辑。
        // 那时 leaveNote 不但会清掉一份已经没人看的草稿，还会通过 takeFocus
        // 把键盘从用户正打字的标题输入框里抢走。
        if (this.noteDraft !== draft) return;
        this.leaveNote();
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
// id 用「标签 + 本次渲染内的序号」而不是随机数：随机 id 每次渲染都变，元素身份
// 不稳定，命中测试与 UI 自动化都没法按 id 定位同一个按钮。序号在 render()
// 开头归零，所以同一份状态下渲染出的 id 逐次一致。
let buttonSeq = 0;
// id 可以显式指定：同一个标签在窗口里可能出现多次（状态里的「取消」和编辑器的
// 「取消」），按标签排查或点选时只能靠序号，而序号随渲染里的其它按钮漂移。
// 需要稳定身份的地方（标题编辑器的保存/取消）传自己的 id。
function button(label, t, active, onClick, id) {
  buttonSeq += 1;
  return h_flex()
    .id(id ?? `btn-${label}-${buttonSeq}`)
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
