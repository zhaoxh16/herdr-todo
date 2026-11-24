# Plan：herdr-todo — 待办列表迁入左侧 Spaces 侧栏

> 协议锚点：继续、恢复或修订本任务时，须加载 `planning`（由其默认加载 `t-mode`）；进入 `spec.md` / `tasks.md` 阶段时分别调用 `spec-writing` / `task-execution`（未经用户本轮明示禁止 commit / push / 提 MR）。

- TAPD 工作项：无
- 工蜂 issue：无
- 是否提交 MR：否
- MR 目标分支：无
- 开发分支：无

## 当前状态

- 状态：in-progress
- 当前步骤：步骤 1–8 完成；需求 1（关联 agent）与需求 2（拖拽关联，含第二轮对称模型返工）已实现并回归；等待 `Gate: Final Review`
- 当前在途：无
- 下一步：用户验收（含一次手动拖拽确认，见「范围外与风险」第一条）

## 现状与目标

- 现状问题：待办只活在右侧 `panel-body` 面板栈里（`layouts/herdr-todo.json` 的 `todo-block`，由 `mod/main.js` 渲染）。
  - 右侧面板和 Files/Changes 共用一列，一次只能看一个；看待办就得挤掉正在看的 diff/文件。
  - 侧栏的 space 行（`mods/spaces/main.js` 的 `Spaces.row`）完全不知道这个 space 还有什么事，用户必须先点右侧 Todo 按钮再逐个 space 展开。实测当前账本 4 条事项、5 个 space，其中 `dev4`/`dev7` 两个 space 空着却照常显示一行。
  - 面板自带「未关联」组和「space 已不存在」组，但只有在用户主动打开面板时才看得见。
- 目标可观察结果：打开任意布局（`herdr-todo`）时，左侧 Spaces 侧栏顶部先出现未关联待办，随后每个 space 行下方直接列出关联到该 space 的未关闭事项（状态字形 + 优先级 + 标题），该 space 有已完成项时末尾一行「已完成 N」可展开。点任一行弹出可拖动悬浮窗显示详情（状态 / 优先级 / 关联 / 归档 / 备注 / 时间线），在窗内改动立刻反映到侧栏。space 行悬停出现＋，可直接给该 space 记一条。右侧不再有 Todo 面板、tab bar 不再有 Todo 按钮、`ctrl-alt-t` 不再绑定。
- 价值排序：数据不丢 > 关联准确 > 一眼可读 > 操作步骤少 > 功能多（沿用上一任务）。

### 已实测的技术事实（起草期关闭的假设）

| 事实 | 证据 |
|---|---|
| App 自带的 `spaces` mod 是只读、每次启动被整份替换，但可以用**运行时 augment**：克隆其源码后再包装 `Spaces.prototype.row` / `grouped` / `render` | `/tmp/htprobe/sidebar-probe.png`、`sidebar-probe2.png`；`herdr-app check` 通过 |
| 包装后追加的子行（`v_flex().children([spaceRow, ...todoRows])`）在真实侧栏里正常渲染、可点击 | `sidebar-probe2.png`：每个 space 下出现 ● P1 修 login 偶发失败 / ▸ 已完成 2 |
| 已构建的 row 元素可以后续 `.child()` / `.on_hover()` 追加（不必重写 `row` 整体） | `/tmp/htprobe/probe2.png`：追加的 ＋ 与自建顶部组同时出现 |
| 侧栏可以调用 `openOverlay()` 打开**本 mod 自己的**第二个实例，并带 `props` | `/tmp/htprobe/probe6.png`：`DETAIL item=t9 space=dev8/x` |
| `openOverlay` 的 `props` 在 overlay 实例里通过 `props()` 读到；但同一 mod 被**再次** `openOverlay` 时新 props 不会驱动已有实例（`update` 未被调用），所以详情窗必须每次新开、以 `key` 区分 | `probe6.png` 中第二个实例读到 `item=undefined` |
| `mod.open` 是 toggle：连续调用会开关交替 | 实测 6 次，overlays 0/1 交替 |
| 侧栏实例有 `AsyncContext`，可 `cx.timer` / `cx.spawn`；`watchFolder` 可监听账本目录 | `mods/spaces/main.js` 自身就用 `cx.timer.every` 与 `watchFolder` |
| `herdr-todo` CLI 已就绪，面板写路径只有 CLI 一条；`mod/store.js` 的 `command()` 已钉死 argv 形态 | `mod/store.js:88`、`tests/argv.test.js` |
| 克隆件与上游 `spaces` 的差异需要人工维持：App 升级后要重新克隆 | README「已知边界」已有同类约定（`tabs-todo`） |

