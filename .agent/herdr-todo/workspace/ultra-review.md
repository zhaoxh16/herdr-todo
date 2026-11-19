# 深度代码评审报告 — herdr-todo

评审日期：2026-11-18
评审对象：`/Users/zxh/workspace/herdr-todo`（非 git 仓库；「本次变更」＝交付的全部文件）

## 结论与范围

> **修复状态（2026-11-18 20:20，评审之后补记）**：9 条 P1 全部修复并逐条复验；F-10～F-33 中影响数据与易用性的部分已修（archive、排序、`--by`、`--json`、退出码、`--file=`、锁 owner token、Promise 拒绝、install.sh 备份与前置检查、布局默认显示 Todo）。未修项与覆盖缺口见文末「修复后仍未处理」。原始报告正文保持发布时的原样，便于对照。

**NEEDS_CHANGES** —— 存在多条经独立复现确认的 P1：备注编辑器在 render 中创建 `InputState` 会直接抛错；CLI 与面板的跨写者更新会静默丢失；`normalizeState` 会把合法 JSON 但字段异常的数据规范化后写回，造成整份账本丢失；`install-keys.py` 在全局键被占用时会删掉用户原本可用的布局绑定；`note <id>` 省略文本会静默清空备注；原子 rename 会把 0600 权限放宽到 0644 并把符号链接换成普通文件；面板首次打开（数据目录不存在）会空转热循环；data 文件超过 1 MiB 时面板显示「空账本」且所有编辑失败。

- 被审版本与目标：工作区全量交付（`src/`、`mod/`、`scripts/`、`install.sh`、`tests/`、`README.md`）。批准合同为 `.agent/herdr-todo/plan.md`；`activity.md` 只当作已知改动线索，**未采信其中「已修复」结论**，下列每条均由独立 reviewer/validator 重新取证。
- 实际覆盖：`src/core.js`、`src/io.js`、`src/cli.js`、`bin/herdr-todo`、`mod/main.js`、`mod/store.js`、`mod/core.js`（与 src 逐字节比对）、`mod/mod.json`、`mod/tabs/main.js`、`scripts/sync-core.sh`、`scripts/install-layout.py`、`scripts/install-keys.py`、`install.sh`、`tests/*`、`README.md`，以及宿主契约 `~/.config/herdr-app/{herdr.d.ts,gpui-kit.d.ts,AGENTS.md}` 与已安装的 mods/layouts/keys（只读）。
- Proof Obligations：**已完成**。固定 reviewer 逐函数做契约分析，建立 50 条 obligation（O1–O50），逐条给出见证/结论；25 条 candidate-defect、25 条 closed-no-defect，无未审查分支。原始记录见本文附录与其完整输出。
- 执行方式：无 peer 模型可用，按 `tdsql-cr` 的回退约定，全部使用本模型的独立 subagent；所有 reviewer/validator 均被要求只读、只在 `/tmp` 做探测。
- 重要限制：未在运行中的 App 里真实 `mod.open` 做点击（会改动 `~/.config/herdr-app` 状态），涉及纯 UI 时序的结论（焦点、裁剪、折叠）只能按代码/契约推断，已单列；`writeTextFile` 的读/写 1 MiB 上限与「文件已存在时 expected=null 必被拒」已由 validator 在真实宿主上取证。

## 当前变更缺陷

以下只列 `CONFIRMED`，按影响排序；同一问题只出现一次，并注明不同 reviewer 的分级差异。

### P1

- **F-1** [P1] `mod/main.js:539`（`renderNoteEditor`）— 在 render 中创建 `InputState`，点击「编辑备注」后整个面板渲染失败

  点击「编辑备注」后 `noteEditingId` 被设置、`noteDraft` 置 null（`:567-570`），下一次 render 进入编辑分支，在 render 内执行 `InputState.new(...)`。`gpui-kit.d.ts:21380-21383` 明确要求「`InputState.new(...)` … never in `render`」，宿主在运行期强制。validator 用 `/tmp` 副本预置一条事项并设 `noteEditingId`，`herdr-app check` 报 `InputState.new(...) cannot run during render` 并失败；未改动副本的对照 `check passed`。异常逃出整个 `render`（无 try/catch），`noteEditingId` 保持，后续每次渲染继续抛错。备注编辑是 plan:59 的交付项，用户看到的就是「点了没反应」。

