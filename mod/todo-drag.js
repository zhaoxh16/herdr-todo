// 待办拖拽的跨 mod 契约。
//
// spaces-todo 与 agents-todo 各有一份副本：沙箱禁止跨目录 import，而「手上拿着哪条
// 待办」两边必须按同一套规则读。内容一旦分叉，就会出现「侧栏画了跟随标签、Agents
// 栏不认这次拖拽」这类只有一边坏掉的行为（tests/sync.test.js 守着不许分叉）。
//
// 为什么拖拽状态放 shared：跨 mod 传不出指针事件。拖动源按下时写 shared，每个 mod
// 重渲染时据此画跟随标签与投放高亮；释放在哪个 mod 的目标行上，就由那个 mod 读它
// 完成关联。
//
// 对称性是这个文件的核心约束：**待办行在两个 mod 里都能按下，space 行与 agent 行
// 都能接收**。只做单向的话，一条已经关联到 agent 的待办就再也拖不动了——用户报的
// 「拖到 Agent 栏之后就没法接着拖动」正是这个。

// 注意：这里**不**从 "herdr" 导入 `window`——那个是 herdr 的 `window()`
// （平台/按钮状态）。跟随标签要的是宿主的环境全局 `window`（`mouse_position()`），
// 导入同名会把它遮住。
import { shared, setShared } from "herdr";
import { div } from "gpui-kit";

export const DRAG_KEY = "todo.drag";

// 手势的有效期。
//
// 宿主不告诉脚本「左键是否还按着」：在终端区、窗口空白处松手时没有任何 mod 收到
// mouse_up，只能靠超时收尾。定得太短，正在犹豫的拖拽会被静默取消（松手后发现什么
// 都没发生）；定得太长，放弃拖拽后跟随标签还会黏在指针旁边。
//
// 15 秒只是最后一道防线。更快的收尾有两处：两个 mod 的根元素一收到按下就作废上一只
// 手势（见 staleOnPress），以及任何投放目标/空放都会自己清。
export const DRAG_TTL = 15000;

/** 两次按下间隔超过这个值，就认为前一次手势已经结束（同一次双击不会误伤）。 */
const PRESS_WINDOW = 300;

/**
 * 手上正拿着哪条待办；没有、格式坏掉、或已过期时返回 null。
 *
 * shared 和账本都不是可信输入：手改过的值只该让这次拖拽失效，不该让整个侧栏渲染
 * 挂掉。
 */
export function readDrag() {
  const d = shared(DRAG_KEY);
  if (!d || typeof d !== "object") return null;
  if (typeof d.id !== "string" || !d.id) return null;
  const at = typeof d.at === "number" ? d.at : 0;
  if (Date.now() - at > DRAG_TTL) return null;
  return d;
}

/**
 * 按下一条待办行时调用。
 *
 * `from` 说明它从哪儿被拿起：`{ kind: "space" | "agent" | "unlinked" | "orphan",
 * key, spaces }`。`spaces` 是这条事项此刻关联的全部 space id：从 space 组拖走时
 * 只移除**被拖出的那一组**，其它关联保持；从孤儿组拖走时这些 id 已不存在，一并
 * 清掉。
 */
export function beginDrag(it, from) {
  setShared(DRAG_KEY, {
    id: String(it.id),
    title: String(it.title ?? ""),
    from: from ?? null,
    at: Date.now(),
  });
}

/** 手势结束（投放、取消、点击）。没有手势时不重复写 shared，免得多余的重渲染。 */
export function endDrag() {
  if (shared(DRAG_KEY)) setShared(DRAG_KEY, null);
}

/**
 * 根元素收到按下时调用：作废上一只「已结束但没人清」的手势。
 *
 * 典型的泄漏场景是「按下待办行，拖到终端区松手，再回来点一下」。终端区没有 mod，
 * 那次松开没有任何人收到，shared 里会留到 TTL。一次新的按下必然意味着上一次已经
 * 结束——但**不能**无条件清：这次按下的事件是冒泡上来的，待办行自己的处理器刚写完
 * 本次手势，根元素若照清就会把它立刻抹掉。所以按时间判定：距离上一次按下超过
 * PRESS_WINDOW 才算陈旧。
 */
export function staleOnPress() {
  const d = readDrag();
  if (d && Date.now() - d.at > PRESS_WINDOW) endDrag();
}