## 改动

### 1. `mod/spaces/main.js`（新文件，`spaces-todo` 克隆件）

克隆 `~/.config/herdr-app/mods/spaces/main.js`，只在**尾部**追加一段「待办扩展」，不改动上游代码：

- 顶部新增 `mods/spaces-todo/main.js` 里 `import { read, command, dataDir } from "./store.js"`（`store.js` / `core.js` 与现有 mod 共用同一份副本）。
- 包装 `Spaces.prototype.init`：在 `spaces()` 之外建立 `this.todo = { state, readError, expandedGroups }`，`load()` 走 `read()`，`watchFolder(dataDir())` 驱动重读（3 秒退避 + 10 秒兜底轮询，与现有面板相同）。
- 包装 `Spaces.prototype.row(r, t)`：原行 + 缩进的待办子行。
  - 子行内容由 `groupBySpace(state.items, knownSpaces)` 派生，取 `kind === "space"` 且 `key === r.w.id` 的那组；只显示 `!CLOSED_STATUSES` 的项。
  - 每行：状态字形（`○ ◐ ●`）+ 优先级（P0 红 / P1 黄 / 其余灰）+ 标题（truncate）+ 相对时间。
  - 该 space 有 done/cancelled 时末尾一行「▸ 已完成 N」，点击展开该组的已完成项（状态存在 `this.todo.expandedGroups`，每个 space 独立）。
  - 行点击 → `openOverlay({ mod: "herdr-todo", kind: "window", key: "herdr-todo-detail", width: 420, height: 520, props: { detail: item.id } })`。
- 包装 `Spaces.prototype.grouped`：在最前面插入「未关联」组（标题 + 未关闭项 + 行内＋），逻辑同 space 组。
- 包装 `Spaces.prototype.render`：`props()?.detail` 存在时渲染详情窗（见第 2 节），否则走上游渲染。
- 侧栏实例的 `init` 里读 `props()?.spawnItem`：来自 mod 命令的参数，用来在点击＋时直接打开快速记录。因为 overlay 实例不能复用 props，**不用** `mod.open` toggle，改由侧栏自己 `openOverlay` 打开 `herdr-todo` 的 capture 形态（`props: { capture: true, space }`）。
- 侧栏宽度 < 160（`narrow()`）时不渲染任何待办子行：窄栏是 32px 图标条，塞不下。
- 读失败时在「未关联」组上方显示一行灰字原因；写失败时在对应行下方显示红色原因（与现在面板的 `writeError` / `readError` 口径一致）。

### 2. `mod/main.js`：从「面板 + 弹窗」改为「详情窗 + 快速记录窗」

- 删掉 `renderPanel` / `renderHeader` / `renderGroupHeader` / `renderItemRow` / `renderClosedSection` / `isFolded` / `toggleGroup` / `selectedId` / `showClosed` / `expanded` / `override` / `scroll` 等只有面板才用的状态与函数。
- 保留 `renderDetail` 的全部能力（状态 / 优先级 / 关联增删 / 归档 / 备注编辑 / 时间线），改为详情窗的根：`props()?.detail` 存在时按该 item 渲染；每次 `mutate` 成功后重读并 `cx.notify()`。
- 详情窗顶栏加一个 ✕（`closeOverlay(props().overlay)`），Esc 由 `kind: "window"` 处理（`.on_key_down`，需要 `focusable: true` 或改用 `dialog`；见「主要风险」）。
- 快速记录窗逻辑保留（`renderCapture` + `createFromDraft`），改为 `props()?.capture` 触发；预填 `props().space`，没有则不关联。
- 详情窗里状态切换、关联增删的写路径继续走 `mod/store.js` 的 `command()`（argv 形态不改）。

