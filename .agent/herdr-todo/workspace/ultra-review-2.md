# 深度代码评审报告（复审 2）

## 结论与范围

**NEEDS_CHANGES** — 上轮 34 条中 20 条确认修复，但 **F-18 未修**，并且本轮的新架构（面板不再写文件，改为 `exec("herdr-todo", [...args, "--json", "--by", "panel", "--file", path])`）引入了一类**新的静默数据错误**：面板把用户标题原样拼进 argv，标题恰为 `-h/--help/--`/`--space` 时分别造成「退出 0 但不创建、面板清空草稿并关窗」「写到默认账本且标题被篡改」「标题与 space 对调」。另有悬空符号链接被替换为普通文件（P1，F-6 修复不完整）。

- **被审版本与目标**：`/Users/zxh/workspace/herdr-todo` 全量交付树（非 git 仓库，无 diff）：`src/{core,io,cli}.js`、`bin/herdr-todo`、`mod/{main,store,core,mod.json,tabs/main.js}`、`scripts/{sync-core.sh,install-layout.py,install-keys.py}`、`install.sh`、`tests/*`、`README.md`。批准基线为 `.agent/herdr-todo/plan.md`；plan 中标注范围外的项不计缺陷。上一轮报告 `.agent/herdr-todo/workspace/ultra-review.md` 只作为待核对清单，其「已修复」补记**未被采信**。
- **实际覆盖**：4 个互补 reviewer（Proof Obligations 固定 prompt、面板运行时、core/io/cli、安装与文档）+ 3 批 Finding Validator（共 30 条候选，全部独立取证）；`npm test`、`sh tests/cli.test.sh`、约 120 次 /tmp 沙箱 CLI/安装探测、锁与信号故障注入、`herdr-app check`（仅 /tmp 副本）、变异测试 20 余处。真实账本与 `~/.config/herdr-app` 仅只读。
- **Proof Obligations**：已完成。`O1–O20` 全部有见证（20/20）；本轮新增/修补分支 38 个，未评审分支 0 个。原始 obligation ledger 与逐条判定保留在本轮 subagent 记录中，本报告正文只引用结论。
- **重要限制**：只读约定下未驱动真实 `mod.open`/点击/键盘，面板侧结论为代码 + 宿主契约级；`readTextFile` 1 MiB 上限按 `~/.config/herdr-app/herdr.d.ts:27` 契约判定（拒绝或截断两种宿主行为导致同一结果）；`F-28` 的并发窗口在生产中需 >10 s 停顿才能进入。

### 作者修复声明与事实的对照

| 声明（`ultra-review.md` 20:20 补记） | 事实 |
|---|---|
| 「9 条 P1 全部修复并逐条复验」 | F-1/F-2/F-4/F-5/F-7/F-8/F-9 确已修；**F-6 只修了一半**：有效符号链接可写穿，**悬空符号链接仍被替换为普通文件**（N-3）。 |
| 「F-10～F-33 中影响数据与易用性的部分已修」 | `F-10`（`--space` 名称模糊匹配，plan:54 明确要求）未实现，且**未列入**「修复后仍未处理」；`F-11` 只改了文档；`F-16` 重试仍不存在；`F-24` 未修；**`F-18` 未修也未被列入未处理清单**。 |
| 「修复后仍未处理」列 F-34、F-24、describeEntry 双份、`Math.random()` | 该清单属实（F-34、F-24 均已复现未修）。 |
| README「被覆盖的文件都会先备份」(README:27) | 布局 `layouts/herdr-todo.json` 被 `os.replace` 覆盖且无备份（N-10）。 |
| README「缺任一项会在改动任何东西之前就退出」(README:30) | 只对三项前置检查成立；缺 `layouts/main.json` 时步骤 1–3 已改完才失败（N-11）。 |

---

## 当前变更缺陷

以下均为独立 Validator `CONFIRMED` 的问题（含 `F-18` 这条上轮问题），按影响排序；同根因只报一次。P3 项集中在表 2。

### N-1 [P1] `mod/main.js:231-233` + `src/cli.js:55-84,178-181` + `mod/store.js:59-68` — 面板把用户文本当选项语法，三种形态都会静默出错

触发：快速记录弹窗的标题进入 `const args = ["add", title]`，`exec` 只传 argv 数组（无 shell、无引号问题），但 CLI 的 `parseArgs` 在**任意位置**识别 `-h/--help/--`/`--key`。因此标题本身决定语义：

```
$ node bin/herdr-todo add "-h" --space spX --json --by panel --file /tmp/fin/a.json
exit=0；输出 USAGE；/tmp/fin/a.json 不存在
# 面板侧：command() 视为成功 → draft.set_value("") → closeOverlay()，用户输入永久丢失
```

