# Plan：herdr-todo — 增加「用 Cursor 打开」按钮与菜单项

> 协议锚点：继续、恢复或修订本任务时，须加载 `planning`（由其默认加载 `t-mode`）；未经用户本轮明示禁止 commit / push / 提 MR。

- TAPD 工作项：无
- 工蜂 issue：无
- 是否提交 MR：否
- MR 目标分支：无
- 开发分支：无

## 当前状态

- 状态：ready_for_final_review
- 当前步骤：全部实现与验证完成，等待 Gate: Final Review
- 当前在途：无
- 下一步：呈 Gate: Final Review

## 现状与目标

- **现状问题**：`mod/codebuddy.js:51` 的 `openInCodeBuddy` 是当前唯一的「从 Herdr 跳到编辑器」出口，入口只有两处——`mod/tabs/main.js:193` 的标签栏按钮与 `mod/menu/main.js:67` 的 space 右键菜单项。本机日常还有一半时间用 Cursor，目前只能手工去 Cursor 里 Open Folder 或敲 `cursor <dir>`；远程 space 更费事（要手动 Remote-SSH 连机器再开目录）。
- **目标结果**：
  - 标签栏尾部在 `CodeBuddy` 按钮旁多一个 `Cursor` 按钮，点击用 Cursor 打开**当前 space 的目录**。
  - space 右键菜单在「用 CodeBuddy 打开」之下多一条「用 Cursor 打开」，作用于被右键的那个 space。
  - 本机 space → 本机 Cursor 窗口打开该目录；远程 space → Cursor 的 Remote-SSH 窗口（`vscode-remote://ssh-remote+<机器名><路径>`），标题形如 `SQLEngine [SSH: dev8]`。
  - 路径、空目录语义、失败提示、连点去重与 CodeBuddy 完全同一口径——同一个 space 上两个按钮打开的是同一个目录。
- **价值排序**：**点了真能开对目录 > 不误开 / 不静默失败 > 不卡界面 > 少写代码**。

### 已实测的技术事实（起草期关闭的假设）

| 事实 | 证据 |
|---|---|
| Cursor 3.31.10 已安装，bundle 内 CLI 在 `/Applications/Cursor.app/Contents/Resources/app/bin/cursor`，在 `env -i PATH=/usr/bin:/bin:...` 下 `--version` 正常、退出 0（与 mod 的 `exec` 环境同口径） | 本会话实测 |
| 本地打开：`cursor <dir>` 在 Cursor 未运行时会启动并建窗；**已在运行时对第二个目录调用也开出了新窗口**（窗口标题从 `cursor-probe-a` 变为 `cursor-probe-b`） | `/tmp/cursor-probe-a`、`.../b` 实测；`workspaceStorage/*/workspace.json` 记录 `file:///tmp/cursor-probe-b` |
| 远程打开：`cursor --folder-uri "vscode-remote://ssh-remote+dev8/data/workspace/SQLEngine"` 退出 0，`resolveAuthority(ssh-remote)` 8 秒内返回隧道，dev8 上自动装好 `~/.cursor-server/bin/linux-x64/<commit>` 并连上 | Cursor `exthost.log` 15:33:35–43、dev8 上 `cursor-server` 进程与目录时间戳；工作区记录 `vscode-remote://ssh-remote%2Bdev8/data/workspace/SQLEngine` |
| Cursor 的 remote-ssh 扩展（`anysphere.remote-ssh` 1.1.19）authority 前缀是 `ssh-remote`，与 CodeBuddy 的 `codebuddy-remote-ssh` 不同 | `~/.cursor/extensions/anysphere.remote-ssh-1.1.19/dist/main.js` 里 `REMOTE_SSH_AUTHORITY="ssh-remote"` |
| `~/.ssh/config` 已有 dev / dev2–dev8 别名 | 本会话 `grep "^Host "` |
| 上游 `tabs`/`menu` 正文里没有 `cursor` 这个词，`id("codebuddy-open")` 是唯一占用的 id → 新 id 取名 `cursor-open` 无冲突 | `grep -ni cursor mod/tabs/main.js mod/menu/main.js` 无输出 |