### 3. `mod/mod.json`：overlay 尺寸与形态

- 默认 overlay 是**快速记录窗**：`{ "kind": "dialog", "width": 460, "height": 148 }`。
  `mod.open`（`ctrl-alt-n`）是唯一走默认值的入口，它打开的就是快速记录；
  详情窗由侧栏每次 `openOverlay` 显式给 `{ kind: "window", 420×520 }`，不读默认值。
  （执行期实测：写成 `window 420×520` 会得到一大块空白面板，且 `overlay.close` 关不掉。）

### 4. `scripts/install-layout.py`：去掉右侧面板块

- 删掉「往 `panel-body` 追加 `todo-block`」「`stack.active = todo-block`」两段；不再改 `panel-body`。
- 不再把 `tabs` 换成 `tabs-todo`（tab bar 恢复成 App 自带的 `tabs`）。
- 保留独立布局文件与备份逻辑；保留「找不到 `panel-body`/`tabs` 就报错退出」的检查改为只检查 `spaces` 块存在。
- 新增：把侧栏 `spaces` 块的 `content.mod` 改为 `spaces-todo`。

### 5. `install.sh`

- 安装 mod 时多复制 `spaces/main.js` 与 `spaces/mod.json` 到 `$APP_HOME/mods/spaces-todo/`（连同 `store.js` / `core.js` —— 跨目录 import 被禁，必须同目录副本）。
- 删除 `tabs-todo` 的安装段；对**已存在的** `tabs-todo` 目录不再触碰（旧安装残留会让布局仍指向它，由 `install-layout.py` 把 `tabs` 改回自带值来消解）。
- 前置检查里把 `mod/tabs/*` 换成 `mod/spaces/*`。

### 6. `scripts/install-keys.py`

- 从 `DEFAULTS` 删除 `ctrl-alt-t`；保留 `ctrl-alt-n`。
- 新增清理：若 keys.json 里存在「本项目当初写入的 `layout.toggle {id: panel}`」绑定则删除；用户自己改过的（命令或参数不同）不动。清理结果计入 `SUMMARY`。

### 7. 测试

- `tests/argv.test.js` 不变（argv 契约没变）。
- 新增 `tests/sidebar.test.js`：把 `mod/spaces/main.js` 的待办派生逻辑抽成纯函数后直接断言——给定 items + spaces 得到「未关联组 + 每 space 的未关闭项 + 已完成计数」；空 space 不产生子行；已在不存在 space 的事项不出现在任何 space 组。
- `tests/sync.test.js`：加入对 `mod/spaces/main.js` 语法可解析（`node --check` 等价）与 `install-layout.py` / `install-keys.py` 的语法检查（已有 Python 段，补 shell/python 列表）。
- `tests/cli.test.sh` 不变。

### 8. `README.md`

- 「它是什么」「面板开关」「快捷键」「用法 · 面板」四节按新形态重写：侧栏分组、行内＋、详情悬浮窗、已完成 N；删掉右侧面板与 Todo 按钮的描述。
- 「已知边界」补一条：`spaces-todo` 是克隆件，App 升级改动 `spaces` 后需重新克隆并重贴待办扩展段。

### 9. 关联到 agent（执行期新增需求，用户 2026-11-19 15:28 提出）

> **2026-11-24 修订**：用户要求「绑定 agent 的待办也显示在 spaces 界面的对应 space 下」。
> 下面「活着时侧栏不列、关了才回退」的口径**已作废**：现在关联 agent 的事项一律按
> `agent.space` 在侧栏归组（无论 agent 活着/搬家/关闭），Agents 栏仍照常显示，两处各一次。
> `deriveSidebar` 不再需要 `knownAgents`；「恰好出现一次」的不变量改为「侧栏绝不丢失，
> 活 agent 时两视图各一次」。这是显示口径的变化，数据模型（互斥、`agent.space` 存关联
> 当时的 space）不变。原文保留仅为记录当时决策，勿据「回退」二字实现。

已锁定的决策（用户经结构化提问确认；显示口径已于 2026-11-24 修订，见上方）：