/**
 * 从根元素的指针事件里学习它在**窗口坐标**里的原点，返回新的缓存。
 *
 * 指针事件同时带 `position`（窗口坐标）与 `local_position`（元素坐标），两者相减
 * 就是该元素原点。宽高不从这里来——`on_size_change` 报告的是 `{width, height}`，
 * 字段名与缓存里的 `w/h` 不同，由调用方自己写回，免得这里再猜一次字段名。
 *
 * 用窗口坐标而不是元素局部坐标，是因为拖拽会跨出本 mod 的 block：只看局部坐标的话，
 * 指针移到隔壁 mod 时这里收不到事件，标签会冻在边界上；而两个 mod 都用窗口坐标，
 * 交接处位置连续，且能各自判断「指针还在不在我这一块里」。
 */
export function learnRoot(prev, ev) {
  const pos = ev?.position;
  const local = ev?.local_position;
  const base = prev ? { ...prev } : { x: 0, y: 0, w: 0, h: 0 };
  if (pos && local && Number.isFinite(pos.x) && Number.isFinite(local.x)
      && Number.isFinite(pos.y) && Number.isFinite(local.y)) {
    base.x = pos.x - local.x;
    base.y = pos.y - local.y;
  }
  return base;
}

/** 窗口坐标里的指针位置；宿主不支持或这一刻取不到时返回 null。 */
function pointer() {
  try {
    // 裸 `window` 是宿主的全局（`mouse_position()` 在测量接口那一组里，渲染期合法）；
    // `globalThis.window` 是同一对象的另一种拼法，宿主两者都装了。这里不写
    // `import { window } from "herdr"`——那是平台/按钮状态的函数，不是这个对象。
    const w = typeof window !== "undefined" ? window : globalThis.window;
    const p = w?.mouse_position?.();
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  } catch {
    // 在 `check` 这类没有窗口的调用里会抛；没有指针就没有跟随标签，不是错误。
    return null;
  }
}

/**
 * 跟随光标的标签；不该画时返回 null。
 *
 * `root` 是本 mod 根元素在窗口坐标里的矩形（见 learnRoot）。指针不在矩形内就不画：
 * 隔壁 mod 会接着画，谁都不在（终端区）时就谁都不画——宿主的 block 会裁剪子元素，
 * 那边本来也画不出去。为了「全窗口跟随」而反复开关 overlay 会干扰按下与焦点，不做。
 *
 * `window.mouse_position()` 与 `viewport_size` 同组，是宿主允许在 render 里调用的
 * 测量接口：没有它就只能靠指针事件，而指针停在原地不动时（拖起来想一想）标签会
 * 停在旧位置。
 */
export function dragGhost(drag, root, t) {
  if (!drag || !root) return null;
  const w = root.w ?? 0;
  const h = root.h ?? 0;
  if (!(w > 0 && h > 0)) return null;
  const p = pointer();
  if (!p) return null;
  // 指针不在本矩形里就不画，交给隔壁 mod。
  //
  // 两个 mod 的矩形是布局里互不重叠的块（侧栏、Agents 栏），所以指针最多落在一个
  // 里面——同一时刻至多一个 mod 画这个标签，不存在重影。
  if (p.x < root.x || p.x > root.x + w || p.y < root.y || p.y > root.y + h) return null;

  // 指针本地坐标，以及标签的尺寸预算。
  //
  // 标签要在**窄侧栏**里也看得见：侧栏只有约 268px，而标签最宽 220px，把标签
  // 一律放在指针右侧会让它大半截探出块外被宿主裁掉（拖到侧栏右半边就只剩一条边）。
  // 所以溢出时翻到指针左侧，两侧都放不下时再夹回块内。竖向同理夹紧——竖直方向
  // 掉到块外看不出「拖拽还在」，横向翻边却能读全标题。
  const GAP = 14;
  const WIDTH = 220;
  const HEIGHT = 18;
  const localX = Math.round(p.x - root.x);
  const localY = Math.round(p.y - root.y);
  let left = localX + GAP;
  if (left + WIDTH > w) left = localX - GAP - WIDTH;
  if (left < 0) left = Math.max(0, Math.min(localX + GAP, w - WIDTH));
  const top = Math.max(0, Math.min(localY + 6, h - HEIGHT));
  return div()
    .id("todo-ghost")
    .absolute()
    .left(left)
    .top(top)
    .max_w(WIDTH)
    .px(8)
    .py(3)
    .rounded(6)
    .border_1()
    .border_color(t.accent)
    .bg(t.raised)
    .opacity(0.96)
    .child(
      div()
        .max_w(200)
        .truncate()
        .text_size(11)
        .text_color(t.foreground)
        .child(drag.title || "（无标题）"),
    );
}
