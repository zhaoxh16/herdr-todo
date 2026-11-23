# Activity：待办迁入公有云 MySQL

### [2026-11-23 11:20] Gate — Gate: Plan Approval 获批
- **结论/动作**：用户批准 plan。六道穷尽追问已锁定：一个 owner=一个人、单库+owner_id 列、mod 轮询时先 pull、本机真 MySQL 集成测试、导入现有 25 条、写 spec。据此把上一版设计里的「延迟 2 秒水位」改为「owner 行锁串行化」，因为 seq 分配顺序等于提交顺序后，乱序在结构上不存在。
- **证据**：`.agent/todo-cloud-mysql/plan.md`

### [2026-11-23 11:32] Result — 三项关键机制在本机 MySQL 26.7.0 上实测成立
- **结论/动作**：① `SELECT … FOR UPDATE` 锁 owner 行后并发事务串行化，后到者的 AUTO_INCREMENT 序号必然大于前者且前者已提交——这是「拉取不需要延迟水位」的全部前提；② 生成列 `IF(kind='agent', item_id, NULL)` + 唯一键确实拒绝同一事项的第二个 agent 关联，多 space 与跨事项互不影响；③ 回滚会消耗一个 AUTO_INCREMENT 值（实测 seq=1 空洞），游标跨过即可，无需回收。
- **证据**：本机 `ht_probe3` / `ht_probe2` 库；spec §4.4「写入串行化与游标正确性」

### [2026-11-23 11:44] Result — 迁移前基线锁定：138 项单测 + CLI 端到端全绿
- **结论/动作**：`npm test` 138/138 通过，`sh tests/cli.test.sh` 全通过。这是改造后不得回退的对照基线，且既有断言不得删改（只能把 `--file` 驱动的用例改造成连测试库）。另记：`--file` 在测试里出现 76 次（集中在 `cli.test.sh` 的 `run()` 与内联调用），删除该选项后这些位置要改为「指向测试库」，不是逐个删断言。
- **证据**：`npm test` 输出 `# pass 138` / `# fail 0`；`tests/cli.test.sh` 末尾 `ALL CLI TESTS PASSED`

### [2026-11-23 11:33] Pivot — 时区假设被实测推翻，连接选项必须双设
- **结论/动作**：原以为「会话 `SET time_zone='+00:00'` 就够」。实测 `mysql2` 在只设会话时区、连接选项用默认值时，读回来的 `DATETIME(3)` 按本机时区解释，整体偏移 8 小时（28800000 ms），且不报错。现改为连接选项 `timezone:'Z'` + 会话 `time_zone='+00:00'` 双设，读时间用 UTC 解析字符串或 `UNIX_TIMESTAMP(col)*1000`；三种写法实测均还原为原始 epoch。已写入 spec §3.3。
- **证据**：`docs/design-docs/herdr-todo/cloud-sync/spec.md` §3.3；本机 `herdr_todo_test` 的 tz / tz2 探针

### [2026-11-23 11:33] Result — 迁移数据实为 18 条，且含 14 处同毫秒事件
- **结论/动作**：旧账本 `seq=25` 是历史最大序号而非事项数，实际 18 条（t1–t5 已删）。验收判据按 18 条与 131 条时间线。发现 14 处同毫秒时间线条目——那是旧 `stamp()` 时钟单调化补丁的产物，迁到多端后同刻事件的先后必须改按 `seq` 排序，否则随读取顺序漂移。已写入 spec §6.3。
- **证据**：旧账本解析输出；`docs/design-docs/herdr-todo/cloud-sync/spec.md` §6.3

### [2026-11-23 11:34] Result — spec 起草完成，自检修掉 7 处实质问题
- **结论/动作**：spec 落盘后逐节通读 + `spec-lint` + `check_mermaid`，修掉：① ER 图两表挤在一行；② 工蜂 mermaid 9.3 不支持 `UK` 标注（改正文说明）；③ `item_events` 缺 `owner_id` 列（否则多租户拉取要跨表过滤）；④ 正文承诺了 `owners.event_seq` 但 schema 没这列；⑤ `pull` 步骤没说「已删除项要从缓存移除」，实现者会漏；⑥ 可见延迟从「≤10 秒」下调为「下一轮轮询内」（10 秒是周期，最坏接近 20 秒）；⑦ `rev` 列只在图里出现、正文没说明。另外发现 `uk_event_id (seq,item_id)` 是主键的冗余前缀索引，已从 schema 删除。
- **证据**：`docs/design-docs/herdr-todo/cloud-sync/spec.md`；`db/schema.sql`；`check_mermaid.py` 输出「3 个 mermaid 块均可解析」

### [2026-11-23 11:34] Result — 并发「不丢更新」在真库上验证通过
- **结论/动作**：两连接对同一行 `SELECT … FOR UPDATE` 实测：B 真实阻塞 607ms 直到 A 提交，最终 `v=2`，两次自增都生效。这是 F2 的直接证据，不是推断。
- **证据**：本机 `herdr_todo_test` 的 locktest 表探针

