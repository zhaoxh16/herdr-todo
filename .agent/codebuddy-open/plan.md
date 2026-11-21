# Plan：herdr-todo — 用 CodeBuddy 打开当前 workspace 的路径

> 协议锚点：继续、恢复或修订本任务时，须加载 `planning`（由其默认加载 `t-mode`）。未经用户本轮明示禁止 commit / push / 提 MR。

- TAPD 工作项：无
- 工蜂 issue：无
- 是否提交 MR：否
- MR 目标分支：无
- 开发分支：无

## 当前状态

- 状态：done
- 当前步骤：全部完成，已提交并推送（两项终审 PASS，`npm test` 120/120）
- 当前在途：无
- 下一步：无（任务关闭）

## 现状与目标

- 现状问题：Herdr 里一个 space 就是一个工作目录，但**看完代码想去编辑器改**时没有出口——要么回终端手敲路径，要么从 Finder 一层层找。本机 8 个 space 里 6 个在远程机器（dev3–dev8，路径如 `/data/workspace/SQLEngine` 只存在于远端），手敲路径尤其费劲。本仓库已把待办长进侧栏、把详情做成悬浮窗，但「从 Herdr 跳到编辑器」这一步始终是手工的。
- 目标结果：
  - 标签栏（`tabs` 那一行）右侧出现一个 CodeBuddy 按钮，点击用本机 CodeBuddy CN 打开**当前 space 的目录**。
  - 本机 space → 本地 CodeBuddy 窗口（folder = 该 space 的目录）。
  - 远程 space → CodeBuddy 的 Remote-SSH 窗口（folder = `codebuddy-remote-ssh+<机器名>` 上的同名路径），窗口标题形如 `SQLEngine [SSH: dev8]`。
  - space 行的右键菜单里加一条「用 CodeBuddy 打开」，作用于被右键的那个 space。
  - 路径取**该 space 第一个终端的实时 cwd**（没有则 `space.folder`）——切 tab、切 pane 时按钮指向的目录不变。
- 价值排序：**点了真能打开 > 不误开错目录 > 不卡住界面 > 不弹失败也无声**.

### 已实测的技术事实（起草期关闭的假设）

| 事实 | 证据 |
|---|---|
| CodeBuddy CN 是 VS Code 1.106.1 fork，bundle 内 CLI 在 `/Applications/CodeBuddy CN.app/Contents/Resources/app/bin/code`，**不依赖用户 PATH**（mod 的 `exec` 用的是 `/usr/bin:/bin:...`） | 在 `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` 下 `--version` 正常；`hc exec` 环境下同样可用 |
| 本地打开：`code <dir>` 会把该目录记成 workspace 并开窗 | `workspaceStorage/<id>/workspace.json` 出现 `file:///Users/zxh/workspace/herdr-todo` |
| 远程打开：`code --folder-uri "vscode-remote://codebuddy-remote-ssh+<host><path>"` 真的连上并打开 | dev3 / dev5 / dev6 / dev8 各开出 `SQLEngine [SSH: devN]` 窗口；远程有对应 `~/.codebuddy-server-cn/stable-22e67e2a…`（与本机同版本）与 6 个 server 进程 |
| 远程打开**首次会慢**（装/启动 server），且偶发 `Connection to 'SSH: devX' could not be established … stdout maxBuffer length exceeded`，重试即成功 | 同一 host 连测 4 次：1 次成功、1 次失败、2 次成功 |
| `open -a` 传目录不可靠：多次调用不会为不同目录新开窗 | `open -a "CodeBuddy CN" <dir>` 连测两个目录，窗口数不变；`buddycn <dir>` 会新开 |
| remote-ssh 是 bundle 内置扩展 `codebuddy-remote-ssh`，authority 前缀硬编码 `codebuddy-remote-ssh` | `mods/../extensions/open-remote-ssh/out/extension.js` 里 `REMOTE_SSH_AUTHORITY="codebuddy-remote-ssh"` |
| `~/.ssh/config` 已有 dev / dev2–dev8 别名（HostName/Port/IdentityFile 齐全） | `~/.ssh/config` 1–80 行；`hc machine ls` 8 台都 connected |
| App 自带 `tabs` / `menu` 是只读、每次启动整份替换，改它必须克隆（仓库已有 `spaces-todo` / `agents-todo` 先例） | `AGENTS.md`「Herdr's own layouts and mods are read-only」；`install.sh` 已是克隆 + 备份模式 |
| 当前布局里 `tabs` 块指向自带 `tabs`，`spaces` 块指向 `spaces-todo` | `~/.config/herdr-app/layouts/herdr-todo.json`（`sidecar`/`work` 结构），`install-layout.py` 只改 `spaces`/`agents` 两处 |

