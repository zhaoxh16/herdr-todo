# Plan：herdr-todo — 待办迁入公有云 MySQL 并支持多端同步

> 协议锚点：继续、恢复或修订本任务时，须加载 `planning`（由其默认加载 `t-mode`）；进入 `spec.md` / `tasks.md` 阶段时分别调用 `spec-writing` / `task-execution`（未经用户本轮明示禁止 commit / push / 提 MR）。

- TAPD 工作项：无
- 工蜂 issue：无
- 是否提交 MR：否
- MR 目标分支：无
- 开发分支：无

## 当前状态

- 状态：done
- 当前步骤：全部完成。`Gate: Final Review` 于 2026-11-23 获用户批准；spec 状态置 Delivered
- 当前在途：无
- 下一步：无（未提交 MR；需要时由用户显式发起新任务）

## 现状与目标

- 现状问题：
  - 账本是单机文件 `~/.local/share/herdr-todo/todos.json`，`src/io.js:165` 的 `withLock` 靠 `mkdir` 锁目录保证互斥，`write()` 用「比对原始字节 + 临时文件 rename」做 CAS。这套机制只在**同一台机器同一个文件系统**上成立，两台机器各持一份账本，改动无法合并。
  - 事项 id 是文件内自增的 `t12`（`src/core.js:237` 由 `state.seq` 生成，`normalizeState` 用 `/^t(\d+)$/` 反推）。两台机器必然撞号。
  - 时间线内嵌在事项对象里（`item.timeline`），既不能按时间区间检索，也没有独立的并发控制点。
  - space/agent 关联是 JSON 数组（`item.spaces`），面板靠整份读取后内存分组（`mod/spaces/todo-view.js` 的 `placeOf`），无法按关联建索引。
  - mod 沙箱没有网络能力（`herdr.d.ts` 只导出 `exec` / `readTextFile` / `hc`），因此面板只能读本地文件；写路径已经统一走 CLI（`mod/store.js:88` 的 `command()`）。
- 目标结果：
  - 待办数据以公有云 MySQL 为唯一真相，`herdr-todo` CLI 直连；不再有「两台机器各一份账本」的分裂。
  - 每台设备的侧栏在 10 秒内看到其他设备的改动（沿用现有轮询节奏，只把「读文件」扩展成「先拉取再读缓存」）。
  - 数据按 `owner_id` 分租户：一个人一个 owner，同一个人多台设备共享同一份数据，不同 owner 互不可见。
  - 现有 18 条待办、它们的完整时间线与 space/agent 关联一次性导入新库，内容不丢。
  - 为后续三项功能（子待办、手动进度、区间时间线）预留的数据结构随本次落地，但界面不实现。
- 价值排序：数据不丢 > 多端一致性（不出现静默覆盖或漏拉） > 现有界面行为不变 > 编号可读性 > 实现简洁。

## 改动

表结构与同步协议的完整承诺在 `docs/design-docs/herdr-todo/cloud-sync/spec.md`（本次先产出，经 `Gate: Spec Review` 批准后才动代码）。本节只列改动的落点与关键不变量。

### 1. 表结构（`db/schema.sql`，新增）

四张表：`owners` · `items` · `item_places` · `item_events`，另加 `meta`。要点：

- `items.id` 是 `CHAR(26)` ULID，客户端生成；`items.num` 是每 owner 连续的人读编号，唯一键 `(owner_id, num)`。所有唯一键与索引均以 `owner_id` 开头。
- `item_places(item_id, kind, ref)` 取代 `spaces` 数组与 `agent` 对象；`uk_one_agent` 由生成列实现，让「一条事项最多一个 agent 关联」在结构上无法违反（现在的 `core.js:426` 只能靠代码保证）。
- `item_events` 的 `AUTO_INCREMENT seq` 就是同步游标；`client_op_id` 唯一键提供重试幂等。
- `deleted_at` 墓碑；`parent_id` / `progress` 两列随本次建好，界面不用。

### 2. 写并发：owner 行锁替代文件锁（关键决策）

