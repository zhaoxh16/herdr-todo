# Plan：herdr-todo — 记录工作事项并与 Herdr space 关联

> 协议锚点：继续、恢复或修订本任务时，须加载 `planning`（由其默认加载 `t-mode`）；进入 `spec.md` / `tasks.md` 阶段时分别调用 `spec-writing` / `task-execution`（未经用户本轮明示禁止 commit / push / 提 MR）。

- TAPD 工作项：无
- 工蜂 issue：无
- 是否提交 MR：否
- MR 目标分支：无
- 开发分支：无

## 当前状态

- 状态：done
- 当前步骤：Gate: Final Review 已获批准，交付完成
- 当前在途：无
- 下一步：无（任务关闭）

## 现状与目标

- 现状问题：本机日常在用的是 Herdr 桌面 App（`herdr-app` 0.1.16，PID 已运行），侧边栏有 5 个 space（本机 `herdr-todo`×2、`dev5/SQLEngine`×2、`dev8/SQLEngine`）。App 只能告诉你每个 space 里 agent 的 working/blocked/done 状态，无法回答「这个 space 到底在做什么事」「还有哪些事没处理」「这件事从提出到今天经历了什么」。所有上下文只存在于 agent 会话与脑子里，跨天/跨机器必然丢失。
- 目标结果：一份可长期维护的事项账本。每个事项有标题、备注、P0–P3 优先级、状态（todo/doing/blocked/done/cancelled）、一个或多个所属 space，以及自动累积的时间线（创建、状态变更、优先级变更、备注编辑、关联变更）。右侧常驻面板按 space 分组展示，一眼看到每个 space 在做什么、还剩什么；点开详情区可直接改状态与备注。全局快捷键弹出快速记录窗。命令行工具操作同一份数据。
- 价值排序：数据不丢 > 关联准确 > 一眼可读 > 操作步骤少 > 功能多。

### 已实测的技术事实（起草期关闭的假设）

| 事实 | 证据 |
|---|---|
| 手写布局 JSON 里插入自定义 mod 块可正常渲染 | `/tmp/ht5/shot-layout.png`，右侧出现面板 |
| 同一 mod 既可作布局块、又可作 overlay，靠 `props().overlay` 区分 | `status` 返回 `overlays: ['todoprobe']`，截图中同屏 PANEL MODE + OVERLAY MODE |
| `readTextFile` / `writeTextFile` 可用，且自动创建嵌套目录 | 写入 `~/.local/share/herdr-todo/todos.json`（目录原本不存在）成功 |
| `writeTextFile` 第三个参数是 CAS 期望值，stale 写被拒 | 传入 `'{"v":999}'` 后文件仍为 `{"v":1}` |
| `watchFolder` 能感知外部（CLI）改动并触发重绘 | 改文件后 mod 内计数递增 |
| mod **不能** import 自己目录之外的文件 | `module '../shared/core.js' resolves outside the application directory` |
| mod 内 `fs/promises` 只能读 home、写 `~/.config/herdr-app`，写 `/tmp` 被拒 | `/tmp/ht6/fs.json` 未创建 |
| `herdr-app check` **不等待**异步任务，文件 IO 不会发生 | 多次 check 通过但目标文件未创建；必须真实 `mod.open` 验证 |
| mod 沙箱内没有 `process` 全局 | 首次探测脚本静默失败，改用 `home()` 后成功 |
| space id 持久化在 core 的 `docs.json`，跨重启保留 | 新建 space 的 id 写入 `~/.local/state/herdr-core/default/docs.json` |

## 改动

仓库根：`/Users/zxh/workspace/herdr-todo`（当前为空目录，全新项目）。