## 改动

1. **新增克隆件 `mod/tabs/`（来自 App 自带 `tabs`）**：整段照抄上游，只在文件**末尾**追加扩展段（与 `mod/spaces/main.js` 同一做法）。
   - 末尾加一个 `codebuddyButton(t)`，在 `+` 按钮之后、Files 按钮之前渲染：文字 `CodeBuddy`，口径照抄同文件 `panelButton`（h 26、px 8、gap 5、`text_size 12`、`t.hover`/`t.muted`）。
   - 点击调 `openInCodeBuddy(spacePath(spaces().find(s=>s.active)))`（见第 2 项）。
   - 路径不存在 / space 未就绪时：按钮照常显示，`tooltip` 说明原因，点击不执行（避免「点了没反应」）。
   - 依赖上游内部结构：`Tabs.prototype.render(cx)` 与其返回的根 `h_flex()`；升级后重新克隆并重贴末尾扩展段（文件头写明依赖的 3 个点）。

2. **新增 `mod/codebuddy.js`（打开动作的唯一实现，被 `tabs` 与 `menu` 各持一份副本）**：
   - `spacePath(space, panes)`：该 space 第一个 tab 里有 cwd 的 pane → 该 cwd；否则 `space.folder`。与 `spaces-todo` 的 `place()` 同口径。
   - `openInCodeBuddy({ path, machine })`：
     - `machine` 为空 → `exec(CLI, [path])`。
     - `machine` 非空 → `exec(CLI, ["--folder-uri", "vscode-remote://codebuddy-remote-ssh+" + machine + path])`。
     - `CLI` 是常量 `/Applications/CodeBuddy CN.app/Contents/Resources/app/bin/code`，不读 PATH。
     - 失败（`code !== 0`）→ `notify({ level: "error", title: "CodeBuddy 打开失败", body: ... })`；远程失败时 body 提示「首次连接需在远端装 server，可再点一次」。
     - 同一时刻只允许一个打开动作在飞（`this.opening`），避免连点开出一串窗口。
   - 为什么用 `exec` 而不是 `run`：App 没有「用编辑器打开目录」这个命令（`herdr-app commands` 全表无此项）。

3. **新增克隆件 `mod/menu/`（来自 App 自带 `menu`）**：整段照抄，只在 `items()` 的 `case "space"` 分支里加一条 `["用 CodeBuddy 打开", "codebuddy", { space: tg.id }]`；`choose()` 里 `it[1] === "codebuddy"` 时先 `closeOverlay`，再取该 space 调 `openInCodeBuddy`。其余分支原样保留。
   - `mods/spaces/main.js:293` 打开的是 `{mod:"menu", tab:"space"}`，需要把那一处改成指向 `menu-todo`（这是本仓库自己的克隆件，改它安全）。

4. **`scripts/install-layout.py`**：在现有 `spaces`/`agents` 两处替换之外，增加 `tabs` → `tabs-todo`。找不到 `tabs` 块时**不失败**（与 `agents` 同口径：用户可能删掉了那一行），但要打印说明「没有标签栏，CodeBuddy 按钮只会在右键菜单里」。

5. **`install.sh`**：新增 `mods/tabs-todo` 与 `mods/menu-todo` 两个安装段（备份 → 复制 `main.js mod.json store? codebuddy.js jsconfig.json` + `tabs` 需要的 4 个 svg），沿用现有 `backup()`；结束时把两个新 mod 加进 `herdr-app check` 提示清单。

6. **`scripts/sync-core.sh` + `tests/sync.test.js`**：`codebuddy.js` 是「三份副本必须一致」的新文件（`mod/`、`mod/tabs/`、`mod/menu/`），纳入同步脚本与比对测试（分叉会出现「按钮能开、菜单开错目录」这种半边坏）。