`src/store/mysql.js` 每个写事务第一条语句是 `SELECT item_num FROM owners WHERE id = ? FOR UPDATE`。它同时做三件事：

1. 串行化同一 owner 的并发写（对应现在 `mkdir` 锁）；
2. 顺带分配 `items.num`，保证编号连续——用全局 `AUTO_INCREMENT` 会让两个 owner 交替添加时编号跳成 1、3、5；
3. 让 `item_events.seq` 的分配顺序等于提交顺序，**因此拉取可以读「当前最大 seq」而无需延迟水位**。这是相对上一版设计（`WHERE recorded_at <= NOW() - INTERVAL 2 SECOND`）的净减法：那个魔数窗口是为了掩盖「先拿到 seq、后提交」的乱序，串行化后乱序在结构上不存在了。

### 3. 规则层拆分：`src/rules.js`（新增）+ `src/core.js` 瘦身

现在 `core.js` 的 `setStatus` / `setPriority` / `setTitle` / `setNote` / `setSpaces` / `moveSpace` / `setAgent` / `archiveItem` / `unarchiveItem` 签名都是 `(state, id, ...) => state`，改写整份账本。改为 item 级纯函数：

```
applyX({ item, places }, args) -> { item, places, events: [...] }
```

`core.js` 只保留只读侧（`normalizeState` / `sortItems` / `groupBySpace` / `summary` / 时间线校验），写入函数连同它们的 state 级旧签名一并删除，不留双路径。`src/cli.js` 所有写命令改为「事务内读行 → 调 rules → 落行 + 落事件」。

mod 侧的 `mod/core.js` / `mod/spaces/core.js` / `mod/agents/core.js` 是 `sync-core.sh` 生成的副本，只读，因此体积变小；`tests/sync.test.js` 的哈希比对随同步脚本更新。

### 4. 缓存与拉取：`herdr-todo pull`

`~/.local/share/herdr-todo/todos.json` 降级为派生缓存，格式在原形状上加一个 `synced_through`，`v` 由 1 改 2：

```json
{ "v": 2, "synced_through": 412, "items": [ /* 与今天逐字段相同 */ ] }
```

`items[]` 内部字段不变（`spaces` 由 `item_places` 折叠回来，`agent` 同理，`timeline` 是最近 20 条事件物化）。因此 `mod/main.js`、`mod/spaces/main.js`、`mod/agents/main.js` 的渲染、分组、拖拽、详情窗逻辑**不改**，只有 `mod/store.js` 与两个侧栏的 tick 处理函数变化。

两个游标必须分开，不合并：

- `pull_cursor`（存在 `~/.config/herdr-todo/sync.json`）：只由 `pull` 单调推进，只用于拉事件；
- `synced_through`（存在缓存头部）：表示缓存已反映到哪个 seq，写入命令直接提到自己那个 seq，但不动 `pull_cursor`。合并两者会让本地写入把别家设备尚未提交的更小 seq 跨过去。

缓存重写前比对 `synced_through`，小则拒绝写入，防止慢速 `pull` 覆盖掉刚提交的写。

### 5. CLI 表面

新增：`pull`、`devices`、`import-json`。删除：`--file`（含 `--file=` 形态，`io.js` 的文件 store 一并删除；测试改用内存适配器）。id 解析放宽为「ULID 或 `num`」，`show 12` 与 `show #12` 等价于 `#12`，`t12` 不再可寻址。退出码加 `4` = 数据库不可达，与 `3`（写入冲突）区分，让面板能说人话。

### 6. 配置

`~/.config/herdr-todo/config.json`（0600）：host / port / database / user / password / `owner`（slug）/ `ssl`。解析优先级 `--db <dsn>` > `HERDR_TODO_DSN` > 配置文件。要求 TLS，账号只授 `SELECT,INSERT,UPDATE,DELETE`。

### 7. mod 侧接线