### [2026-11-23 11:41] Result — 独立评审 NEEDS_REVISION（6 阻塞 + 6 建议），已全部收敛
- **结论/动作**：评审指出最严重的一条是真缺陷：`seq` 是全局 AUTO_INCREMENT，而 owner 行锁只保证同 owner 内「分配序=提交序」，我原文的论证不能推广到全局。已补硬约束「游标只能推进到本次实际取到的最大 seq，绝不能取全局 MAX(seq)」。其余修掉：`synced_through` 定义原本为假（已改为「缓存重写的单调保护戳」）、`devices` 实体在 ER 图缺失且 GC 未按 owner 限定、`last_pull_seq` 推进时机未定、事项被物理清除后的分支、`sync.json` 丢失后的恢复语义、测试计划缺四项验收、三处 plan 层内容混入。另补 `num` 与 `synced_at` 进缓存格式。有一条我反驳并保留：`db/schema.sql` 不应被视为外部依赖，DDL 是本设计组成部分。
- **证据**：`docs/design-docs/herdr-todo/cloud-sync/spec.md`

### [2026-11-23 11:42] Result — 「提交序乱序」用两组对照实验证伪/证实
- **结论/动作**：先复现真 bug：同 owner 下 A 取号 1 未提交、B 取号 2 已提交，游标推到 2 后 A 提交，实测 `seq=1` 永久漏拉。再加 owner 行锁重跑：B 被真实阻塞 806ms 直到 A 提交，取号 2，最终 `1,2` 都在游标之后。结论：漏拉风险在有行锁时被结构性消除，spec 新增的「禁止取全局 MAX(seq)」约束仍然必要（防的是实现图省事查全局最大值）。
- **证据**：本机 `herdr_todo_test` 的 ev3（无锁，复现漏拉）与 ev4/owners2（有锁，无漏拉）两组探针

### [2026-11-23 11:42] Pivot — 复审暴露我漏掉的静默丢数据路径，两条均已实测确认
- **结论/动作**：① 写保护与游标推进顺序：原设计「写保护放弃写缓存、但仍推进 pull_cursor」会让那批事件永不重拉。已改为「先落盘成功才推进」，并规定冲突时换用较新基线合并重试而非放弃。② 全量重建未要求一致性快照：实测方案 A（分页读不在同一事务）下，重建期间被改的事项在缓存里是旧值、游标却取到最新 MAX(seq)，该改动永久落后；方案 B（同一 REPEATABLE READ 快照，游标取快照开始时值）不漏。已写入 spec。③ 采纳「无新事件时游标不动」，防越过本 owner 未提交的取号。
- **证据**：`docs/design-docs/herdr-todo/cloud-sync/spec.md` §4.4；本机 `herdr_todo_test` 的 ri/iev 对照探针

### [2026-11-23 11:45] Gate — spec 经四轮独立评审收敛为 PASS，呈 Gate: Spec Review
- **结论/动作**：第四轮结论 PASS，剩余仅一条非阻塞措辞：`sync.json` 丢失后「`pull_cursor` 归零」没说是落盘还是只在内存。已补写为「立即把归零值落盘再重建」，并在 §7「游标丢失后恢复」加判据「重建失败或重试耗尽后重运行仍从 0 重建」。累计四轮共修掉 15 项（8 阻塞 + 7 建议），其中三处是实测暴露的真丢数据路径。spec 状态仍为 Draft，等用户批准 Gate 后才置 Design approved。
- **证据**：`docs/design-docs/herdr-todo/cloud-sync/spec.md` 头部状态；§4.4、§7


### [2026-11-23 13:05] Result — 实现全部落地，端到端在真库上跑通
- **结论/动作**：步骤 3–9 完成。`npm test` 179 条全绿；真库集成 `tests/store.test.js`（12）+ `tests/pull.test.js`（11）全绿；`tests/cli.test.sh` 输出 `ALL CLI TESTS PASSED`（24 组，含 6 进程并发、缓存损坏、umask、退出码 4）。18 条真实数据导入本机 `herdr_todo`：18 事项 / 131 事件 / 13 关联，自检通过；另用 `pull` 后的缓存与旧账本逐字段（标题/正文/状态/优先级/created/updated/归档/关联/最近 20 条时间线）比对一致。两台设备在同一 owner 上交错写与 pull 冒烟验证通过（B 新增 #19，A pull 后看到），验证后用 SQL 精确回滚到 18 条并把 `owners.item_num` 与 `devices` 一并复原。
- **证据**：`.agent/todo-cloud-mysql/workspace/{import-report.txt,verify-pre-review.txt}`；`~/.local/share/herdr-todo/todos.json` 的 sha256 仍为 `2959e281…`（真实账本未被改动）

### [2026-11-23 13:12] Pivot — 端到端脚本暴露三个真实缺陷，其中一个是丢数据的
- **结论/动作**：① 写命令在**缓存损坏**时整条失败——事务已提交、缓存读不懂，`cache.update` 的 `corrupt` 被抛穿，用户看到「命令失败」而库里其实已经写了。改为：写路径吞掉 `corrupt`（真相在库，下一次 pull 整体重建），pull 侧把缓存损坏当作重建触发条件（`cache.update({fromCorrupt:true})` 只对重建开放，普通合并仍必须看到错误），并补单测锁死「普通 update 拒绝、只有重建能写」。② 另两条是测试自身的断言错：空列表提示文案「（没有未完成的事项）」含「完成的」，按子串 grep 误判；`show` 删除项的提示是「已被删除」而非「已删除」。
- **证据**：`src/sync.js` `flushToCache` / `pullOnce`；`src/cache.js` `update(…, {fromCorrupt})`；`tests/io.test.js` 新增用例；`tests/cli.test.sh`