```
$ node bin/herdr-todo add "--" --space spX --json --by panel --file /tmp/fin2/t.json
exit=0；/tmp/fin2/t.json 不存在；默认账本新增：
  title='--space spX --json --by panel --file /tmp/fin2/t.json'  spaces=[]  by='cli'
# '--' 把面板自己追加的 --file/--by/--json 全部变成位置参数：
#   写到默认路径（--file 失效）、标题被污染、--by panel 变成 cli
```

```
$ node bin/herdr-todo add "--space" --space spREAL --json --by panel --file /tmp/fin/c.json
exit=0；title='spREAL'，spaces=['--space']
# 标题与 space 对调：值被当成键，键被当成值，且成功退出
```

对照（说明不是引号/换行问题）：`add '修复 “login” bug\n第二行' ...` 逐字节保存正确；带空格、引号、中文、换行的标题均安全。**唯一不安全的是与控制语法同名**。

影响：`-h/--help` 是**静默丢失**——面板显示成功并关窗；`--` 是**写错文件 + 写错内容**；`--space` 是**写错关联**。三者都退出 0，`mod/store.js` 只看 `code === 0`，不校验 stdout 是否真的含有新建项。

严重度分歧已核对：PO reviewer 判 P1；面板 reviewer 判 P2；Validator 判 P2（理由是触发面收窄到确切 token）。本报告按**实际后果**定 P1：一条合法标题被静默丢弃/篡改，且三种形态都发生在最常用的「快速记录」路径上。修复很小：`command()` 把面板自己的 flag 放到**子命令之前**，在子命令之后插入 `--`：

```js
exec(cli, ["--json", "--by", "panel", "--file", path, args[0], "--", ...args.slice(1)], ...)
```

`parseArgs` 在 `--` 之后一律当位置参数；`-h` 只在子命令未确定时识别；`-`（stdin）也由此统一。注意不能把 flag 放在 `--` 之后——那样它们会变成位置参数。

### N-2 [P1] `mod/main.js:206-214,553,567` — F-18 未修：关联增删仍以 render 快照为准，注释与代码相反

`setSpaces(item, next)` 的注释写「这里按 id 现取一次最新账本，避免用 render 时的快照把别人刚加的关联覆盖掉」，但代码只是把闭包里的 `item.spaces` 拼成**绝对**的 `set-spaces` 发给 CLI：

```
seed spaces [A]; CLI: link t1 B  → [A,B]
面板（仍持有快照 [A]）加 C        → set-spaces t1 A C → 最终 [A,C]；B 静默消失，exit 0
同一秒内两次点击「加到 B」「加到 C」→ 两者都看到 [A] → 最终 [A,C]，B 丢失
```

时间线会记录 `[A,B] → [A,C]`，但普通用户不会去读时间线。触发窗口是面板 3 s watch 延迟与点击之间的正常并发，不需要任何异常条件。这是 plan 第 2 价值「关联准确」的直接违背，且是本轮把写通道从「进程内 update(fn)」换成「argv 字符串」后**加重**的（旧实现由 core 在最新状态上合并，新实现是绝对替换）。四个独立来源（我、PO reviewer、面板 reviewer、Validator）均复现。修复：在 `setSpaces` 内先 `await read()` 并按 id 取最新项；或改成增量 `link`/`unlink` 由 CLI 在锁内合并。

### N-3 [P1] `src/io.js:72-84,90-97` — 悬空符号链接被替换成普通文件（F-6 修复不完整）

```
mkdir -p /tmp/x1/{home,repo}; ln -s /tmp/x1/repo/todos.json /tmp/x1/l.json   # 目标不存在
HOME=/tmp/x1/h node bin/herdr-todo --file /tmp/x1/l.json add probe
exit=0
结果：l.json 是普通文件（含新数据）、repo/todos.json 不存在、链接消失
```

`lstat` 成功且 `isSymbolicLink()` 为真 → `realpath` 抛 ENOENT → 被本用于 `lstat` 的 `catch` 吞掉（`:80-81` 只对非 ENOENT 重抛）→ `target` 保持链接路径 → `rename(tmp, link)` 覆盖链接。有效链接（目标已存在）的同文件系统行为正确，因此这是**修复覆盖不到的分支**，不是旧行为原样。触发是 dotfiles 的常态（先建链接、目标尚未创建；或目标被删/未挂载）。严重度：P1（静默把链接换掉、数据分流；不销毁既有字节，故非 P0）。修复：悬空时 `readlink` 后按链接所在目录解析目标并写入，或直接报错；并补一条悬空链接测试。

### N-4 [P2] `src/core.js:271-284` + `src/cli.js:212-214,223,341-348` — 归档是第二套「关闭」表示，`reopen` 清不掉它

```
archive t1 → cancelled + archived
status t1 doing --reopen → exit 0，status=doing，archived 仍在
list        → 不显示（过滤 !i.archived）
list --all  → 显示
header      → "未处理 2"，但只渲染 1 行（summary 只按 status 计）
spaces      → 按 status 计数，说它有 2 项未处理
面板        → groupBySpace 只看 CLOSED_STATUSES，仍显示该项
```