- **F-2** [P1；PO reviewer 判 P0] `src/io.js:55-73` ↔ `mod/store.js:41-67` — CLI 与面板的跨实现写入会静默丢失更新

  CLI 侧 `write()` 在 `:57-58` 读文件比对 `expected`，`:67` 才 `rename` 覆盖；中间无复检。`withLock`（`:81-114`）只序列化同样使用 `${abs}.lock` 的 CLI 进程，mod 侧是 lock-free 的 `writeTextFile` CAS（`mod/store.js:55`），完全不参与。交错：两端都读到 R → 面板 CAS 写入 R' → CLI 比对仍是 R 通过 → CLI rename 覆盖 R'，双方都报成功。validator 在副本中于比对与 rename 之间注入 300ms，确定性复现「最终只剩 CLI 条目、面板条目丢失、无任何报错」；另一独立 validator 用真实 `bin/herdr-todo` 进程对面板式写者跑 300 轮，也出现双向丢失。mod reviewer 将其列为 P0（其「宿主内部是否单步」一节未能实测），PO reviewer 亦为 P0；两名 validator 独立判 P1，本报告取 P1。后果直接违反 plan:22 的「数据不丢」与 README:108-109 的「并发写入不会互相覆盖」。

- **F-3** [P1] `src/core.js:37, 49-54` — `normalizeState` 对「合法 JSON、异常形状」静默降级并写回，导致整份账本丢失

  `const items = Array.isArray(raw.items) ? raw.items : [];`：`items` 为对象/字符串/null 时直接变成空表，不报错（与 `:28` 注释「坏数据不静默丢弃」相反）。同一处还把未知 `status` 强制成 `todo`、未知 `priority` 强制成 `P2`、非数组 `spaces` 变 `[]`、非法 timeline 条目 filter 掉。validator 实测：文件 `{"v":1,"seq":5,"items":{"t1":{...}}}` 上执行一次 `add` → exit 0，文件被重写成只剩新增的一条，原 t1 彻底消失；`status:"Done"` 被改写成 `todo` 并持久化，已完成事项重新变成待办。触发源是外部写入/手工编辑/合并恢复，但下一次任何 CLI 或面板写入都会把降级结果固化。

- **F-4** [P1] `scripts/install-keys.py:63-69` — 先删布局分区里「与默认相同」的绑定，再尝试写 global；global 被占用时用户唯一可用的快捷键被删且不恢复

  清理循环先于 `:71-82` 的补写循环。实测 keys.json 为 `global.ctrl-alt-n=app.help` + `layout:herdr-todo` 里两条正确绑定时：脚本删掉两条布局副本，再「跳过 global ctrl-alt-n：已被 app.help 占用」，退出码 0；结果 ctrl-alt-n 什么都不打开，报告行「与 global 默认绑定重复」还是假的（global 并非默认值）。`ctrl-alt-t` 同理。直接违反 README:53-55「不会覆盖你的设置」与脚本自己的注释。上游 reviewer、PO、两个 validator 均 CONFIRMED。

- **F-5** [P1] `src/io.js:21-24` ↔ `mod/store.js:8`（`README.md:106`）— 设置 `XDG_DATA_HOME` 时 CLI 与面板读写不同文件

  CLI 的 `defaultDataPath()` 遵循 `XDG_DATA_HOME`，mod 的 `DATA_PATH` 硬编码 `${home()}/.local/share/herdr-todo/todos.json`。validator 实测 `XDG_DATA_HOME=/tmp/xdg herdr-todo add` 后 CLI 写入新路径，面板仍读旧路径，两边都成功、无任何提示；`install.sh:60` 也无条件打印非 XDG 路径。README 同时承诺「共用同一份数据」与「可用 XDG_DATA_HOME 覆盖」，二者不可能同时成立。安装 reviewer 与 plan-conformance reviewer 独立判 P1，PO 为 P2；取 P1（核心卖点静默 split-brain，且只在用户显式配置时触发）。