### [2026-11-23 13:20] Result — 删掉无人引用的 `src/io.js`
- **结论/动作**：`--file` 删除后 `src/io.js`（旧的文件锁与 CAS 写）已无任何 importer，但文件仍在，会让读者以为文件账本路径还活着。删除并同步 spec §9「现有实现」清单；`npm test` 仍 179 全绿。
- **证据**：`grep -rn "io\.js" src mod tests scripts bin` 无结果（除 spec/plan 的历史叙述）

### [2026-11-23 13:28] Result — 补上「要求跑集成测试」的可信开关
- **结论/动作**：`npm run test:db` 原来只设一个没人读的 `HERDR_TODO_TEST_DB=1`，连不上库时照样 SKIP 并以 0 退出——「CI 上明明要跑集成测试」和「顺手跑单测」因此分不清，假绿。改为 `HERDR_TODO_REQUIRE_DB=1`，`tests/support/db.js` 的 `probe()` 与 `tests/cli.test.sh` 的探库分支都读它：设了就连不上直接报错，没设才 SKIP。两条路径各实测一次（可达 → 全绿；不可达 + REQUIRE → 失败并说明原因；不可达 + 无 REQUIRE → SKIP exit 0）。
- **证据**：`tests/support/db.js`、`tests/cli.test.sh`、`package.json`；`README.md`「开发」一节

### [2026-11-23 13:38] Pivot — 边界值直接撞驱动报错：`--by` / `--op` / `owner` 都要在入口收口
- **结论/动作**：实测 `--by <100 字符>` 得到 `Data too long for column 'actor'`（exit 1），`--op <40 字符>` 得到 `Data too long for column 'client_op_id'`，`--owner <100 字符>` 得到 `Data too long for column 'slug'`。三处都是「事务已回滚、用户只看到驱动内部报错」。改在边界一次解决：`actorOf` 去空白并截到 64（与 `item_events.actor VARCHAR(64)` 一致，旧实现在 core.js 里也截到 40，属于既有行为不是新增限制）；`--op` 必须是 26 位 ULID，否则用法错误（exit 2）并说明用途；`owner` 抽成 `config.js` 的 `readOwner()`，配置文件与 `--owner` 共用同一校验，超 64 字符报用法错误。端到端补三条断言（非法 `--op` 被拒、超长 `--by` 截到 64 且写成功、`show` 里能看到截断后的 actor）。
- **证据**：`src/cli.js` `actorOf` / `opIdOf`；`src/config.js` `readOwner`；`tests/cli.test.sh`「错误路径」段

### [2026-11-23 13:34] Pivot — 我对本机真实库误跑了一条 delete，已精确复原
- **结论/动作**：为验证 delete 路径，我对着本机 `herdr_todo`（已导入真实数据的库）跑了一次 `delete "#18"`，写入了一条 `deleted` 事件并把 `updated_at` 推到当时。发现后立即用 SQL 精确回滚：删掉那条 `deleted` 事件（seq=133）、`deleted_at` 置回 NULL、`updated_at` 与 `rev` 复原为 `1795399803727` / 1，`devices` 清空。随后 `export` 与旧账本逐条比对（标题/正文/状态/优先级/created/updated/归档/完整 131 条事件）全部一致，计数回到 18/131/13。教训：本机 `herdr_todo` 已是真实数据，只在 `herdr_todo_ci` 上做写测试。
- **证据**：`herdr_todo` 的 items/item_events 计数 18/131；`export` 与 `~/.local/share/herdr-todo/todos.json` 的逐条比对输出

### [2026-11-23 13:44] Pivot — `db/schema.sql` 写死了 `USE herdr_todo`，文档里的建测试库做法根本不生效
- **结论/动作**：实测 `mysql -uroot schema_probe < db/schema.sql` 在 `schema_probe` 里**一张表都没建**——文件里的 `USE herdr_todo` 把语句重定向到了另一个库，且因为 `CREATE DATABASE IF NOT EXISTS` 存在，命令退出码为 0，属于静默建错地方。而 README 与测试夹具都写着「用 db/schema.sql 建测试库」，等于测试库搭建说明是错的。改为：`db/schema.sql` 只建表、不含 `CREATE DATABASE`/`USE`（库名由调用方给）；新增 `db/create.sh <库名>` 负责建库 + 建表，幂等。README、测试夹具提示、`tests/cli.test.sh` 的跳过信息统一改为 `sh db/create.sh herdr_todo_test`。`sh -n` 与「变量后紧跟全角字符」两条脚本检查把 `db/create.sh` 一并纳入（它第一次跑就踩了同一个 bash 3.2 坑：`$DB（` 被当成变量名）。
- **证据**：`db/create.sh`；`db/schema.sql` 头部注释；在 `schema_probe` 上验证建出 6 表 + meta，重跑幂等

### [2026-11-23 13:52] Result — 双设备端到端场景在独立库上手工跑通
- **结论/动作**：在临时库 `herdr_todo_e2e`（用 `db/create.sh` 建）上用两个 HOME 模拟两台设备：A 建两条 → B 首次 pull 全量重建 → B 改状态 + 加一条 → A pull 看到 → B 删 #2 → A pull 后缓存移出该条 → A 删 #3 → B pull 后与 A 一致 → 故意把 B 的缓存改成非法 JSON 再 pull（应重建）→ 删掉 B 的 sync.json 再 pull（应重建并写回 sync.json）。每步结果都符合预期，`devices` 显示两台设备各自的 `last_pull_seq`。顺带发现 `pull` 在重建时的输出也是「已是最新」，把重建这件事藏了起来——改为 `已重建缓存：N 条事项，游标 → S`，并在端到端脚本里钉住「首次 pull 报重建」。
- **证据**：临时库 `herdr_todo_e2e`（已删）；`tests/cli.test.sh`「pull / devices」段

