# herdr-todo

把工作事项记下来，并关联到 Herdr App 的 space。回答三个问题：

- 这个 space 现在在做什么？
- 还有哪些事没处理？
- 这件事从提出到现在经历了什么？

## 它是什么

一个 Herdr App 的 mod（右侧常驻面板 + 快速记录弹窗）和一个命令行工具，共用同一份
JSON 数据。事项有标题、备注、P0–P3 优先级、五种状态（待办 / 进行中 / 阻塞 / 完成 / 取消）、
一个或多个关联 space，以及自动累积的时间线。

面板按 space 分组，因为你本来就是按 space 组织工作的。关联到多个 space 的事项会在每组
各出现一次；没关联任何 space 的进最上面的「未关联」组；关联到已不存在 space 的单独归到
「space 已不存在」，不会被悄悄丢掉。

## 安装

```sh
./install.sh
```

它会做五件事：把共享数据逻辑同步进 mod（mod 沙箱禁止跨目录 import）、把 `herdr-todo`
链到 `~/.local/bin`、把 mod 与 tabs 克隆件复制进 Herdr App、生成一份带待办面板的布局、
把快捷键写进 `keys.json`。

重复执行是安全的：**每一次覆盖都会先备份**（文件名带 `.bak-<日期>-<毫秒>`），包括
`layouts/herdr-todo.json`——你可能手工调过面板宽度。备份失败会中止安装，不会「以为备份了」。

前置要求：`node`（≥ 18）与 `python3`，以及**已经安装并运行过 Herdr App**（脚本要往
`~/.config/herdr-app` 里写文件，并且需要 App 生成的 `layouts/main.json` 与 `keys.json`）。
所有输入在改动任何文件之前统一检查，缺一项就直接退出，不会留下半装状态。

装完检查并切换布局：

```sh
herdr-app check ~/.config/herdr-app/mods/herdr-todo
herdr-app do layout.switch --name herdr-todo
```

### 面板开关

待办是右侧面板列里的第三个成员，和 **Files / Changes** 完全同构：

- tab bar 右上角三个按钮 `Todo | Files | Changes`，点哪个显示哪个，再点一次收起整列
- 关掉后按钮仍在（它长在 tab bar 上，不在面板里），随时点回来
- 每个 space 记住自己上次开的是哪个面板

### 快捷键

安装时会写进 `keys.json`，也就是 App 的 **Keyboard shortcuts**：

| 按键 | 动作 |
|---|---|
| `ctrl-alt-t` | 展开 / 收起整个右侧面板列（等同点 Todo 按钮） |
| `ctrl-alt-n` | 打开快速记录弹窗 |

这两条是普通配置项，可以在 App 里直接改；重跑 `install.sh` 会补齐缺失的绑定，
被别的动作占用的按键会跳过并汇报，不会覆盖你的设置。**被跳过的键不会出现在安装末尾的
快捷键清单里**——清单只列真的绑上的。

脚本还会删掉旧版本遗留在 `layout:<布局名>` 分区里的同名副本——那个分区优先级更高，
留着会让你的改动看起来不生效。

## 用法

### 面板

右侧面板顶部是统计（未处理 / P0 / 完成），下面按 space 分组。点击任意一条展开详情区：

- 状态按钮：待办 / 进行中 / 阻塞 / 完成 / 取消
- 优先级按钮：P0–P3
- 关联：点 `×` 移除，点「加到」下的 space 名添加
- 备注：点「编辑备注」修改
- 时间线：最近 8 条变更

默认只展开当前 space：其它 space 只留一行标题和未处理数，点标题可以展开/收起。这样面板
始终先回答「我手上的这个 space 还有什么事」；当前 space 没事项时，自动展开第一个有事的组。
底部「已完成 N」默认收起。

### 命令行

```sh
herdr-todo add "修 login 偶发失败" --priority P0 --space <space-id>
herdr-todo list                    # 未处理的事项
herdr-todo list --all              # 含已完成
herdr-todo show t1                 # 详情与完整时间线
herdr-todo status t1 doing
herdr-todo priority t1 P0
herdr-todo note t1 -  < notes.md   # 从 stdin 读备注
herdr-todo note t1 "备注正文"
herdr-todo note t1 --note ""       # 显式清空（省略文本会报错，不会误清）
herdr-todo link t1 <space-id>      # 追加关联
herdr-todo unlink t1 <space-id>    # 移除关联
herdr-todo set-spaces t1 <id...>   # 整体替换关联（脚本用；面板用 link/unlink 增量合并）
herdr-todo archive t1              # 归档：从列表收起，数据仍保留（--all 可见，可导出）
herdr-todo unarchive t1            # 取消归档，回到未处理列表
herdr-todo spaces                  # 数据里出现过的 space 及待办数
herdr-todo export                  # 完整的原始数据
```

所有命令都接受 `--json`，便于脚本处理；`--file <路径>` 可以指向另一份数据文件，
也接受 `--file=<路径>`（空值会报错，不会悄悄退回默认账本）。`--by <名字>` 记录时间线
里的操作者（面板用 `panel`）。`link`/`unlink`/`set-spaces` 的 space 既可以写成位置参数，
也可以写成 `--space <id>`。

