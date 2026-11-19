# activity — todo-sidebar

### [2026-11-19 14:01] Result — 侧栏可以被「运行时包装」，不必改 App 自带 spaces
- **结论/动作**：克隆 App 的 `spaces` mod 后包装 `Spaces.prototype.row` / `render`，追加的缩进待办子行、悬停＋、以及在侧栏里 `openOverlay` 打开自己的详情窗，都在真实侧栏里渲染并渲染正确（`herdr-app check` 通过，截图可见每个 space 下出现 ● P1 行与 ▸ 已完成 N）。
- **证据**：`.agent/todo-sidebar/workspace/`（探测截图）；实测命令见本次会话

### [2026-11-19 14:01] Pivot — 详情窗不能靠「再 openOverlay 换 props」
- **结论/动作**：同一 mod 第二次 `openOverlay` 时已有实例不会收到新 props（`update` 未被调用，截图显示 `item=undefined`）。改为每次以固定 `key` 打开新实例、props 在创建时给定；`mod.open` 还发现是 toggle 语义（连续调用开关交替），所以新增入口也由侧栏自己 `openOverlay`，不依赖 `mod.open`。
- **证据**：`/tmp/htprobe/probe6.png`、`/tmp/htprobe/o1.png`；6 次连续 `mod.open` 的 `overlays` 在 0/1 间交替

### [2026-11-19 14:01] Result — 探测现场已清理
- **结论/动作**：临时 mod（`spaces-probe`、`spaces-todo-probe`）已删除，`herdr-todo.json` 的 `spaces` 块已指回自带 `spaces`；`herdr-app status` 的 `errors` 为空、`overlays` 为空，`herdr-todo` mod 检查通过。
- **证据**：`herdr-app status` 输出；`grep -c "spaces-probe" layouts/herdr-todo.json` = 0

### [2026-11-19 15:01] Gate — 实现完成，呈 Gate: Final Review
- **结论/动作**：待办从右侧面板整体迁到左侧 Spaces 侧栏（`spaces-todo` 克隆件运行时包装 `row`/`grouped`），右侧 Todo 面板、tab bar 按钮与 `ctrl-alt-t` 一并移除；详情改为可拖动悬浮窗（✕ 与 Esc 两条关闭路径，实测拿到键盘焦点），快速记录只按显式预填的 space 建事项。`npm test` 59/59、CLI e2e 全过、两个 mod check 通过；验证过程中造出的 t11–t14 与 t6 上的两条测试时间线已从账本移除，真实数据仍是 t6–t9。
- **证据**：`.agent/todo-sidebar/workspace/FINALz.png`（侧栏）、`.agent/todo-sidebar/workspace/f3z.png`（详情窗）、`.agent/todo-sidebar/workspace/badz.png`（坏账本）；`mod/spaces/main.js`、`mod/main.js`、`scripts/install-layout.py`

### [2026-11-19 15:01] Pivot — 待办 ＋ 从常驻改为悬停出现
- **结论/动作**：常驻 ＋ 在空 space 下方紧挨着上游的「+ New space there」，两者功能完全不同却难以区分。改为 space 行悬停时才出现，悬停判定挂在外层 row 上（挂在内层会让指针移到 ＋ 上时反复进出、按钮闪烁）。
- **证据**：`mod/spaces/main.js` `todoRowWrap`；截图 `.agent/todo-sidebar/workspace/FINALz.png`

### [2026-11-19 15:05] Pivot — 自查发现两处安装器缺陷，待与 review 结果一并修
- **结论/动作**：派发三个独立 reviewer 循环评审期间自查：① `install.sh:12` 的毫秒备份戳在 macOS 上失效——BSD `date` 不支持 `%N`，输出字面量 `N`（实测 `[N]`），备份名变成 `...-N`，同一秒内两次安装会互相覆盖，违背「每次覆盖都先备份」的承诺；② `backup()` 把 `cp -R` 的备份放在 `mods/` 目录内，而 App 会把该目录下每个文件夹当 mod 加载——`tabs-todo.bak-20261119144427-N` 已出现在 `seen.json`。
- **证据**：`date +%N` 输出 `N`；`~/.config/herdr-app/seen.json` 中列出 `tabs-todo.bak-20261119144427-N`

