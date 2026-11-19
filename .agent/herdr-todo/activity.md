# activity — herdr-todo

### [2026-11-18 17:25] Gate — Plan Approval 通过
- **结论/动作**：用户批准计划，确认平台为 Herdr 桌面 App mod、CLI + 面板一次交付。
- **证据**：`.agent/herdr-todo/plan.md`

### [2026-11-18 17:50] Pivot — 快速记录弹窗从 window 改为 dialog
- **结论/动作**：用户反馈弹窗打开后关不掉。原用 `kind: "window"`（常驻、Esc 不关闭、无关闭入口）→ 改为 `kind: "dialog"`（Esc 可关）并在标题行加 ✕ 按钮，两条退出路径都成立。
- **证据**：`mod/mod.json`、`mod/main.js`；`/tmp/dialog.png`

### [2026-11-18 17:48] Result — 并发写入的真实缺陷与修复
- **结论/动作**：8 个并发 `update` 只剩 1 条落盘。纯 CAS（写前比对旧内容）存在 TOCTOU 窗口，两个写入者同时通过比对后各自 rename，后者覆盖前者。改为 `mkdir` 锁目录把整个读-改-写包起来，并保留 CAS 作二次校验。
- **证据**：`tests/io.test.js`（修复前 1 条 / 修复后 8 条），`src/io.js` `withLock`

### [2026-11-18 17:55] Pivot — 待办面板改为接入原生 panel stack
- **结论/动作**：先前自建一列右侧栏，用户指出「关不掉」「收起也占空间」，并问为何不像 Files/Changes。核实 App 原生做法：面板是 `panel-body` stack 的成员，开关按钮长在 tab bar 上，开关状态按 space 存 localStorage。改为同构方案——todo 作为 stack 第三个成员 + 克隆 tabs mod 加 Todo 按钮；删掉自造的宽度收起窄条与隐藏按钮。
- **证据**：`mods/tabs/main.js:134-141`（原生 panelButton）、`scripts/install-layout.py`、`mod/tabs/main.js:153`；`/tmp/native.png`、`/tmp/todo-active.png`

### [2026-11-18 17:52] Result — 快捷键改为 keys.json 可配置项
- **结论/动作**：用户要求快捷键进 App 的 Keyboard shortcuts。改为 `scripts/install-keys.py` 写入标准绑定（`ctrl-alt-t` 切面板列、`ctrl-alt-n` 快速记录），占用冲突时跳过并汇报、改动前备份 keys.json。
- **证据**：`scripts/install-keys.py`、`keys.json.bak-*`

### [2026-11-18 18:20] Result — 面板按钮点击无反应的根因：用了失效的 Context
- **结论/动作**：用户报告状态、优先级都切不了、也无法改关联。根因是面板把 `render(cx)` 收到的 `Context` 存进闭包，点击时拿它 `spawn`——`Context` 只对产生它的那一次宿主调用有效，render 返回后即失效，抛 stale-context，而宿主吞掉异常，表现就是「点了没反应」。改为视图只持有 `init` 收到的 `AsyncContext`（`this.cx`），所有异步任务统一走 `this.spawn()`；handler 不再需要传 cx。
- **证据**：`mod/main.js` `spawn/load/watch`；`gpui-kit.d.ts:393-410`（Context vs AsyncContext），`:248-252`（Context 仅对当次调用有效）

### [2026-11-18 18:22] Result — 关联区「加到」按钮从未渲染
- **结论/动作**：`.child(a, b)` 的第二参数被丢弃，导致「+ space」按钮整行不存在，关联只能删不能加。改为 `v_flex().children([...])` 两层都放进去，并给两行 `flex_wrap()`，space 多时换行而不是被裁掉。
- **证据**：`mod/main.js` `renderDetail`；截图 `/tmp/v3p.png`（关联 herdr-todo ×，加到 dev5/SQLEngine、dev8/SQLEngine）