- **F-6** [P1] `src/io.js:64-67` — 原子写的 rename 丢失文件权限并替换符号链接

  temp 文件用默认 mode 创建（0666 & umask → 644），`rename` 整体替换 inode，既不改回原 mode，也不解析 symlink。实测：`chmod 600 todos.json` 后任意一次写入即变 644；`--file link.json` 指向符号链接时，写入后 link.json 变成普通文件、真实目标仍是旧内容，后续写入全部落到分叉出来的新文件。备注是明文存储，权限放宽有隐私影响；dotfiles/备份用户会遇到不可见的分叉账本。

- **F-7** [P1] `src/cli.js:260`（及 `:29, :66-68`）— `note <id>` 省略文本会静默清空备注；`--file` 在 note 用法中与 store 路径冲突

  `opts.note ?? rest.slice(1).join(" ")` 缺省为 `""` 并调用 `setNote`；实测 5 字备注变 `""`，时间线只记录 `{length:5}→{length:0}`，正文不可恢复（README:99 自述只记长度）。另外 USAGE 第 29 行写 `note <id> [--file <路径> | -]`，但 parseArgs 把 `--file` 一律当数据文件；`note t1 --file notes.md` → 「数据文件不是合法 JSON」，exit 1，文档承诺的操作无法完成。

- **F-8** [P1] `mod/main.js:156-168` — watch 循环在 `watchFolder` reject 时无任何退避，首次打开面板即空转

  `for(;;){ try{await watchFolder(dir)}catch{} await this.load() }`，注释声称「等下一次轮询」，实际没有任何等待。validator 在真实 App 中探测：数据目录不存在时 500ms 内 `watchFolder` 抛错 20927 次，每次还伴随一次 `readTextFile` + `notify()`。`install.sh` 不创建数据目录，`~/.local/share/herdr-todo` 只在第一次写入时出现，因此全新安装第一次打开面板就会持续空转，直到有写入为止。

- **F-9** [P1] `mod/store.js:14-20`（配合 `:41-67`、`herdr.d.ts:27`）— 读失败一律当「文件不存在」，超 1 MiB 时面板显示空账本且所有编辑失败

  `readRaw` 把**所有** `readTextFile` reject 都映射成 `null`。validator 在真实宿主取证：1 MiB 以上时 `readTextFile` 报 `Text file exceeds 1 MiB`（write 同样有上限），文件已存在时 `writeTextFile(path, body, null)` 被拒（宿主不会覆盖，报 `The file changed outside Herdr…`）。于是 1 MiB+ 的账本让面板渲染成「未处理 0」、`this.error === null`，任意编辑重试 6 次后报「一直被其他进程改写」（误导性原因），且面板永远无法修复该文件——而这样的文件 CLI 完全能写出来（200 条 × 6KB 备注 ≈ 1.51 MiB，已实测）。

### P2（已确认，按影响排序）

- **F-10** [P2] `src/cli.js:160-163` / `README.md:76` — `--space` 不做名称解析，原样存字符串
  plan:54 要求 `<id|名称>` 模糊匹配；实现 `return String(arg)`。README 第 76 行示例还是截断 id `dev5/sp57d5466`（真实 id 更长），照抄示例会把事项放进「space 已不存在」组；`--space ""` 也会存 `[""]` 并归入该组（`src/core.js:128` 缺 `filter(Boolean)`）。关联准确是 plan 的第二优先价值。

- **F-11** [P2] `src/cli.js:334-344` + `:224/:272/:285` vs core 的 `not_found` — 退出码与 plan 不符，且「找不到」自相矛盾
  plan:55 是 0/1(用法)/2(冲突)；实现是 0/1(运行时)/2(用法)/3(冲突)，README:91 记录的是实现。更麻烦的是 `show`/`link`/`unlink` 的 not-found 走 `UsageError`→2，`status`/`priority`/`note` 的 not-found 由 core 抛 `TodoError`→1；脚本无法可靠区分。

- **F-12** [P2] `src/cli.js:276, :291` — `link`/`unlink` 忽略 `--json`
  README:89 承诺「所有命令都接受 `--json`」；这两条永远输出人类文本且 exit 0，脚本会静默拿到不可解析输出。其余命令均正确。