### [2026-11-23 13:40] Gate — Gate: Code Review 呈现（独立 reviewer，NEEDS_CHANGES）
- **结论/动作**：由本模型新 context 的独立 reviewer 评审未提交改动（评审对象是 13:37 的磁盘快照）。结论 NEEDS_CHANGES：2 个阻塞缺陷 + 11 个非阻塞问题 + 6 项未决风险。阻塞两条都是「默认路径上必现」的问题：① 配置文件不写 `ssl` 时 `loadConfig` 返回布尔 `true`，mysql2 抛 `TypeError: SSL profile must be an object`，所有命令变成 exit 1（正确应为正常连上，若真是配置问题则 exit 2）——此前的端到端脚本每组都显式写 `"ssl": false`，默认分支零覆盖；② 删掉 `todos.json`、保留 `sync.json` 时 `pull` 报「已是最新，缓存 0 条」，缓存永不重建，面板静默变空，且此后增量游标已越过那些事件、永远补不回来。
- **证据**：reviewer 报告（本会话 task `abff7462b220b02bd` 的结果）；两条均按 reviewer 描述复现（TLS 报错与 exit 1；删缓存后 `itemCount:0` 且文件 ENOENT）

### [2026-11-23 13:58] Pivot — 13 项评审问题全部处理，其中 6 项是真实缺陷
- **结论/动作**：
  - **D1 TLS 默认值**：`ssl` 默认改为 `{ rejectUnauthorized: true }`；`ssl` 写成布尔/字符串/数组时在 `loadConfig` 抛 `ConfigError`（exit 2），不再让驱动的 `TypeError` 冒充运行时错误（exit 1）。新增 `tests/config.test.js` 8 条，把默认分支变成有测试的路径。实测：省略 ssl → 走到 TLS 握手（对自签证书报「连不上数据库」exit 4，语义正确）；`ssl: true` → exit 2 并说明该写什么。
  - **D2 删缓存不重建**：`createCache` 新增 `exists()`（区分「文件不存在」与「存在但为空」），`pullOnce` 把 `cacheMissing` 纳入 `needsRebuild`。补 pull 用例并在修复前做过反向验证（把判据去掉，该用例必红）。实测：两条事项、删缓存、`pull` → `已重建缓存：2 条事项`，缓存文件重新出现。
  - **D3 超长静默截断**：`rules.js` 的标题/备注改为报错（消息带上限与实际长度，明确「没有保存任何内容」）；README 原来宣称「超了报错而不是截断」而实现是 slice，现在两者一致（选报错，因为时间线只记长度、正文不可恢复）。补 rules 边界用例 + CLI 断言。
  - **D4 面板不显示编号**：详情窗头部加 `#num`（id `detail-num`）；`mod-runtime.test.js` 补一条断言。spec §4.2 要求 `num` 进缓存正是为了这里。
  - **D5 `setDevicePullSeq` 缺 owner 过滤**：补 `AND owner_id = ?`。位点被改高会让 `minPulledSeq()` 误判、GC 提前清掉该设备还没拉到的墓碑。
  - **D6 `closed_at` 从不写入**：`applyStatus` 进入终态记时间、离开清空；`applyArchive` 被动置 cancelled 时同步记；`applyUnarchive` 退回 todo 时清空。补 rules 用例，并用真库跑了一遍 done→reopen→archive→unarchive 四个状态看列值。
  - 8 项非阻塞：D7 墓碑自动回收**不做**（超范围，改 README 写明无执行者）、D8 导入前进备份（实测「源文件就是默认缓存路径」最自然的用法，备份里仍是完整 v1）、D9 导入 `synced_through` 取实际最大 seq（实测与库里 `MAX(seq)` 相等）、D10 幂等重放不刷缓存、D11 README 四处不准确（可见延迟、退出码 3、删缓存、旧账本去向）、D12 `atomicWrite` 恢复穿符号链接写入（含悬空链接，补两条用例）、D13 三处测试质量问题（写保护用例改驱动真实 `pullOnce`、跨 owner 用例用裸连接造真实「取号未提交」交错、`--file` 空格形态与 `exec` 抛错）。
  - 未决风险采纳三条：`fullSnapshot` 的 `ownerId()` 移到事务外（首次调用会 INSERT，快照边界不该取决于驱动何时建 read view）、`snapshotFor` 注释与 SQL 对齐、`uk_op` 全局唯一的理由写进 schema 注释。另清理三处死代码（`writeOnce`、`cacheOnly`、`configFileHint`）与 `cli.js` 里绕过 store 直接读表的 `storeTimeline`（改为 `Store.fullTimeline`，顺带补上 owner 过滤）。
  - 遗留风险（写进 plan 的「范围外与风险」）：`import-json` 是一次性长事务（现场无并发写者，代码里注明了这个偏离）、两个侧栏各自起一个 pull。