- `mod/store.js`：`read()` 不变（仍读缓存）；新增 `sync()` 调 `herdr-todo pull`，超时/不可达时返回原因而不是抛穿；`command()` 的 argv 形态不变。
- `mod/spaces/main.js:721` 与 `mod/agents/main.js:629` 的 10 秒 tick：先 `sync()` 再 `read()`，同一时间只跑一个（在途标记）；失败时沿用现有 `readError` 显示一行「数据库不可达，显示的是 <时间> 的缓存」，不静默。
- `watchFolder(dataDir())` 保留——同机 CLI 写缓存时它仍是最快的刷新通道。

## 验证

最终状态全部重跑（见步骤 10，证据 `.agent/todo-cloud-mysql/workspace/verify-final.txt`）：`npm test` 205/205、`npm run test:db` 205/205（真库）、`tests/cli.test.sh` 全通过、五个 mod `check passed`。

- [x] 规则层语义与现有实现逐条等价（含「终态需 --reopen」「归档与取消是两件事」「space 与 agent 互斥」「备注只记长度」）→ `tests/rules.test.js` 41 条，纯函数、不连库；与 `git show HEAD:src/core.js` 的旧实现逐条对照过
- [x] 并发写同一事项不丢更新、不产生第二条状态事件 → `tests/store.test.js`「并发改同一条事项」：两连接交错，最终 `rev=3`、时间线三条
- [x] `client_op_id` 重复提交只落一条事件、返回同一结果 → `tests/store.test.js`「幂等」：第二次 `changed:false, replayed:true`
- [x] 同一 owner 并发 `add` 得到连续且唯一的 `num` → `tests/store.test.js`「并发 add 10 次」断言 1..10；CLI 侧另有 6 进程并发用例
- [x] `pull` 增量语义：两设备交错写后各自 pull，最终缓存一致；重复 pull 幂等 → `tests/pull.test.js` 16 条（含两游标不可合并、写保护×拉取、缓存缺失/0 字节/途中被删四入口）
- [x] 缓存写保护：慢 pull 不会覆盖更新的缓存 → `tests/pull.test.js`「写保护 × 拉取」驱动真实 `pullOnce`，在快照返回后注入本机写入
- [x] 墓碑：删除后另一端 pull 会从缓存移除该条 → `tests/pull.test.js`「墓碑：一端删除…」；`tests/store.test.js`「墓碑回收：两个条件缺一不可」
- [x] 18 条现有数据（旧账本 `seq=25` 是历史最大序号，非条数）导入后内容与时间线逐条比对一致 → 执行 `import-json` 导入 18 条 / 131 事件 / 13 关联，自检零差异；另与 `pull` 后的缓存逐字段比对（`workspace/import-report.txt`、`workspace/ledger-fingerprint.txt`）
- [x] 缓存派生后仍通过 `normalizeState`，侧栏与 Agents 栏渲染不变 → `tests/sidebar.test.js`、`tests/mod-runtime.test.js` 全绿；详情窗新增 `#num`（`detail-num`）由新用例覆盖
- [x] CLI 端到端（add/status/note/link/move/agent/archive/list/show/export + 并发）→ `tests/cli.test.sh` 31 组断言（每组含多条检查）连测试库跑通，输出 `ALL CLI TESTS PASSED`
- [x] `npm test` 在无 MySQL 环境下如实报「跳过集成测试」而不是静默通过 → `tests/support/db.js` 的 `probe()` 打 `# SKIP` 并附原因；`npm run test:db` 设 `HERDR_TODO_REQUIRE_DB=1`，连不上直接报错
- [x] 改动已达可提交状态但不提交（`是否提交 MR` = 否）：工作树包含本任务与前一个任务 `.agent/todo-edit-title` 的改动，按风险约定不混合提交，无 commit / push / MR

## 范围外与风险