7. **`README.md`**：新增「用 CodeBuddy 打开」一节（按钮位置、本机/远程两种行为、首次连远程会装 server、失败如何重试）；「已知边界」补两条：远程依赖 `~/.ssh/config` 别名；`--folder-uri` 的行为随 CodeBuddy 版本可能变。

## 验证

- [x] **本机 space 真能开窗**：在 `herdr-todo` space 点按钮 → CodeBuddy 前台窗口标题
  `herdr-todo`、资源管理器根 `HERDR-TODO`，即 `/Users/zxh/.local/share/herdr-todo`
  （= 该 space 第一个终端**前台进程**的 cwd，不是终端外壳的 cwd）→
  `workspace/02-opened-local-window.png`。
- [x] **远程 space 真能开窗**：切到 dev8 点按钮 → 出现 `SQLEngine [SSH: dev8]`，
  状态栏 `SSH: dev8` / `wide-table-dev*` →
  `workspace/04-opened-remote-window.png`；`workspaceStorage` 对应目录的
  `state.vscdb` 在点击后写入（`workspace/storage.txt`）。
- [x] **路径选取正确**：`tests/codebuddy.test.js` 固定 `spacePath` 的四种情形（pane 顺序
  不影响结果、无 cwd 回退 folder、无 space 返回 null、cwd 优先于 folder）；另用真实
  `spaces()`/`panes()` 快照核对 7 个 space 的目标，按钮 tooltip 显示的就是即将打开的路径
  （`00/01/03/07` 四张图，切 space 后 tooltip 随之变化）。
- [x] **右键菜单**：活动 space 是**本机 herdr-todo**，右键 **dev6** 行 → 菜单出现
  「用 CodeBuddy 打开」→ 点后开出 `SQLEngine [SSH: dev6]`。这同时证明菜单作用于被右键的
  space，不是当前活动的那个 → `workspace/05-menu-dev6-open.png`、`06-menu-dev6-opened.png`。
- [x] **不误开错目录 / 不静默失败**：单测覆盖「无目录不 exec 且给 warning」「非 0 退出发
  error 且远程带重试提示」「抛错后锁释放」「连点只 exec 一次」。
- [x] **回归全绿**：`npm test` 102/102 通过（无删除、无放宽既有断言）。
- [x] **真实产物**：`herdr-app check` 对 `mod/tabs`、`mod/menu` 与已安装的
  `mods/{tabs-todo,menu-todo,tabs}` 全部 `check passed`（`spaces-todo` 报
  `mod called hc` 警告，是它的设计行为——check 会真的执行异步取数）；`install.sh` 装完后
  App 正常，按钮可见，原有 tab 拖拽/右键/关闭都在。

## 范围外与风险

- **范围外与延期项**：
  - 不做全局快捷键（用户已选「按钮 + 右键菜单」）。
  - 不做 CodeBuddy 的 CLI agent 模式、不做「在远端终端里起 codebuddy」。
  - 不做「打开后聚焦 CodeBuddy 窗口」（`exec` 起 GUI 后由 macOS 自行处理前台）。
  - 【本任务新增边界】`tabs-todo` / `menu-todo` 是克隆件，App 升级后需重新克隆并重贴扩展段（与 `spaces-todo`/`agents-todo` 同一维护约定）。
- **主要风险与应对**：
  1. **远程首次打开慢 / 偶发 maxBuffer 失败**。缓解：失败时给明确的重试提示；`opening` 锁防止连点堆窗口。残留：用户仍可能遇到一次失败，需再点一次。
  2. **克隆件与上游漂移**。缓解：扩展段全部集中在文件末尾并注明依赖的内部结构；`npm test` 锁三份 `codebuddy.js` 一致；README 写明重贴步骤。
  3. **`--folder-uri` 是 CodeBuddy 内部约定**，升级后这套 authority 拼法可能变。缓解：把拼法集中在一个常量与一个函数里（`codebuddy.js`），变了一处改；README 记为已知边界。
  4. **install.sh 就位失败时 mod 目录会整个不在**（复核实测）：逐 mod「备份→替换」，替换那一步失败时旧目录已挪进 `backups/`，而布局仍指向它，需手工从 `backups/` 恢复。原 F-3 的「`main.js` 在、`codebuddy.js` 缺」半残目录已消除。触发需 `mv` 失败（权限/磁盘满）。保留为残留风险。
  5. **install.sh 无并发锁、`backups/` 无保留策略**（复核实测：并行跑必有一方失败；10 对并发累积 27 条备份）。单用户正常安装不触发。
  6. **`machine` 名原样拼进 URI authority**：名字含空格/`#`/`?` 会拼出非法或截断的 URI。现有机器名（dev/dev2–dev8）都正常，故不作为本次改动。