- **证据**：`tests/config.test.js`、`tests/io.test.js`（符号链接 + exists）、`tests/pull.test.js`（删缓存重建 + 真驱动写保护）、`tests/store.test.js`（真实跨 owner 交错）、`tests/rules.test.js`（超限、closedAt）、`tests/argv.test.js`（exec 抛错）、`tests/cli.test.sh`（--file 两种形态、超长标题）、`mod/main.js`（detail-num）；`.agent/todo-cloud-mysql/workspace/verify-final.txt`

### [2026-11-23 13:59] Result — 修复后最终状态全绿
- **结论/动作**：`npm test` 201/201（原 186 + 新增 15 条：评审 13 项带来的用例、`requireExisting` 三条、导入预热两条、`--json` 契约一条），`npm run test:db` 201/201 真库，`HERDR_TODO_REQUIRE_DB=1 sh tests/cli.test.sh` → `ALL CLI TESTS PASSED`，`herdr-app check` 五个 mod 全部 `check passed`。真实库与缓存未受影响：18 事项 / 131 事件 / 13 关联，`todos.json` 的 sha256 仍为 `2959e281…`。临时 owner（`sslprobe` / `cachedel` / `closeprobe` / `impprobe` / `pullprobe`）与临时目录均已清理，`herdr_todo_ci` 的 owners 计数为 0。
- **证据**：`.agent/todo-cloud-mysql/workspace/verify-final.txt`

### [2026-11-23 14:06] Pivot — D2 的修复只堵了「删缓存后直接 pull」，漏了「删缓存后先写一条」
- **结论/动作**：自己按 D2 的场景换了个顺序复现：删掉 `todos.json` 后执行 `add`，`flushToCache` 从空基线写出了一份**只含这一条**的缓存；此后 `pull` 看到文件存在就走增量，其余事项（事件早已在游标之下）永不回来——与 D2 是同一条失效路径，只是入口晚了一步。修法：`cache.update` 新增 `requireExisting`，缓存文件不存在时直接返回 `missing`、不创建文件；写命令照常成功（事务已提交）并标 `cacheSkipped`，缓存留给下一次 `pull` 全量重建。同时把 spec 的两处相关承诺写明（缓存缺失必须重建、写命令不得创建缓存），README「本地缓存」补一句。
- **证据**：`src/cache.js` 的 `update({requireExisting})`、`src/sync.js` 的 `flushToCache`；`tests/io.test.js`「requireExisting」、`tests/pull.test.js`「缓存被删除后先发生一次写命令」；实测：删缓存 → `add`（缓存文件仍不存在）→ `pull` → `已重建缓存：5 条事项`，五条全在
- **连带修正的既有测试**：`tests/store.test.js` 与 `tests/pull.test.js` 里有三条用例依赖「第一次写命令就建缓存」这个旧行为，现已按新语义先 `pull` 一次；`tests/cli.test.sh` 的「缓存损坏」「umask」两段同样改为先 `pull` 建缓存，并新增断言「缓存缺失时写命令不得建出只含本条的快照」（修复前该断言会红）。

### [2026-11-23 14:15] Pivot — 同一条失效路径的第三个入口：增量拉取跑到一半时缓存被删
- **结论/动作**：`pull` 只在开头查一次缓存是否存在，随后一个循环最多跑 40 批。用户在第 2 批之前删掉缓存，那一批的 `read()` 返回空状态，合并结果只含本批涉及的事项，其余事项的事件早已在游标之下、永不再来——与 D2 和「删缓存后先写一条」是同一条失效路径。修法：循环里的每次合并都带 `requireExisting`，返回 `missing` 就放弃增量、走 `resetAndRebuild`（顺手把「归零落盘 → 重建 → 推进游标」抽成这个函数，两处调用同一个）。新增真库用例「增量拉取途中缓存被删」，在「取完快照、合并之前」删文件，并做过反向验证（去掉判据该用例必红）。
- **证据**：`src/sync.js` 的 `resetAndRebuild` 与循环内 `cache.update(..., { requireExisting: true })`；`tests/pull.test.js`「增量拉取途中缓存被删」；spec §4.4 新增一段「这条判据在 pull 的每一批合并时同样要查」、§7 的「缓存文件缺失」行扩成三种情形

### [2026-11-23 14:19] Result — 同一条纪律的第四个入口：`import-json`
- **结论/动作**：审计所有缓存写入口时发现 `importLedger` 的缓存合并也没带 `requireExisting`。默认用法不受影响（默认缓存路径就是源文件、导入前已存在），但缓存不存在时它会凭空造一份「只含本次导入条目」的快照，`--force` 重复导入的场景下库里其余事项就再也不会回到缓存。改为同一条纪律：缺失则不写，并打印「第一次 pull 会整体重建」。用临时 owner 实测：导入 3 条 → 缓存文件仍不存在 → `pull` 整体重建得到 3 条、`synced_through` 等于导入事务的最大 seq；临时 owner 与临时目录已清理。
- **证据**：`src/import.js` 的 `cache.update(..., { requireExisting: true })`；新增 `tests/import.test.js` 两条（缺失不创建 + 已存在则合并且 `synced_through` 等于库里 `MAX(seq)`），做了反向验证；`npm test` 200/200