- 范围外与延期项：
  - 子待办、手动进度、区间时间线的**界面与命令**不实现（本次只建好列与事件 `kind`）。不交付的影响：这三项能力暂无入口。【本任务新增边界】
  - 离线写入与 outbox 不做。断网时待办不可用，面板顶部明示。**【本任务新增边界】**
  - 终态事项的备注仍完整进缓存，`readTextFile` 的 1 MiB 上限继续存在（现在 18 条约 28 KB）。真到上限再改成「详情窗打开时按需取正文」。【维持现状】
  - 连接池不做：每条命令一个短连接，符合 CLI 短进程模型。常驻需求出现时再加。【维持现状】
  - **墓碑的自动回收不做**：`canPurge` 的判定规则与测试已就位，但没有命令或定时任务触发物理清除，墓碑会一直留着（只占空间，不影响正确性）。需要一个 `purge` 命令或后台任务时另立交付。**【本任务新增边界】**
  - 两个侧栏各自持一个在途标记，会并行起两个 `pull` 进程（各自目录不同、互不阻塞，代价是双份连接）。个人使用量级可接受。【本任务新增边界】
- 关键约束：
  - 直连公有云 MySQL，不加网关层；口令明文存于各设备 0600 配置文件。
  - 不支持离线；不兼容旧 `t12` id；现有 18 条一次性导入。
  - 前端三个新功能不做，但数据结构预留。
- 主要风险与应对：
  - **事件流与游标乱序导致漏拉**：靠 owner 行锁把写串行化，使 seq 分配顺序等于提交顺序；集成测试用两连接交错写验证。这是本设计最脆的一环，若实测发现仍有乱序（例如间隙锁行为与预期不符），退回到「延迟水位 + 按事件 id 去重」的方案，spec 里写明这个备选。
  - **规则层重写引入行为退化**：现有 `tests/core.test.js`（567 行）里的写侧断言先迁移成 `rules.test.js` 并保持断言原样，改动前后逐条对照；不允许通过删改断言过关。
  - **`mysql2` 成为首个运行时依赖**：`install.sh` 把 `~/.local/bin/herdr-todo` 链回仓库内的 `bin/herdr-todo`（已核实 `install.sh:106`），因此 `node_modules` 只需在仓库里存在一次，不必随每个 mod 复制。`install.sh` 的前置检查里要加一步「`node_modules/mysql2` 存在」，缺失时明确报错并给出 `npm i` 指令，而不是装出一个连不上库的 CLI。
  - **工作树里有前一个任务的未提交改动**：`.agent/todo-edit-title` 停在 Gate: Final Review，其改动（`mod/main.js`、`tests/mod-runtime.test.js`、`tests/cli.test.sh`、`README.md`）尚未提交，而本次的 138 项基线包含它们。本次改造会与这批改动叠在同一工作树。应对：不动那批改动的语义；每次跑验证前确认 `git status` 与基线一致；交付时不把两个任务的改动混成一个提交。

## 质量门禁

- [x] Gate: Plan Approval — 已于 2026-11-23 获用户批准。
- [x] Gate: Spec Review — 2026-11-23 用户批准。spec 经四轮独立评审收敛至 PASS，状态置 Design approved。
- [x] Gate: Code Review — 独立 reviewer（本模型新 context，非实现者）评审未提交改动。首轮 NEEDS_CHANGES：2 项阻塞（TLS 默认值、删缓存后不重建）+ 11 项非阻塞，13 项全部处理并逐项补了测试；自查又发现同一失效路径的另外三个入口（“删缓存后先写一条 / 增量拉取途中删缓存 / 导入预热”，`requireExisting`），以及 `import-json --json` 把中文提示写进 stdout。复审结论 **PASS，0 项阻塞**，另有 8 项非阻塞；其中 N1–N7 已修（0 字节缓存、symlink 锁路径分裂、`update()` 先读后查存在性、`add --status done|cancelled` 不记 `closed_at`、spec 退出码措辞、导入遇损坏缓存抛错、增量拉取不校验落盘），N8 为验证时间戳已刷新。修复后 `npm test` 205/205、`npm run test:db` 205/205、`tests/cli.test.sh` 全通过、五个 mod `check passed`。详见步骤 10 与 `activity.md` 的 Gate 条目。
- [x] Gate: Final Review — 2026-11-23 用户批准。ultra-review 的 1 P0 + 6 P1 已全部修复并在最终代码状态完成验证（`workspace/verify-final.txt`：`npm test` 219/219、`npm run test:db` 219/219、`tests/cli.test.sh` 35 组全过、五个 mod `check passed`）。spec 状态置 Delivered；未提交 MR。