- **F-13** [P2] `src/core.js:246-254`（`tests/core.test.js:228`）— 排序与 plan 相反
  plan:58 是「状态→优先级→更新时间」，实现先比优先级后比状态，测试还把该行为固定成断言。README 未声明顺序。需要二选一并同步 plan/测试。

- **F-14** [P2] `src/cli.js`（无 `archive` 分支）/ `src/core.js`（无 `archiveItem`）— plan:46/53 的归档能力缺失
  `archive t1` → 「未知命令」exit 2；core 也没有 `archiveItem`/`updateItem`/`pendingCount`。属于交付范围缩减但未修订 plan/README（README 同样未提）。

- **F-15** [P2] `src/core.js:37-56, 101-108` — 不校验 id 唯一性，重复 id 只改第一条
  `findIndex` 命中第一条；实测两条 `t1` 时 `status t1 done` 只翻转第一条，另一条永远无法按 id 触达。触发源是外部合并/手工编辑，失败方式为静默部分修改。

- **F-16** [P2] `src/io.js:120-139` + `tests/io.test.js:88-103` — Node store 没有重试，测试名「重试耗尽」名不副实
  `update()` 只有一次尝试，`maxAttempts` 从未被读取，`MAX_ATTEMPTS`（`:9`）是死导出；该测试完全依赖仅供测试的 `_beforeWrite` 钩子（`:135`）。validator 实测：删掉 `maxAttempts: 1` 测试仍全绿；真实 CLI 撞上冲突时 43/300 轮直接 exit 3 而不重试。反过来 `tests/io.test.js:57-71` 声称模拟 CLI 与 mod 并发，实际两个写者都是持同一把锁的 `createNodeStore`，无法发现 F-2。

- **F-17** [P2] `src/io.js:133-137` / `mod/store.js:51-52` — `mutate` 若返回 Promise，会把文件写成 `"{}"`
  `JSON.stringify(Promise)` → `{}`，实测确实覆盖数据文件。当前没有调用方这样用（潜伏缺陷），但没有任何 `instanceof Promise` 或形状校验兜底，一次未来改动即可触发「数据不丢」最上层红线。

- **F-18** [P2] `mod/main.js:508, 522` — 关联增删基于 render 时快照，覆盖并发 link/unlink
  closure 捕获 `item.spaces` 而不是在 `st` 里按 id 重查；实测「[A] → CLI 加 B → 面板点 +C」得到 `["A","C"]`，B 静默丢失，`store.update` 的 CAS 重放也让同一份陈旧数组。删除分支同构。

- **F-19** [P2] `mod/main.js:201-215` — 快速记录无在途保护，可重复创建
  `draft.value()` 同步读取，`draft.set_value("")` 在 `await update(...)` 之后；添加按钮全程可点。实测（串行 CAS 宿主桩）两次提交产生两条同名事项。

- **F-20** [P2] `mod/main.js:575-581` — 备注保存失败会丢掉用户刚输入的文本
  `commitNote` 先清 `noteEditingId`/`noteDraft`，再等在途 mutate；失败时编辑器已卸载，文本不可恢复。

- **F-21** [P2] `mod/main.js:539, 545` — 备注编辑器是单行 `Input`，不满足 plan:59 的「备注编辑（多行）」
  多行应使用 `TextareaState`/`Textarea`（`gpui-kit.d.ts:21446-21486`），Enter 当前直接提交而非换行；`:564` 还只展示 `split("\n")[0]`。与 F-1 同一处代码，但属独立缺陷（即使修好抛错也不满足多行）。

- **F-22** [P2] `install.sh:35-37, 43-44, 47-48` — 覆盖已安装的 mod/tabs/布局时不做备份
  plan:67「覆盖前备份」、README:27「已存在的文件会先备份」；实际只有 `~/.local/bin` 的真实文件与 keys.json 有备份，`mods/herdr-todo`、`mods/tabs-todo` 无 `.bak-*`，手改过的已安装副本会静默消失。

- **F-23** [P2] `install.sh:32` — `$APP_HOME；` 在 macOS bash 3.2 + UTF-8 locale 下被解析为变量名 `APP_HOME；`
  最小复现 `sh -uc 'A=/tmp/x; echo "$A；"'` → `A?: unbound variable`。首跑（Herdr 未启动）时用户拿到的是 shell 错误而不是「找不到 …；请先安装并运行过 Herdr App」。退出码仍为 1。