没有任何 CLI 命令能清除 `archived`，只能手改 JSON。另外 `archive` 对 `done` 项会追加一条 `status done→done` 的空操作时间线（`core.js:281` 在条件分支之外）。严重度：P2（数据未丢、`--all`/`show`/`export` 可读，但用户会以为记录消失，且四处界面互相矛盾）。

### N-5 [P2] `mod/main.js:233-241,217-222` + `mod/store.js:23-32` — 「写成功、随后读失败」被当成失败，`add` 会诱导重复创建

`createFromDraft` 的顺序是 `await command(args); this.state = await read(); 清空草稿/关窗`。若 CLI 已落盘而面板 `readTextFile` 失败（>1 MiB、权限、瞬时 IO），`spawn` 捕获到的是读错误并设 `writeError`：草稿不清、弹窗不关，用户再按回车就**再建一条**。`mutate` 同理把「已写入」报成编辑失败。

可达性不靠外部工具：面板自己的多行备注每项上限 20 000 字，18 项 × 20 000 汉字 ≈ 1.08 MB，已经越过面板 1 MiB 读上限（CLI 写入无上限，实测 1.21 MB 写入成功）。修复：写入成功后先清草稿/关窗，再读（读失败降级为「刷新失败」提示），并区分读错误与写错误。

### N-6 [P2] `src/core.js:80-84,154-157` — 合法导入 id 可使 `seq` 溢出并生成重复 id，账本自锁死

```
seed {"id":"note-20261119123456789"}（17 位数字，合法字符串 id）
add a → exit 0（id t20261119123456788）
add b → exit 0，写入与上一条相同的 id
list  → exit 1 "事项 id 重复：t20261119123456788"
export→ exit 1；没有任何 CLI 命令能修复
```

根因是 `Number(String(id).replace(/\D/g,""))` 无安全整数上界，`seq+1` 在 2^53 附近成为空操作；更极端的 400 位 id 会让 `seq=Infinity` 被 `JSON.stringify` 写成 `null`。这与本轮回填的「id 重复就报错」形成闭环：校验只防读、不防写。严重度：P2（需要导入/外部写入的 id，但一旦发生即账本不可读）。

### N-7 [P2] `src/cli.js:329-339,301-318` + `:74` — `set-spaces`/`unlink` 用 `--space` 传参时静默清空全部关联

`--space` 进入 `opts.spaces`，而 `set-spaces` 只读 `rest`。`set-spaces t1 --space spC` → `next=[]` → 关联被清空、exit 0、无警告；`unlink t1 --space C` 同理。这是**一条命令把用户数据改错**，且与 N-1 同源的「值/键混淆」，但根因是命令实现只读一个来源，故单列。

### N-8 [P2] `src/cli.js:183` — `--file=`（空值）回退到真实默认账本

`createNodeStore(opts.file || defaultDataPath(env))`，`""` 为假值。`add q --file=` → 写入 `$HOME/.local/share/herdr-todo/todos.json`，exit 0。本轮新增的 `--file=` 支持（F-33）因此多了一个「写错文件」的入口；评审期间一名 Validator 正是踩中它写到了真实账本（见副作用披露）。修复：显式 `if (opts.file !== undefined && !opts.file.trim()) throw new UsageError(...)`。

### N-9 [P2] `src/core.js:69-78` — F-3 只修了一半：剩余静默强制转换仍会被下一次写落盘

已修：items 非数组、未知 status/priority、重复 id 会抛错。仍静默：`spaces:"sp1"` → `[]`（关联全丢）；`created:"yesterday"`/`updated:null` → `0`；timeline 非对象项被丢弃；`archived:"false"` → `Date.now()`（字符串为真值，直接把事项变成归档）；250 字标题 / 25 000 字备注在**读**时被切片，并在下一次无关写入时持久化。模块注释（`:31-33`）承诺「任何会把用户数据换成别的东西的情形都抛错」，这五类均不符。

### N-10 [P2] `scripts/install-layout.py:66-69` + `README.md:27` — 布局覆盖无备份

重跑安装会把用户手工调整的 `layouts/herdr-todo.json`（如 `panel.size`）恢复成默认值，`layouts/` 下没有任何 `.bak-*`；README 却承诺「被覆盖的文件都会先备份」。Validator 用 `size.px=500 → 320` 复现。修复：写 DST 前 `shutil.copy2` 到带毫秒戳的 `.bak`，或改 README 措辞。

### N-11 [P2] `install.sh:22-27,29-66` + `README.md:30` — 安装非事务：前置检查只覆盖三项

缺 `layouts/main.json` 时，步骤 1（同步 core）、2（CLI 链接）、3（mod + tabs 复制）已全部执行并覆盖用户修改，步骤 4 才 `die`，退出 1；步骤 5 不执行。README「缺任一项会在改动任何东西之前就退出」不成立。修复：把所有输入校验（`layouts/main.json`、`mod/tabs/mod.json`、`todo.svg`、写权限）前移到步骤 1 之前。