- **agent 替代 space**：一条事项要么关联 space（可多个），要么关联**一个** agent，二者不同时存在。
- **回退**：agent 关闭后，事项自动显示在它**关联当时所在的 space** 下。已查实 `agents()` 在 agent
  消失后不提供任何反查 lineage 的手段（`hc ls` 的 `where` 是给人看的字符串，没有 space id），
  所以关联时必须把当时的 space id 一并存下来。
- **Agents 栏显示**：两种排序模式（按优先级 / 按 space 分组）与子 agent 行下都显示；子 agent
  也可作为关联目标。

数据形态（`src/core.js`，账本是长期契约）：

- 事项新增 `agent: { address, space } | null`。`address` 是 Herdr 的终端地址（`dev5/t2`、`t7`），
  `space` 是关联当时它所在的 space id（回退用）。仍带原有的 `spaces` 数组，但两者互斥：
  写入 `agent` 时 `spaces` 置空，反之亦然（由 core 的写入函数强制，不靠调用方自觉）。
- 时间线新增 `kind: "agent"`，`from`/`to` 为 `address|null`，沿用 `link`/`unlink` 的语义。
- 读入校验：`agent` 不是 `{address: string, space: string}` 就判 `corrupt`（与 `spaces` 同口径）。
- CLI 新增 `herdr-todo agent <id> <address>` 与 `herdr-todo agent <id> --clear`
  （写入时把该 agent 当前所在 space 一并存下——由 mod 传入，因为 CLI 不查 Herdr）。

派生（`mod/spaces/todo-view.js` → 改名 `mod/todo-view.js`，两个克隆件共用）：

- `deriveSidebar(state, spaces, agents)`：关联到活着的 agent 的事项**不进**任何 space 组；
  agent 已消失的事项按 `agent.space` 回退到该 space 组；`agent.space` 也已不存在的进孤儿组。
- 新增 `deriveAgents(state, agents)`：每个 agent 地址 → `{open, closed}`，供 agents 栏渲染。

渲染：

- `mod/spaces/main.js`：`todoRow` 在关联 agent 的事项上显示 agent 名（地址尾巴），并作为拖拽源。
- 新增 `mod/agents/main.js`（`agents-todo` 克隆件）：克隆 App 自带 `agents`，在 `render` 的
  `groups.flatMap(...)` 处按地址插入待办行；只在非窄栏、非折叠时显示。客户端的 `rows` 是
  `groups.flatMap((g) => [header(g), ...members.flatMap(withKids)])`，待办行作为 `withKids`
  的返回值追加在 agent 行之后，因此两种排序模式与子 agent 行下都自然生效。

### 10. 拖拽关联（执行期新增需求，用户 2026-11-19 15:28 提出）

已查实的机制（不是猜测）：

- mod 沙箱**没有**跨 mod 的拖拽 payload 通道；`drag_paths` 只把文件路径送到终端。
- GPUI 的 `on_mouse_up` 按**松开位置**命中测试（证据：上游 `spaces` 的拖拽排序把
  `on_mouse_up` 挂在列表容器上、`on_mouse_move` 挂在每行上，就能识别「放在哪一行」）。
- `setShared` 会让每个 mod 重渲染并重新读取，可作跨 mod 的拖拽状态通道。

实现（**对称模型**，2026-11-19 第二轮按用户反馈重写）：

> 用户反馈的三点——「拖到 Agents 栏之后就没法接着拖」「space 之间不能来回拖」
> 「拖动时没有悬浮标签」——其实是同一个缺口的三面：第一版只让**侧栏**的待办行当
> 拖动源、只让 **agent 行**当初放目标。于是 agent 待办一旦拖过去就再也拖不走，
> space 行接不住任何东西，也没有任何跟随光标的视觉。