1. **`src/core.js`**（纯数据层，无 IO 依赖，CLI 与 mod 共用）
   - 数据结构：`{ v: 1, items: [...], seq: number }`；item 字段 `id / title / note(markdown) / priority(P0-P3) / status / spaces[] / created / updated / timeline[]`。
   - 时间线条目：`{ at, kind: "created"|"status"|"priority"|"note"|"spaces"|"title", from, to, by }`。
   - 纯函数：`addItem / updateItem / setStatus / setPriority / setNote / setSpaces / archiveItem`，以及 `groupBySpace(items, spaces)`、`pendingCount(items)`、`sortItems(items)`。
   - 所有变更函数返回新状态对象（不就地改），并自动追加时间线条目。
   - 非法状态转移（如 `done → todo` 未经重开）在数据层拒绝并返回错误原因。
2. **`src/io.js`**（IO 适配器，两个实现同签名）
   - `readStore()` / `writeStore(state, expectedRaw)`；`--file <path>` 可覆盖路径，默认 `~/.local/share/herdr-todo/todos.json`。
   - Node 实现：`fs/promises`，原子写（temp + rename），用 CAS 检测并发。
3. **`src/cli.js`**（`bin/herdr-todo`，Node ≥ 18，零依赖）
   - 子命令：`add / list / show / status / priority / note / link / unlink / archive / spaces / export`。
   - `--json` 输出机器可读结果；`--space <id|名称>` 支持按名称模糊匹配。
   - 退出码：0 成功、1 用法错误、2 数据冲突。
4. **`mod/main.js` + `mod/mod.json`**（Herdr App 面板）
   - 双模式：布局块（右侧常驻面板）/ `props().overlay` 存在时的弹出窗（快速记录）。
   - 面板结构：顶部统计行（P0 数 · 未处理总数）→ 按 space 分组（含顶部「未关联」组）→ 每组内按 状态→优先级→更新时间 排序 → 底部「已完成 N」折叠区。
   - 选中项在面板下方显示详情区：状态下拉、优先级选择、备注编辑（多行）、关联 space 管理、时间线列表。
   - 快速记录窗：单输入框（标题）+ 可选的当前 space 预填，回车创建后关闭。
   - 数据同步：`cx.timer.every` 以 `watchFolder` 为主 + 低频兜底轮询；写入走 CAS，冲突时重读再重试一次。
   - `mod/` 内附 `core.js` 的副本（由 `scripts/sync-core.sh` 从 `src/core.js` 复制，因沙箱禁止跨目录 import）。
5. **`mod/../layouts`**：`layout/herdr-main.json`，克隆自 App 的 `main`，在 `work-body` 中把 `panel` 列改为三选一栈并追加 `todo` 块（尺寸 320px，可调）。由 `install.sh` 安装到 `~/.config/herdr-app/layouts/`。
6. **`scripts/sync-core.sh`**：把 `src/core.js` 复制到 `mod/core.js` 并在尾部写入源码哈希注释；`install.sh` 调用它，CI/验证时用它检查副本是否过期。
7. **`install.sh`**：
   - 把 `bin/herdr-todo` 链到 `~/.local/bin/`（已存在则备份为 `.bak-<ts>`）；
   - 复制 `mod/` 到 `~/.config/herdr-app/mods/herdr-todo/`（覆盖前备份）；
   - 复制布局到 `~/.config/herdr-app/layouts/herdr-todo.json`；
   - 打印 `herdr-app check` 的验证命令，不自动切换布局。
8. **`tests/`**：`node --test`，覆盖 `core.js` 的时间线累积、状态机、分组排序、CAS 冲突处理。
9. **`README.md`**：安装、快捷键绑定方法（`keys.json` 加 `mod.open:herdr-todo` 或用布局内的记录按钮）、数据文件位置、备份方法。

## 验证