### N-12 [P2] `scripts/install-keys.py:71-73,113` + `install.sh:69-79,87-92` — 快捷键被占用时仍退出 0，安装末尾照常宣传

全局已有 `ctrl-alt-n` 时，脚本打印「跳过 … 已被 … 占用」并 `return 0`；`install.sh` 的 `KEYS_OK=1`，最后仍打印「安装完成」并列出「ctrl-alt-n 打开快速记录弹窗」——该键实际打开 Help。这是 F-26「不宣传未必存在的快捷键」的残留：只区分了硬失败，没有区分「跳过」。

### N-13 [P2] `scripts/install-keys.py:100-108` — keys.json 为跨文件系统符号链接时 `os.replace` 抛 EXDEV

临时文件写在链接旁，目标 `realpath` 在另一文件系统（iCloud/挂载卷/磁盘映像）。Validator 用 APFS 磁盘映像复现：

```
OSError: [Errno 18] Cross-device link: '…/keys.json.tmp' -> '/…/real-keys.json'
exit=1；keys.json.tmp 残留；真实目标未更新
```

代码注释声称支持符号链接，但只在同文件系统成立。修复：临时文件写到 `os.path.dirname(target)`，或 `EXDEV` 时回退 `copyfile+unlink`。

### N-14 [P2] `src/core.js:76,88-90` + `src/cli.js:132-152` + `mod/main.js:82-102` — 时间线条目类型校验不足，`show` 直接 TypeError

`isTimelineEntry` 只校验 `kind` 是字符串、`at` 可转数字。合法 JSON `{"kind":"spaces","from":null,"to":"spA"}` 会通过，随后 `describeEntry` 的 `(e.to || []).join(",")` 抛错：

```
show t1 → exit 1 "herdr-todo: (e.to || []).join is not a function"
list/export → exit 0；下一次 status 写入原样保留该条目；show 仍然失败
```

CLI 自身不会产生这种形状（`link` 写的是数组），触发者是手改/第三方导入的账本；`mod/main.js` 有同一表达式，选中该项时面板 render 会抛（未驱动真实 App，代码级）。严重度 P2（只读命令失败、无数据丢失），但两份 `describeEntry` 必须一起改。

### 表 2：其余已确认的 P3（非阻塞，但都是本轮的修复/新架构留下的）

| ID | 锚点 | 问题 | 证据 |
|---|---|---|---|
| N-15 | `install.sh:10,16-20` | 备份戳只到秒，同一秒两次安装时第二次覆盖第一次备份，用户原始修改不可恢复 | `/tmp` 内两次连跑，只剩一个 `.bak`，内容为第二次安装后的版本 |
| N-16 | `install.sh:35-39` | 目标是真实目录时 `ln -sfn` 把链接建到目录**里面**，脚本仍打印成功、exit 0 | 预建 `bin2/herdr-todo/` 目录，链接落在 `bin2/herdr-todo/herdr-todo` |
| N-17 | `install.sh:4,85` | `set -u` 下无 `HOME` 时，五个步骤全部成功后最后一行 `HOME: unbound variable` 使退出码变 1 | `env -u HOME … sh install.sh` |
| N-18 | `install-layout.py:46-53` | `main.json` 已有 `todo-block` 但指向别的 mod 时，保留该子节点并设为 active，布局加载错 mod | 合成 `content.mod:"some-other-mod"`，输出 active=todo-block |
| N-19 | `src/io.js:119-142` | 无 owner 文件的锁目录只能等 10 s 陈旧回收：第一次写等 5 s 后 exit 3，提示「其他进程正在写入」；`mkdir` 成功后 owner 写失败也会留下同样的孤儿锁（注释却说「owner 写失败不该让写操作失败」） | 预建 `.lock`：5.09 s / exit 3；10.5 s 后自愈 |
| N-20 | `src/io.js:91` | `writeFile(...,{mode})` 仍被 umask 掩码：0664 账本在 umask 022 下变 0644 | 三种 umask 实测；0600 保持不变 |
| N-21 | `src/io.js:90-97` | 无 fsync；SIGKILL 在写入与 rename 之间留下 `.tmp` 与 `.lock`，原文件完好但下次写被 N-19 阻塞 | 25 MB 临时文件残留，原 JSON 仍可解析 |
| N-22 | `src/io.js:210-216` | `createMemoryStore.update` 缺 Promise 检查，`async` mutate 会把账本替换成 `{}`（node store 已拒绝）。该 store 无调用方，属潜伏 | 直接调用复现 |
| N-23 | `mod/main.js:155,192-195` | `writeError` 只在一次**成功写入**后清除；一次失败的写之后若只有成功的读，错误提示永久残留 | 逻辑复刻；普通读错误不会设置它 |
| N-24 | `install.sh:7` + `mod/store.js:18,73-75` | 自定义 `HERDR_TODO_BIN_DIR` 不在 App 的 PATH 时，面板两个候选都找不到，报「请先运行 install.sh」 | 静态；未启动真实 App |
| N-25 | `scripts/install-keys.py:48-64` | keys.json 顶层/分区形状异常时抛裸 TypeError 栈（exit 1，未损坏文件） | `{"global":["a"]}`、`[1,2]`、`{"global":"x"}` |
| N-26 | `scripts/sync-core.sh:13-22` | `shasum` 缺失时写出空哈希头并 exit 0；哈希无任何消费方（仅写入方与 plan 提及） | PATH 剥离后实测；全仓 grep 仅 `sync-core.sh:17` 与 `mod/core.js:2` |