### [2026-11-18 18:24] Result — todo-block 被面板白名单拒收，Todo 按钮点不开
- **结论/动作**：`shared("workspace.panels")` 由 welcome 面板选择器维护，只含自带面板（files/changes），克隆件用 `enabled.includes(stored)` 校验，于是 `todo-block` 被判非法、面板被重置回 files。root cause 是「待办不是 welcome 已知的面板」。改为 enabled 恒定并入 `todo-block`，files/changes 仍由 shared 决定。
- **证据**：`mod/tabs/main.js:134`；`frame/welcome/main.js:112-118`

### [2026-11-18 18:26] Result — keys.json 里同名绑定重复，用户改动会「不生效」
- **结论/动作**：`layout:herdr-todo` 分区里还留着 `ctrl-alt-n` 的副本，而分区优先级高于 `global`；用户去 Keyboard shortcuts 改 global 上那条时，生效的仍是分区里那份。改为：脚本清理与默认值完全相同的分区副本（global 已覆盖同一动作，删掉不改变行为），并在 README 说明。
- **证据**：`scripts/install-keys.py`；清理后 keys.json 只剩 `global` 两条

### [2026-11-18 20:05] Pivot — ultra-review 确认 9 条 P1，写入统一走 CLI
- **结论/动作**：独立 ultra-review 报告（5 reviewer + 5 validator）确认 9 条 P1。逐条复核后确认属实，按根因修复：① 备注编辑器在 render 里建 `InputState`（宿主明令禁止）→ 改在点击时建 `TextareaState`，顺带满足 plan 的多行要求；② CLI 的 mkdir 锁与 mod 的无锁 CAS 互不相识导致跨写者静默丢更新 → **面板不再自己写文件**，改为 `exec herdr-todo`，写路径只剩一条；③ `normalizeState` 把结构异常的数据静默降级并写回（items 变对象时整份账本被抹掉）→ 改为抛错且不改写原文件；④ `install-keys.py` 先删后写导致用户唯一可用的绑定被删 → 调整次序并只在 global 确实覆盖时才清理；⑤ CLI 跟随 XDG 而面板不跟随造成 split-brain → CLI 固定路径；⑥ rename 丢失权限并替换符号链接 → 继承 mode、写到符号链接的真实目标；⑦ `note <id>` 省略文本静默清空 → 报错；⑧ watchFolder 空转热循环 → 加 `cx.sleep(3000)` 退避；⑨ 读失败一律当空账本 → 只把 ENOENT 当空。
- **证据**：`.agent/herdr-todo/workspace/ultra-review.md`；`mod/store.js`、`mod/main.js`、`src/core.js`、`src/io.js`、`src/cli.js`、`scripts/install-keys.py`、`install.sh`

### [2026-11-18 20:10] Result — 修复后回归实测
- **结论/动作**：`npm test` 32/32、`tests/cli.test.sh` 全过（含 6 进程并发）、两个 mod `check` 通过。逐条复验：结构异常 JSON 现在报错且原文件未被改写；重复 id、未知状态均报错；`note` 省略文本 exit 2 且备注保留；`--file=` 可用；`link/unlink --json` 正常；not-found 统一 exit 1；20 个并发 CLI 写者全部落盘；面板通过 CLI 写入 t9 成功且时间线 `by` 记为 `panel`；权限 600 保持、符号链接不被替换；CLI 加事项后面板 3 秒内同步。
- **证据**：`.agent/herdr-todo/workspace/`；实测命令输出见本次会话

### [2026-11-18 20:20] Result — P2 一批修复完成
- **结论/动作**：连同 9 条 P1 一起修掉影响较大的 P2：`archive` 命令与 `archiveItem`（归档保留数据、`--all` 可见，往返读写不丢标记）；排序改为 plan 约定的「状态 → 优先级 → 更新时间」并同步测试；`--by` 选项让时间线区分 panel 与 cli；`link/unlink` 支持 `--json`；not-found 统一 exit 1；`--file=` 形式；`--space ""` 报错；`note` 省略文本报错；锁加 owner token 防止抢占后误删别人的锁；`update` 拒绝 Promise 型 mutate；install.sh 覆盖前备份、失败不谎报成功、前置检查；生成的布局默认显示 Todo（首次 ctrl-alt-t 不再弹出 Files）。`npm test` 34/34、CLI e2e 全过。
- **证据**：`src/core.js`（`archiveItem`、`sortItems`）、`src/cli.js`、`src/io.js`（owner token、Promise 拒绝）、`install.sh`、`scripts/install-layout.py`、`tests/core.test.js`

