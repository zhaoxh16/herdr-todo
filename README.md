# herdr-todo

把工作事项记下来，并关联到 Herdr App 的 space。回答三个问题：

- 这个 space 现在在做什么？
- 还有哪些事没处理？
- 这件事从提出到现在经历了什么？

## 它是什么

一个 Herdr App 的 mod（左侧 Spaces 侧栏里的待办行 + 详情悬浮窗 + 快速记录弹窗）和一个
命令行工具，共用同一份 JSON 数据。事项有标题、备注、P0–P3 优先级、五种状态（待办 / 进行中 / 阻塞 / 完成 / 取消）、
一个或多个关联 space，以及自动累积的时间线。

待办直接长在左侧 Spaces 侧栏里，因为你本来就是按 space 组织工作的：每个 space 行下面
就是它的待办。关联到多个 space 的事项会在每组各出现一次；没关联任何 space 的进最上面的
「未关联」组；关联到已不存在 space 的归到列表末尾的「space 已不存在」，不会被悄悄丢掉。

一条事项也可以**关联到某个 agent**（Herdr Agents 栏里跑着的那个）而不是 space。这时它
显示在 Agents 栏那个 agent 行下面，侧栏不再列它；agent 关掉之后，它自动回退显示到关联
当时它所在的那个 space。关联 agent 与关联 space 互斥。

## 安装

```sh
./install.sh
```

它会做五件事：把共享数据逻辑同步进各 mod（mod 沙箱禁止跨目录 import）、把 `herdr-todo`
链到 `~/.local/bin`、把详情窗 mod 与四个克隆件（`spaces-todo` / `agents-todo` / `tabs-todo` /
`menu-todo`）复制进 Herdr App、生成一份指向它们的布局、把快捷键写进 `keys.json`。

重复执行是安全的：**每一次覆盖都会先备份**，mod 目录整份挪进 `backups/<名字>.bak-<时间戳>`，
`layouts/herdr-todo.json` 与 `keys.json` 各自先存一份 `.bak-<时间戳>`。备份失败会中止安装，
不会「以为备份了」。

安装是**整体替换**：每个 mod 先在 `$APP_HOME/.install-stage.<pid>` 里装完整，再验一遍文件齐全，
最后整目录换上去。中途失败时正在用的 mod 不受影响，暂存目录由 `trap` 清掉——
不会出现「`main.js` 已引用 `./codebuddy.js`、而它还没拷到」这种布局指向半个 mod 的状态。

「要装哪些 mod、每个 mod 有哪些文件」在 `install.sh` 里只有一份清单（`MOD_MANIFEST`），
前置检查、暂存、替换、就位后核对全部从它派生；`npm test` 会校验清单里的文件都真实存在。

前置要求：`node`（≥ 18）与 `python3`，以及**已经安装并运行过 Herdr App**（脚本要往
`~/.config/herdr-app` 里写文件，并且需要 App 生成的 `layouts/main.json` 与 `keys.json`）。
所有输入（含清单里的每个 mod 文件）在改动任何文件之前统一检查，缺一项就直接退出，不会留下半装状态。

装完检查并切换布局：

```sh
herdr-app check ~/.config/herdr-app/mods/herdr-todo
herdr-app check ~/.config/herdr-app/mods/spaces-todo
herdr-app check ~/.config/herdr-app/mods/agents-todo
herdr-app check ~/.config/herdr-app/mods/tabs-todo
herdr-app check ~/.config/herdr-app/mods/menu-todo
herdr-app do layout.switch --name herdr-todo
```

### 侧栏

待办**不是**右侧面板，不占 Files / Changes 那一列。它由 `spaces-todo` 渲染——App 自带
`spaces` mod 的克隆件，在原生 space 行之后追加待办行：

- 顶部「未关联」组列出还没归到任何 space 的事
- 每个 space 行下面缩进列出它的未关闭事项：状态字形 + 优先级 + 标题 + 相对时间
- 该 space 有已完成/已取消的事项时，末尾一行「▸ 已完成 N」，点开才列出
- 鼠标停在 space 行上，右侧出现 ＋，点它给这个 space 记一条
- 侧栏拖窄到 160px 以下的图标条形态时，待办行不显示（塞不下）