### [2026-11-23 14:23] Result — 复审暴露对外契约缺陷：`import-json --json` 的 stdout 混入中文提示
- **结论/动作**：reviewer 实测 `import-json --dry-run --json` 的 stdout 是「[dry-run] 将导入…」而不是 JSON，无法解析；真导入时「已备份旧账本 → …」也混在 JSON 之前。README 与 spec 都写了「所有命令接受 `--json`」，所以这是已承诺契约的违约，不是排版问题。修法：`importLedger` 新增 `note` 回调（默认 `console.error`），备份路径、缓存跳过、dry-run 的提示分开走；`--json` 的 dry-run 改成输出一行 JSON（`{dryRun, items, events, imported}`）。新增 `tests/import.test.js` 用例「stdout 只有一份可解析的 JSON」并做反向验证；spec §4.2 与 README 补明契约。
- **证据**：`src/import.js` 的 `note`、`src/cli.js` 的 `note: (line) => process.stderr.write(...)`；实测 `--json` 两条路径都 `parse OK`，stderr 里是备份与缓存提示

### [2026-11-23 14:26] Result — 逐个命令实测 `--json` 的 stdout 均可解析
- **结论/动作**：把签名开放的全部 `--json` 命令在临时 owner 上跑了一遍，逐条用 `JSON.parse` 校验 stdout：`add / list / list --all / show / export / spaces / devices / pull / priority / note / title / link / archive / unarchive / delete / status` 全部可解析；`import-json` 的 dry-run 与真导入在修完后也可解析。两个「BAD」是命令名写错（`del`）与缺必填参数（`agent`），属用法错误，不是输出格式问题。临时 owner 与临时目录已清理，`herdr_todo_test` 的 owners 回到 0。
- **证据**：临时 HOME + `herdr_todo_test` 的逐命令实测

### [2026-11-23 14:28] Result — 同一条 `--json` 契约还漏了一个分支：`devices --revoke`
- **结论/动作**：逐命令实测后发现唯一剩下的违约点是 `devices --revoke`：它无视 `--json` 直接打印中文。改为 `jsonOut(opts, { revoked: <id> }, …)`；`tests/cli.test.sh` 的 pull 段补两条断言（`--json` 输出 `{revoked}`、吊销后列表 `revoked=true`），反向验证已做（改回旧写法该断言失败）。
- **证据**：`src/cli.js` 的 `case "devices"`；`tests/cli.test.sh`「pull 幂等、设备登记与位点正确」

### [2026-11-23 14:31] Gate — Gate: Code Review 复审结论 PASS（0 阻塞，8 项非阻塞）
- **结论/动作**：续接同一独立 reviewer 复审修复后的版本。结论 PASS：无当前变更阻塞缺陷；8 项非阻塞里 N1（0 字节缓存绕过全部判据）、N2（符号链接下锁与写的路径分裂）、N3（`update()` 先读后查存在性）、N4（`add --status done` 不记 `closed_at`）经核实是真实缺陷，其余为文档措辞与健壮性收尾。reviewer 明确建议唯一值得再动的代码是 N1 的判据收口。
- **证据**：reviewer 复审报告（本会话 task `abff7462b220b02bd`）

### [2026-11-23 14:34] Pivot — N1 的判据落在文件结构上，而不是游标不变量
- **结论/动作**：先试过「`synced_through < pull_cursor` 即缓存不完整」这条不变量，但它对「先清空缓存再写一条」无效——写入会把 `synced_through` 抬到本条事件的 seq，不变量当场成立，空基线照旧被合并。改为结构性判据 `cache.isBlank()`（文件不存在 / 0 字节 / 纯空白三者等价），`pullOnce` 的开头检查与 `update({requireExisting})` 都用它；N2 的 `resolveLink` 一次解析供锁与写共用；N3 把存在性检查提到 `read()` 之前；N4 在 `applyCreate` 里补 `closedAt`。N5（spec 退出码措辞）、N6（导入遇损坏缓存不抛穿）、N7（增量拉取断言 `res.written`）一并修掉，另补 `isBlank()` 单测。
- **证据**：`src/cache.js`（`isBlank` / `update` 的 `target`）、`src/sync.js`（`pullOnce` / `resetAndRebuild` / `flushToCache`）、`src/rules.js`（`applyCreate`）、`src/import.js`（`note`）、`tests/io.test.js`、`tests/pull.test.js`（0 字节与截断两条）、`tests/import.test.js`

### [2026-11-23 14:36] Result — 复审修复后最终状态全绿，真实数据未受影响
- **结论/动作**：`npm test` 205/205、`npm run test:db` 205/205（真库，0 skipped）、`HERDR_TODO_REQUIRE_DB=1 sh tests/cli.test.sh` → `ALL CLI TESTS PASSED`（31 组）、`herdr-app check` 五个 mod 全部 `check passed`。真实库 18 事项 / 131 事件 / 13 关联 / 1 owner / 0 devices，测试库 owners 为 0，缓存 sha256 仍为 `2959e281…`。
- **证据**：`.agent/todo-cloud-mysql/workspace/verify-final.txt`