- [x] 时间线正确累积：创建/改状态/改优先级/改备注/改关联各产生一条带 from→to 的记录，且按时间升序 → `node --test tests/core.test.js`
- [x] 非法状态转移被拒：`done → todo` 直接拒绝并返回可读原因 → 同上
- [x] CAS 冲突不丢数据：模拟两方并发写，落盘结果包含双方变更且无覆盖 → `tests/io.test.js`
- [x] 分组正确：无关联事项进入顶部「未关联」组；一个事项关联多个 space 时在每组各出现一次；已完成折叠区只含 done/cancelled → 同上
- [x] CLI 端到端：`add → list --json → status done → list --json` 状态与时间线正确；用 `jq` 断言字段 → `tests/cli.test.sh`
- [x] 面板在真实 App 中渲染：`herdr-app check mod/` 通过，且 `mod.open` 后截图确认分组、详情区、折叠区三处都在 → `herdr-app shot` 截图留证于 `.agent/herdr-todo/workspace/`
- [x] 面板与 CLI 共享数据：CLI 改一条状态后，面板在 3 秒内自动反映 → 截图前后对比
- [x] 快速记录窗可用：渲染、预填当前 space、✕ 与 Esc 两条关闭路径（`kind: window` 无关闭入口 → 改 `dialog`）：快捷键/overlay 打开后输入标题回车，事项落盘并出现在面板对应 space 组 → 截图 + `list --json`
- [x] 安装可重入：连续执行两次 `install.sh` 均成功，旧文件被备份、App 无 `errors`（`herdr-app status`）→ 命令行输出 + status
- [x] 主题跟随：面板使用 `theme()` 取色，在 App 当前主题下文字可读 → 截图目视 + 代码审查无硬编码颜色
- [x] 面板内改状态 / 改优先级 / 改关联真的落盘：在装好的 mod 里触发这三条 `mutate`，`todos.json` 的 status、priority、spaces 与时间线随之变化 → 自测后还原数据（`/tmp/todos-backup.json`）
- [x] 快速记录弹窗写入并自动关闭：填标题提交后新事项落盘、挂到当前 space、overlay 关闭 → `herdr-app status` 的 overlays 为空 + `list --json`
- [x] 默认折叠：只展开当前 space，其它组显示标题与未处理数 → `.agent/herdr-todo/workspace/panel.png`
- [x] 重复执行 `install.sh` 后 `herdr-app check` 仍通过（herdr-todo 与 tabs-todo 两个 mod）
- [x] ultra-review 的 9 条 P1 逐条复现后修复并复验 → 报告 `.agent/herdr-todo/workspace/ultra-review.md`；写入统一走 CLI，结构异常数据报错而不改写原文件
- [x] 第二轮 ultra-review（NEEDS_CHANGES，3 条 P1）逐条复现后修复 → 报告 `.agent/herdr-todo/workspace/ultra-review-2.md`；面板 argv 以 `--` 隔离用户文本（`tests/argv.test.js` 用假 exec 钉死形态并做过变异自检）、关联改成增量 `link/unlink`（不再用 render 快照做绝对覆盖）、悬空符号链接写入目标而非替换链接
- [x] 第二轮 P2/P3 一并修掉 → 归档与 cancelled 解耦（`unarchive`/`reopen` 都能解开、统计与列表口径一致）、seq 只从 `t<n>` 推导并拒绝溢出、剩余静默转换改为报错、时间戳单调不减、`--file=` 空值报错、`--space` 两种传参形式一致、fsync + umask + 孤儿锁、安装脚本前置校验全部前置并给布局备份、被占用的快捷键不再宣传、`sync-core` 哈希接入 `npm test`、清掉死代码
- [x] 修复后的全量回归 → `npm test` 48/48、`sh tests/cli.test.sh` 全过（新增 12 组边界用例）、两个 mod `check` 通过、真实 App `errors: []`、真实账本 4 条（t6–t9）完好

## 范围外与风险

- 范围外与延期项：
  - 【维持现状】不做 agent 集成（一键把事项派给 space 里的 agent）。
  - 【维持现状】不改左侧 space 侧边栏（不显示每个 space 的待办数）。
  - 【维持现状】不做 TUI 插件形态（即便同一份数据，TUI 与桌面 App 不共享 space）。
  - 【本任务新增边界】不做截止日期、提醒、重复任务、标签、全文搜索。
  - 【本任务新增边界】不做多端同步/云备份；仅本地 JSON 文件。