**拖拽改归属**：任意一条待办都能拖着走，拖动时它会跟着指针显示一个小标签。

| 拖到什么上 | 结果 |
| --- | --- |
| 另一个 space 行 | 挪到那个 space（从原 space 移走，不是同时挂两边） |
| Agents 栏的 agent 行 | 关联到那个 agent（替换 space 关联） |
| 「未关联」分组标题 | 摘掉 space / agent 关联，回到未关联 |

从 Agents 栏里的一条待办也能同样拖走——它在 space 与 agent 之间可以来回换。
也可以拖到「space 已不存在」组里的死关联上把它拖出来，顺带清掉那些已不存在的 id。

### Agents 栏

关联到 agent 的待办显示在 Agents 栏对应 agent 行下面（两种排序模式都有，子 agent 行下也
有）。点那条待办同样打开详情窗；agent 名下没有待办时那行不变，不占额外空间。

agent 被关闭（终端结束）后，它的事项自动回退到**关联当时**它所在的 space，侧栏那一行会
带一个 `↩ <agent 地址尾巴>` 标记，说明这是从 agent 回退回来的，不是原本就挂在 space 上的。

### 快捷键

安装时会写进 `keys.json`，也就是 App 的 **Keyboard shortcuts**：

| 按键 | 动作 |
|---|---|
| `ctrl-alt-n` | 打开快速记录弹窗（新建一条不关联 space 的待办） |

旧版本写的 `ctrl-alt-t`（切换右侧面板列）会在这条待办搬进侧栏后被清理掉；你手工改绑到
别处的 `ctrl-alt-t` 不会被碰。

这一条是普通配置项，可以在 App 里直接改；重跑 `install.sh` 会补齐缺失的绑定，
被别的动作占用的按键会跳过并汇报，不会覆盖你的设置。**被跳过的键不会出现在安装末尾的
快捷键清单里**——清单只列真的绑上的。

脚本还会删掉旧版本遗留在 `layout:<布局名>` 分区里的同名副本——那个分区优先级更高，
留着会让你的改动看起来不生效。

## 用法

### 侧栏与详情窗

点侧栏里任意一条待办，弹出一个可拖动的悬浮窗：

- 状态按钮：待办 / 进行中 / 阻塞 / 完成 / 取消
- 优先级按钮：P0–P3
- 关联：点 `×` 移除；点「加到」下的 space 名添加。关联了 agent 时这里显示 agent 名与 `×`
- 备注：点「编辑备注」修改
- 时间线：最近 8 条变更
- 归档：从所有列表收起，数据仍保留

关闭方式：右上角 ✕，或按 Esc（正在编辑备注时 Esc 先退出编辑，不关窗）。改动立刻落盘，
侧栏在三秒内跟上。

「未关联」那一行的 ＋ 和 `ctrl-alt-n` 都新建**不关联**的事项——不会自动挂到你当前正开着的
space 上。要挂到某个 space，用那个 space 行上的 ＋。

快速记录窗是 dialog：回车创建、Esc 关闭，右上角也有 ✕。

### 用 CodeBuddy 打开

标签栏右侧有一个 `CodeBuddy` 按钮，space 行右键菜单里也有一条「用 CodeBuddy 打开」。
两者打开的都是**那个 space 的目录**：它第一个终端当前的 cwd；这个 space 还没有终端时用
创建时记录的目录。切 tab、切 pane 不会改变按钮指向的目录。

- 本机 space → 本机 CodeBuddy 窗口，打开那个目录。
- 远程 space（dev3–dev8 这类）→ CodeBuddy 的 Remote-SSH 窗口，标题形如
  `SQLEngine [SSH: dev8]`。

菜单作用于**被右键的那个** space，不要求它是当前活动的那个。没有目录可开时按钮仍然显示，
tooltip 说明原因，点击不动作——不会静默什么都不发生。

远程窗口首次连接要在那台机器上准备 CodeBuddy Server，会慢一些，偶尔会失败一次并弹出
错误通知；再点一次即可。打开动作进行中时连点会被忽略，不会开出一串窗口。