### [2026-11-19 15:33] Result — reviewer #3（安装脚本与升级路径）6 项全部核实并修复
- **结论/动作**：① bash 3.2 把全角标点并进变量名（`"$X）"`）→ `set -u` 下 unbound variable，**升级路径必挂**（已用 `/bin/sh` 实测复现，`install.sh:61/109` 与 `tests/cli.test.sh:102` 三处），改 `${…}` 并加测试锁住；② 先删 `tabs-todo` 后生成布局，布局失败会留下「布局指向已删 mod」的半装状态（已复现）→ 把移除排到布局成功之后；③ `RETIRED.get(combo) == action` 会误删任意 `null` 绑定（本次引入的回归）→ 先判 `combo in RETIRED`；④ `args` 非对象时 `AttributeError`（存量）→ 先 `isinstance`；⑤ `mods/` 里旧版 `*.bak-*` 备份仍被当 mod 扫描（存量）→ 新增按本项目前缀清理；⑥ `install-layout.py` 把布局文件的符号链接换成普通文件（存量）→ 与 `install-keys.py` 同口径写到真实路径。
- **证据**：`install.sh`、`scripts/install-keys.py`、`scripts/install-layout.py`、`tests/sync.test.js`（新增全角字符守卫，注入坏行验证变红）；临时 home 里完整升级 EXIT=0、布局失败场景旧 mod 保留

### [2026-11-19 15:22] Pivot — 自查发现详情窗丢了外部变更感知
- **结论/动作**：旧右侧面板有 `watchFolder` + 10 秒兜底轮询，改写后的详情窗只在 `init` 与自身写入后重读——窗开着时 CLI 改动不会反映（侧栏却会变）。补回同口径的 `watch()` + 定时重读，并用探针 mod 实测：CLI 改状态 4 秒后窗内出现「更新于 刚刚」与新的时间线项。
- **证据**：`mod/main.js` `watch()`；截图 `.agent/todo-sidebar/workspace/detail-before.png` / `detail-after.png`

### [2026-11-19 15:20] Result — 自查修复若干：mod.json 形态、按钮 id、主题色、孤儿导入
- **结论/动作**：① `mod.json` 默认 overlay 仍是详情窗的 `window 420×520`，但 `mod.open`（`ctrl-alt-n`）唯一走它、打开的是快速记录窗——实测是一大块空白面板且 `overlay.close` 关不掉（window 不受它管），改为 `dialog 460×148`；② `button()` 的 id 用模块级递增计数器，每次重绘都变（注释却声称稳定）→ `render()` 开头归零；③ 主题回退链里的 `t.red/green/blue/yellow/peach` 都不在 `theme()` 文档列表里 → 收敛到 `ansi1`/`ansi3`/`working`/`blocked`/`done`；④ 侧栏克隆件里 `props` 导入与 `CLOSED_STATUSES` 导入无人使用（`props` 那个 guard 属于已放弃的设计）→ 删除；⑤ `deriveSidebar` 的 `pendingCount` 无人调用 → 删除；⑥ `grouped` 包装插入前置行后没补偿上游 `activeAt`，活动 space 会滚错位 → 补偿；⑦ `.gitignore` 只忽略 `mod/gpui-kit.d.ts`，新增的 `mod/spaces/` 会把 800 KB 生成物提交进仓库 → 改为不带目录的通配。
- **证据**：`mod/mod.json`、`mod/main.js`、`mod/spaces/main.js`、`mod/spaces/todo-view.js`、`.gitignore`；截图 `.agent/todo-sidebar/workspace/round1-capture2.png`

### [2026-11-19 16:15] Result — 需求 1（关联 agent）确认生效；原先的「没显示」是看了安装前的旧帧
- **结论/动作**：把旧截图放大后可以看到 `◐ P0 ICI支持ADD/DROP 刚刚` 就在 dev5 那个 agent 行下面——需求 1 一直是好的。之前判断「Agents 栏没显示」时用的是布局尚未指向 `agents-todo` 的那一帧。用真实 `agents()` 数据在 Node 里跑 `deriveAgents` 也得到 `dev5/t2 → open: [t8]`，与界面一致。t8 的测试性 agent 关联已清除、恢复成原来的 space 关联（`dev5/sp57d546…`），账本已备份。
- **证据**：`/tmp/crop-agents2.png`（放大后的 Agents 栏）；`deriveAgents` 模拟输出；`herdr-todo show t8`