## 步骤

1. [x] 产出 `docs/design-docs/herdr-todo/cloud-sync/spec.md`（调用 `spec-writing`）：表结构全文、事件 `kind` 与 `data` 形状、两个游标语义、幂等与并发规则、缓存派生格式、迁移与回滚 → 呈 `Gate: Spec Review` → 四轮独立评审收敛至 PASS，2026-11-23 用户批准；spec 状态置 `Design approved`
2. [x] 建 `db/schema.sql` 与测试库（`herdr_todo_test`），在本机 MySQL 上执行并核对生成列、唯一键、时区行为 → 六张表建成；端到端冒烟验证五条约束全部生效：编号连续（num=1）、事件序号 seq=1、幂等键重复被 `uk_op` 拒绝、同事项第二个 agent 被 `uk_one_agent` 拒绝、多 space 关联正常写入（`db/schema.sql`，本机 `herdr_todo_test`）
3. [x] 抽取 `src/rules.js` 并迁移 `tests/core.test.js` 的写侧断言到 `tests/rules.test.js`，先红后绿；删除 `core.js` 里的 state 级写函数 → `rules.test.js` 先红后绿，最终 41 条全绿（条数以 `node --test tests/rules.test.js` 为准）；`core.test.js` 重写为只读侧 + v2 约束；无直接 v1 等价物的 3 条断言在测试里注明了替代断言
4. [x] 实现 `src/store/mysql.js`（事务、owner 行锁、num 分配、幂等、ULID 生成）与集成测试 → `tests/store.test.js` 12 条真库用例全绿（编号连续、并发不丢更新、幂等键、时间线 seq 递增、租户隔离、跨 owner 游标、快照上限、墓碑与 GC、时区往返）
   - 已实测：owner 行锁使并发写在真库上真实阻塞（607ms）且两次更新都生效（不丢更新）；`mysql2` 的 JSON 列必须 `JSON.stringify` 后传，重复主键错误码为 `ER_DUP_ENTRY/1062`；ULID 用 `node:crypto` 自实现（10 万条零碰撞、26 字符、跨毫秒有序），`mysql2` 是唯一新增依赖。
