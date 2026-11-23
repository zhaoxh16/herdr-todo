# Plan：herdr-todo — 待办标题支持在界面上修改

> 协议锚点：继续、恢复或修订本任务时，须加载 `planning`（由其默认加载 `t-mode`）。未经用户本轮明示禁止 commit / push / 提 MR。

- TAPD 工作项：无
- 工蜂 issue：无
- 是否提交 MR：否
- MR 目标分支：无
- 开发分支：无

## 当前状态

- 状态：in_progress
- 当前步骤：步骤 1–8 完成（两轮独立评审；第二轮复核的 D1 残留、N1、错误位置断言、TITLE_MAX 越界均已处理；最终复跑变异时补上一条焦点重试的覆盖空洞）
- 当前在途：步骤 9 — Gate: Final Review 已呈，等用户批准
- 下一步：等用户对 Gate: Final Review 的明确批准；批准后置状态 done。批准前不 commit / push
- 残留风险：本环境的 UI 自动化点击已失效（连侧栏行都点不动），第二轮修复的真机交互复验只做到「窗口渲染正常」，点击链路的证据来自代码探针与单测，见「范围外与风险」

## 现状与目标

- 现状问题：详情窗（`mod/main.js` 的 `renderDetailWindow` → `header(item.title)`）把标题当只读文本显示，`renderDetail` 里状态、优先级、关联、归档、备注都有编辑入口，唯独**标题没有**。数据层与 CLI 早就支持：`src/core.js` 的 `setTitle`（写过校验 `cleanTitle`、`TITLE_MAX=200`、时间线 `kind:"title"` 记录 from/to）与 `src/cli.js` 的 `title <id> <新标题>` 子命令都在，时间线渲染也已有 `card "title" → 标题改为「…」` 分支（CLI 与 mod 两侧各一份）。结果是用户想纠正一条事项的措辞，只能开终端敲 `herdr-todo title t7 新标题`。
- 目标可观察结果：**点详情窗头部的标题文字本身**（不加按钮）就切换成单行输入框（预填当前标题、直接可打字、回车保存、Esc 取消），保存后：
  - 账本里该事项的 `title` 改变、`updated` 刷新、时间线多一条 `{"kind":"title","from":旧,"to":新,"by":"panel"}`；
  - 详情窗头部立即显示新标题，侧栏（`spaces-todo`）与 Agents 栏（`agents-todo`）里那一行在秒级内跟着变；
  - 空标题（只有空白）被拒绝并提示，不写盘；标题恰好是 `-h` / `--space` / 以 `-` 开头等文本也能原样保存。
- 价值排序：**不写坏数据 > 改完立刻可见 > 入口明显 > 少点几下**。与既有备注编辑同一套交互与失败处理，不另造模式。

### 已实测的技术事实（起草期关闭的假设）

| 事实 | 证据 |
|---|---|
| 写入路径唯一：mod 里任何写都要走 CLI（`mod/store.js` 的 `command()`，参数布局 `[flags] <sub> -- <位置参数>`），`--by panel` 与 `--file=` 已固定 | `mod/store.js:88-118` |
| `InputState.new({placeholder,value})` 可在事件处理器里建、有 `value()`/`set_value()`/`focus()`/`on("submit")` | `mod/gpui-kit.d.ts:21380-21426` |
| 备注编辑器已建立「点按钮 → 建草稿状态 → 渲染输入框 → 保存/取消/Esc 收回」的完整先例，标题可复用同一形状 | `mod/main.js:557-607`、`detailFrame` 的 Esc 分支 `mod/main.js:445-455` |
| `setTitle` 已有单测（只在变化时记时间线、空白标题抛错），CLI `title` 无专项 e2e | `tests/core.test.js:112-128`、`tests/cli.test.sh`（无 title 段） |
| `tests/mod-runtime.test.js` 已能在 Node 里给 mod 换假宿主、实例化并调用 `render`，用记录型替身断言可观察投影 | `tests/mod-runtime.test.js:75-140, 320-351` |
| 基线全绿：`npm test` 120/120 | 本轮实测（2026-11-21） |

## 改动