- 关键约束：
  - mod 沙箱内禁用 `process`、`setTimeout`、跨目录 import；必须用 `home()`、`cx.timer`、复制文件。
  - 自带 `main` 布局与 `spaces` mod 只读且每次启动被替换，故用独立布局文件而非修改 `main`。
  - space id 是关联基准，用户已明确选择；`docs.json` 证明其持久化，但 App 大版本升级若改变 id 生成策略会使关联失效。
- 主要风险与应对：
  1. **CLI 与面板并发写导致数据丢失**：用 `writeTextFile` 的 CAS + 冲突后重读重试；`tests/io.test.js` 覆盖。
  2. **`core.js` 副本与 `src/core.js` 漂移**：`scripts/sync-core.sh` 写哈希注释，验证步骤比对；`install.sh` 强制同步。
  3. **布局克隆后 App 升级不再同步**：独立布局文件命名可辨识；README 说明升级后如何重新克隆。

## 质量门禁

- [x] Gate: Plan Approval — 批准这个 `plan.md` 后才能开始执行。
- [x] Gate: Final Review — 已批准（2026-11-19）；对照验证标准全部达成。

## 步骤

1. [x] 建立项目骨架：`src/core.js`、`src/io.js`、`bin/herdr-todo`、`package.json` → 零运行时依赖，Node ≥18（`package.json`）
2. [x] 写 `tests/core.test.js`（先红）→ 先红确认（`ERR_MODULE_NOT_FOUND`），实现后全绿
3. [x] 实现 `src/core.js` 至测试全绿 → 22/22 通过（`tests/core.test.js`）
4. [x] 写 `tests/io.test.js` 与 `src/io.js` → 暴露真实缺陷：纯 CAS 有 TOCTOU 窗口，8 并发写只剩 1 条；改用 `mkdir` 锁目录后全绿（`tests/io.test.js`）
5. [x] 实现 `src/cli.js` 全部子命令 → `tests/cli.test.sh` 11 项全过，含 6 进程并发写
6. [x] `scripts/sync-core.sh` → 带 `source-sha256` 头，漂移可检出（`mod/core.js`）
7. [x] 实现 `mod/main.js` 面板模式 → 真实窗口截图：分组/详情/时间线均正确（`/tmp/todo-panel.png`、`/tmp/todo-detail.png`）
8. [x] 实现 `mod/main.js`：快速记录 overlay 模式 → 弹窗渲染、预填当前 space；高度从 560 收紧到 148（`/tmp/cap4.png`）
9. [x] 布局生成 → 改为 `scripts/install-layout.py` 从 App 实时的 `main` 克隆，避免仓库里存过期布局；`herdr-todo.json` 已验证渲染
10. [x] `install.sh`：链 CLI、复制 mod、装布局、可重入 → 连续执行两次成功，`herdr-app status` 的 errors 为空，`herdr-todo` 可从 PATH 调用
11. [x] 真实 App 验证 → `check` 通过；CLI 改状态后 3 秒内面板同步（`/tmp/todo-live.png`、`/tmp/after-add.png`）；空数据首启正常（`/tmp/fresh.png`）
12. [x] `README.md` → 含安装、用法、规则、数据、已知边界
13. [x] 修用户报的三处缺陷 → ① 异步任务改用视图自己的 AsyncContext（`mod/main.js` `spawn`）② 关联「加到」整行原先被 `.child()` 丢参、补上并换行 ③ `todo-block` 并入 tabs 的 enabled 白名单（`mod/tabs/main.js:134`）
14. [x] 默认折叠当前 space 之外的组 → `isFolded` + `fallbackKey`；截图 `/tmp/panel.png`
15. [x] 回归：`npm test` 32/32、`tests/cli.test.sh` 全过、两个 mod `check` 通过、测试数据已还原