### [2026-11-23 15:32] Result — 真实数据已迁入公有云 MySQL，本机完成接入
- **结论/动作**：在腾讯云 CynosDB（MySQL 8.0.30-cynos）建库 `herdr_todo` 并执行 `db/schema.sql`（6 表 + meta）。`import-json` 导入 18 事项 / 131 事件 / 13 关联，自检零差异；`pull` 整体重建缓存后逐条比对标题/正文/状态/优先级/关联与旧账本一致。`install.sh` 重装五个 mod，`check` 全过，布局已切到 `herdr-todo`。实测面板 10 秒 tick 在工作（`devices.last_seen_at` 持续刷新），设备已登记 `01M83MPQB9V8…`。迁移前旧账本已备份为 `~/.local/share/herdr-todo/todos.v1.json`（sha256 `2959e281…`）。
- **两个与文档不符的实机事实**：① 该实例**不支持 SSL**（`HANDSHAKE_NO_SSL_SUPPORT`），只能 `"ssl": false`，口令与数据在网络上明文传输——已写进 README 配置节；② 该账号实际持有 `GRANT ALL … WITH GRANT OPTION`，与「只授 DML」的约定不符，需要用户自行收紧。
- **证据**：云库 `items=18 / item_events=131 / item_places=13 / owners=[ethanxhzhao]`；`herdr-todo list --all` 18 条；`sync.json` cursor=131

### [2026-11-23 15:34] Result — ultra-review 已复现一条 P0：`pull` 会把 v1 旧账本直接销毁
- **结论/动作**：在临时 HOME 里放一份 254 字节的 v1 账本在缓存路径、配好指向空测试库的配置，跑一次 `herdr-todo pull`：输出「已重建缓存：0 条事项」，文件被覆盖成 81 字节的空 v2 缓存。原因是 `pullOnce` 的「缓存可用」判据只看「非空白 + JSON 可解析」，而 `normalizeState` 为导入兼容接受 `v: 1`，于是 v1 账本被当成合法的 v2 基线。旧版 mod 不调用 `pull`，所以危险窗口是「配置已就位 + 新 CLI 已装 + 尚未 `import-json`」——正是迁移流程的开头。
- **动作**：README「接入二」的顺序由「先 install、后导入」改为「先导入、后装 mod」，并写明代价（旧面板会短暂报版本不支持）与原因（`pull` 会覆盖）。实测该顺序下旧面板从不触发 `pull`（已装 `store.js` 里没有 `sync`），窗口安全。
- **证据**：`README.md`「接入二」；`src/sync.js:216-228`、`src/core.js:48`、`src/cache.js:248`

### [2026-11-23 15:40] Gate — ultra-review 发现阶段完成（5 维度），确认一条 P0 数据丢失路径
- **结论/动作**：按 `/harness-commands ultra-review` 派出 5 个独立发现维度（Proof Obligations 固定维度 + 同步缓存 / 存储事务 / CLI 配置 / 规则 spec）。四个已返回，全部 `NEEDS_CHANGES`。共同确认的当前变更缺陷聚成五类：
  1. **P0 升级链路**：`pull` 把缓存路径上的 v1 旧账本当成合法 v2 基线并整体覆盖（已独立复现：254 字节 → 81 字节空缓存，无备份），而面板每 10 秒自动 `pull`；`import-json` 随后报「没有事项」，数据不可恢复。README 已把迁移顺序改为「先导入、后装 mod」。
  2. **P1 跨租户写**：`purgeItem` / `saveItem` / `ensureDevice` 三条写路径缺 `owner_id` 过滤；`slug` 用大小写不敏感的 `utf8mb4_0900_ai_ci` 作身份标识。
  3. **P1 `--owner` 复用本机同步状态**：`sync.json` 与缓存路径不含 owner，换身份 pull 会推进共享游标并永久漏拉、跨租户混显。
  4. **P1 写路径 flush 无事项级新旧判据**：并发 pull 之后，`flushToCache` 会用旧行覆盖更新版本，或把已删除事项复活进缓存。
  5. **P2 组**：时间线按 `at` 而非 `seq` 排序（违反 spec §6.3）、`TodoError("conflict")` 退出码为 1 而非 3、`item_places.ref` 大小写不敏感与规则层去重不一致、space id 未做长度收口、导入的终态事项 `closed_at` 恒为 NULL、面板 argv 不传 `--op`（重试会重复执行）。
- **动作**：已派 3 个独立 Finding Validator 对存储、同步、规则三组候选逐条复核（CONFIRMED/REFUTED），不复用发现者的 context。云端真实数据未受影响：18 事项 / 131 事件 / 13 关联 / 1 设备；测试库 owners 归零。
- **证据**：`.agent/todo-cloud-mysql/workspace/review-manifest.sha256`；五个 reviewer 的原始输出（本会话后台任务）；复现记录见上一行与本行

### [2026-11-23 15:46] Result — install.sh 加了迁移顺序硬拦截，与 README 的矛盾消除
- **结论/动作**：CLI 维度 reviewer 指出 `install.sh` 结尾仍写着「先 install、后导入」，与 README 刚改的「先导入、后装 mod」相反——而前者正是会销毁旧账本的顺序。我把提示从「事后告知」改成「动手前拦截」：前置检查里加 `is_v1_ledger`，缓存路径上是非空 v1 账本时 `die`，并直接给出 cp → import-json --dry-run → import-json → 重跑 install 四步。实测：v1 账本时 exit 1、`~/.local/bin` 与布局都未被改动；v2 缓存时正常装完。
- **证据**：`install.sh` 的 `is_v1_ledger` 段；临时 HOME 两次实测（v1 拦截 / v2 放行）；`node --test tests/sync.test.js` 19/19