### [2026-11-19 16:10] Pivot — 拖拽只有折叠态 agent 行接了投放，普通行与子 agent 行都漏了
- **结论/动作**：原实现只在 `collapsed`（窄栏图标条）那一支加了 `on_mouse_up`，正常宽度下的 agent 行、以及 `subRow` 的子 agent 行都收不到投放——也就是用户真正会用的那条路径根本没接上。抽出 `todoDrop(a, cx)` 并接到三种行上；子 agent 来自 `terminals()` 的树，未必在 `agents()` 里，space 按「agent → terminal」两级兜底查找。
- **证据**：`mod/agents/main.js` 的 `row`/`subRow` 两支与 `todoDrop`

### [2026-11-19 16:12] Pivot — 拖拽把「点击」误判成「拖拽」
- **结论/动作**：侧栏一次普通点击同样走 `mouse_down`/`mouse_up`，原先只要按下就写 `shared`，于是「点一条待办、指针恰好停在某个 agent 行上」会被关联到那个 agent。改为按下只记候选，指针位移超过 4px 才置 `active` 并写 `shared`；投放方只在 `active` 为真时才收。另外补了两道残留兜底：`grouped` 里发现 `shared` 已被投放方清空即收尾；拖拽标记 15 秒自动作废（在终端区松手时侧栏收不到自己的 `mouse_up`）。
- **证据**：`mod/spaces/main.js` `todoRow` / `todoGroupedWrap`；`mod/agents/main.js` `todoDrop`

### [2026-11-19 16:08] Pivot — reviewer #2 的 4 项：详情窗焦点与文案
- **结论/动作**：① 退出备注编辑（Esc / 取消 / 保存成功）后键盘留在已销毁的 `Textarea` 上，Esc 要按两次才关窗 → 新增 `leaveNote()`，清草稿并 `takeFocus()` 收回键盘；② 原来「等 60ms 再 focus」是固定竞速：慢机器上元素还没渲染、快机器上白等 → 改为 `is_focused()` 轮询重试（30ms × 20）；③ 载入中 / 读失败 / 事项不存在三个分支根本没有 `track_focus`，任何时机都拿不到键盘、只能靠 ✕ 关 → 抽出 `detailFrame()`，四个分支共用同一个可聚焦外框；④「已删除或归档」措辞不对——归档只是打标记，`findItem` 只在真被删除时落空 → 改成「可能刚被删除」。
- **证据**：`mod/main.js` `takeFocus` / `leaveNote` / `detailFrame`；`herdr-app check` 通过

### [2026-11-19 16:30] Pivot — 拖拽高亮复用上游 hovered 会顶出 pin 按钮
- **结论/动作**：Agents 行的 `this.hovered` 同时决定 pin 图标与「N 分钟」文本显不显示。拖拽时拿它做投放高亮，指针一进 agent 行就会把这两个控件顶出来、行高跳动。改为独立的 `this.dropAt`；`on_hover(false)` 与 render 开头（`!drag?.active` 时）各自清一次。
- **证据**：`mod/agents/main.js` 的 `row` / `subRow` / `render` 包装

### [2026-11-19 16:32] Pivot — 拖拽超时清理原先写在 render 路径上，永远不会触发
- **结论/动作**：在终端区/窗口空白处松手时，侧栏收不到自己的 `mouse_up`（命中测试按松开位置算），`shared("todo.drag")` 没人清；而这条超时判定原本写在 `grouped` 里——那一刻根本不会有重渲染，于是判定永远等不到，那条待办行一直压暗。改为放进 `init` 的 3 秒定时器，并直接以 `shared` 为准（本实例已经换了拖拽对象时，属于过去那次的残留也要清掉）。原来那个 10 秒读账本保底仍然保留。
- **证据**：`mod/spaces/main.js` `init` 的两个 `cx.timer.every`

### [2026-11-19 16:34] Result — 三条「恰好出现一次」的不变量写成测试
- **结论/动作**：`deriveSidebar` 让活 agent 的事项 hidden、`deriveAgents` 按地址收；两个函数各自的单测都过，但地址不匹配时会出现「两边都不显示」。新增两条测试：三种 agent 状态（活着 / 关了但 space 在 / 关了且 space 没了）下侧栏与 Agents 栏合计恰好一次；已完成与已归档在两边口径一致。`npm test` 79/79。
- **证据**：`tests/sidebar.test.js`

