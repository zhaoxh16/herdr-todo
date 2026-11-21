# 发现阶段原始输出 — 安装 / 升级 / 部署路径

> 原样保留，供 Finding Validator 与后续复核使用。本文件不改写 reviewer 的结论。

## 结论摘要

全新安装与正常升级路径都能跑通（已在临时副本实测）。本维度找到 **3 条 P1、3 条 P2**，均为安装/升级正确性或兼容性问题；无 P0。所有复现都在 `/tmp/herdr-review.*` 的仓库副本与伪造 `HERDR_APP_HOME` 中进行，未改动被审工作区（`git status --short` 复核不变）。

---

## 发现

### F1（P1，本次引入）新增的两个 mod 有文件未进前置检查，失败发生在已写入部分 mod 之后

- **claim**：`install.sh` 的「统一前置检查」不覆盖 `mod/tabs/jsconfig.json`、`mod/tabs/win-*.svg`、`mod/menu/jsconfig.json`，这些文件缺失时安装会在第 3 步中途 `die`，留下「`spaces-todo` 已换成引用 `menu-todo` 的版本、但 `menu-todo` 不存在」的半装状态，且布局未重建。
- **file:line**：`install.sh:63-67`（前置检查只查 `tabs|menu` 的 `mod.json`/`main.js`）、`install.sh:123-126`、`install.sh:132-135`、`install.sh:147`；README 承诺在 `README.md:38`（「缺一项就直接退出，不会留下半装状态」）。
- **evidence**：删掉仓库副本里的 `mod/tabs/win-restore.svg` 后执行 `install.sh`（HOME/APP_HOME 全部指向临时目录），退出码 1，日志停在 `安装: 复制 tabs-todo/win-restore.svg 失败`；此时 `mods/` 内已有 `herdr-todo`、`spaces-todo`、`agents-todo`、残缺的 `tabs-todo`，而 `menu-todo` 不存在；`mods/spaces-todo/main.js:294` 已经是 `openOverlay({ mod: "menu-todo", ... })`（grep `menu-todo` = 1 处）。删 `mod/menu/jsconfig.json` 同理：`menu-todo` 目录只含 `main.js/codebuddy.js/mod.json`，且 `layouts/herdr-todo.json` 未生成（`ls` 只有 `main.json`）。反向确认：`ls mod/tabs`（9 项含 App 生成的 `gpui-kit.d.ts`）与拷贝清单 8 项完全对应，`ls mod/menu`（5 项含 `gpui-kit.d.ts`）与清单 4 项对应——**没有多/少拷**，问题只在检查覆盖面。
- **关系**：本次引入（基线只拷 `spaces-todo`/`agents-todo`，其文件均在检查内；新清单首次出现未检查项）。补充：`mod/tabs/*.svg` 实际被 `mod/tabs/main.js:154-156` 以 `mods/tabs/...` 绝对路径引用（见 `AGENTS.md:206`「克隆件要改写自身资源前缀」），拷到 `tabs-todo/` 的这 4 个 svg 不被引用，属无害冗余，不单列缺陷。

### F2（P1，本次引入/加重）两个新 mod 的逐文件拷贝没有原子性，失败可让布局指向「装了一半/无法加载」的 mod

- **claim**：`tabs-todo` 的拷贝循环按 `main.js` → `mod.json` → `codebuddy.js` 顺序覆盖，中途任一 `cp` 失败（权限、磁盘满、文件是目录、只读文件）都会留下 `main.js` 已引用 `./codebuddy.js` 而该文件缺失的目录；由于布局在新版本里指向 `tabs-todo`，App 重启/热重载后标签栏整体加载失败。
- **file:line**：`install.sh:123-126`；布局指向处 `scripts/install-layout.py:54-58`；import 处 `mod/tabs/main.js:4`。
- **evidence**：在已装好的环境里把 `mods/tabs-todo/codebuddy.js`、`mods/menu-todo/codebuddy.js` 设为 `444` 后重跑，日志 `cp: ... Permission denied` / `install: 复制 tabs-todo/codebuddy.js 失败`，`main.js` 已是新版（11579 B），`codebuddy.js` 为旧版；更直接的变体：`mods/tabs-todo/codebuddy.js` 是目录时 `cp` 会把源拷进该目录并**以退出码 0 宣称安装完成**，随后 `herdr-app check` 报 `cannot resolve module './codebuddy.js' ... check failed`，而布局仍写着 `"mod": "tabs-todo"`。空目录场景同理（`herdr-app check` 报 `no main.js`）。另：App 对 `mods/&lt;name&gt;/` 是 hot reload（`AGENTS.md:81`），升级过程中 `main.js` 先落盘那一刻已可能被重载报错，直到下一次 `cp` 才恢复——瞬态，但同一根因。
- **关系**：本次引入（基线中 `tabs-todo` 不被布局引用，拷贝失败不会让标签栏消失；现在布局明确指向它，同一个逐文件模式的后果被放大）。