---

## 未决风险与覆盖缺口

- `mod/main.js:94-98` — N-14 的面板侧表现（选中含畸形时间线条目的事项时 render 抛错）为代码级推断；`herdr-app check` 不执行数据相关渲染，无法作为证据。需要一次真实 `mod.open` + 点击。
- `mod/store.js:54-75` — `exec` 的「超时」与「程序不存在」被同一个 `catch` 合并，两者都落到下一个候选；两个候选又常常是同一个文件（`~/.local/bin/herdr-todo` 与 PATH 命中同一路径），超时可能导致同一条写被执行两次。机制确定，需构造 >20 s 的挂起才能实测，标 `PLAUSIBLE`。
- `src/io.js:110-142` — 陈旧锁抢占窗口（mtime > 10 s）在真实环境需 >10 s 停顿（SIGSTOP/调试器/NFS）；注入版已复现两个写者同时在临界区且一次更新无声丢失。生产可达性未证，标 `PLAUSIBLE`（上轮 F-28 的残余）。
- `src/io.js:62-63` vs `:93` — CAS 比对与 rename 之间无再校验；这是上面同一并发根因的另一半，修复需与 F-28 一并考虑。
- `mod/main.js:162-178` — `watch()` 循环里的 `await this.load()` 在 `try` 之外，spawn 上下文失效异常会逃出无限循环；未驱动真实 App，未分级。
- `mod/main.js:299-303,317-319` — >1 MiB 时面板进入「一直报错 + 继续用旧快照点按钮」的状态；N-5 已覆盖其数据后果，这里记录的是 UI 侧无恢复入口。
- 平台与持久化：Windows 路径、断电持久化（无 fsync）未验证，目标平台为 macOS。
- **一条不适用于本轮的 Validator 结论**：`InputState.new during render` 的 P1 判定针对的是 2026-11-18 19:16 的旧树（`mod/main.js` 当前 mtime 20:05），当时 `renderNoteEditor` 在 render 中建状态。当前代码在点击处理器里建 `TextareaState`（`mod/main.js:610-615`），该判定已被 F-1 的修复取代，本报告不采信。
- `mod/mod.json:4` + `mod/main.js:259-303` — 退出码 2 的 stderr 是「消息 + 约 30 行 USAGE」，而弹窗固定高 128 px；按渲染树推算错误行只剩约 11 px，用户可能只看到被裁掉的用法文本而看不到原因。面板 reviewer 给出布局算术但未能截图，未验证，标 `PLAUSIBLE`。
- 真实打包/安装只在 `/tmp` 副本验证；`sync-core.sh` 会改写仓库的 `mod/core.js`（见副作用披露），未对真实仓库重跑安装。

---

## 存量问题与范围外建议

只列能减少代码量、消除重复实现或替换成标准库/宿主原语的项，不含风格问题。

