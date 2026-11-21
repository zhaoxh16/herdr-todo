# 评审材料：herdr-todo「用 CodeBuddy 打开」

> 本文件只含事实与批准约束，不含任何 reviewer 或作者的结论。

## 原始问题（用户原话）

> 新需求：在当前 workspace 页面增加一个按钮，点击后可以通过 codebuddy 打开当前 workspace 的路径

经澄清后锁定的合同（用户逐条选定）：

1. 按钮位置：Workspace 页面的标签栏（`tabs` 那一行）右侧。
2. 「当前 workspace 的路径」= **当前 space 第一个终端的实时 cwd**，没有则 `space.folder`。
   切换 tab / pane 不应改变按钮指向的目录。
3. **远程 space 也必须支持**（本机 8 个 space 里 6 个在远程 dev3–dev8）。
   远程表现为 CodeBuddy 的 Remote-SSH 窗口。
4. 入口：标签栏按钮 **+** space 行右键菜单一条。
5. 不做全局快捷键。
6. 不提 MR。

## 版本

- 仓库：`/Users/zxh/workspace/herdr-todo`，分支 `main`，HEAD = `355935a`。
- 被审的是**工作区未提交改动**（含未跟踪的新文件）。基线 = HEAD。
- 查改动：`git status --short`、`git diff`、`git diff --stat`、`git ls-files --others --exclude-standard`。

## 改动清单（事实，不含评价）

修改：

- `mod/spaces/main.js`（2 行）：space 右键菜单的 `openOverlay` 目标由 `"menu"` 改为 `"menu-todo"`。
- `install.sh`（+32/−22）：新增 `tabs-todo` / `menu-todo` 两个 mod 的安装段与前置检查；
  **删除**了原来「装完后把旧的 `mods/tabs-todo` 挪到 backups/」那段逻辑。
- `scripts/install-layout.py`（+12/−3）：布局里的 `tabs` 块指向 `tabs-todo`。
- `scripts/sync-core.sh`（+9/−1）：把 `mod/codebuddy.js` 复制到 `mod/tabs/` 与 `mod/menu/`。
- `tests/sync.test.js`（+28）：新增副本一致性、语法、以及「install.sh 不再移除 tabs-todo」的断言。
- `README.md`（+30）：新增用法一节与两条已知边界。
- `.agent/current_task.json`：任务指针。

新增（未跟踪）：

- `mod/codebuddy.js`（79 行）：`spacePath` / `remoteUri` / `openInCodeBuddy` 与两个常量。
- `mod/tabs/`（`main.js` 207 行 + `codebuddy.js` 副本 + `mod.json` + 4 个 svg）：App 自带 `tabs` 的克隆件，
  末尾追加了按钮。
- `mod/menu/`（`main.js` 165 行 + `codebuddy.js` 副本 + `mod.json`）：App 自带 `menu` 的克隆件，
  在 `space` 分支加了一条。
- `tests/codebuddy.test.js`（126 行）：10 条行为测试。

## 环境事实（已核实，可直接采信；与代码行为冲突时以代码为准并指出）

- Herdr 桌面 App 的 mod 运行在沙箱里：**不能 import 自己目录之外的文件**，所以
  `codebuddy.js` 必须有同目录副本。
- App 自带的 `tabs` / `menu` 等 mod 在**每次启动时被整份替换**，所以改动方式是克隆 + 末尾包装。
  仓库里已有 `spaces-todo` / `agents-todo` 两个同类克隆件的先例。
- mod 可用的宿主 API：`spaces()`、`panes()`、`exec(cmd,args,{cwd,on,timeout})`、`notify()`、
  `openOverlay()`、`closeOverlay()`、`props()`、`theme()`、`run()`、`shared()`、`layout()`、`window()`、`settings()`。
- mod 的 `exec` 使用的 PATH 是 `/usr/bin:/bin:/usr/sbin:/sbin`，不含用户 PATH。
- 用户机器上 CodeBuddy CN = VS Code 1.106.1 fork，bundle CLI 位于
  `/Applications/CodeBuddy CN.app/Contents/Resources/app/bin/code`。
- 该 App 由 Herdr 的 `layout` 配置指向本仓库的克隆件：
  `~/.config/herdr-app/layouts/herdr-todo.json` 里 `spaces`→`spaces-todo`、`agents`→`agents-todo`、
  `tabs`→`tabs-todo`；`spaces-todo` 打开右键菜单时用 `menu-todo`。
- 验证入口：`npm test`（node:test）、`sh tests/cli.test.sh`、`herdr-app check <mod 目录>`、
  `sh -n <脚本>`。这些都可只读执行。

## 评审规则要点（来自 ultra-review 命令）

- 关注影响**正确性、稳定性、安全、兼容性、性能**的问题，以及偏离已批准目标的实现。
- 一般风格 / 重构 / 测试覆盖建议不算缺陷。
- 违反 `t-mode` #2（减法优先）或 #4（领域建模）可单列结构简化建议，不与正确性缺陷混同。
- 发现的基线是上述已批准合同；未批准的草稿不能自行成为基线。
- 只读：不要修改任何文件，不要产生 diff。