5. [x] 实现 `pull` 与缓存派生（含写保护、墓碑移除），测试放在内存适配器层 → `tests/pull.test.js` 11 条真库用例全绿：增量一致、两游标不合并、慢 pull 写保护、sync.json 丢失后重建且归零游标已落盘、重建被打断时游标不推进、墓碑移除、设备位点、空写不推进
6. [x] 接线 `src/cli.js`：新增 `pull` / `devices` / `import-json`，删除 `--file` 与文件 store，id 解析支持 `num`，退出码 4；改造 `tests/cli.test.sh` → 真库跑通 `ALL CLI TESTS PASSED`（当时 24 组，评审轮次补到 31 组，含并发 6 进程、缓存损坏、umask、exit 4）。修掉的三个真实缺陷：① 空列表提示文案「（没有未完成的事项）」含「完成的」，测试按子串 grep 误判——断言改为条目数；② `show` 已删除事项的提示是「已被删除」而非「已删除」，测试匹配词修正；③ **写命令在缓存损坏时整条失败**——事务已提交而缓存读不懂，原来把 `cache.update` 的 `corrupt` 抛穿了；改为写路径吞掉 `corrupt`（真相在库），pull 识别出损坏走全量重建（`cache.update({fromCorrupt:true})`），并补 `tests/io.test.js` 一条单测锁死「普通 update 拒绝、只有重建能写」
7. [x] `scripts/import-json.js` + 实际导入现有 18 条，输出逐条比对表 → `herdr-todo import-json` 导入 18 条 / 131 条时间线 / 13 条关联；自检通过；另用 `pull` 后的缓存与旧账本逐字段比对（标题/正文/状态/优先级/created/updated/归档/关联/最近 20 条时间线）一致。证据：`.agent/todo-cloud-mysql/workspace/import-report.txt`、`workspace/ledger-fingerprint.txt`（sha256 `2959e281…`，与 `~/.local/share/herdr-todo/todos.json` 一致；真实账本含备注正文，不复制进仓库）
8. [x] `mod/store.js` 加 `sync()`，两个侧栏 tick 接上；`install.sh` 加 `mysql2` 前置检查、`package.json` 加依赖 → `sync()` 不抛（返回 `{ok,error,lastPullAt}`）、10s tick 有在途标记、失败渲染一行提示；`herdr-app check mod` 与 `mod/{spaces,agents,tabs,menu}` 全部 `check passed`
9. [x] 更新 `README.md`（数据、配置、同步、已知边界）与 `scripts/sync-core.sh`、`tests/sync.test.js` → README 重写「安装前置/命令行/数据/配置/本地缓存/多端同步/开发/已知边界」；`sync-core.sh` 已重跑；`npm test` 179 全绿（其中一条「shell 变量后紧跟全角字符」检查抓出 `tests/cli.test.sh` 的 `$DSN（`，已改 `${DSN}`）
10. [x] 在最终代码状态上重跑全部验证（`npm test`、`sh tests/cli.test.sh`、`herdr-app check`）→ 修复后**最终状态**：`npm test` 205/205、`npm run test:db` 205/205（真库）、`HERDR_TODO_REQUIRE_DB=1 sh tests/cli.test.sh` 输出 `ALL CLI TESTS PASSED`（31 组）、`herdr-app check` 五个 mod 全部 `check passed`；真实库仍是 18 事项 / 131 事件 / 13 关联 / 1 owner / 0 devices，测试库 `herdr_todo_test.owners` 为 0，缓存 sha256 仍为 `2959e281…`。证据：`.agent/todo-cloud-mysql/workspace/verify-final.txt`（`verify-pre-review.txt` 为评审前的旧快照）
   - 补记（评审前自查，均为实测发现的真缺陷）：`db/schema.sql` 写死 `USE herdr_todo`，导致文档里的「建测试库」静默建到生产库名上——改为只建表 + 新增 `db/create.sh <库名>`；`--by`/`--op`/`owner` 三个越界值原先直接撞驱动报 `Data too long for column`，改为在入口收口（actor 截 64、`--op` 必须 26 位 ULID、owner 超 64 报用法错误）；`npm run test:db` 原先设的是一个没人读的变量、连不上照样 SKIP 假绿——改为 `HERDR_TODO_REQUIRE_DB=1` 强迫真跑；删掉无人引用的 `src/io.js`
   - 补记（Code Review 修复，逐条见 `activity.md`）：
     - D1 TLS 默认值：`ssl = { rejectUnauthorized: true }`；`ssl` 写成布尔/字符串/数组时由 `loadConfig` 抛 `ConfigError`（exit 2），不再让 mysql2 的 `TypeError` 冒充运行时错误。新增 `tests/config.test.js`（8 条）覆盖默认分支——这正是原先零覆盖的那条路径。
     - D2 删缓存不重建：`createCache.exists()` + `pullOnce` 的 `cacheMissing` 纳入 `needsRebuild`；新增 pull 用例「删缓存 + 保留 sync.json」，并做过反向验证（去掉判据该用例必红）。同类路径另有两个入口一并堵上（自查发现）：缓存缺失时写命令不建缓存（`requireExisting` → `cacheSkipped`），以及增量拉取每批合并前仍要求文件存在（途中被删则转全量重建）。三条路径的共用收口是 `src/sync.js` 的 `resetAndRebuild` 与 `flushToCache`，反向验证均已做过。
     - D3 超长静默截断：`rules.js` 的标题/备注改为**报错**（exit 1，消息含上限与实际长度），README 由「超长报错而不是截断」的错误宣称改为二选一后的实情（CLI 报错）。补 `rules.test.js` 边界用例与 `cli.test.sh` 断言。
     - D4 面板不显示编号：详情窗头部加 `#num`（`detail-num`），`mod-runtime.test.js` 补断言。
     - D5 `setDevicePullSeq` 缺 `owner_id`：补上过滤（位点被改高会让 GC 提前清墓碑）。
     - D6 `closed_at` 从不写入：`applyStatus` 进入终态记时间、离开清空；`applyArchive` 被动置 cancelled 时同步记；`applyUnarchive` 退回 todo 时清空。补 rules 用例。
     - D7 墓碑无执行者：本版**不加**自动 GC（超出已批准范围），在 README「已知边界」写明 `canPurge` 已就位但无命令触发，需要时手工执行。
     - D8 import 不备份：导入前 `copyFile` 成 `<源>.bak-<时间戳>` 并打印路径；README 的「旧账本仍原样留在原路径」改为实情。实测「源文件就是默认缓存路径」这一最自然用法，备份里仍是完整 v1。
     - D9 导入 `synced_through` 算错：改为事务内记录实际分配的最大 seq。实测导入后缓存头部 `synced_through` 与库里 `MAX(seq)` 相等。
     - D10 幂等重放仍刷缓存：`createItem` 与 `updateItem` 一致，`changed:false` 时直接返回。
     - D11 README 准确性：可见延迟改为「通常一个周期内、最坏约 20 秒」；退出码 3 改为如实描述「本地缓存竞争」；删缓存触发重建的承诺现在成立。
     - D12 符号链接写入回退：`atomicWrite` 恢复 `resolveLink`，穿过链接写到目标（含悬空链接）；`io.test.js` 补两条用例（链接仍在、内容落在目标）。
     - D13 测试质量：`pull.test.js` 的写保护用例改为驱动真实 `pullOnce`（在快照返回后注入本机写入），不再手抄合并逻辑；`store.test.js` 的跨 owner 用例改为用裸连接制造「A 取号未提交、B 提交并 pull、A 再提交」的真实交错；`cli.test.sh` 补 `--file <value>` 空格形态与超长标题断言；`argv.test.js` 补 `exec` 抛错时 `sync()` 不抛穿。
   - 评审的 6 项「未决风险」里采纳三条：`fullSnapshot` 的 `ownerId()` 移到事务外（首次调用会 INSERT，快照边界不该取决于驱动何时建 read view）、`snapshotFor` 注释与 SQL 对齐（墓碑行会返回，移除发生在 `mergeBatch`）、`uk_op` 全局唯一在 schema 注释里写明理由。两条记为残留风险：`import-json` 是长事务（一次性迁移、现场无并发写者，已在代码里注明）、两个侧栏各自持在途标记会并行起两个 pull（个人使用量级可接受）。
   - 补记（Code Review **复审** N1–N7，逐条见 `activity.md`）：
     - N1 0 字节缓存绕过全部判据：`> todos.json` / 编辑器重写被打断 / 恢复工具留下的 0 字节文件，`read()` 返回空状态、`exists()` 为真，被当成「合法空快照」增量合并。新增 `cache.isBlank()`（缺失、0 字节、纯空白三者等价），`pullOnce` 与 `update({requireExisting})` 都以它为准。先前试过的不变量 `synced_through < cursor` 在「先清空再写一条」的场景失效（写入会把戳抬高），所以判据落在文件结构上而不是游标上。
     - N2 `withLock` 与 `atomicWrite` 路径分裂：缓存是符号链接时锁建在链接名、写落在目标名，两个写者各锁各的、一份写入静默丢失。改为先 `resolveLink` 一次，锁与写都用解析后的 `target`。
     - N3 `update()` 先读后查存在性：`requireExisting` 原先在 `read()` 之后，0 字节文件会先被读成空基线。改为先查 `isBlank()`。
     - N4 `add --status done|cancelled` 不记 `closed_at`：`applyCreate` 补齐（创建即终态时关闭时间就是创建时间）。
     - N5 spec §4.2 的退出码 3 描述与实现不符：改写为「本地缓存竞争」。
     - N6 导入在事务提交后遇损坏缓存会抛错：改为吞掉 `corrupt` 并提示下一次 pull 重建（与 `flushToCache` 同一条纪律）。
     - N7 增量拉取未校验 `res.written`：补显式冲突错误，避免「合并返回 null 但游标照推」将来漏掉一批事件。
     - 另补 `tests/io.test.js` 的 `isBlank()` 单测（缺失 / 0 字节 / 纯空白 / 合法空快照四种形态）。