- **F-24** [P2] `scripts/sync-core.sh:13-22` — 哈希头没有任何消费方；且 `shasum`/`cut` 缺失时会写出空哈希并 exit 0
  plan:64 声称「CI/验证时用它检查副本是否过期」，仓库内除写入者与 `mod/core.js:2` 的数据行外无人读取；validator 追加 `// DRIFT` 到 src 后 `npm test`、`herdr-app check` 全部照常通过。PATH 去掉 shasum 时管道状态取自 awk，脚本打印「synced」并成功退出，写出的头为空。

- **F-25** [P2] `scripts/install-keys.py:88-94` — 备份名只有秒级分辨率，且 `os.replace` 会把符号链接换成普通文件
  同一秒内两次运行互相覆盖备份（实测两次都是 `keys.json.bak-20261118193739`，真正的 pre-install 内容丢失）；keys.json 为 dotfiles 符号链接时，写入后链接消失、目标文件保持旧内容。

- **F-26** [P2] `install.sh:44, 51, 53-65` — 吞掉失败后仍打印「安装完成」并列出两条快捷键
  `cp mod/tabs/mod.json ... || true`：缺文件时生成只有 `main.js` 的 tabs-todo，布局却引用它；`install-keys.py` 失败只 `say` 一句警告，随后仍无条件宣传 ctrl-alt-t / ctrl-alt-n。实测三种失败场景均 exit 0。

- **F-27** [P2] `README.md:25-27`（及 `package.json:17-19`、`install.sh:48`）— 安装说明漏项，且无前置要求
  「四件事」没提克隆 tabs-todo 与写 keys.json；README 全文没有 Node ≥ 18 / python3 要求。实测 PATH 缺 python3 时，前 3 步已写入 app home，第 4 步失败退出，留下半安装状态且无回滚。

- **F-28** [P2] `src/io.js:89, 93-98, 112` — 陈旧锁按 mtime 抢占，且 `finally` 无归属地删除锁
  持锁进程挂起超过 10s 后锁被他人 `rm -rf` 并抢占；原持有者恢复后按路径删除，会把抢占者的锁删掉，使后续写者进入临界区。需 >10s 停顿（睡眠/调试器/NFS），未实测，按代码级确认；修复需引入持有者 token。

- **F-29** [P2] `scripts/install-keys.py:26-31` + `layouts/herdr-todo.json` — `ctrl-alt-t` 首次按下显示 Files 而非 Todo，且在 terminals/win98 布局中指向不存在的节点
  生成的布局里 `panel.hidden=true`、`panel-body.active="files"`，`.state` 无记忆值；README:50「等同点 Todo 按钮」在首次使用时为假。`terminals.json`/`win98.json` 没有 `panel` 节点，全局绑定在那里会报错。validator 在已安装文件上确认。

- **F-30** [P2] `mod/main.js:296-308, 350-354` — 当前 space 组与 fallback 组无法折叠
  `isFolded` 对 `group.key === here` 恒定返回 false，fallback 组又被强制展开；点击标题只改 `this.expanded`，两条路径都不读，用户看到的是完全没反应。README:69-70 的「点标题可以展开/收起」对这两组不成立。

- **F-31** [P2] `mod/main.js:146-154` — 下一次成功 `load()` 无条件 `this.error = null`，把上一次失败的提示抹掉
  任何 mutate 抛错（冲突耗尽、非法转移）后，最迟 10s 的兜底轮询会把错误清空并重绘，用户看不到失败原因，账本也没有变化。

- **F-32** [P2] `mod/main.js:345` vs `:452` — 顶部「完成 N」只数 done，底部「已完成 N」数 done+cancelled
  一件 done + 两件 cancelled 时显示 完成 1 / 已完成 3，同一语义两个数字。

- **F-33** [P2] `src/cli.js:63-73`（parseArgs）— 不支持 `--file=<路径>` 形式
  `--file=/tmp/x.json` 被当成未知选项 exit 2。常见 GNU 风格写法失败；属易用性/一致性，不是数据问题。