## 改动

核心判断：Cursor 与 CodeBuddy 的差异只有**三个常量与一处 authority 拼法**（CLI 路径、按钮文字、菜单文字、`ssh-remote` vs `codebuddy-remote-ssh`），其余（目录选取、URI 编码、空目录语义、通知、`opening` 锁、失败重试提示）逐字相同。所以不复制第二份打开模块，而是把 `mod/codebuddy.js` 泛化成一个「用一个编辑器打开」的模块，由**单一事实源**决定两台编辑器各自的差异。

1. **`mod/codebuddy.js` → 泛化（保留文件名，避免改动 `[herdr-todo]` 标记与既有测试面）**
   - 现状：`CODEBUDDY_CLI`、`REMOTE_AUTHORITY` 是两个写死的导出；`openInCodeBuddy(host, {space, path, panes})` 只认 CodeBuddy。
   - 改为：新增 `EDITORS` 常量表（唯一事实源），每项 `{ key, name, cli, authority }`：
     - `codebuddy`: name `CodeBuddy`, cli `/Applications/CodeBuddy CN.app/Contents/Resources/app/bin/code`, authority `codebuddy-remote-ssh`
     - `cursor`: name `Cursor`, cli `/Applications/Cursor.app/Contents/Resources/app/bin/cursor`, authority `ssh-remote`
   - `remoteUri(editor, machine, path)`：authority 从表里取。`CODEBUDDY_CLI` / `REMOTE_AUTHORITY` 仍保留为从表派生的导出，既有测试与 README 引用不变。
   - 新增 `openInEditor(host, editorKey, {space, path, panes})`：原 `openInCodeBuddy` 的全部逻辑；`openInCodeBuddy` 保留为 `openInEditor(host, "codebuddy", …)` 的薄包装（`tabs`/`menu` 里既有调用点不动）。
   - `host.opening` 锁改为**每个编辑器一个**（`host.opening = { codebuddy: false, cursor: false }`，初始化在 `tabs` 的 `init` 里，由 `EDITORS` 派生）。理由：两个按钮是两种独立动作，Cursor 正在开 dev8 时点 CodeBuddy 不该被吞；同一按钮连点仍只开一次（`tests/codebuddy.test.js` 既有断言按 key 重新表达）。
   - 不做：不抽公共 `notify` 文案模板，两处文案不同（`name` 直接进标题）。

2. **`mod/tabs/main.js`（末尾扩展段，全部在 `[herdr-todo]` 分界之下）**
   - `init` 里 `this.opening = false` → `this.opening = openingState()`（从 `EDITORS` 派生的 `{key: false}`）。
   - 抽出 `editorButton(t, { id, name, editor, ready, title, onOpen })`，`codebuddyButton` 与新的 `cursorButton` 各调一次；两个按钮渲染在 `+` 之后、`Files` 之前，顺序 `CodeBuddy`、`Cursor`，中间 gap 沿用同一 h_flex。
   - 新按钮 id `cursor-open`，文字 `Cursor`，tooltip 与置灰判据和 CodeBuddy 完全同一逻辑（`ready = path !== null && path !== undefined`）。
   - 依赖的上游内部结构不变（仍是末尾包装 `render`）。

3. **`mod/menu/main.js`（内联改动，全部带 `[herdr-todo]` 标记）**
   - `items()` 的 `space` 分支在 `["用 CodeBuddy 打开", …]` 之下加 `["用 Cursor 打开", "cursor", { space: tg.id }]`。
   - `menuIcon()` 加 `command === "cursor" → "monitor"`（`mods/workspace-chrome/monitor.svg` 已存在；`file-text` 已被 codebuddy 占用）。
   - `choose()`：`target` 的取值条件由 `it[1] === "codebuddy"` 扩成 `it[1] === "codebuddy" || it[1] === "cursor"`；分发改为 `openInEditor(this, it[1], {…})`。
   - 文件头「重新克隆后要贴回的位置」清单从 4 条变 5 条（菜单项两条）。