### [2026-11-19 16:40] Pivot — 折叠 agent 时待办「凭空消失」，补一条条数提示
- **结论/动作**：上游折叠一个 agent 会把它的子 agent 行一起收起，我的待办行沿用了同一处提前返回，于是折叠后挂在它上面的待办完全看不见、也没有任何计数。改为折叠时多画一行「… 还有 N 条待办」（只在有开放待办时出现）。id 用地址而不是条数：同屏可能有两个 agent 都是「还有 2 条」，用条数会撞身份。
- **证据**：`mod/agents/main.js` `withKids` / `todoCountFor` / `todoFoldedHint`

### [2026-11-19 16:38] Result — todoByAgent 每次渲染重算是平方级开销
- **结论/动作**：`withKids` 对每个 agent 与每个子 agent 各调一次 `todoLinesFor`，而后者每次都重跑 `deriveAgents`（遍历整本账本）→ agents × items。加一层只对「账本引用 + agent 地址串」都未变时有效的缓存，挂到实例上。
- **证据**：`mod/agents/main.js` `todoByAgent` / `_todoByAgent`

### [2026-11-19 16:45] Result — 安装器补 jsconfig.json，CLI 补 agent 时间线文案
- **结论/动作**：① `install.sh` 原先不复制两个克隆件的 `jsconfig.json`（编辑器类型提示用，gpui-shell 首次生成）；手工装的目录里有、脚本装的没有，会造成「新机器上打开是红的」这种只影响开发体验的差异。补进复制清单与前置检查。② CLI 的 `show` 时间线对 `agent` 条目没有中文描述，直接打印 `agent`；补成 `agent 无 → dev5/t2`。
- **证据**：临时 HOME 里完整跑一遍 `install.sh`（EXIT=0，两个目录都有 6 个文件）；`herdr-todo show t1` 的时间线输出

### [2026-11-19 16:52] Pivot — 投放失败提示用错了基线，成功时会误报
- **结论/动作**：原实现记 `before = this.todoError`，投放结束后判断 `todoError !== before` 就提示。但 Agents 栏没有任何地方显示或清空 `todoError`，上一次的失败会一直留着；下一次**成功**时它变成 `null`，`null !== 旧错误` 成立 → 弹出「关联失败」，与事实相反。改为只看本次结束后 `todoError` 是否非空（`todoLink` 成功路径会把它置 null）。
- **证据**：`mod/agents/main.js` `todoDrop`

### [2026-11-19 17:05] Pivot — 独立评审的 4 条，全部核实并修复（拖拽状态机重做）
- **结论/动作**：评审给出的 4 条都成立，前三条同一个根：**宿主不告诉脚本「左键是否仍按着」**，用「按下后位移 ≥4px」猜拖拽，必然有无法清除的残留（按下后松手在别处，本行收不到 mouse_up，`active:false` 永久留着；之后不按键划过就会被判成继续拖，再单击任意 agent 行即误关联）。改为上游 space 排序那套模型：
  - 按下即 `setShared("todo.drag", {id,title,at})`，松手位置决定动作（本行=点击开详情，agent 行=投放，别处=取消）。删掉 `active` 标记与位移阈值。
  - 新增 `AgentsTodo.todoCancelDrop()`：agent 行的 `on_mouse_down` 里作废陈旧手势。一次新的按下必然意味着上一个手势已结束，而真正从侧栏拖过来的手势是在侧栏按下的——这样「拖起来又放弃，随后点 agent 行聚焦」不会误关联（原第 2 条）。
  - 超时清理从 15 秒改到 60 秒。超时按按下时刻算，取短了会在用户还按着时中途取消（原第 3 条）；取长只是残留多留一会儿，而残留另有 on_mouse_down 这道防线。
  - 折叠父 agent 时的「还有 N 条」现在把**子 agent** 名下的也算上（原第 4 条：子 agent 的待办在折叠时两个视图都看不见且无提示）。
  - 顺带：`it.agent.address.split("/")` 加类型守卫（账本是用户可手改的 JSON，一条坏数据不该让整个侧栏渲染挂掉）。
- **证据**：`mod/spaces/main.js` `todoRow` / `todoInit` / `todoGroupedWrap`；`mod/agents/main.js` `todoCancelDrop` / `todoDrop` / `todoCountFor`；三个 mod `check` 通过、`npm test` 80/80、CLI e2e 全过