## 质量门禁

- [x] Gate: Plan Approval — 用户以「批准」通过。
- [x] Gate: Final Review — 已呈出；用户指示提交并推送，据此视为通过。

## 证据

`workspace/` 下按验证顺序编号：

| 文件 | 证明什么 |
|---|---|
| `00-button-in-tabbar.png` | 标签栏右侧出现 `CodeBuddy` 按钮（`+ / Files / Changes / CodeBuddy`） |
| `01-button-tooltip-local.png` | 本机 space 下按钮 tooltip 显示 `/Users/zxh/.local/share/herdr-todo`（= 该 space 第一个终端前台进程的 cwd） |
| `02-opened-local-window.png` | 点按钮后 CodeBuddy 打开 `herdr-todo` 窗口，资源管理器根是 `HERDR-TODO` |
| `03-button-tooltip-remote.png` | 远程 space 下 tooltip 显示 `dev8:/data/workspace/SQLEngine` |
| `04-opened-remote-window.png` | 点按钮后出现 `SQLEngine [SSH: dev8]` 窗口，状态栏 `SSH: dev8` / `wide-table-dev*` |
| `05-menu-dev6-open.png` | 活动 space 是**本机**；右键 **dev6** 行，菜单里有「用 CodeBuddy 打开」 |
| `06-menu-dev6-opened.png` | 点该菜单项后开出 `SQLEngine [SSH: dev6]`——菜单作用于被右键的 space，不是当前活动的那个 |
| `07-tooltip-follows-active-space-local.png` | 切回本机 space 后 tooltip 变回本地路径，说明按钮跟随活动 space |
| `storage.txt` | CodeBuddy 的 `workspaceStorage/*/workspace.json` 里确有上述三个目标目录 |
| `tests.txt` | `npm test` 102/102 输出（ultra-review 前的基线） |
| `fix-01-button-after.png` | 修复后标签栏按钮仍在原位（`+ / Files / Changes / CodeBuddy`） |
| `fix-02-button-crop.png` | 按钮区放大图 |
| `fix-03-menu-todo.png` | 右键菜单弹出 `menu-todo`（多一条「用 CodeBuddy 打开」） |
| `fix-04-fallback-menu.png` | 删掉 `menu-todo` 后菜单退回自带 `menu`：Rename/worktree/Close 都在，无 CodeBuddy |
| `review-report.md` / `review-fixes.md` / `review-findings-*.md` | ultra-review 的完整结论与逐条修复记录 |

本轮（复核修复后）追加的实测证据：
- `npm test` **120/120** 全绿。
- `sh install.sh` 后 5 个 mod 的 `herdr-app check` 全部 `check passed`；安装件与仓库 5 个关键文件 `cmp` 全部 SAME。
- 按钮：真实点击后 `state.vscdb` 于 19:01:16 更新，新建 `workspaceStorage/68e4b7be…/workspace.json` 记录 `file:///Users/zxh/.local/share/herdr-todo`，与按钮 tooltip 显示一致。
- 右键菜单：本轮界面复验被其他应用反复抢占前台打断（用户指示停止），沿用 `05`/`06` 的既有实测证据。

## 步骤