### F3（P1，本次引入）`spaces-todo` 对 `menu-todo` 变成硬依赖：`menu-todo` 缺失时丢的是整个 space 右键菜单

- **claim**：`mods/spaces-todo/main.js` 把 space 右键菜单从自带 `menu` 改成 `menu-todo` 后，`menu-todo` 一旦缺失或加载失败（安装中断、用户手工删除、克隆件语法错误），App 打开的是不存在的 mod，整个 space 右键菜单不可用——不是「只少一条 CodeBuddy」，也没有回退到自带 `menu`。
- **file:line**：`mod/spaces/main.js:294`；安装段 `install.sh:129-136`；README 相关说法 `README.md:128-130`、`README.md:255-256`。
- **evidence**：基线 `~/.config/herdr-app/mods/spaces/main.js:290` 为 `{ mod: "menu" }`，本次改为 `{ mod: "menu-todo" }`（`git diff mod/spaces/main.js`）。F1 的失败复现里 `mods/menu-todo` 不存在而 `spaces-todo` 已指过去；`herdr-app check mods/spaces-todo` 通过，`check` 不校验 `openOverlay` 的目标存在性（实测 `check passed`）。宿主对 `openOverlay` 未知 mod 的行为未能交互验证（前提：宿主文档只为 `terminal_menu`/`toast` 声明了回退，`AGENTS.md:274,278`，`openOverlay` 契约 `AGENTS.md:1086-1089` 未提回退；binaries 里有 `no such mod` 字样）。
- **关系**：本次引入。删掉了「旧 `tabs-todo` 整目录移到 backups」那段并不造成此问题；问题来自把独立菜单 mod 变成必需依赖。

### F4（P2，本次引入的同模式缺陷）`tabs` 块 `content` 为 `null` 时 `install-layout.py` 抛 TypeError 而非优雅处理

- **claim**：`setdefault("content", {})` 只在键**缺失**时生效；`"content": null` 时 `["mod"] =` 直接 `TypeError`，`install.sh` 第 4 步 `die`（其余 mod 已安装、布局未重建）。
- **file:line**：`scripts/install-layout.py:56`（新增），同一模式在 `scripts/install-layout.py:50`、`:65` 是存量。
- **evidence**：把 `main.json` 的 `tabs` 块改成 `"content": null` 后运行脚本：`TypeError: 'NoneType' object does not support item assignment`，退出 1，`herdr-todo.json` 未生成。`content` 键缺失时表现正确（自动补 `{"mod": "tabs-todo"}` 并成功落盘，实测）；`tabs` 块缺失时按设计打印提示并返回 0（实测）。前提：未在真实 App 写出的布局里观察到 `content: null`，触发需手工编辑；因此定 P2。

### F5（P2，存量机制、本次重新暴露）`backup()` 对符号链接只备份链接本身，"备份"与目标同时被覆盖

- **claim**：若已安装的 mod 文件是符号链接（dotfiles 管理），`backup()` 的 `cp -R` 复制出的是另一个指向同一目标的链接，随后的 `cp` 顺着目标写入，用户原内容没有留下任何副本，违背 `README.md:33` 的「每一次覆盖都会先备份」。
- **file:line**：`install.sh:38-43`（未改），被新用于 `install.sh:124`、`:133`。
- **evidence**：把 `mods/tabs-todo/main.js` 做成指向外部文件的符号链接后安装，结果 `main.js` 与 `main.js.bak-<戳>` 都是指向同一路径的 symlink，且目标内容在安装后变为新克隆件（11579 B）。注：README 只承诺布局/keys 支持符号链接（`install-layout.py:79-89`），未承诺 mod 文件可链接，故 P2。

### F6（P2，本次引入的文档/验证缺口）README 安装节仍描述「两个克隆件」，装完检查清单漏掉两个新 mod

- **claim**：按 README 操作的用户不会检查 `tabs-todo`/`menu-todo`，且 README 的「五件事 / 两个克隆件」与新安装内容不符；同时没有文档说明如何在不破坏 `spaces-todo` 的前提下关掉 CodeBuddy 入口。
- **file:line**：`README.md:29-30`、`README.md:43-45`、`README.md:120-130`、`README.md:243`（唯一的「临时关掉」只讲侧栏 `content.mod` 改回 `spaces`）。
- **evidence**：`install.sh:181-182` 已把两个 mod 加进提示清单，README 未同步；回退方式：改 `tabs` 的 `content.mod` 回 `tabs` 只会去掉按钮，`menu-todo` 仍被 `mod/spaces/main.js:294` 使用，右键菜单那一项无法只靠改布局关掉；若通过删目录「卸载」，则落入 F3。未见 README 任何卸载/回退章节（`grep -n '卸载|回退|恢复' README.md` 仅命中 agent 相关语义）。

---

## 问题清单之外，逐条回答