- **共享契约** `mod/todo-drag.js`（两个 mod 各一份副本，`sync-core.sh` 生成、
  `tests/sync.test.js` 守着不许分叉）：
  - `beginDrag(item, from)` / `endDrag()` / `readDrag()`：手势写在
    `shared("todo.drag")`，`readDrag` 同时做 TTL 与格式校验（手改过的值只让这次
    拖拽失效，不该让侧栏渲染挂掉）。
  - `staleOnPress()`：根元素收到按下时作废**上一次**已结束但没人清的手势。按时间
    窗口（300ms）判定，因为这次按下会冒泡到根元素，无条件清会把本行刚写的手势抹掉。
  - `learnRoot(prev, ev, size)`：从指针事件的 `position - local_position` 学到
    根元素在**窗口坐标**里的矩形，宽度来自 `on_size_change`。
  - `dragGhost(drag, root, t)`：跟随光标的标签。位置在 render 里用
    `window.mouse_position()`（与 `viewport_size` 同组的测量接口，渲染期合法）算，
    夹在根矩形内，指针跑出本 mod 的 block 就不画、交给隔壁 mod 接着画——两边都用
    窗口坐标，交接处连续。
- **拖动源**：**两个 mod 的待办行都是**（侧栏的 `todoRow` 与 Agents 栏的
  `todoRow`）。按下即 `beginDrag`，不设位移阈值（宿主不告诉脚本「左键是否还按着」，
  阈值判定会留下清不掉的残留）。点击不走 `on_click` 而走 `on_mouse_up`：`beginDrag`
  写 shared 会让每个 mod 重渲染，按下时元素被换掉，click 配对判定就落空了——
  用户报的「拖到 agents 栏后点击不弹详情」正是这个。
- **投放目标**：**space 行、agent 行（含子 agent、窄栏）、「未关联」分组标题**。
  space 行是这一轮补的另一半（用户要的「space 之间来回拖」）。高亮单独记在
  `todoDropAt`，不复用上游 `hovered`（那个还决定 ＋ 与 pin 显不显示）。
- **写入**：新增 `core.moveSpace()` 与 CLI `move <id> [space] [--from ...]`。
  一次加锁的读改写完成「去掉来源、加上目标」，避免 unlink+link 两次写的中间态与
  快照覆盖。`--from` 可重复（孤儿组一次摘掉多个已不存在的 space id）。来源是
  agent 时 `moveSpace` 在同一次写里摘掉 agent（互斥不变量在 core 强制）。
- **残留清理**：`spaces-todo` 2 秒定时器按 `DRAG_TTL`（15 秒）收尾；两个 mod 的
  根元素按下时 `staleOnPress`；任何目标行的松开都会 `endDrag`。
- **失败要说出来**：Agents 栏没有显示错误的位置，投放写失败时 `notify()` 一条 toast，
  否则用户看到的和成功一模一样。侧栏把错误写进顶部红字行。

## 验证

- [x] 侧栏渲染：真实 App 中 `spaces-todo` 加载后，每个 space 行下方出现待办子行；未关联组在顶部；空 space 无子行；窄栏（< 160px）不出现待办行 → 截图 `.agent/todo-sidebar/workspace/FINALz.png`；`errors: []`
- [x] 详情窗：`props { detail }` 打开后标题/状态/优先级/关联/归档/备注/时间线齐全，✕ 与 Esc 两条关闭路径；`focus=1` 证明窗口确实拿到了键盘 → 截图 `.agent/todo-sidebar/workspace/f3z.png`
- [x] 详情窗写入落盘：窗内 mutate 走 CLI，`todos.json` 状态与时间线随之变化（`by: "panel"`），侧栏 3 秒内更新 → `herdr-todo show t6 --json`；验证数据已还原
- [x] 快速记录：未关联行的＋与 `ctrl-alt-n` 建出**未关联**事项（`spaces: []`）；space 行的＋预填该 space 建出关联事项 → `list --json`（t13 / t14 两条验证记录，已从账本移除）
- [x] 右侧清理：tab bar 只剩 `Files | Changes`、`panel-body` 无 todo-block、`keys.json` 中 `ctrl-alt-t` 已被清理且只留 `ctrl-alt-n` → 截图与 `keys.json`
- [x] 写路径仍是 CLI 唯一：侧栏与详情窗的改动都产生 `by: "panel"` 的时间线条目 → `show --json`
- [x] 读失败与坏账本：写入重复 id 后侧栏顶部显示「数据文件有问题：事项 id 重复：t99」，原文件未被改写（重新读取仍是坏数据）→ 截图 `.agent/todo-sidebar/workspace/badz.png`；之后已还原
- [x] 回归：`npm test` 91/91、`sh tests/cli.test.sh` 全过、三个 mod `check` 通过、真实账本 4 条（t6–t9）完好 → 命令输出（账本 seq 为 11，见「范围外与风险」注）
- [x] 需求 1：关联 agent 的事项显示在 Agents 栏该 agent 行下、且不在任何 space 组 → 截图 `.agent/todo-sidebar/workspace/agents-row-linked.png`（`○ P3 拖拽验证临时项` 在 dev5 行下）；`deriveAgents` 用真实 `agents()` 数据在 Node 里跑出 `dev5/t2 → [t8]`
- [x] 需求 1 回退：三种状态（agent 活着 / 关了但 space 在 / 关了且 space 没了）下侧栏与 Agents 栏合计恰好出现一次 → `tests/sidebar.test.js` 的不变量测试
- [x] 需求 1 互斥：`link` 与 `agent` 双向清空、`normalizeState` 保留合法字段、深拷贝 → `tests/core.test.js` 8 条 + CLI e2e 3 条
- [x] 需求 2 拖拽（第二轮）：两个 mod 的待办行都是拖动源、space 行/agent 行/「未关联」标题都是投放目标、跟随光标标签由 `window.mouse_position()` 在 render 里算 → `mod/todo-drag.js` + 两处 render 包装
- [x] 需求 2 写入：`core.moveSpace` 9 条单测（替换来源 / 多关联保留 / to=null / from=null / agent 互斥 / 幂等 / 不重复添加 / 找不到报错）、CLI `move` 2 组 e2e（含多个 `--from`）
- [x] 拖放判定矩阵：9 种「源 × 目标」组合逐一核对落在唯一分支（脚本对照）
- [ ] 需求 2 拖拽：**仍需你手动确认一次**（App 禁止指针自动化，见「范围外与风险」第一条）

