# activity — todo-edit-title

### [2026-11-21 22:39] Gate — 起草完成，呈 Gate: Plan Approval
- **结论/动作**：合同已锁：补详情窗的标题编辑（数据层与 CLI 的 `setTitle` / `title` 子命令早已存在，缺的只有界面入口），侧栏双击改名与删除列为范围外。交付方式沿用前两次任务：不提 MR，Final Review 通过后等明示再提交。
- **证据**：`.agent/todo-edit-title/plan.md`

### [2026-11-21 23:20] Result — 标题编辑端到端跑通，真机取证齐全
- **结论/动作**：点详情窗标题即进编辑态（无按钮），改名回车后账本写入 `kind:title` 时间线且 `by:panel`，侧栏 3 秒内显示新标题；编辑态按一次 Esc 只退编辑、第二次才关窗。`npm test` 124/124、CLI e2e 全过、三个 mod check 通过。
- **证据**：`.agent/todo-edit-title/workspace/01-title-edit-mode.png`、`03-sidebar-after-save.png`、`05-ledger-after-save.json`

### [2026-11-21 23:22] Pivot — 界面点击坐标与截图坐标不一致，浪费了数轮排查
- **结论/动作**：`herdr-app shot` 产出 2x retina 图，而 CGEvent 点击用逻辑点且主屏顶部有 37px 菜单栏偏移；起初按截图坐标点击一直落在侧栏其他行上，误以为侧栏渲染丢行。改为「截图坐标 ÷2 + 菜单栏偏移」并先用一次点击的回读（`herdr-app status` 的 space / overlays）校准后，稳定命中。与产品代码无关，未改动任何生产逻辑。
- **证据**：`/tmp/e2e-*.png` 系列与 `herdr-app status` 回读

### [2026-11-22 00:55] Pivot — 独立评审判 NEEDS_CHANGES，推翻了「照备注编辑同构就够」的假设
- **结论/动作**：评审用探针实测出两处我漏掉的真问题：标题编辑中点「编辑备注」会让两个草稿同时活着（反向互斥只在 enterTitle 里做了一半），以及保存成功的 `takeFocus()` 会把键盘从刚点开的输入框抢回去。另三条：超长标题被 CLI 静默截断、报错落在滚动区看不见、上一轮 onDone 会清掉新一轮草稿。已全部修复，并把「进入编辑」做成两个方向都先清另一份草稿。
- **证据**：`.agent/todo-edit-title/plan.md` 步骤 8；修复后 `npm test` 133/133

### [2026-11-22 00:58] Result — 测试从「9 个变异存活」变成 16/16 拦下
- **结论/动作**：原测试靠「挨个试所有 on_click 直到命中」，先点到「取消」就退出了编辑，断言因此永远成立。改成按稳定 id 精确触发（`todo-title-<id>`、`title-save`、`title-cancel`、`note-edit`），并补了按下是否 `stop_propagation`、Input 是否真挂上、Esc 链、双向互斥、焦点令牌、上一轮 onDone 等用例；另把替身对 `children(null)` 改为与真机一样抛错。
- **证据**：`tests/mod-runtime.test.js`；16 个变异逐个复跑全部 caught

### [2026-11-22 01:05] Result — 真机发现两处只有实跑才暴露的缺陷
- **结论/动作**：① 头部 `.children([...])` 里放了 null，真机整窗渲染失败（替身以前照收）；② 审查后改动留下重复的 `leaveTitle()` 定义。均已修掉并用真 App 复验：点标题进编辑（有边框的输入框）、空标题与 250 字标题都在窗口内就地提示且编辑态保留、回车保存后账本写 `kind:title / by:panel`、侧栏 3 秒内更新。
- **证据**：`/tmp/d6c.png`、`/tmp/d7c.png`、`/tmp/d8c.png`、`/tmp/d10c.png`、`/tmp/d10s.png`

### [2026-11-22 01:13] Result — 收口复跑发现一条变异「假通过」，补测后 22/22
- **结论/动作**：呈 Final Review 前逐个复跑 22 个变异，m15（去掉 `takeFocus()` 里「已聚焦就返回」）报存活——原补丁的替换锚点早已因代码移动失效，此前那次 caught 其实是空转。重新锚定后确实存活：没有任何用例观察「拿到键盘后循环是否停下」。补一条用例（第一次 `focus()` 生效后 `calls === 1`），m15 转为 caught，其余 21 个仍全部 caught；`npm test` 138/138。
- **证据**：`tests/mod-runtime.test.js`（「窗口一旦拿到键盘，抢焦点的重试就停」）；`/tmp/m15.py`、`/tmp/runmut.sh`

### [2026-11-22 01:13] Gate — 呈 Gate: Final Review
- **结论/动作**：按 plan 的 `## 验证` 四项逐项呈报真实证据与残留风险，等用户批准。批准前不 commit / push（本任务约定不提 MR）。复验顺带纠正一处：`herdr-app check` 参数是目录路径，裸 mod 名会报 `does not exist`。
- **证据**：`.agent/todo-edit-title/plan.md` 的 `## 验证`、`workspace/01`–`13`