1. **`mod/main.js`（详情窗）**：新增标题编辑态，与备注编辑态同构但不混在一起。
   - 新字段：`this.titleEditingId`、`this.titleDraft`（备注编辑同理已有 `noteEditingId`/`noteDraft`）。
   - 头部：`header()` 目前只接 `title` 字符串；改为标题文字本身可点——点击（`on_click`）即切到编辑态。**不加任何「改标题」按钮**。非编辑态标题带 hover 底色与 tooltip「点击修改标题」，让可点这件事在点之前就看得出来；编辑态下标题行换成 `Input.new(this.titleDraft)`（预填当前标题、自动拿焦点）+ 「保存 / 取消」。
     点击区域不是 `div` 而是可接收点击的元素：标题文字的 `div` 上直接 `on_click` 即可，`header` 的其它元素（更新于…、✕）不动。**必须同时在标题上 `on_mouse_down` 里 `cx.stop_propagation()`**：window 形态的拖动由任意未被阻止的按下发起（`mod/main.js:639-641` 的既有注释），不拦住按下，点标题会变成拖窗口、`on_click` 收不到。由于 `header()` 在 `renderDetailWindow` 里被多个分支调用，只给详情主分支传编辑态，载入中/读失败/事项不存在三个分支维持原样（那里的标题是「待办详情」之类固定文本，不可编辑）。
   - 保存：`commitTitle(item.id)` → `this.mutate(["title", item.id, text])`，即 `command()` 发出 `--json --by panel --file=… title -- <新标题>`——标题是 `--` 之后的位置参数，`-h`/`--space` 不会被当成选项（与快速记录窗传标题的方式一致，见 `mod/main.js:296-301`）。
   - 失败处理：沿用 `mutate` 的语义——写失败时 `writeError` 显示在窗口里、**不**收起编辑态，保留用户输入；写成功才 `leaveTitle()`（清草稿、把键盘收回窗口）。空标题由 CLI 拒绝（`标题不能为空`），提示原样显示在窗口内。
   - Esc 优先级：`detailFrame` 的 `on_key_down` 先处理备注编辑；扩展为「先退标题编辑、再退备注编辑、最后关窗」——两个编辑器不会同时存在（进入一个时退出另一个）。
   - 渲染期不能建输入状态（宿主限制），所以 `InputState.new` 只在**点击标题的回调**里调用，与备注的「编辑备注」一致。
2. **`tests/cli.test.sh`（CLI e2e 补一段）**：`title` 子命令目前没有命令行层测试。补：
   - 正常改名后 `show --json` 的 `title` 改变、时间线最后一条 `kind=title` 且 `from/to` 正确、`by` 为执行者；
   - 空白标题退出码非 0 且账本不变；
   - 标题为 `-h` / `--space` 时原样落盘（`--` 之后位置参数）。
3. **`tests/mod-runtime.test.js`（详情窗行为）**：用现有 `loadMod` + 记录型替身加载 `mod/main.js`（此前没有测试覆盖它），断言可观察行为：
   - 详情态渲染的头部有 title 文本，点击它（替身记录到的点击回调被调用）后渲染出输入框与「保存 / 取消」，且**不存在**「改标题」按钮；
   - 点「保存」→ 替身记录到的 `exec` argv 是 `[... , "title", "--", "<新标题>"]`，且标题文本落在 `--` 之后（含 `-h` 这种标题）；
   - `titleDraft` 写入的文本与传给 CLI 的文本一致（用户输入直通）；
   - 写失败（让替身 `exec` 返回 code 1）时状态不被当作成功：`writeError` 有值且编辑态仍在。
4. **`README.md`**：「用法 → 侧栏与详情窗」列出标题可改；命令行示例旁说明界面用的是同一条 `title` 命令。

不改 `src/cli.js`（标题能力已完整）；不改 `mod/spaces`、`mod/agents`（侧栏与 Agents 栏通过 `watchFolder`/10s 轮询自动刷新，`mod/spaces/main.js:720-755`）。

**关于 `src/core.js`（如实记录一次来回）**：修复 D2 时曾把 `TITLE_MAX` 改成 `export const`，复核指出这越过了已批准的范围（「不改 `src/core.js`」），且该常量是界面输入上限、不是数据层语义。已撤回，`src/core.js` 回到零改动（哈希仍是 `ed478b72…`）；改为在 `mod/main.js` 顶部定义本地 `const TITLE_MAX = 200`，并由新增的 `tests/sync.test.js` 用例校验两侧数值一致——改一处漏改另一处，测试直接红。

## 验证