4. **`scripts/sync-core.sh` + `tests/sync.test.js`**
   - 同步脚本不变（仍只同步一份 `codebuddy.js`）；`echo` 文案不改。
   - `sync.test.js` 的克隆件标记断言：把「space 分支应有一条 CodeBuddy 菜单项」扩为 codebuddy 与 cursor 两条都在；`choose()` 分发断言改为匹配 `openInEditor`。

5. **`tests/codebuddy.test.js`**：新增/改写用例，钉住「两台编辑器共用同一口径、只有差异三者不同」：
   - `EDITORS` 表里 cursor 的 cli/authority 正确；`remoteUri(EDITORS.cursor, "dev8", p)` → `vscode-remote://ssh-remote+dev8/…`，codebuddy 仍是 `codebuddy-remote-ssh`。
   - 远程 cursor 的 argv 形状；本地 cursor 直接传目录。
   - 锁按编辑器独立：cursor 在飞时 codebuddy 能开、同 key 连点仍只发一次 exec。
   - 既有 `spacePath` / 编码 / 空 folder / 失败通知用例保留（改调 `openInEditor` 或保留 `openInCodeBuddy` 包装，二者都要覆盖）。

6. **`tests/mod-runtime.test.js`**
   - `menu-todo` 用例：`clickUntilOpens` 对着 `["--folder-uri", "vscode-remote://ssh-remote+dev8/data/ws"]` 能命中；本机用例对 cursor 再跑一遍（用 `/repo/sub` 打开）。
   - `tabs-todo` 渲染用例：按钮文字里同时有 `CodeBuddy` 与 `Cursor`；空 folder 时两者都不显示「还没有可打开的目录」。

7. **`README.md`**
   - 「用 CodeBuddy 打开」一节扩成「用编辑器打开」，写明两个按钮/两条菜单、Cursor 的远程写法（`ssh-remote`）、首次连远程会装 Cursor Server。
   - 「克隆件」一节与「已知边界」里的 `mod/codebuddy.js` 说明补上 `EDITORS` 表（换 Cursor 安装位置改哪一项）。
8. **`install.sh`**：只在 `MOD_MANIFEST` 的说明文字里体现（`标签栏里的编辑器按钮`、`space 右键菜单`），文件清单不变（没有新文件）。

## 验证

- [x] **两台编辑器各自的打开参数正确** → `tests/codebuddy.test.js` 14→16 条：`EDITORS` 表逐项断言 + 本机/远程各跑两台；变异「cursor authority 改成 codebuddy」捕获 5 条红。
- [x] **远程 authority 不串台**（Cursor 不能用 codebuddy 前缀，反之亦然）→ 单测断言两台 authority 不相等 + argv 形状；变异验证见上。
- [x] **锁互不干扰、同按钮连点不多开** → 单测「连点只发一次 exec」「两台编辑器的锁互不干扰」「宿主没有锁表时惰性创建」；变异「共用一把锁」捕获 3 条红。
- [x] **右键菜单第二条真的分发到 Cursor，且不落到 `run("cursor")`** → `tests/mod-runtime.test.js` 的 `clickUntilOpens` 加 cmd 限定（本机两条参数相同，靠 CLI 区分）；变异「删 Cursor 菜单项」红 2 条、「分发落空走 run()」红 2 条。
- [x] **标签栏两个按钮都在、各自打开对的编辑器** → 渲染用例断言两个按钮文字；新增「真的按下按钮」用例（`RECORD_KIT` 记录 on_click）断言每个按钮发出自己 CLI 的 exec；变异「两个按钮都开 CodeBuddy」红 1 条。
- [x] **回归全绿** → `npm test` **234/234**（基线 227；一条断言被加强而非放宽：克隆件标记扫描从只查 `codebuddy` 扩为 `codebuddy|cursor|openInEditor`）。
- [x] **真实产物**：`sh install.sh` 后 `herdr-app check` 对 `tabs-todo` / `menu-todo` / `spaces-todo` / `agents-todo` / `herdr-todo` 全部 passed；安装件与仓库 `cmp` 四个文件全部 SAME。
- 按用户要求，不做本机真实点击与截图。