### [2026-11-23 16:05] Result — ultra-review 四个 Validator 全部返回，两条 P0 候选被推翻、P0 只剩一条
- **结论/动作**：11 + 6 + 7 + 11 = 35 条候选全部独立复核完毕。**唯一 P0** 是升级链路（`pull` 销毁 v1 源账本），两路独立复现（688 字节 → 81 字节，无备份），已定 `NEEDS_CHANGES`。被推翻的三条重要候选：① `saveItem` ODKU「静默覆盖」——冲突只可能同 owner，`item_events` 外键会抛 `ER_NO_REFERENCED_ROW_2` 并整体回滚，不构成静默覆盖；② 事件子查询缺 owner 的跨租户泄漏——实测跨 owner id 返回 size 0，无可达路径，属纵深防御缺口；③ `db/create.sh` 命令注入——shell 不对 `"$DB"` 二次求值。`purgeItem` 缺 owner 从 P0 降 P1（**无生产调用者**，CLI 无 purge 命令），接上 GC 即升 P0。`actorOf` 代理对从 P2 降 P3 PLAUSIBLE（实测落库是 U+FFFD、长度 33，与断言不符）。
- **P1 六条**：`flushToCache` 覆盖较新版本；`flushToCache` 复活已删事项（同根因）；`--owner` 复用共享游标/缓存；`ensureDevice` ODKU 缺 owner；`timelineOf` 按 `at` 排序且缓存丢 `seq`（违反 spec §6.3）；另有 install.sh↔README 矛盾——已在本轮修掉并复核 `REFUTED（已修复）`。
- **证据**：`.agent/todo-cloud-mysql/workspace/ultra-review-report.md`（合并报告，NEEDS_CHANGES）、`workspace/ultra-review-validated.md`（逐条判定与证据链）；四个 Validator 均用临时 HOME + `herdr_todo_test`，结束时 owners 归零，工作树仅 README / install.sh / activity.md 三处预期改动

### [2026-11-23 16:52] Result — ultra-review 路径 B 修复完成：1 P0 + 6 P1 全部落地，全部验证在最终代码状态重跑通过
- **结论/动作**：按用户选定的路径 B 修掉 P0（v1 旧账本被首次 pull 销毁）与六条 P1（flush 覆盖较新版本 / 复活已删事项、`--owner` 跨租户、`ensureDevice` 归属、时间线未按 `seq`），顺带修掉游标回退那条 P2。每条都先写失败用例再改代码。最终状态：`npm test` 219/219、`npm run test:db` 219/219（真库）、`tests/cli.test.sh` 35 组全过、五个 mod `check passed`；云端 `herdr_todo` 仍是 18 事项，测试库跑完 owners/items/events/places/devices 全为 0。
- **实现中发现并修掉的自身缺陷**（都是先红后绿抓到的，不是事后补的）：① `flushToCache` 第一版「先按 id 过滤再判断较新」，结果是较新的那份被删掉又不放回——调试脚本打印出 `realUpdate -> true []` 才暴露；② `--owner` 若只从选项表里删掉会被当成「未知选项」，提示不可照做，改为专门错误信息；③ 身份作废若只靠 `pull`，改配置后先跑写命令会一直撞 exit 3（写保护永远判缓存更新），因此 `open()` 也要查一次；④ 那个检查若用字符串比较路径，dotfiles 场景（缓存是符号链接、用户给真实路径）会把导入源当别人的缓存删掉，改为按 inode 比。
- **证据**：`.agent/todo-cloud-mysql/workspace/verify-final.txt`；改动集中在 `src/cache.js`、`src/sync.js`、`src/cli.js`、`src/store/mysql.js`、`src/import.js`、`src/core.js`、`mod/*/core.js`、README 与 spec

### [2026-11-23 16:55] Result — spec 已同步三条对外承诺的变化
- **结论/动作**：spec 的 F4、§4.4（本机状态与 devices）、§6.3（时间线顺序）、§7 测试计划同步到实现：① `--owner` 不再是表面的一部分，换身份只能改配置文件，并写明换身份时本机状态整体作废的判据与后果；② `devices` 按 `(owner_id, id)` 归属，撞上别人的设备行必须报错而不是静默改写（否则 GC 的 `minPulledSeq` 对着不存在的设备算）；③ 时间线条目必须带 `seq`，导入的旧条目退回按 `at`。§7 增两行测试判据（时间线顺序、v1 账本在缓存路径上），F4 行补换身份与设备归属的验收。
- **证据**：`docs/design-docs/herdr-todo/cloud-sync/spec.md`（`spec-lint.sh` 无残留项）

### [2026-11-23 16:56] Gate — 呈报 `Gate: Final Review`
- **结论/动作**：ultra-review 路径 B 全部完成并在最终代码状态验证通过，按 `planning` 的必选门禁呈报 `Gate: Final Review`。需要用户裁决的只有一件事：是否批准交付（以及是否要提交 MR——plan 当前默认「否」）。
- **证据**：`.agent/todo-cloud-mysql/workspace/verify-final.txt`、`plan.md` 步骤 11、`workspace/ultra-review-report.md`

### [2026-11-23 17:00] Gate — `Gate: Final Review` 获用户批准，任务关闭
- **结论/动作**：用户批准最终结果。任务状态置 `done`；spec 状态由 Design approved 改为 **Delivered**，§7 补齐「各项承诺由哪些测试承担」与「已执行 / 未执行」两段，未执行的验证如实保留（真实 App 内 UI 行为、云端 TLS 往返、两真机轮询）。未提交 MR、未 commit、未 push。
- **证据**：`plan.md` 的 `质量门禁` 与 `当前状态`；`docs/design-docs/herdr-todo/cloud-sync/spec.md`