1. **`parseArgs` 换 `node:util` 的 `parseArgs`**（`src/cli.js:55-84`）。手写解析器同时承担「flag 任意位置」「`--key=value`」「`--` 终止」「`-`=stdin」四种语义，是 N-1/N-7/N-8 的共同温床。`util.parseArgs({ allowPositionals: true, strict: true })` 能覆盖 `--key=value`、`--` 与未知选项报错；配合面板侧插入 `--`，可删掉约 30 行并让「用户文本 vs 选项」的边界由运行时定义而不是手写分支。
2. **`describeEntry`、状态文案/图标/配色各两份**（`src/cli.js:132-152` 与 `mod/main.js:82-102`；另一组在 render 中）。这是 N-14 必须改两处的原因。`core.js` 已经在同步，建议把纯函数 `describeEntry` 并入 core（无宿主依赖），词表同理；或把同步脚本扩展为两个文件。
3. **死代码/死开关**：`src/io.js:9` `MAX_ATTEMPTS` 从未被读；`src/io.js:193-218` `createMemoryStore` 无调用方且语义与 node store 不同（N-22）；`src/core.js:376-378` `sortByRecent` 无调用方；`src/cli.js:11` 引入的 `groupBySpace` 未使用；`src/cli.js:168-174` `resolveSpaceArg` 是永远返回字面量的 `async` 空壳（且 `storeStateSpaces` 恒为 `null`）；`mod/store.js:54,64` `lastError` 只写不读；`mod/main.js:122` `this.p`、`:136` `saveHint`、`:441` `const overdue = false` 均为死代码。删除这些可让 F-10/F-16/N-1 的语义不再有三种说法。
4. **`mod/store.js:18` 的候选列表把同一个二进制列两次**：`~/.local/bin/herdr-todo` 与 PATH 上的 `herdr-todo` 在默认安装下是同一个文件。去掉重复可以让超时/失败只发生一次，也让 `CliMissingError` 的文案不再列两个等价路径。
5. **`button()` 用 `Math.random()` 生成元素 id**（`mod/main.js`）：每次渲染都变，元素身份与命中测试不稳定，UI 自动化无法按 id 定位。用「语义前缀 + 稳定序号」（如 `todo-btn-<itemid>-<action>`）即可，是纯减法。
6. **`sync-core.sh` 的哈希头没有消费方**：要么在 `npm test` 里加一条「`mod/core.js` 头部哈希 == `src/core.js` 的 sha256」断言（同时让 CI 真的有漂移检测），要么删掉这行与 `scripts/sync-core.sh:13` 的 `shasum` 依赖；当前形态既无检查又会在 `shasum` 缺失时静默写空（N-26）。
7. **重复的路径拼接**：`src/io.js:26-29` 的 `path.join(home, ".local","share","herdr-todo","todos.json")` 与 `mod/store.js:16` 的模板字符串各写一份，`mod/store.js:78-80` 又用正则反推目录。路径常量应只有一处定义（同步文件），否则改路径时两个进程会各写各的。
8. **`install.sh` 的备份/事务**：`backup()` 是「逐文件 `cp -R` + 秒级时间戳」，既不能覆盖布局（N-10），也不能回滚半装（N-11）。更简单可靠的形态是「整目录复制到 `<APP_HOME>.bak-<ms>` 一次 + 全部校验前置 + 失败时 `trap` 回滚」，能删掉 5 处零散 `backup` 调用与 `KEYS_OK` 的两段式收尾。
9. **`.agent/herdr-todo/workspace/panel.png` 与 `panel-folded.png` 字节完全相同**（均 48 284 字节）：plan:87 声称的「默认折叠」证据图并未体现折叠，建议重拍或删除其一。

---

## 附录 A：F-1～F-34 复审判定

`FIXED` 20 / `PARTIALLY_FIXED` 9 / `NOT_FIXED` 5 / `NOT_APPLICABLE` 0。每条均以当前代码与 /tmp 复现为准，未采信作者补记。