## 范围外与风险

- **拖拽与点击的交互无法由我端到端验证**：`herdr-app --skill` 明确规定「Never experiment with
  pointer/key automation on the person's real display」，而 App 也没有提供注入指针事件的命令。
  我能验证的是：拖拽状态机（数据层单测 + 代码路径审查）、写入落盘（`herdr-todo agent` 的
  CLI 端到端）、以及 Agents 栏确实按 `deriveAgents` 渲染（真实截图）。**「按住一条待办拖到
  某个 agent 行上」这一步需要你手动确认一次。** 如果拖拽不生效，最可能的两处是
  `on_mouse_move` 在按住左键时是否送达、以及跨 mod 的 `mouse_up` 是否按松开位置命中。

- 范围外与延期项：
  - 【维持现状】不改 App 自带 `spaces` 的其它行为（git 分支、worktree 嵌套、拖拽排序、右键菜单）。
  - 【本任务新增边界】事项在侧栏内的**手动排序**不做：拖拽用于「换归属」（space ↔ space、space ↔ agent、→ 未关联、→ 已不存在的 space 清理），不调整事项之间的顺序。
  - 【维持现状】账本 `seq` 现在是 11 而非验证标准里写的 10：执行期在账本上验过两次
    「新增事项」后删除了那两条记录，但 id 序号不回退（回退会让已发出去的 id 被重新分配）。
    真实数据仍是 t6–t9 四条，与验证标准一致。
  - 【本任务新增边界】不做「已完成 N」里的批量操作（只能逐条点开重开）。
- 执行期偏离已批准计划的两处（均已获用户当轮指示或属实现内部选择，不改变目标与验证标准）：
  - 用户中途要求「去掉『在哪个 workspace 就默认创建到哪个 workspace』」：`createFromDraft` 不再
    回退到当前聚焦 space，未关联入口确实能建出未关联事项；因此也删掉了 `focused` 导入与
    `focusedSpaceId()` 辅助函数。
  - 侧栏 ＋ 改为「space 行悬停才出现」而非常驻：常驻的 ＋ 与上游 «+ New space there» 行
    在空 space 下上下相邻、功能完全不同却难以区分；悬停判定挂在外层 row 上，避免指针移到
    按钮上时反复进出导致闪烁。