1. [x] 从 App 自带 `tabs`、`menu` 各克隆一份到 `mod/tabs/`、`mod/menu/`（原样照抄，只加文件头说明）→ `mod/tabs/main.js` 157 行上游 + 末尾扩展段，`mod/menu/main.js` 只在 `space` 分支与 `choose()` 各加一处。
2. [x] 写 `mod/codebuddy.js`（`spacePath` + `openInCodeBuddy` + CLI 常量 + `opening` 锁）→ 80 行，单测 10 条全绿（`tests/codebuddy.test.js`）。
3. [x] 在 `mod/tabs/main.js` 末尾追加扩展段（按钮 + 点击），在 `mod/menu/main.js` 的 `space` 分支加条目 → 按钮 id `codebuddy-open`；菜单项 `["用 CodeBuddy 打开", "codebuddy", {space}]`。
4. [x] 改 `scripts/install-layout.py`（`tabs` → `tabs-todo`）与 `install.sh`（两个新 mod 的安装段 + check 清单）→ 顺手删掉会误删新 tabs-todo 的 `OLD_TABS_DIR` 退休段，并加测试钉住。
5. [x] 改 `scripts/sync-core.sh` 与 `tests/sync.test.js`（三份 `codebuddy.js` 同步校验）→ 一致性测试 + 语法测试各一条。
6. [x] 加 `tests/codebuddy.test.js`（`spacePath` 两种分支、路径缺失不 exec、非 0 退出有通知）→ 实际 10 条，多覆盖 URI 编码、抛错释放锁、连点去重；两刀变异均被捕获。
7. [x] 重跑 `npm test` + `sh -n` + `herdr-app check`；跑 `install.sh` 并在真实 App 里点按钮（本机、远程各一次）、右键菜单一次 → 102/102；按钮本机 12:04、远程 dev8 12:08；菜单 dev6 12:40 各验一次。
8. [x] 验证失败即修复重跑，直到第 7 步全绿；截图与命令行证据存入 `.agent/codebuddy-open/workspace/` → 证据见下方「证据」。
9. [x] ultra-review（4 维度并行发现 + 2 个独立 Validator 复核）→ 结论 NEEDS_CHANGES：3×P1、5×P2 确认，5 条推翻（`workspace/review-report.md`、`review-fixes.md`）。
10. [x] 修 8 条确认缺陷：
    - D-1 `remoteUri` 改逐段 `encodeURIComponent`（含 `#`/`?` 单测，红→绿已验证）；
    - D-2/D-3 install.sh 引入单一 `MOD_MANIFEST`，暂存目录 + 整目录替换 + 就位后核对；清单缺失在任何写入前退出（4 个场景实测）；
    - D-4 空 `folder` 区分 null/undefined（本机 `home()`，远程 authority 无路径；实测 CodeBuddy 规范化为 `%2Bdev8/` 并连远端 home）；
    - D-5 `spaces-todo` 增加 `probeMenuTodo()` 回退到自带 `menu`（实测删掉 menu-todo 后菜单仍可用、装回后自动恢复用 menu-todo）；
    - D-6 删掉 4 个死 svg；D-7/D-8 同步测试加强（克隆件 `[herdr-todo]` 标记 + 关键位置断言 + tabs-todo 移除逻辑全匹配）。
    - 结果：`npm test` 107/107；真实 App 里按钮开出 `/Users/zxh/.local/share/herdr-todo`、右键菜单弹出 `menu-todo`、回退与恢复均实测（`workspace/fix-*.png`）。
11. [x] 独立 reviewer 复核修复及其影响，结论合入后重新呈 `Gate: Final Review`。
    - 复核提出 1 P1（`spaces/main.js` 的 import 行缺 `[herdr-todo]` 标记）+ 3 P2（标记测试过弱、回退测试过弱、探测认不出 present-but-broken），全部已修。
    - 新增 `tests/mod-runtime.test.js`：用真 `init()`/`clickUntilOpens` 断言可观察行为（右键打开哪个 mod、点 CodeBuddy 发什么 argv、按钮是否置灰），不靠源码文本。
    - `probeMenuTodo()` 加 `looksLoadable()` + `codebuddy.js` 存在性检查。
    - 两项终审 **均 PASS**：F-1/F-4（16 组边界输入全对，缺 `%` 用例已补并做了变异验证）；install.sh（清单单一来源确认，删文件/`chmod 000`/就位失败三场景都不动在用目录，暂存清理干净）。
    - 变异表：运行时 11/11 捕获（含新补的 `agents` 导入与 `%` 编码），克隆件 5 处改动全部有测试兜。
    - 结果：`npm test` 120/120。
    - 复核新发现但**未修**（均为既有路径或非本次引入，记入范围外）：install.sh 就位失败时存在「mod 目录整个不在」窗口；并发安装无锁；`backups/` 无保留策略；`machine` 名原样拼进 URI authority。