- **F-34** [P2] `src/core.js:95-99, 167-169` — 时间线/排序依赖墙钟 `at`，时钟回拨会打乱顺序
  实测 add@1 → doing@5 → blocked@3 得到时间线 [todo@1, blocked@3, doing@5]，最后一条与 `item.status` 不一致。无数据丢失。

## 未决风险与覆盖缺口

- `mod/store.js:69-71` — `dataDir()` 只按 `/todos.json` 去后缀；Windows 下 `home()` 返回反斜杠路径时结果依赖混合分隔符能否解析。目标平台是 macOS，未实测。
- `mod/tabs/main.js:134, 155` — `enabled` 恒定并入 `todo-block`，但该 mod 无法知道当前布局是否真有这个块；在 terminals/win98 或重新克隆的布局里可能渲染出点不开的按钮。代码级成立，未在真实布局逐一点击。
- `mod/main.js:136` — 快速记录弹窗只在 init 里 `focus()` 一次，未像自带弹窗（prompt/help/picker 等）那样在 `timer.after(600)` 再抢一次焦点；键入可能落到终端。属纯 UI 时序，未用真实键盘验证。
- `mod/mod.json:4` + `mod/main.js:259-265` — 弹窗固定高 128px，错误行在 hint 之后；错误消息换行时可能被裁掉，用户看到「点了没反应」。按渲染树推算，未构造失败截图。
- `writeTextFile` 的 compare+replace 是否在宿主内部单步原子：未验证。它只影响「两个 mod 副本互写」的场景；F-2 的 CLI↔mod 丢失不依赖该前提（validator 的注入点就是「比对通过后、rename 前有别的写入提交」）。
- 真实 `mod.open` 交互（点击、键盘、截图）未执行：会改动 `~/.config/herdr-app` 与真实账本，超出只读约定。因此涉及实际点击路径的结论（F-1 的抛错有 `herdr-app check` 实证；其余 UI 行为为代码/契约级）。
- `mod/`、`install.sh`、`scripts/*.py`、`sync-core.sh` 没有任何自动化测试；`npm test` 32/32 与 `tests/cli.test.sh` 全绿，但均不覆盖本报告绝大多数缺陷。
- 未做崩溃/断电持久化测试（`src/io.js` 无 fsync），仅在代码层记录。

## 存量问题与范围外建议

以下不阻塞本次交付，披露以控制后续成本。

- `src/io.js:145-169` `createMemoryStore` 未被使用且与 mod/store 语义不同；`src/io.js:9` `MAX_ATTEMPTS`、`src/core.js` `sortByRecent`、`src/cli.js:160` 的异步空壳 `resolveSpaceArg`、`mod/main.js:397` 的 `const overdue = false`、`mod/main.js:120` 的 `this.p` 均为死代码。
- `src/cli.js:124-144` 与 `mod/main.js:80-100` 各有一份 `describeEntry`；状态文案/图标/配色也各一份。`core.js` 是唯一被同步的文件，这些词表会长期漂移，建议并入 core 或第二个同步文件。
- `mod/main.js:600-610` — `button()` 用 `Math.random()` 生成元素 id，每次渲染都变，元素身份/命中测试不稳定，也无法按 id 做 UI 自动化。
- `scripts/install-layout.py:56-60`、`install.sh` 的 mod 复制都是非原子写入（布局用 `os.replace`），在 App 运行中安装会短暂出现半套文件；建议先写临时目录再整体替换。
- `mod/tabs/main.js` 是上游 tabs 的整份克隆、`layouts/herdr-todo.json` 由 `main.json` 生成，App 升级后没有漂移告警；建议 `install.sh` 加一次与已安装上游文件的 `diff` 或记录上游哈希。
- `mod/main.js:156-168` 的 `await this.load()` 位于 `try` 之外，spawn 的上下文失效异常会逃出循环（自带 mod 都会包一层）；与 F-8 同处，建议一并处理。
- `.agent/herdr-todo/workspace/panel.png` 与 `panel-folded.png` 字节完全相同（sha256 `6f5affc0…`），plan:87 声称的「默认折叠」证据图实际没有体现折叠。
- `README.md` 的退出码表、`--space` 示例、`ctrl-alt-t` 语义、`--json` 承诺、XDG 路径承诺与实现不一致（详见 F-5/F-10/F-12/F-29）；建议以修好后的实现为准统一一次。