### [2026-11-19 11:00] Pivot — 第二轮 ultra-review 判 NEEDS_CHANGES，3 条 P1 已复现并修复
- **结论/动作**：复审报告（4 reviewer + 3 批 validator，30 条候选全 CONFIRMED）判 NEEDS_CHANGES。逐条自己复现后确认属实：① **面板把用户标题原样拼进 argv**——标题为 `-h` 时 exit 0 但什么都没建（面板还清空草稿并关窗）、为 `--` 时吞掉面板自己的 `--file/--by` 写到默认账本、为 `--space` 时标题与关联对调（复现时真实账本被写入 t11，已删除并把 seq 恢复为 10）；② **F-18 上轮漏修**——面板仍用 render 快照拼「完整的下一份列表」发 `set-spaces`，并发新增的关联被静默覆盖；③ **悬空符号链接被替换成普通文件**（上轮只修了有效链接）。修法：`command()` 改成「面板选项在前 → 子命令 → `--` → 位置参数」，`--note`/`--space` 用单 token `=` 形式；关联改成增量 `link`/`unlink`，由 CLI 在锁内基于最新账本合并；`resolveLink()` 沿 readlink 链解析、目标缺失时写到那个（尚不存在的）路径。
- **证据**：`.agent/herdr-todo/workspace/ultra-review-2.md`；`mod/store.js`、`mod/main.js`、`src/cli.js`、`src/io.js`；`tests/argv.test.js`（用假 exec 固定 argv 形态，两个变异均能变红）

### [2026-11-19 11:05] Result — 第二轮 P2/P3 与全量回归
- **结论/动作**：归档与 cancelled 解耦——归档有自己的标记，`unarchive` 与 `status --reopen` 都能解开，「reopen 之后还在归档里」的死结消失；`summary()`/`groupBySpace()` 排除归档项，顶部统计与列表行数不再对不上。`seq` 只从 `t<n>` 形式的 id 推导（导入 `note-20261119123456789` 不再把 seq 推到 2^53 外导致每次 add 生成同一 id），溢出时直接报错拒写。`normalizeState` 把剩余的静默转换（spaces 是字符串、时间戳非法、时间线条目形状错）改为可定位报错，并停止在读时截断标题/备注。时间戳单调不减，时钟回拨不再出现「状态是 blocked、最后一条时间线是 doing」。`--file=` 空值报错；`link/unlink/set-spaces` 同时接受位置参数与 `--space`。写入加 fsync（临时文件 + 目录）、新文件权限跟随 umask、owner 写失败时拆掉刚建的锁。`install.sh` 把所有输入检查前置（缺 `layouts/main.json` 时零改动退出）、给布局加备份、毫秒级备份戳、被占用的快捷键不再出现在清单里（改由 `install-keys.py` 输出 `SUMMARY bound=… skipped=…`）。`sync-core.sh` 的哈希接入 `npm test`。删掉 `createMemoryStore`、`MAX_ATTEMPTS`、`resolveSpaceArg` 空壳等死代码。
- **证据**：`npm test` 48/48（core 33 + io 10 + argv 1 + sync 4）、`sh tests/cli.test.sh` 全过（新增参数边界/归档/畸形时间线/悬空链接/umask 等 12 组）、`herdr-app check` 两个 mod 通过、`herdr-app status` 的 `errors` 为空、真实账本仍为 t6–t9 且 seq=10

### [2026-11-19 11:12] Gate — Gate: Final Review 获用户批准，任务关闭
- **结论/动作**：用户明确批准最终结果。对照已签验证标准逐项确认：单测 48/48、CLI 端到端全过（含并发与 12 组边界）、两个 mod `check` 通过、真实 App `errors: []` 且截图确认面板与弹窗正常、真实账本 4 条（t6–t9，seq=10）完好。`plan.md` 状态置 `done`；按合同不提交 MR、不 commit。
- **证据**：`plan.md`（当前状态与 Gate 勾选）、`activity.md` 本条