标题、备注这类用户文本可以用 `--` 与选项分隔：

```sh
herdr-todo add -- "--space 是标题的一部分"
```

`--` 之后一律当位置参数。面板就是这么传的，所以标题叫 `-h`、`--` 或 `--space` 也能
正常保存，不会被当成选项。

退出码：`0` 成功、`1` 运行时错误、`2` 用法错误、`3` 写入冲突。

## 规则

**完成状态要显式重开。** 一条事项进入「完成」或「取消」后，不能直接改回「待办 / 进行中」
——必须带 `--reopen`（面板里点状态按钮会自动带上）。这样误点不会悄悄把做完的事重新打开。

**时间线自动记录，不能手填。** 创建、状态变更、优先级变更、标题变更、备注变更、关联变更
各产生一条记录。备注只记字数变化，正文留在事项里，不把长文本塞进时间线。

**归档与取消是两件事。** 取消（`cancelled`）表示「这件事不做了」，是一个可以 reopen 的
正常状态；归档表示「别在列表里烦我」，事项从所有列表移除但数据完整保留，`list --all`
与 `export` 仍可读。`unarchive` 或 `status --reopen` 都能把它放回来——不会出现
「reopen 之后还在归档里」的死结。

**space 关掉不会丢事项。** 关联的 space 消失后，事项仍在，归入「space 已不存在」组，
可以重新关联到别的 space。

## 数据

`$HOME/.local/share/herdr-todo/todos.json`。

它是普通 JSON，可以直接备份或版本化。**写只有一条路径**：面板不自己写文件，它调
`herdr-todo` 命令，因此 CLI 的锁是唯一的互斥点，面板与命令行的修改不会互相覆盖。
面板用文件监听感知外部改动，通常三秒内刷新。

写入是原子的（临时文件 + fsync + rename），断电或强杀不会留下半截 JSON；符号链接
（含目标尚不存在的悬空链接）会被尊重——写到它指向的文件，不会把链接换成普通文件。
文件权限在每次写入后保持不变（`chmod 600` 的账本不会变成 644）。

路径固定，**不跟随 `XDG_DATA_HOME`**：面板运行在 App 的沙箱里，读不到环境变量，只能拼
固定路径；CLI 若跟着 XDG 走，两边就会各写各的文件而不报错。要换位置请两边同时用
`--file`（面板的写入命令会自己带上）。

文件被外部改坏时，命令会报错退出并且**不改写原文件**——不会把读不懂的账本当空的
覆盖掉。会报错的包括：`items` 不是数组、状态/优先级不认识、id 重复、`spaces` 不是数组、
时间戳不是数字、时间线条目形状不对。宁可停下让人修，也不静默丢数据。

面板通过 `readTextFile` 读账本，那个接口的上限是 1 MiB。超过时面板会明确提示「太大」，
命令行不受影响。真到那个规模，用 `list`/`export` 读，并归档旧事项。

## 开发

```sh
npm test                     # core / io / 面板 argv / 同步一致性 / 脚本语法
sh tests/cli.test.sh         # CLI 端到端（含并发）
sh scripts/sync-core.sh      # 改完 src/core.js 后同步到 mod/
```

`src/core.js` 是纯数据层，CLI 与 mod 共用；`mod/store.js` 只负责读文件和拼 CLI 命令
（面板不自己写文件，见上面「数据」）。因为 Herdr 的 mod 沙箱不能 import 自己目录
之外的文件，`mod/core.js` 是它的副本，由 `scripts/sync-core.sh` 生成并在文件头写入源码
哈希。`npm test` 里有一条测试比对哈希与正文，忘了同步会直接红。

改动面板后必须跑 `herdr-app check <mod 目录>`；注意 check **不执行异步任务**，涉及文件
读写的改动要真的 `mod.open` 起来看。

## 已知边界

- 只对接 Herdr **桌面 App**。TUI 的 workspace 与 App 的 space 是两套独立体系，不共享。
- space 关联以 App 的 space id 为准。App 若在某次升级中改变 id 生成方式，已有事项会落入
  「space 已不存在」组，需要重新关联（不会丢数据）。
- 不做 agent 集成、不做截止日期与提醒、不改左侧 space 侧边栏。
- 布局文件是从 App 自带的 `main` 克隆的独立副本。App 大版本升级若改动了 `main` 的结构，
  重新执行 `install.sh` 会基于新的 `main` 重建，但你对布局的手动调整需要重做。
- `sync-core.sh` 需要 `shasum` 或 `sha256sum`；两者都没有时它会报错退出，而不是写一个
  空哈希伪装成同步成功。
- tab bar 用的是 `tabs` mod 的克隆件（`tabs-todo`），因为它需要多一个 Todo 按钮。
  App 升级若改动 tab bar，需要重新克隆，并重加两处：`enabled` 里并入 `todo-block`，
  以及 `.when(enabled.includes("todo-block"), el => el.child(panelButton("todo-block", ...)))`。
  前者不能省：`shared("workspace.panels")` 由 App 的面板选择器维护、只列自带面板，
  不加这一条 Todo 会被判成非法面板，点了会弹回 Files。
