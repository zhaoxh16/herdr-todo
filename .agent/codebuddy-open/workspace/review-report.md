# 深度代码评审报告

## 结论与范围

**NEEDS_CHANGES** — 3 条 P1 已确认：远程路径含 `#`/`?` 时会静默打开父目录，安装前置检查漏掉 7 个会被拷贝的输入，逐文件拷贝非原子可留下布局指向的残缺 mod。功能主路径（本地按钮、远程 Remote-SSH、右键菜单）已在真实 App 中验证可用，缺陷集中在边界条件与安装健壮性。

- 被审版本与目标：`main` @ `355935a`，工作区未提交 diff（`mod/codebuddy.js`、`mod/tabs/`、`mod/menu/`、`mod/spaces/main.js:294`、`install.sh`、`scripts/install-layout.py`、`scripts/sync-core.sh`、`tests/`、`README.md`）。评审对象是用户已批准的合同：标签栏按钮 + space 右键菜单，路径取当前 space 第一个终端的实时 cwd（无则 `space.folder`），远程 space 开 CodeBuddy Remote-SSH 窗口，不提 MR。
- 实际覆盖：4 个独立发现维度（固定 Proof Obligations、安装/升级部署、mod 运行时行为、克隆件漂移与测试有效性）并行只读评审，各自独立 context；全部候选交 2 个独立 Finding Validator 复核（不复用发现者 context，Validator 只读且可跑本地无副作用验证）。合并去重后 17 个候选，确认 8 个、推翻 5 个，另 4 个并入已确认项或转未决风险。功能路径另有真实 App 端到端验证（本地 / dev8 远程按钮、右键 dev6 菜单）与 `state.vscdb` mtime 佐证。
- Proof Obligations：已完成（37 条 obligation 全部闭合，O4/O7/O11/O25/O28 成为候选缺陷）。原始输出在 `.agent/codebuddy-open/workspace/review-findings-proof.md`；其余三维度原始输出见同目录 `review-findings-{install,runtime,clone}.md`。
- 重要限制：未在 Linux/Windows 上验证窗口按钮布局（RT-4 只在 macOS 可达）；未真实打开含 `#`/`?` 的远程目录（用 CodeBuddy 自身 `cliArgToUri` 正则与 vscode-uri 语义复现解析结果）；`openOverlay` 指向不存在 mod 的宿主运行时行为未交互验证。

## 当前变更缺陷

### P1

- **F-1** [P1] `mod/codebuddy.js:32` — `encodeURI` 不转义 `#` 与 `?`，远程 space 静默打开错误目录

  远程 cwd 含 `#` 或 `?`（POSIX 合法路径，如 git 分支 `fix#42` 的 worktree 目录）时，`encodeURI` 原样保留这两个字符，拼出的 folder URI 被 CodeBuddy 按 RFC 3986 解析成 path + fragment/query。用 CodeBuddy 自己的 `cliArgToUri` 正则（`^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?`）复现：`/data/worktrees/repo/fix#42` → `path="/data/worktrees/repo/fix"`、`fragment="42"`。CLI 可正常退出 0，成功 toast 报的是**用户以为的**路径，实际打开的是父目录——直接违反价值排序里的「不误开错目录」。本次引入（`remoteUri` 是新代码）。需修复：按 `/` 分段做 `encodeURIComponent` 再拼回，并补一条含 `#`/`?` 的单测（现测试只覆盖空格与中文）。

- **F-2** [P1] `install.sh:63-67` — 前置检查漏掉 7 个实际会被拷贝的输入，可复现半装状态

  拷贝清单在 `:123`（8 项）与 `:132`（4 项），前置检查只覆盖其中 5 项。`mod/tabs/jsconfig.json`、4 个 `win-*.svg`、`mod/menu/jsconfig.json` 未检查。删掉仓库副本的 `mod/tabs/win-restore.svg` 后执行安装：退出码 1，日志停在「复制 tabs-todo/win-restore.svg 失败」，此时 `mods/` 里已有 `spaces-todo`（其 `:294` 已指向 `menu-todo`）、残缺 `tabs-todo`，而 `menu-todo` 不存在，布局未重建——正是 `install.sh:45-47` 注释与 `README.md:38` 承诺不会出现的半装状态。根因是「必需文件清单」被手写了两份并已漂移（`t-mode` #4 Hand-synced list）。需修复：前置检查与拷贝清单由同一份清单派生。