## 2026-11-19 第二轮：拖拽三点反馈 + 点击失效

用户反馈：
1. 「拖到 agent 界面之后就没法接着拖动了」
2. 「space 界面没法在 space 之间来回拖动」
3. 「拖动的时候没有待办悬浮在鼠标位置的动画」
4. （中途追加）「好像把待办拖到 agents 栏后，点击不能弹出详情了」

### 诊断

第 1、2、3 点是同一个缺口的三面：第一版只让侧栏待办行当拖动源、只让 agent 行当初放
目标。于是 agent 待办拖过去后**没有出路**，space 行接不住任何东西，跟随标签压根没写
（plan 里记的就是「没有实现」）。

第 4 点是我这一轮自己引入的：Agents 栏待办行把点击放在 `on_click` 上，而新增的
`beginDrag` 在 `on_mouse_down` 里写 shared → 所有 mod 重渲染 → 按下时那个元素被换掉
→ click 的「按下+松开配对」判定落空。侧栏一直用 `on_mouse_up` 做点击，因此没有这个
毛病。修法是与侧栏统一。

### 改动

- 新文件 `mod/todo-drag.js`：跨 mod 拖拽契约（`beginDrag`/`endDrag`/`readDrag`/
  `staleOnPress`/`learnRoot`/`dragGhost`）。`sync-core.sh` 分发到两个 mod 目录，
  `tests/sync.test.js` 加一致性 + 语法检查。
- `mod/spaces/main.js`：
  - `todoRow` 的 `groupKey` 改为来源描述 `{kind, key, spaces}`；
  - `SpacesTodo.row` 包装上加 `on_mouse_move`/`on_mouse_up` → 投放到该 space；
  - 「未关联」分组标题成为投放目标（→ 解除 space 关联）；
  - 新增 `todoDropTo` / `todoDropUnlinked` / `todoMove` / `todoDropReady`；
  - `render` 包装：根元素 `relative()`、`on_mouse_move` 学习窗口坐标矩形并在拖拽中
    `cx.notify()`（否则标签冻住）、按下时 `staleOnPress`、画跟随标签。
- `mod/agents/main.js`：待办行改为拖动源（`beginDrag`），点击从 `on_click` 改到
  `on_mouse_up`；`todoDropReady(ownKey)` 让「拿着自己的那条」不算投放目标；
  `todoCancelDrop` 恢复「按下即作废旧手势」但加 `if (!readDrag()) return` 保护；
  `render` 包装同侧栏。
- `src/core.js`：新增 `moveSpace(state, id, from, to, opts, at)` —— 一次读改写完成
  「去掉来源、加上目标」，落到 space 时顺带摘 agent。
- `src/cli.js`：`move` 子命令；`--from` 改成可重复选项（`REPEAT_OPTIONS`），支持
  孤儿组一次摘掉多个死 id。
- 脚本：`sync-core.sh` 分发 `todo-drag.js`；`install.sh` 前置检查 + 两个克隆件目录
  的复制清单。
- 测试：`core.test.js` +9（`moveSpace`）、`cli.test.sh` +2 组（`move`、多个 `--from`）、
  `sync.test.js` +1（契约副本一致性）与语法检查范围扩大 → **91/91**。

### 过程中发现并修掉的次级问题

- `dragGhost` 只在重渲染时取指针位置 → 拖起来不动标签就冻住。修：拖拽期间在根元素
  `on_mouse_move` 里 `notify()`；不拖拽时绝不 notify。
- space 行高亮原本用 `bg(t.selected)`，会把上游「当前 space」底色和排序落点线一起盖住。
  改成描边。
- 在 agent 行「拿起又放回」时会漏 `stop_propagation`，上游 `on_click` 会把 pane 聚焦
  走。补上。
- 孤儿组拖走后死 id 会残留。改为把死 id 逐个放进 `--from`，由 `moveSpace` 过滤掉。

### 复核手段（无指针自动化）

- `herdr-app --skill` 禁止在用户真实屏幕上做指针自动化，也没有注入指针事件的命令。
- 可做的：三个 mod `herdr-app check` 全过、布局切换后 `status` 的 `errors: []`、
  截图确认渲染无回归；拖放判定写了 9 种「源 × 目标」组合的脚本对照；写入路径用
  CLI e2e 覆盖。
- 仍需用户手动确认一次真实拖拽（含跟随标签与跨空间拖动）。