1. **全新安装**：可成功。临时空 `APP_HOME`（复制真实 `main.json`/`keys.json`）跑 `install.sh` 退出 0，生成 5 个 mod 目录、布局 `tabs→tabs-todo`、`spaces→spaces-todo`、`agents→agents-todo`，`herdr-app check` 五个目录全部 `check passed`（注意 `check` 对失败也常返回 0，需看输出文本）。`mkdir` 齐全（`install.sh:122`、`:131`；`mods/` 不存在时由 `mkdir -p` 逐级创建，实测通过；`APP_HOME` 含空格也能装）。拷贝清单与目录逐一对应，见 F1。
2. **重复安装**：退出 0，无 `mods/` 下新目录；每个被覆盖文件在同目录生成 `.bak-<戳>`（`tabs-todo` 每次 8 个、`menu-todo` 4 个），`.bak` 是文件不是目录，不会成为 mod（`seen.json` 只记录目录；`mods/` 根下无新目录）。升级场景（v0.1 旧 `tabs-todo` + 布局指向它）实测被就地覆盖并留下 `main.js.bak-*`（v0.1 内容 9859 B 可回溯），最终 `check passed`。
3. **删除旧 `tabs-todo` 移除段**：没有引入「覆盖丢数据」的新失败模式（逐文件备份生效）；老用户旧目录里 v0.1 的 3 个文件都在新清单内被覆盖。唯一新增风险是 F2 的非原子覆盖。`mods/*.bak-*` 目录仍会被 `install.sh:152` 循环搬到 `backups/`（实测 `tabs-todo.bak-OLD`、`menu-todo.bak-OLD` 均被移出），不误加载。
4. **失败原子性**：无回滚；F1/F2 给出两种「布局指向不可加载 mod」的可复现路径（`tabs-todo` 空目录/缺 `codebuddy.js`）。布局生成失败（第 4 步）时旧布局保底仍在，但第 3 步已完成的 `spaces-todo` 替换不可撤销。
5. **`install-layout.py`**：`tabs` 块缺失 → 打印提示、返回 0（`scripts/install-layout.py:57-58`）；`content` 键缺失 → `setdefault` 正确补出 `{"mod": "tabs-todo"}`；`content: null` → TypeError（F4）。`tabs` 块 `content` 里已有的其他键（如 `props`）被保留（实测）。
6. **卸载/回退**：见 F6/F3。布局里把 `tabs` 改回自带 `tabs` 可隐藏按钮且不破坏其它功能；但 `menu-todo` 没有单点关闭方式，删目录会让整个 space 右键菜单失效。

---

## 覆盖声明

**读过的文件**：`.agent/codebuddy-open/workspace/review-brief.md`；`install.sh`（全文，含 `git show HEAD:install.sh`）；`scripts/install-layout.py`（全文及 HEAD 版本）；`scripts/sync-core.sh`；`tests/sync.test.js`；`mod/spaces/main.js` 相关段与 diff；`mod/tabs/main.js`、`mod/menu/main.js`（头尾与 diff vs App 自带件）；`mod/tabs/mod.json`、`mod/menu/mod.json`、`mod/tabs/jsconfig.json`；`README.md` 安装/克隆件/已知边界节；`~/.config/herdr-app/AGENTS.md` 的 mods/overlay 契约片段；`~/.config/herdr-app/layouts/main.json`、`herdr-todo.json`、`installed.json`、`seen.json`；`~/.config/herdr-app/backups/tabs-todo...`（v0.1 备份）。

**跑过的命令**（只读或仅写 /tmp）：`git status/diff/diff --stat/ls-files --others`、`git show HEAD:...`、`git log`、`git check-ignore`；`sh -n install.sh`、`sh -n scripts/sync-core.sh`、`python3 ast.parse install-layout.py`；`npm test`（102/102 通过）；`herdr-app check`（仓库内 `mod/tabs`、`mod/menu` 与临时安装的 5 个 mod）；在 `/tmp/herdr-review.N7o7bp` 用仓库副本 + 伪造 `APP_HOME` 跑了：全新安装、二次安装、v0.1→新 升级、HEAD→新 升级、缺 `win-restore.svg`、缺 `menu/jsconfig.json`、只读 `codebuddy.js`、`codebuddy.js` 为目录、空 `tabs-todo`、符号链接 mod 文件、`content` 缺失/null、`tabs` 块缺失、布局符号链接、无 `mods/` 目录、路径含空格等场景。

**未覆盖**：真实 App 在 `openOverlay` 指向不存在 mod 时的运行时表现（未做 GUI 交互，只据宿主文档与二进制字符串推断，已在 F3 标注）；`herdr-app check` 的退出码语义（实测失败也返回 0，依赖输出文本判断）；Windows 平台（`win-*.svg` 路径只在 `w.platform === "windows"` 分支用到）；真实 App 热重载在拷贝中间态的精确时序（推理依据 `AGENTS.md:81`，未观测）。