- **F-3** [P1] `install.sh:123-126`、`:132-135` — 逐文件备份+拷贝非原子，失败会让布局指向无法加载的 mod

  拷贝顺序是 `main.js` → `mod.json` → `codebuddy.js`：任一 `cp` 失败（权限、磁盘满、目标为只读文件）都会留下 `main.js` 已 `import "./codebuddy.js"` 而该文件是旧版或缺失的目录。布局在新版本里明确指向 `tabs-todo`（`scripts/install-layout.py:56`），App 对 `mods/<name>/` 是热重载，重启后标签栏整体加载失败。更隐蔽的变体：`mods/tabs-todo/codebuddy.js` 若是**目录**，`cp` 会把源拷进该目录并**以退出码 0 宣称安装完成**，随后 `herdr-app check` 报 `cannot resolve module './codebuddy.js'`。基线中 `tabs-todo` 不被布局引用，同一模式后果有限；本次布局明确指向它，失败被放大为「标签栏消失」。需修复：先写临时目录、整体替换，或至少 `cp` 后校验目标为普通文件且内容一致。

### P2

- **F-4** [P2] `mod/codebuddy.js:25` — 空字符串 `space.folder` 被当作「没有目录」

  `|| space.folder || null` 把 `folder: ""` 折叠成 `null`，按钮置灰并提示「这个 space 还没有终端，也没有记录目录」；而 Herdr 把空 folder 文档化为「该机器的 home」。当前 8 个 space 都不为空 folder，触发需手工构造，故 P2。`tests/codebuddy.test.js:92` 已把这个行为写成期望值，修的时候要一起改。

- **F-5** [P2] `mod/spaces/main.js:294` — space 右键菜单成为 `menu-todo` 的硬依赖，缺失时整份菜单消失

  该行是 `menu-todo` 的唯一 opener 且没有回退；`menu-todo` 缺失或加载失败时，重命名/关闭/worktree 等**全部** space 菜单动作一起失效，而此前用的是 App 自带、永远与版本匹配的 `menu`。F-2/F-3 修好后主要靠安装完整性兜底，仍建议：`openOverlay` 失败时回退到 `mod: "menu"`，或在 README 写明这是有意的硬依赖与卸载方式。`herdr-app check` 不校验 `openOverlay` 目标存在性（实测 `check passed`）。

- **F-6** [P2] `install.sh:123` — 4 个 `win-*.svg` 是死拷贝，且正是 F-2 的故障触发输入

  `mod/tabs/main.js:154-156` 引用的是 `svg("mods/tabs/win-*.svg")`（App 自带 mod 的资源前缀），拷进 `tabs-todo/` 的这 4 个 svg 不被任何代码引用。删掉这条拷贝可同时消掉 F-2 里 4 个未检查输入，是 F-2 最省的修法之一。

- **F-7** [P2] `tests/sync.test.js:111-114` — 「不移除 tabs-todo」的断言只匹配一种字面写法

  `assert.equal(/mv "\$OLD_TABS_DIR"/.test(text), false)` 只拦截历史上的具体字面量。在副本里插入 `rm -rf "$APP_HOME/mods/tabs-todo"` 或 `mv "$TABS_DIR" …`，`node --test tests/sync.test.js` 仍 15/15 全过。当前 `install.sh` 确实没有此类移除，属测试有效性问题而非现存 bug。