路径里的 `#`、`?` 与空格会按 URI 规则逐段编码，所以 worktree 目录名带 `#`（如 `fix#42`）
也能打开正确的那一个，而不是被 URI 解析截断成父目录。space 的目录是空字符串时
（Herdr 把它定义为「那台机器的 home」），本机打开 `$HOME`，远程打开该机器的 home。

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
herdr-todo link t1 <space-id>      # 追加关联（会解掉 agent 关联）
herdr-todo unlink t1 <space-id>    # 移除关联
herdr-todo move t1 <space-id> --from <旧 space>   # 从一个 space 挪到另一个（省略目标=未关联）
herdr-todo set-spaces t1 <id...>   # 整体替换关联（脚本用；界面用 link/unlink 增量合并）
herdr-todo agent t1 dev5/t2 --in-space <space-id>   # 关联到 agent
herdr-todo agent t1 --clear                         # 解除 agent 关联
herdr-todo archive t1              # 归档：从列表收起，数据仍保留（--all 可见，可导出）
herdr-todo unarchive t1            # 取消归档，回到未处理列表
herdr-todo spaces                  # 数据里出现过的 space 及待办数
herdr-todo export                  # 完整的原始数据
```

所有命令都接受 `--json`，便于脚本处理；`--file <路径>` 可以指向另一份数据文件，
也接受 `--file=<路径>`（空值会报错，不会悄悄退回默认账本）。`--by <名字>` 记录时间线
里的操作者（界面上操作记为 `panel`）。`link`/`unlink`/`set-spaces` 的 space 既可以写成位置参数，
也可以写成 `--space <id>`。

标题、备注这类用户文本可以用 `--` 与选项分隔：

```sh
herdr-todo add -- "--space 是标题的一部分"
```

`--` 之后一律当位置参数。界面就是这么传的，所以标题叫 `-h`、`--` 或 `--space` 也能
正常保存，不会被当成选项。

退出码：`0` 成功、`1` 运行时错误、`2` 用法错误、`3` 写入冲突。

## 规则

**完成状态要显式重开。** 一条事项进入「完成」或「取消」后，不能直接改回「待办 / 进行中」
——必须带 `--reopen`（详情窗里点状态按钮会自动带上）。这样误点不会悄悄把做完的事重新打开。

**时间线自动记录，不能手填。** 创建、状态变更、优先级变更、标题变更、备注变更、关联变更
各产生一条记录。备注只记字数变化，正文留在事项里，不把长文本塞进时间线。

**归档与取消是两件事。** 取消（`cancelled`）表示「这件事不做了」，是一个可以 reopen 的
正常状态；归档表示「别在列表里烦我」，事项从所有列表移除但数据完整保留，`list --all`
与 `export` 仍可读。`unarchive` 或 `status --reopen` 都能把它放回来——不会出现
「reopen 之后还在归档里」的死结。

**space 关掉不会丢事项。** 关联的 space 消失后，事项仍在，归入「space 已不存在」组，
可以重新关联到别的 space。

**agent 关掉不会丢事项。** 关联到一个 agent 时，会同时记下它当时所在的 space（命令行
就是那个必填的 `--in-space`）。agent 关掉后 Host 不再告诉你它属于哪个 space，
所以关联当时就得存下来——那条事项随后回退显示到那个 space。

**agent 与 space 互斥。** 一条事项要么挂在若干 space 上，要么挂在某一个 agent 上。
`link` 一个 space 会解掉 agent 关联，反过来也一样，时间线各记一条。这样「它到底在哪」
永远只有一个答案，侧栏与 Agents 栏不会各显示一份。

## 数据

`$HOME/.local/share/herdr-todo/todos.json`。

它是普通 JSON，可以直接备份或版本化。**写只有一条路径**：界面不自己写文件，它调
`herdr-todo` 命令，因此 CLI 的锁是唯一的互斥点，界面与命令行的修改不会互相覆盖。
侧栏用文件监听感知外部改动，通常三秒内刷新。

写入是原子的（临时文件 + fsync + rename），断电或强杀不会留下半截 JSON；符号链接
（含目标尚不存在的悬空链接）会被尊重——写到它指向的文件，不会把链接换成普通文件。
文件权限在每次写入后保持不变（`chmod 600` 的账本不会变成 644）。

路径固定，**不跟随 `XDG_DATA_HOME`**：mod 运行在 App 的沙箱里，读不到环境变量，只能拼
固定路径；CLI 若跟着 XDG 走，两边就会各写各的文件而不报错。要换位置请两边同时用
`--file`（界面的写入命令会自己带上）。

文件被外部改坏时，命令会报错退出并且**不改写原文件**——不会把读不懂的账本当空的
覆盖掉。会报错的包括：`items` 不是数组、状态/优先级不认识、id 重复、`spaces` 不是数组、
时间戳不是数字、时间线条目形状不对。宁可停下让人修，也不静默丢数据。

侧栏通过 `readTextFile` 读账本，那个接口的上限是 1 MiB。超过时会明确提示「太大」，
命令行不受影响。真到那个规模，用 `list`/`export` 读，并归档旧事项。

## 开发

```sh
npm test                     # core / io / 侧栏分组 / argv 形态 / 同步一致性 / 脚本语法
sh tests/cli.test.sh         # CLI 端到端（含并发与 agent 关联）
sh scripts/sync-core.sh      # 改完 src/core.js / todo-view.js / todo-drag.js 后同步副本到三个 mod
```

`src/core.js` 是纯数据层，CLI 与 mod 共用；`mod/store.js` 只负责读文件和拼 CLI 命令
（界面不自己写文件，见上面「数据」）。因为 Herdr 的 mod 沙箱不能 import 自己目录
之外的文件，`mod/core.js` 是它的副本，由 `scripts/sync-core.sh` 生成并在文件头写入源码
哈希。`npm test` 里有一条测试比对哈希与正文，忘了同步会直接红。

改动 mod 后必须跑 `herdr-app check <mod 目录>`；注意 check **不执行异步任务**，涉及文件
读写的改动要真的 `mod.open` 起来看。

### 侧栏克隆件

`spaces-todo` 是 App 自带 `spaces` mod 的克隆件：前半部分原样照抄，文件末尾追加一段
「待办扩展」，用运行时包装 `Spaces.prototype` 的 `init / row / grouped / render` 把待办行
接进去。App 大版本升级若改动了 `spaces` 的结构（尤其是 `row`、`grouped` 的签名与内部字段），
需要重新克隆上游文件、再把末尾那段贴回去。布局里侧栏的 `spaces` 块指向它；
想临时关掉待办，把那一块的 `content.mod` 改回 `spaces` 即可。

`agents-todo` 同理，是 App 自带 `agents` mod 的克隆件（布局里 `agents` 块指向它）。
它比 `spaces-todo` 多一处不得不改的地方：待办行必须插在「每个 agent 及其子 agent」
那组行里，而组装那组行的 `withKids` 是 render 内部的局部函数，外面拿不到。所以上游
正文里有 2 行标了 `[herdr-todo]` 的插入，重新克隆时要一并贴回。

`tabs-todo` 与 `menu-todo` 也是克隆件，只为了 `CodeBuddy` 按钮与那条菜单项：
`tabs-todo` 在文件末尾包装 `Tabs.prototype.render` 往标签栏尾部追加按钮，
`menu-todo` 在 `items()` 的 `space` 分支里多一条。两者共用同一份 `codebuddy.js`
（打开动作的唯一实现），由 `scripts/sync-core.sh` 复制，`npm test` 比对——它一旦分叉，
就会出现「按钮开对目录、菜单开错目录」这种两边单独看都正常的半边坏。

**这两个克隆件的非上游改动全部带 `[herdr-todo]` 标记**（`grep -n 'herdr-todo]' mod/tabs/main.js
mod/menu/main.js`）。`menu-todo` 因为上游正文里没有可依赖的空位，改动是内联的 4 处：import、
菜单项、`menuIcon()` 的图标分支、`choose()` 里取 `target` 与分发。重新克隆后按这 4 处贴回；
`npm test` 会检查这些位置还在，并把「整份重新克隆导致功能静默消失」判为失败。

`spaces-todo` 另有一处不得不改：上游 `mods/spaces` 打开右键菜单时写死了 `{mod: "menu"}`，
`spaces-todo` 改成优选用 `menu-todo`、并用 `probeMenuTodo()` 在启动时确认它真的装着——
`openOverlay` 指向不存在的 mod 不报错、也不显示任何东西，没有这个回退时，`menu-todo`
一旦缺失，space 的整份右键菜单（重命名/关闭/worktree 全部）会一起静默失效。重新克隆
`spaces-todo` 时这段同样要贴回。

两个克隆件的 `core.js` / `store.js`（以及 `todo-view.js`、`todo-drag.js`）都由
`scripts/sync-core.sh` 生成副本，`npm test` 会比对内容——这几个文件分叉是最隐蔽的一种
漂移：`todo-view.js` 分叉会让侧栏与 Agents 栏用两套「这条该显示在哪」的算法，各自看起来
都对，合起来就重复或丢失；`todo-drag.js` 分叉会让一侧认不出另一侧发起的手势（例如侧栏
拖出来的手势 Agents 栏不认，或跟随标签只有一边画得出来）。

拖拽之所以要跨两个 mod：宿主没有跨 mod 的拖拽通道，也不把指针事件发给别的 mod。
手势写在 `shared("todo.drag")` 里，任何 mod 一写就让所有 mod 重渲染并重读——这是唯一的
跨 mod 同步通道。代价是「按下」这个动作本身会触发重绘，所以**点击不能用 `on_click`**
（按下时元素被换掉，click 的配对判定就落空了），两个 mod 的待办行都用 `on_mouse_up` 判定
「拿起又放回 = 点击」。

## 已知边界

- 只对接 Herdr **桌面 App**。TUI 的 workspace 与 App 的 space 是两套独立体系，不共享。
- space 关联以 App 的 space id 为准。App 若在某次升级中改变 id 生成方式，已有事项会落入
  「space 已不存在」组，需要重新关联（不会丢数据）。
- 不做截止日期与提醒；拖拽改的是**归属**（space ↔ space、space ↔ agent、→ 未关联），
  不做事项之间的手动排序。
- 拖拽在**终端区或窗口空白处**松手时不会取消：宿主不告诉脚本「左键是否仍按着」，也收不到
  那里的松开事件。这种残留会在 15 秒后自动清掉，或在下一次按下任何地方时立即作废——不影响
  数据，只是那段时间里拖动源的行仍显示为压暗。
- 关联 agent 的依据是 agent 的**地址**（`dev5/t2` 这种）。agent 重启后如果换到别的 space，
  它会带着原地址回来，关联仍然有效；但如果地址本身变了，那条事项会被当作「agent 已关闭」
  回退到 space。地址里带着 space 前缀，跨机器也不冲突。
- 布局文件是从 App 自带的 `main` 克隆的独立副本。App 大版本升级若改动了 `main` 的结构，
  重新执行 `install.sh` 会基于新的 `main` 重建，但你对布局的手动调整需要重做。
- `sync-core.sh` 需要 `shasum` 或 `sha256sum`；两者都没有时它会报错退出，而不是写一个
  空哈希伪装成同步成功。
- `spaces-todo` 依赖 App 自带 `spaces` 的内部结构（`row` 返回一条 space 行、
  `grouped` 返回侧栏列表的直接子元素）。App 升级后若待办行错位或消失，按上面
  「侧栏克隆件」一节重新克隆并重贴末尾的待办扩展段。
- 远程 CodeBuddy 窗口靠 `~/.ssh/config` 里的机器别名（`dev8` 这类）连接，并且用
  `vscode-remote://codebuddy-remote-ssh+<别名><路径>` 这个写法打开。后者是 CodeBuddy
  内置 remote-ssh 扩展的内部约定，不是公开接口；升级后若远程窗口打不开，先看
  `mod/codebuddy.js` 里的 `REMOTE_AUTHORITY` 常量。
- 打开 CodeBuddy 用的是 bundle 内的 CLI（`/Applications/CodeBuddy CN.app/.../bin/code`），
  不读 `PATH`。CodeBuddy 换安装位置时需要改 `mod/codebuddy.js` 的 `CODEBUDDY_CLI`。
- 没有目录时按钮置灰；`space.folder` 为空字符串不算「没有目录」（那是机器的 home）。
- `tabs-todo` 的按钮画在标签栏最右侧；在 Linux/Windows 上（App 自己画窗口按钮时）它会排在
  最小化/最大化/关闭之后。macOS 上窗口按钮由系统画，位置与设计一致。