- 关键约束：
  - mod 沙箱禁止跨目录 import：`spaces-todo/` 必须自带 `store.js` 与 `core.js` 副本。
  - App 自带 `spaces` 每次启动被整份替换，只能靠克隆件 + 运行时包装，且升级后需重新克隆。
  - 同一 mod 的 overlay 实例不能靠再次 `openOverlay` 换 props，详情窗必须每次按 `key` 新开。
- 主要风险与应对：
  1. **包装上游 `grouped`/`row` 依赖内部字段（`this.shown`、`r.w`、`collapsed`）**：App 升级改这些内部结构会让待办子行错位或报错。→ 只在最小接触面包装（`row` 的返回值追加子行、`grouped` 的返回值前插一组），包装处加注释说明依赖；`check` + 真实截图作为验证关卡；README 写明升级后需重新克隆。
  2. **详情窗的 Esc 关闭**：`kind: "window"` 下 Esc 会送到 mod（不自动关闭）。→ 详情窗用 `dialog` 形态（Esc 可关、居中、有 ✕），或 `window` + `focusable: true` + `.on_key_down` 自己处理 Esc；实现在探测两版后择一，验收时明确验证 Esc 与 ✕ 两条路径。
  3. **侧栏高频重绘**：待办子行会加宽每个 space 的渲染面积，且 `watchFolder` + 10 秒轮询会触发全窗重绘。→ 沿用现有 mod 的退避与低频兜底，不做逐帧动画；实测目视卡顿即回退到「只在账本变更时 `cx.notify()`」。

## 质量门禁

- [x] Gate: Plan Approval — 2026-11-19 14:05 用户批准。
- [ ] Gate: Final Review — 对照 `## 验证` 逐项确认后呈最终审查，获批即交付。

## 步骤

1. [x] 抽出待办派生纯函数到 `mod/spaces/todo-view.js`，先写 `tests/sidebar.test.js` 确认先红（`ERR_MODULE_NOT_FOUND`）→ 实现后 9/9 通过；函数最终名为 `deriveSidebar`
2. [x] 克隆 `spaces` 源码到 `mod/spaces/main.js`，末尾追加 init / row / grouped 三处包装（详情窗由 `herdr-todo` mod 自己提供，不需要在这里包装 render）→ `herdr-app check` 通过
3. [x] `spaces-todo/mod.json` 与同目录 `store.js` / `core.js` / `todo-view.js` 副本；`sync-core.sh` 一并生成与校验 → `npm test` 的同步测试覆盖
4. [x] 改造 `mod/main.js`：面板渲染整段删除（730→约 480 行），详情窗 + 快速记录窗两种形态；Esc 与 ✕ 两条关闭路径
5. [x] 三个脚本改完：布局只改侧栏 `spaces` 块、安装复制 `spaces-todo` 并移除旧 `tabs-todo`、`ctrl-alt-t` 退休清理
6. [x] 真实 App 验证：侧栏分组/空 space/已完成 N/坏账本报错、详情窗焦点与写入、快速记录两种预填、右侧清理
7. [x] 回归：`npm test` 59/59、CLI e2e 全过、两个 mod check 通过、账本恢复为 t6–t9
8. [x] `README.md` 按侧栏形态重写，补「侧栏克隆件」升级说明
9. [x] 需求 1（关联 agent）：`core.setAgent` 与 `setSpaces` 的双向互斥、`normalizeState` 校验、CLI `agent` 子命令、`deriveAgents`、`agents-todo` 克隆件 → 真实截图确认事项出现在 agent 行下
10. [x] 需求 2（拖拽关联）：侧栏待办行为拖拽源（4px 阈值 + `shared` 通道）、Agents 栏三种行（普通 / 子 agent / 窄栏）为投放目标、失败 toast、残留清理
11. [x] 回归：`npm test` 80/80、CLI e2e 全过、三个 mod check 通过、账本恢复为 t6–t9
12. [x] 需求 2 返工（用户 2026-11-19 反馈三点）：抽出 `mod/todo-drag.js` 契约、Agents 栏待办行也作拖动源、space 行为投放目标、跟随光标标签、`core.moveSpace` + CLI `move`；`npm test` 91/91
13. [x] 修为 `on_click` → `on_mouse_up`：`beginDrag` 写 shared 使按下时元素被替换，click 配对判定落空（用户报「拖到 agents 栏后点击不弹详情」）