| ID | 上轮 | 本轮 | 证据锚点 |
|---|---|---|---|
| F-1 | P1 | **FIXED** | `mod/main.js:610-615` 在点击处理器创建 `TextareaState`；render 路径仅使用（`:582`）。 |
| F-2 | P1 | **FIXED** | `mod/store.js:5` 注释外无 `writeTextFile`；所有写经 `command()` → CLI 锁。新架构自身缺陷见 N-1/N-2/N-5。 |
| F-3 | P1 | **PARTIALLY_FIXED** | 非数组 items/未知状态优先级/重复 id 已抛错（`core.js:45-68`）；spaces/created/updated/archived/timeline/截断仍静默（N-9）。 |
| F-4 | P1 | **FIXED** | 先写 global 再清理布局副本，清理需 `combo in landed`（`install-keys.py:101-105`）；global 被占时布局副本保留，exit 0。残留「跳过仍宣传」见 N-12。 |
| F-5 | P1 | **FIXED** | `io.js:26-29` 不再读 XDG；`tests/io.test.js:16-24` 断言忽略 `XDG_DATA_HOME`。 |
| F-6 | P1 | **PARTIALLY_FIXED** | 有效链接与权限已保留（`io.js:72-79`）；悬空链接仍被替换（N-3）。 |
| F-7 | P1 | **FIXED** | `cli.js:271-285` 无文本即 `UsageError`（exit 2），备注不变。 |
| F-8 | P1 | **FIXED** | `main.js:167-174` 失败后 `await cx.sleep(3000)`。 |
| F-9 | P1 | **FIXED** | `store.js:23-32` 仅 ENOENT 视为空；其余读失败上抛并在 UI 显示。>1 MiB 的后续残留见 N-5。 |
| F-10 | P2 | **NOT_FIXED** | `cli.js:168-174` 仍返回 trim 后的字面量；`--space "my space name"` 原样入库。plan:54 要求名称模糊匹配。 |
| F-11 | P2 | **PARTIALLY_FIXED** | README:99 已写 0/1/2/3，plan:55 仍写 0/1/2；「找不到」仍分裂：`show` → 2，其余 → 1（实测）。 |
| F-12 | P2 | **FIXED** | `link t1 sp1 --json` 输出 JSON 对象、exit 0。 |
| F-13 | P2 | **FIXED** | 排序为状态→优先级→更新时间；测试名与行为一致。 |
| F-14 | P2 | **FIXED** | `archive` 分支与 `archiveItem` 存在；功能本身的缺陷见 N-4。 |
| F-15 | P2 | **FIXED** | 重复 id 读取即抛错（exit 1）；但分配器仍能制造重复（N-6）。 |
| F-16 | P2 | **NOT_FIXED** | `MAX_ATTEMPTS` 无读方；「重试耗尽」测试删掉后仍 9/9 通过（Validator 变异）。 |
| F-17 | P2 | **FIXED** | node store 对 async mutate 抛错且不落盘；memory store 仍缺（N-22，死代码）。 |
| F-18 | P2 | **NOT_FIXED** | `set-spaces` 仍由 render 快照构成绝对列表；注释声称现取最新账本，代码没有（N-2）。 |
| F-19 | P2 | **FIXED** | `busy` 同步置位、`finally` 清除（`main.js:226-241`）。 |
| F-20 | P2 | **FIXED** | `commitNote` 只在 `onDone`（写+读成功）清编辑器（`:625-631`）。 |
| F-21 | P2 | **FIXED** | 备注编辑器为 `TextareaState` 多行（`:613`）。 |
| F-22 | P2 | **PARTIALLY_FIXED** | mod/tabs 已备份（`install.sh:45-48,54-58`）；布局无备份（N-10）；秒级戳会互相覆盖（N-15）。 |
| F-23 | P2 | **FIXED** | 原全角分号行已消除；同类新实例（`:85` `$HOME`）见 N-17。 |
| F-24 | P2 | **NOT_FIXED** | 哈希无消费方；`shasum` 缺失时写空哈希并 exit 0（N-26）。 |
| F-25 | P2 | **PARTIALLY_FIXED** | install-keys 已改毫秒戳（`install-keys.py:96-99`）、同 FS 符号链接保留；跨设备 EXDEV（N-13）；install.sh 仍秒级（N-15）。 |
| F-26 | P2 | **PARTIALLY_FIXED** | `KEYS_OK` 门控与缺 tabs/mod.json 的 `die` 已加；被占用的键跳过仍 exit 0 并宣传（N-12）。 |
| F-27 | P2 | **PARTIALLY_FIXED** | 前置要求已写入 README；「改动任何东西之前退出」不成立（N-11）。 |
| F-28 | P2 | **PARTIALLY_FIXED** | owner token 已加、释放安全；陈旧抢占仍可双写（未决风险）。 |
| F-29 | P2 | **PARTIALLY_FIXED** | 布局 `active=todo-block` 已生效；terminals/win98 仍无 `panel` 节点而全局绑定 `layout.toggle{id:panel}`。 |
| F-30 | P2 | **FIXED** | `override`/`expanded` 使点击权威，分组可折叠。 |
| F-31 | P2 | **FIXED** | `load()` 仅在 `!writeError` 时清错；残留 N-23。 |
| F-32 | P2 | **FIXED** | 顶部与底部都用 `closed.length`。 |
| F-33 | P2 | **FIXED** | `--file=/path` 可用；空值回退默认账本是新边（N-8）。 |
| F-34 | P2 | **NOT_FIXED** | 时间线仍按墙钟排序：`status=blocked` 而最后一条时间线是 `doing`（复现）。 |

---

## 附录 B：测试有效性（两项自检）

**「破坏行为」**（在 /tmp 副本上逐项注入，跑 `npm test` + `sh tests/cli.test.sh`）：

- **能抓住**：删除锁目录（CLI 并发用例失败）；反转 `sortItems` 状态序（core 1 红）；删除 reopen 门（core 1 红 + CLI 红）；时间线降序（6 红）；`setStatus` 不更新 `updated`（1 红）；`archiveItem` 不写 `archived`（2 红）；删除 `link/unlink` 的断言路径（CLI 红）。
- **抓不住（注入后两套测试全绿）**：删除重复 id 守卫、非数组 items 守卫、未知状态守卫、`seq` 恢复（`max(raw.seq, maxSeq)`）、lstat/realpath 权限与符号链接块、owner token 校验、`note` 必须带文本守卫、退出码映射（2/3 全压平为 1）、`busy` 防重复、`list` 的 `!i.archived` 过滤、`set-spaces` 的 `--json` 分支、`--by` 角色、`MAX_ATTEMPTS`、`staleLockMs` 降到 1 ms、临时文件名计数器不自增、`writeFile` 去掉 `mode`。
- 结论：测试套件对「核心变形逻辑」有一定保护，但对**本轮新增的写入路径与边界**（面板 argv、`--file=`、归档/重开、锁与权限、退出码、安装脚本）几乎没有保护；`cli.test.sh` 只判断零/非零，不检查具体退出码，也不断言 JSON 形状。