## 范围外与风险

- **范围外与延期项**：
  - 不做全局快捷键、不做「已开着同一目录时聚焦已有窗口」（Cursor CLI 自身行为，不拦）。
  - 不做编辑器可配置（`EDITORS` 表里改代码即换；暂不加设置项）——【维持现状】。
  - 不把 CodeBuddy 按钮/菜单改名或挪位置——【维持现状】。
  - 本机真实点击与截图验证（用户明确要求不做）——【本任务新增边界】，改用 mod-runtime 的按钮点击用例覆盖同一个可观察行为（发出的 CLI 与 argv）。
- **主要风险与应对**：
  1. **Cursor 的 `ssh-remote` authority 是会变的内部约定**。缓解：拼法集中在 `EDITORS` 表一项里；README 已知边界写明「换版本后远程打不开先看这张表」。残留：真实远程打开未在本任务内复验（起草期实测过 3.31.10）。
  2. **Cursor 远程首次连接会装 server 且偶发超时**（起草期实测首次约 8 秒 + 自装 `~/.cursor-server`）。缓解：失败通知沿用「可以再点一次」；`opening` 锁防连点。
  3. **`host.opening` 从布尔改成对象**：已由 `openInEditor` 惰性初始化兜住菜单视图（它没有 init），并有单测钉住。

## 质量门禁

- [x] Gate: Plan Approval — 用户「批准，不需要本机真实点击和截图测试」。
- [ ] Gate: Final Review — 批准最终结果、对照已签验证标准、提交准备状态。

## 步骤

1. [x] 泛化 `mod/codebuddy.js`（`EDITORS` 表 + `remoteUri(editor, …)` + `openInEditor` + 按编辑器的锁 + 惰性建锁表）→ 少了 `openInCodeBuddy` 薄包装：三个调用点都在本任务内，留着只是多余的一层。
2. [x] 改 `mod/tabs/main.js`：`init` 的锁表、`editorButton` 抽取、`Cursor` 按钮（id `cursor-open`）→ 两个按钮共用同一渲染函数，只是参数不同。
3. [x] 改 `mod/menu/main.js`：菜单项 + `menuIcon` 分支 + `choose()` 分发 + 文件头贴回清单 → 5 处内联改动全部带 `[herdr-todo]` 标记。
4. [x] `sh scripts/sync-core.sh` 同步副本 → 三个文件 `cmp` SAME。
5. [x] 写/改 `tests/codebuddy.test.js`（16 条：cursor 参数、authority 不串台、锁独立、惰性锁表、既有用例保绿）。
6. [x] 改 `tests/sync.test.js` 与 `tests/mod-runtime.test.js`（菜单第二项、按钮文字、按钮真实点击、`clickUntilOpens` 加 CLI 限定）。
7. [x] 改 `README.md` 与 `install.sh` 的说明文字。
8. [x] `npm test` 234/234；`sh install.sh`；5 个 mod 的 `herdr-app check` 全 passed；安装件与仓库 `cmp` SAME。变异验证 6 处全部被捕获（authority 串台 / 共用锁 / 删菜单项 / 分发落空 / 删按钮 / 两个按钮接错）。
   - 过程中误用 `git checkout -- mod/menu/main.js` 回退变异时把本任务的改动一并冲掉，已重新逐处应用并用 `npm test` 复验，最终状态正确。