- **F-8** [P2] `mod/menu/main.js`、`mod/tabs/main.js`、`README.md` — 按 README 重新克隆会静默丢功能，且全部检查仍通过

  用上游 `{tabs,menu}/main.js` 覆盖两个克隆件后：`npm test` 102/102 绿、两个 `herdr-app check` 通过、`grep -c codebuddy` 为 0——功能完全消失而检查全绿。`mod/menu/main.js` 全文没有任何 `[herdr-todo]` 标记（tabs 只有末尾注释块），与其 5 处内联改动（`:9` import、`:67` 菜单项、`:85` `menuIcon`、`:116-117` 取 `target`、`:120` 分发）不相称；先例 `spaces-todo`/`agents-todo` 靠 README 明确列出「2 行标了 `[herdr-todo]` 的插入」兜底。本次材料的改动清单也低估了 menu 的改动面（写成「两处新增」，实际 5 处）。

## 未决风险与覆盖缺口

- `mod/menu/main.js:118-120` — **PLAUSIBLE**：`choose()` 先 `closeOverlay` 再 `openInCodeBuddy`，成功/失败的 `notify` 发生在 overlay 关闭之后；宿主文档只说「Closing a mod copy cancels its pending calls」，未说明普通 async 续段与 `notify` 是否仍可达。`exec` 在首个 `await` 前就派发，开窗本身有实测证据（`workspace/06-menu-dev6-opened.png`），待证的是失败时会不会「点了没声」，违反「不弹失败也无声」。需要一次远程失败场景的实测。
- `mod/codebuddy.js:22-26` — **PLAUSIBLE**：`spacePath` 实际取「`panes()` 数组顺序里第一个属于该 space 且有 cwd 的 pane」，契约里「切 pane 不改变指向」依赖 `panes()` 是稳定模型顺序；`gpui-kit.d.ts` 对 `panes()` 只写「Every pane in every tab. Live.」，无顺序保证（只有 `agents()` 明确写成 space→tab→pane 顺序）。当前版本用真实快照核对 7 个 space 的 tooltip 全部吻合，与上游 `place()` 同口径。需证的是顺序保证本身。
- `mod/tabs/main.js:190-206` — **PLAUSIBLE**：按钮追加在根元素末尾，而根元素在 `w?.buttons` 为真时（Linux/Windows）以最小化/最大化/关闭收尾，按钮会排在关闭按钮右侧。macOS 上 `buttons` 为 false，本机不可达；功能不坏（有 `.on_mouse_down` stop），只是与「`+` 之后、Files 之前」的约定在非 macOS 平台不一致。
- 覆盖缺口：Linux/Windows 窗口按钮布局、真实 GUI 下的远程失败重试、宿主对 `openOverlay` 未知 mod 的处理，均未实测。

## 存量问题与范围外建议

- `install.sh:38-43` `backup()` 对符号链接只备份链接本身，「备份」与目标同时被覆盖。dotfiles 场景下会丢失原内容，但 README 只承诺布局/keys 支持符号链接，不承诺 mod 文件可链接；本次新清单只是重新使用该存量机制，不属本次引入。
- `scripts/install-layout.py:50`、`:65`（及新增的 `:56` 同模式）`setdefault("content", {})` 在 `"content": null` 时抛 `TypeError`。`:50`/`:65` 是存量；`:56` 为本次新增但需手工编辑布局才触发，已并入 F-2/F-3 的修复面考虑，不单独列为本次缺陷。
- `tests/codebuddy.test.js:90-96` 对「无目录」只断言「不发 exec + 一条 warning」，不断言锁状态；把「先设锁再 return」这种会永久锁死按钮的变异放进去，8 条测试仍全绿。当前实现正确，属测试义务缺口，可与 F-4 一并补。
- 已复核并推翻的候选（保留在评审记录中，不计入结论）：两条新入口各持一把锁（各开一个窗口是注释声明的范围，README 的「连点」指同一按钮）、render 期 path 快照（cwd 变化是否触发重渲染未证，且现有两个入口在同一 tick 内结果一致）、缺重试提示（错误本身不会静默，只是少一句引导）、`panes()` 顺序（见上，降为未决风险）。