**「纯内部重构」**：重命名 `logEntry`、给 `describeEntry` 加注释、更换临时文件命名方案 —— 两套测试保持全绿，说明测试没有绑定内部结构，属于合格性质。但同一事实也意味着：**临时文件命名里的真实错误（去掉计数器仍绿）无法被发现**，即「重构友好」与「行为覆盖不足」在这里是同一枚硬币。

**用例计数**：`npm test` = `tests/core.test.js` 24 + `tests/io.test.js` 10 = 34 例；`tests/cli.test.sh` 11 条 `pass`（10 条正向行为 + 1 条聚合的「错误路径均按预期失败」，后者只断言非零退出，不查具体码）。「6 个并发进程」用例是唯一的多进程并发断言。

**完全未覆盖的新逻辑**：`mod/*`（argv 组装、`command()` 的退出码映射、超时回退、`read` 的 1 MiB 分支、`setSpaces` 快照）、`install.sh` 与三个脚本、`sync-core.sh`、N-4/N-6/N-7/N-8/N-9 的全部路径。建议最小补齐：面板 argv 的 `-h/--/--space` 三例、`--file=` 空值、归档→重开→list 计数、seq 溢出、悬空链接、退出码 2/3 各一例。

---

## 附录 C：评审执行记录与副作用披露

**派出的 reviewer / validator**（全部为本模型独立 subagent，明确只读；无 peer 模型，按 tdsql-cr 回退约定）：

| 角色 | 覆盖 | 结果 |
|---|---|---|
| Proof Obligations reviewer（固定 prompt 原文） | 16 个改动函数 + 4 个脚本，O1–O20 全量见证 | 20/20 完成；9 条 candidate-defect、11 条 closed |
| 面板运行时 reviewer | `mod/main.js`、`store.js`、`core.js`、`mod.json`、`tabs/main.js` + callee | 7 条候选（argv、超时回退、写后读失败、快照、1 MiB、错误展示、孤儿锁） |
| core/io/cli reviewer | `src/*`、`bin`、tests | 17 条候选（seq、锁与 CAS、权限、fsync、悬空链接、`--file=`、退出码、测试） |
| 安装/文档 reviewer | `install.sh`、`scripts/*`、`README`、plan 对照 | F 表 + 9 条新缺陷（备份、事务性、EXDEV、形状校验等） |
| Validator 批 1（C1–C12 + F 表） | 数据模型/CLI/安装候选 | 12/12 CONFIRMED；F-1..F-34 独立复核 |
| Validator 批 2（V1–V15 + 5 条测试结论） | 安装、锁、权限、内存 store、`-h` | 15/15 CONFIRMED（V1 降 P3） |
| Validator 批 3（X1–X3） | 悬空链接、时间线条目、归档粘滞 | 3/3 CONFIRMED；X1 定 P1，X2/X3 定 P2 |

共 **4 个 reviewer + 3 批 validator（30 条候选）+ 1 个辅助状态恢复 agent**；无派发失败。降级：无 peer 模型（同模型独立 context）；无真实 App UI；`herdr-app check` 只在 /tmp 副本；安装脚本只在 /tmp 副本；Validator 批 2 首次输出过大后被重新读取，结果未变。

**副作用披露**（按只读约定逐项）：

1. **真实账本曾被误写并已恢复**。评审早期，一个 shell 循环把字面量 `"--"` 当作标题，`parseArgs` 将其视为终止符、吞掉了 `--file /tmp/...`，从而向 `~/.local/share/herdr-todo/todos.json` 写入 t12–t15；另一名 subagent 也用同形态的 `--` 探测写入了 t11。这直接演示了 N-1 的「`--` 重定向到默认账本」。已快照后删除 t11–t15、将 `seq` 恢复为 10，并保留 App/面板在 09:53 对 t6 产生的两条真实状态变更。当前文件：4 条（t6–t9）、`seq=10`、5 095 字节、无 `.lock`/`.tmp` 残留。此后所有探测均带显式 `--file /tmp/...` 与 `HOME=/tmp/...`，并已把该规则写进两名 Validator 的强制安全约束。
2. **`mod/core.js` 被确定性地重写过一次**（sync-core 探测），当前 SHA-256 `97b93268…`、内容与评审前快照逐字节一致，头哈希 `5521d24e…` 与 `src/core.js` 相同，仅 mtime 变化（11-19 10:19）。源码其余哈希未变：`src/core.js 5521d24e…`、`src/cli.js a4cc027f…`、`src/io.js d30216f2…`、`mod/store.js f653ffe9…`、`mod/main.js 10fcf577…`。
3. 未修改 `~/.config/herdr-app` 下任何文件；未 commit/push；仓库内未新增文件（复核 `find` 无 `gpui-kit.d.ts`/`jsconfig.json` 等生成物）。
4. 唯一写入的评审文件是本报告 `ultra-review-2.md`。
