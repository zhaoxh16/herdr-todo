# activity — codebuddy-open

### [2026-11-20 11:20] Gate — 起草完成，呈 Gate: Plan Approval
- **结论/动作**：用户锁定：按钮放标签栏右侧；路径取当前 space 第一个终端的实时 cwd（无则 space.folder）；**远程 space 也要支持**，且要开成 CodeBuddy 的 Remote-SSH 窗口；入口做「按钮 + space 右键菜单」；不提 MR。起草期用真实调用确认了本地打开与远程 Remote-SSH 打开都能成窗，也确认远程首次会慢且偶发 maxBuffer 失败（重试即成功），这一条直接写进了 plan 的风险与验证。需要克隆 App 自带的 `tabs` 与 `menu` 两个 mod。
- **证据**：`.agent/codebuddy-open/plan.md`「已实测的技术事实」

### [2026-11-20 13:01] Result — 验证期发现 `panes()` 不能从 `hc ls` 的 cwd 推断
- **结论/动作**：核对「按钮会打开哪个目录」时，先用 `hc ls` 的 `cwd` 喂给 `spacePath`，结果把本机 space 算成 `/Users/zxh/workspace`（终端外壳的 cwd）、把 dev3/dev6/dev8 算成 `/root`；而按钮 tooltip 实际显示 `/Users/zxh/.local/share/herdr-todo`。改用 `hc get <t>` 的 `foreground.cwd`（终端里**当前前台程序**的 cwd）重算后与 tooltip 逐一吻合，7 个 space 全部对上。结论：`panes()` 的 cwd 是前台程序的 cwd，不是外壳的初始 cwd；用错口径会得出「代码取错路径」的假结论。
- **证据**：`workspace/01-button-tooltip-local.png`、`03-button-tooltip-remote.png`、`07-tooltip-follows-active-space-local.png`

### [2026-11-20 13:01] Pivot — 右键菜单一度"点不动"，是测试手段问题而非代码问题
- **结论/动作**：用 CGEvent 右键时 `menu-todo` 常不出现，反复失败。排除代码嫌疑：左键点击定位正确（能选中 space）、同一坐标的右键偶发成功，最终定位到右键事件必须显式设置 `mouseEventButtonNumber` 与 `clickState`，否则 App 收不到。改成带这两个字段的 helper 后稳定复现。原假设「菜单注册没生效」→ 实测推翻 → 与 `mod/menu` 代码无关，本次未因此改动任何生产代码。
- **证据**：`workspace/05-menu-dev6-open.png`

### [2026-11-20 15:05] Result — ultra-review 复核完成，结论 NEEDS_CHANGES
- **结论/动作**：4 个独立发现维度（Proof Obligations + 安装部署 + mod 运行时 + 克隆件/测试有效性）并行只读评审，17 个候选合并去重后交 2 个独立 Validator 复核，确认 8 条、推翻 5 条。阻塞项 3 条 P1：远程路径含 `#`/`?` 时 `encodeURI` 不转义导致静默打开父目录；安装前置检查漏掉 7 个会被拷贝的输入（可复现半装）；逐文件拷贝非原子（`cp` 目标为目录时退出码 0 却留下无法加载的 mod）。主功能路径（本地/远程按钮、右键菜单）已实测可用。
- **证据**：`.agent/codebuddy-open/workspace/review-report.md`、`review-fixes.md`、`review-findings-{proof,install,runtime,clone}.md`

### [2026-11-21 18:55] Result — 复核反馈全部修完，变异表 10/10
- **结论/动作**：复核提出的 1 P1（`spaces-todo` 的 import 行漏 `[herdr-todo]` 标记）+ 3 P2 已全部修完。P2 里最关键的两条是「源码文本断言挡不住真坏法」——补了 `tests/mod-runtime.test.js`，把克隆件接上假宿主真的实例化并调用，断言「右键打开哪个 mod」「点 CodeBuddy 发的是什么 argv」「按钮是否置灰」。变异表复测 10 处运行时变异全部捕获；其中「删 `agents` 导入」原本漏网（`todoGroups()` 会 ReferenceError、整条侧栏渲不出，而 `herdr-app check` 照样 passed），已补一条走真实分组路径的测试。克隆件 5 处内联改动（菜单项/图标/choose 分发/target/tabs 绑定）逐一验证，全部有测试兜住。顺手补了评审报告点出的测试义务缺口：`host.opening` 在「没有目录」分支必须仍为 false（把设锁提到判空之前会让按钮永久卡死，已实测该变异被捕获）。
- **证据**：`tests/mod-runtime.test.js`（12 条）、`tests/sync.test.js`、`npm test` 119/119；`sh install.sh` 11:51 后 5 个 mod `herdr-app check` 全 passed，安装件与仓库逐字节一致
- **未决**：F-1/F-4 与 install.sh 两项最终复核由两个新派发的 reviewer 执行中（前两个复核 agent 停滞十余分钟/一天后已停止）

### [2026-11-21 19:05] Result — 两项终审均 PASS，补上 `%` 编码测试
- **结论/动作**：两个独立复核均判 PASS。F-1/F-4 用 16 组边界输入（`/ # ? % 空格 中文 emoji 反斜杠 换行 [] ~ $ & , : ; + ' \``）实测，`decodeURIComponent(pathname)` 全部严格等于输入、`hash`/`search` 恒为空；空 folder 语义与 CodeBuddy 自身 `cliArgToUri` 的规范化一致。install.sh 的单源清单成立，删文件 / `chmod 000` / 就位失败三场景实测都不改动在用目录、暂存目录清理干净。复核指出的唯一代码侧缺口（缺 `%` 用例）已补：`/data/100%` → `%25`、`/data/%20literal` → `%2520literal`，并把「把 `%25` 还原成 `%`」这个变异实测抓红。
- **证据**：`tests/codebuddy.test.js` 新增用例；`npm test` 120/120；变异表运行时 11/11、克隆件 5/5
- **未修（记入范围外）**：install.sh 就位失败时的「mod 目录整个不在」窗口、并发无锁、`backups/` 无保留策略、`machine` 名未编码——均属既有路径或非本次引入

### [2026-11-21 19:15] Gate — Final Review 通过，用户指示提交并推送
- **结论/动作**：呈出 `Gate: Final Review` 后用户指示「提交并 push 到 master」。仓库默认分支是 `main`（远端只有 `origin/main`，无 `master`），按推到默认分支处理。提交面：5 个新增文件（`mod/codebuddy.js`、`mod/tabs/`、`mod/menu/`、`tests/codebuddy.test.js`、`tests/mod-runtime.test.js`）、7 个修改文件、任务记录与证据。`gpui-kit.d.ts` 仍由 `.gitignore` 排除。不提 MR。
- **证据**：本轮 commit 与 `git push origin main` 输出