- [x] **CLI 层行为**：`title` 改名成功 / 空白拒绝 / `-h` 原样落盘 → `sh tests/cli.test.sh`（新增段）+ `tests/core.test.js` 既有 setTitle 用例保持绿 → `sh tests/cli.test.sh` 输出 `ALL CLI TESTS PASSED`（含 title 段：改名前后快照对比、时间线恰好 +1 且是本次变更、`updated` 不倒退、`-h` 原样落盘）。
- [x] **界面写路径**：点「保存」发出的命令形状正确（标题在 `--` 之后、`--by panel`、`--file=` 指向账本）且失败时保留输入 → `npm test` 的 `tests/mod-runtime.test.js` 记录型替身断言 argv 与状态 → `tests/mod-runtime.test.js` 29 条（原 4 条 + 25 条），`npm test` 138/138；22 个变异逐个复跑全部 caught。
- [x] **真实 App 端到端**：在真实账本上打开一条待办的详情窗，**直接点标题文字**（不加按钮）确认进入编辑态、窗口未被拖走；改标题并保存 → `herdr-todo show <id> --json` 的 `title`/`updated`/时间线末条随之改变（`by: "panel"`），详情窗头部与侧栏那一行显示新标题 → `herdr-app shot` 截图 + CLI 输出存 `.agent/todo-edit-title/workspace/`（先用临时事项验证，验证后删除该临时事项并让账本回到验证前状态）→ 第一轮真机取证齐全（`workspace/01`–`06`，账本 t23 `{"kind":"title","from":"临时标题测试A","to":"新标题来自界面编辑","by":"panel"}`，侧栏 3 秒内跟上，Esc 一次退编辑）；修复后的第二轮真机取证为 `workspace/07`–`13`（输入框有边框、空标题与 250 字标题就地提示且编辑态保留、保存后头部与侧栏更新，账本 t24 `{"kind":"title","from":"验证临时-标题编辑","to":"标题已改好","by":"panel"}`）。**第二轮未能用点击复验交互**：本环境 CGEvent 点击整机失效（见范围外风险），点击链路证据来自生产代码探针 + 单测。临时事项 t21/t23/t24 均已 cancelled+archived，用户事项 t22 未被改动。
- [x] **回归全绿**：`npm test`（基线改动前 120 条，不得删除或放宽既有断言；最终 137 条全过）、`sh tests/cli.test.sh`、`scripts/sync-core.sh` 哈希校验、`herdr-app check` 对 `herdr-todo` / `spaces-todo` / `agents-todo` / `tabs-todo` / `menu-todo` 五个目录均 exit 0，安装件（`mod/main.js`、`mod/core.js`、`mod/store.js`、`mod.json` 及 spaces/agents/tabs/menu 各文件）与仓库逐字节一致 → 最终复跑：`npm test` 138/138、CLI e2e 全过、`sync-core.sh` 输出 `sha256 ed478b72756e…`（`src/core.js` 零改动）。注意 `herdr-app check <名字>` 认的是目录路径，传裸名字会报 `does not exist`，须传 `~/.config/herdr-app/mods/<name>`。

## 范围外与风险

- 范围外与延期项：
  - 侧栏/Agents 栏的待办行**双击就地改名**【维持现状】：侧栏行的按下即拖拽手势（`mod/todo-drag.js`）与双击判定会互相干扰，属于独立交互设计，留待后续单独交付。
  - 事项**删除**（账本里没有 delete，只有归档）【维持现状】。
  - 批量修改、修改任意历史时间线条目【维持现状】。
- 主要风险与应对：
  - **Esc 与输入框抢键盘**：详情窗自己接 Esc 关窗。备注编辑已有「先退编辑再关窗」的先例；标题编辑接入同一判断链，且进入标题编辑时先退出备注编辑，避免两个草稿同时存活。验证：`tests/mod-runtime.test.js` 断言编辑态渲染，真实 App 手动按一次 Esc（截图 + 窗口仍在）。
  - **点标题被当成拖窗口**：详情窗是 `kind:"window"`，未阻止的按下会发起拖动，`on_click` 就收不到（`mod/main.js:639-641` 已有的坑）。标题元素上补 `on_mouse_down` + `stop_propagation`，真实 App 里点一次标题确认进编辑态、且窗口没被拖走。
  - **标题里的特殊文本被当成选项**：`command()` 已把位置参数放在 `--` 之后；测试用 `-h`、`--space x` 作标题断言 argv 形状与落盘结果。
  - **写成功但显示不刷新**：`mutate` 写完立刻重读，侧栏走 `watchFolder` + 10 秒兜底（既有机制）。真实 App 用例里同时检查详情窗与侧栏，若侧栏未在 3 秒内跟上，则记为残留风险并如实报告。
  - **本环境 UI 自动化点击失效（残留风险，未消除）**：第一轮真机验证时点击正常，完成了「点标题进编辑 / 空标题与超长标题就地提示 / 回车保存写入 `kind:title` / 侧栏秒级更新 / Esc 一次退编辑」的取证。第二轮修复后，CGEvent 点击在整机范围内都不再生效（连侧栏的 space 行都点不动，鼠标坐标确实移动了、Herdr 在前台），因此**第二轮修复的交互复验改为**：真机只确认窗口正常渲染（无 «This view could not be re-rendered»）；点击链路改用生产代码探针（加载真实 `mod/main.js`、驱动真实事件回调）与 28 条单测覆盖。用户在该机器上手动点一次即可补上最后一环。