11. [x] ultra-review 路径 B 修复（1 P0 + 6 P1 + 同步修掉 2 项 P2），逐条先红后绿，然后在最终代码状态重跑全部验证 → `npm test` 219/219、`npm run test:db` 219/219、`HERDR_TODO_REQUIRE_DB=1 sh tests/cli.test.sh` 35 组全过、五个 mod `check passed`；云端 18 事项未被触碰，测试库跑完归零。证据：`.agent/todo-cloud-mysql/workspace/verify-final.txt`
   - F-1（P0）v1 旧账本被首次 pull 销毁：`cache.read()` 对 `v===1` 抛专门错误码 `legacy_ledger`（不能复用 `corrupt`——那正好触发重建销毁）；`pullOnce` 上抛并提示先 `import-json`；`flushToCache` 与 `importLedger` 遇 `legacy_ledger` 跳过缓存而不是失败（事务已提交）；`rebuild()` 整体替换前 `cache.backup("bak")` 且备份失败即中止。测试：`io.test.js`「v1 报 legacy_ledger 且绝不按 corrupt 处理」（含 `fromCorrupt` 也被拦）、`pull.test.js`「pull 停下并提示先导入」、`import.test.js`「源文件就是缓存路径时预热跳过它」、`cli.test.sh` 断言文件 sha256 不变。
   - F-2/F-3（P1）`flushToCache` 覆盖较新版本 / 复活已删事项：mutate 先取 `cached` 再判断——缓存里 `updated` 更大就原样保留（**不能先去重再判断**：那样较新的那份被删掉又不放回，这是实现时自己踩到并修掉的 bug），基线里已无该条且 `synced_through` 已越过本次 seq 则判定为同伴已删除、不插回。测试用两个用例在 `cache.update` 前注入并发状态，断言缓存保留较新标题、已删条目不复活。
   - F-4（P1）`--owner` 跨租户污染：参数从 `VALUE_OPTIONS` 移除并给出专门用法错误（不能只当未知选项，否则提示不可照做）；`sync.json` 记 `owner`，`pullOnce` 与 CLI `open()` 都调 `ownerMismatch`/`invalidateLocalState` 作废本机状态（备份后删缓存、删 sync.json、换 device id、游标从 0 重建）。`open()` 的身份检查带 `importSource` 例外并按 **inode** 判同一文件——字符串比较会漏掉「缓存是符号链接、用户给真实路径」这种最自然的 dotfiles 用法，那样会把导入源当别人的缓存删掉。
   - F-5（P1）`ensureDevice` 归属错乱：插入前读已有行的 owner，属于别人就报错并给出「删 sync.json 重试」的处置；同 owner 重复登记照常。
   - F-6（P1）时间线顺序：`eventToTimeline` 带 `seq`，`timelineOf` 按 `seq` 优先、缺 `seq`（导入的旧条目）退回按 `at`；`scripts/sync-core.sh` 已重跑。测试：`core.test.js` 时钟慢 5 秒的设备不能改变顺序、`pull.test.js` 缓存时间线条目全部带 `seq`。
   - P2 顺带：`advanceSync` 在文件锁里取「磁盘现值 vs 本次值」较大者，替代原来只在内存里 `Math.max`（两个 pull 交错仍会把游标写小）。测试：`io.test.js`「并发 pull 交错写不会把游标写小」。