## 附：评审执行记录

**派出的 reviewer / validator（全部为本模型独立 subagent，只读；无 peer 模型，按 tdsql-cr 回退约定）**

| 角色 | 覆盖 | 结果 |
|---|---|---|
| Proof Obligations reviewer（固定 prompt 原文） | 31 个函数 + 3 个脚本；O1–O50 全量见证 | 返回：25 candidate / 25 closed；本报告主要依据 |
| core/io/cli reviewer | core.js、io.js、cli.js、bin、tests | 返回：并发、锁、权限、XDG、退出码、测试有效性 |
| mod runtime reviewer | mod/main.js、store.js、core.js、tabs、mod.json | 返回：18 条候选（含 P0 分级） |
| install/packaging reviewer | install.sh、install-*.py、sync-core.sh、README | 返回：16 条候选，全部在 /tmp 复现 |
| plan-conformance & tests reviewer | plan/README 对照、tests 质量 | 返回：备注编辑器崩溃、`--space`、退出码、备份、排序等 |

Validator（每条从零取证，`CONFIRMED/PLAUSIBLE/REFUTED`）：F1/F2 并发与测试（2 条 CONFIRMED）、备注编辑器 render 崩溃（CONFIRMED）、C1–C10 数据模型/CLI（10 条 CONFIRMED）、C11–C16 mod 运行时（6 条 CONFIRMED，含真实宿主 1 MiB 取证）、C17–C23 安装（7 条 CONFIRMED）。共 5 个 reviewer + 5 个 validator，**无派发失败**；唯一降级是「无 peer 模型，故全部使用同模型独立 subagent」，以及无法真实 `mod.open` 驱动 UI。

**证据与副作用披露（按只读约定）**

- 所有临时探测均在 `/tmp`；未修改 `~/.local/share/herdr-todo/todos.json`（仍为 4626 字节，mtime 由用户 App 的 19:27 活动产生），未修改 `~/.config/herdr-app` 下的 keys/layouts/mods 内容。
- 一次为验证安装脚本的误操作：以 `HERDR_APP_HOME=/tmp/...` 运行 `install.sh` 时，脚本仍对真实仓库执行了 `scripts/sync-core.sh`，重写了 `mod/core.js`（内容与头哈希 `7e38f512…` 与此前逐字节一致，仅 mtime 变化），并重建了 `~/.local/bin/herdr-todo` 符号链接（目标不变）。`mod/core.js` 已核对：去掉两行头后 sha256 与 `src/core.js` 完全一致。
- `herdr-app check` 会自动生成 `mod/gpui-kit.d.ts`、`mod/jsconfig.json` 及 `mod/tabs/` 下同名文件；reviewer 运行后遗留的这些生成物已删除，交付文件集恢复原状（`mod/` 仅 core.js、main.js、mod.json、store.js、todo.svg、tabs/{main.js,mod.json}）。
- 已安装的 `mods/herdr-todo/*` 与 `mods/tabs-todo/*` 与仓库逐字节一致（复核时点）。

## 修复后仍未处理（2026-11-18 20:20 补记）

以下保持原状，作为残留风险或后续交付：

- **真实 `mod.open` 交互验证**：评审因只读约定未做；修复后我用真实的 App 实例验证了面板渲染、CLI→面板同步、面板→CLI 写入，但未做点击/键盘自动化。
- **`writeTextFile` 内部原子性**：已不再依赖（面板不再写文件）。
- **Windows 路径、崩溃/断电持久化（无 fsync）**：未验证，目标平台是 macOS。
- **`mod/`、`install.sh`、`scripts/*.py` 仍无自动化测试**：这些路径靠手工复验（本次修完逐条实跑过）。
- **F-34 时间线依赖墙钟**：未改（时钟回拨会打乱时间线顺序，但数据不丢）。
- **F-24 `sync-core.sh` 哈希头无消费方**：未加检查，仍只是提示。
- **`describeEntry` 与状态词表在 CLI / mod 各一份**：未合并（要动 sync 机制，超出本次修复范围）。
- **`button()` 用 `Math.random()` 生成 id**：未改（不影响功能，影响 UI 自动化）。