## 质量门禁

- [ ] Gate: Plan Approval — 批准这个 `plan.md` 后才能开始执行。
- [ ] Gate: Final Review — 对照 `## 验证` 呈最终审查。
- [ ] Gate: Code Review — 理由：改动触及用户输入的边界校验（空标题、特殊字符）与 UI 键盘/Esc 优先级，落在真实产品代码上；由 `tdsql-cr` 独立评审后并入 Final Review 的证据。

## 步骤

1. [x] `tests/cli.test.sh` 补 `title` 段（正常改名 + 空白拒绝 + `-h` 原样落盘），对齐 CLI 现有能力 → 三段全过；`updated === 时间线末条 at` 断言与 core 的 stamp 语义一致
2. [x] `tests/mod-runtime.test.js` 为 `mod/main.js` 建加载与记录型替身骨架（`loadMod(".", …)`、`RECORD_KIT`/`RECORD_BASE`），四条用例先红：消息「不该出现改标题按钮」绿、「点标题进编辑态」等三条因 `titleEditingId` 不存在而失败 → `node --test tests/mod-runtime.test.js`（13 pass / 3 fail）
3. [x] 实现 `mod/main.js` 的标题编辑（`titleEditingId` / `titleDraft` / 标题文字可点 / `commitTitle` / `leaveTitle` / Esc 链）→ 第 2 步 4 条转绿；另用两处变异（保存时丢标题文本、写失败也收起编辑器）确认用例真能捕获
4. [x] `npm test` + `sh tests/cli.test.sh` 全过 + `sync-core.sh` 重跑后哈希 `3a1e2d09…`（`src/core.js` 仅新增 `TITLE_MAX` 导出，见「改动」末段的说明）
5. [x] `sh install.sh` 安装 → `herdr-app check` 对 `herdr-todo` / `spaces-todo` / `agents-todo` 三个 mod 均 passed，安装件与仓库逐字节一致
6. [x] 真实 App 端到端：点标题 → 输入框预填当前标题 → 改名回车 → 账本 t23 时间线 `{kind:title, from:临时标题测试A, to:新标题来自界面编辑, by:panel}`，侧栏 3 秒内显示新标题；编辑态按一次 Esc 只退编辑、第二次才关窗 → `workspace/01-…05-…`
7. [x] `README.md` 补「点标题即编辑」与 Esc 说明、命令行补 `title` 示例
8. [x] Gate: Code Review（`tdsql-cr`，两轮）：
   - 第一轮 `NEEDS_CHANGES`：D1 编辑器可共存 / D2 超长标题静默截断 / D3 报错不可见 / D4 抢焦点 / D5 onDone 吞新草稿 + 「测试大半测不出」→ 全部修复。另发现并修掉两处真缺陷：`header` 的 `children()` 收到 null 导致真机整窗渲染失败、`leaveTitle` 重复定义。
   - 第二轮复核：D2/D4/D5 关闭、D1 互斥关闭；剩余 N1（本地拦截提示退出编辑后不清）、「错误行挪回滚动区测不出」、「`TITLE_MAX` 越界」三项 → 已修：`titleProblem` 与 `writeError` 分开且退出编辑即清、错误行加 `id="title-error"` 并由替身断言父容器、`src/core.js` 撤回 export 改 mod 侧常量并加一致性测试。
   - 变异验证：22 个变异逐个复跑全部 caught（评审前只拦 4 个）。最终复跑时发现 m15（去掉 takeFocus 里的「已聚焦就返回」）存活——原补丁锚点已失效，此前那次「caught」实为空转；重新锚定后补一条用例（`focus()` 生效后循环即停，不再反复调用），22/22 恢复全 caught。
   - 最终：`npm test` 138/138、CLI e2e 全过、`src/core.js` 零改动（`ed478b72…`）、五个 mod check 通过、安装件与仓库逐字节一致
9. [ ] Gate: Final Review
