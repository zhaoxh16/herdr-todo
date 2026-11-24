# herdr-todo

把工作事项记下来，并关联到 Herdr App 的 space。回答三个问题：

- 这个 space 现在在做什么？
- 还有哪些事没处理？
- 这件事从提出到现在经历了什么？

## 它是什么

一个 Herdr App 的 mod（左侧 Spaces 侧栏里的待办行 + 详情悬浮窗 + 快速记录弹窗）和一个
命令行工具，共用同一份数据。事项有标题、备注、P0–P3 优先级、五种状态（待办 / 进行中 / 阻塞 / 完成 / 取消）、
一个或多个关联 space，以及自动累积的时间线。

数据存在 **MySQL** 里，命令行直连。本地的 `todos.json` 只是一份派生缓存，面板读它、
定期拉取刷新；同一份数据可以被多台设备同时使用，通常在一个轮询周期内、最坏约 20 秒看到
彼此的改动。

待办直接长在左侧 Spaces 侧栏里，因为你本来就是按 space 组织工作的：每个 space 行下面
就是它的待办。关联到多个 space 的事项会在每组各出现一次；没关联任何 space 的进最上面的
「未关联」组；关联到已不存在 space 的归到列表末尾的「space 已不存在」，不会被悄悄丢掉。

一条事项也可以**关联到某个 agent**（Herdr Agents 栏里跑着的那个）而不是 space。这时它
**两处都显示**：Agents 栏挂在那个 agent 行下面，Spaces 侧栏按关联当时记下的 space 归到
对应 space 组下（行尾带 `@ <agent 地址尾巴>` 标记）。这样每个 space 下有哪些待办一眼看全，
不管那些待办是挂在 space 上还是挂在 agent 上。关联 agent 与关联 space 互斥。

## 安装

```sh
./install.sh
```

它做五件事：把共享数据逻辑同步进各 mod（mod 沙箱禁止跨目录 import）、把 `herdr-todo`
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

前置要求：`node`（≥ 18）与 `python3`，在仓库里跑过一次 `npm install`（唯一的运行时依赖是
`mysql2`；`install.sh` 会检查它存在，缺了直接报错并给出指令，而不是装出一个连不上库的 CLI），
以及**已经安装并运行过 Herdr App**（脚本要往
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

光装完还不能用：面板读的是本地缓存，缓存要靠 `pull` 从数据库拉一次。下面两种情形选一种。

### 接入一：新设备，数据已经在云端

另一台设备已经导入过，这台机器全新。**关键是 `owner` 必须和那台设备写得一模一样**——
它决定这台机器看到哪一份数据，写错就是另一个人（空数据）。

```sh
npm install                                   # 仓库里装一次 mysql2

mkdir -p ~/.config/herdr-todo
cat > ~/.config/herdr-todo/config.json <<'JSON'
{
  "owner": "me",
  "host": "mysql.example.com",
  "port": 3306,
  "database": "herdr_todo",
  "user": "herdr_todo",
  "password": "……"
}
JSON
chmod 600 ~/.config/herdr-todo/config.json

./install.sh
herdr-todo pull        # 首次全量重建，同时把这台机器登记成一台设备
herdr-todo devices     # 应能看到本机这一行
herdr-app do layout.switch --name herdr-todo
```

没有 `pull` 之前，面板读到的是空缓存——看起来像「数据都没了」，其实只是还没拉。

### 接入二：本机已有旧账本，要迁上云

**顺序仍然是「先导入、后装 mod」**，但现在有兜底：`pull` 发现缓存路径上是一份 v1 旧账本
时**停下并拒绝覆盖**，提示先跑 `import-json`；写命令同样跳过它（事务提交到库里，但不动那个
文件）。全量重建整体替换缓存之前也会先留一份 `.bak-<时间戳>`。

```sh
cp ~/.local/share/herdr-todo/todos.json ~/.local/share/herdr-todo/todos.v1.json
sh db/create.sh herdr_todo                    # 建库 + 建表（幂等；库已存在时可跳过）
# 写 ~/.config/herdr-todo/config.json（同上，owner 写你自己的）

herdr-todo import-json ~/.local/share/herdr-todo/todos.v1.json --dry-run   # 先看条数与事件数
herdr-todo import-json ~/.local/share/herdr-todo/todos.v1.json
herdr-todo pull                               # 整体重建缓存，登记本机

./install.sh                                  # 数据已进库之后才装新 mod
herdr-app do layout.switch --name herdr-todo
```

代价：导入会把 `todos.json` 重写成 v2，而旧版面板只认 v1，所以在 `install.sh` 之前它会
短暂显示「不支持的数据版本 2」。这只是显示问题，数据已在库里，装完就恢复。

`import-json` 自己也会把源文件备份成 `<原名>.bak-<时间戳>`，但迁移前手工留一份
`todos.v1.json` 更稳妥：**导入只该在一台机器上做一次**。同一份旧账本在第二台机器上再导
一遍，会变成另一批 id 不同的事项，两条并存。

导入后、`pull` 之前缓存里会短暂同时有新条目与旧条目（预热是往现有缓存上合并）；
`pull` 会整体重建掉。所以导入后务必跑一次 `pull`。

### 侧栏

待办**不是**右侧面板，不占 Files / Changes 那一列。它由 `spaces-todo` 渲染——App 自带
`spaces` mod 的克隆件，在原生 space 行之后追加待办行：

- 顶部「未关联」组列出还没归到任何 space 的事
- 每个 space 行下面缩进列出它的未关闭事项：状态字形 + 优先级 + 标题 + 相对时间
- 关联 agent 的事项也列在这里（按关联当时记下的 space 归组），行尾带 `@ <agent 地址尾巴>`
  标记，说明它的 space 归属来自 agent；agent 还活着时，同一条事在 Agents 栏那个 agent
  行下也会出现一次（agent 关掉后 Agents 栏没有行，侧栏这里仍显示）
- 该 space 有已完成/已取消的事项时，末尾一行「▸ 已完成 N」，点开才列出
- 鼠标停在 space 行上，右侧出现 ＋，点它给这个 space 记一条
- 侧栏拖窄到 160px 以下的图标条形态时，待办行不显示（塞不下）

**拖拽改归属**：任意一条待办都能拖着走，拖动时它会跟着指针显示一个小标签。

| 拖到什么上 | 结果 |
| --- | --- |
| 另一个 space 行 | 挪到那个 space（从原 space 移走，不是同时挂两边） |
| Agents 栏的 agent 行 | 关联到那个 agent（替换 space 关联） |
| 「未关联」分组标题 | 摘掉 space / agent 关联，回到未关联 |
| 放回它自己所在的那一组 | 取消，不写盘（拿起又放回，没有表达任何意图） |

从 Agents 栏里的一条待办也能同样拖走——它在 space 与 agent 之间可以来回换。
但把它拖回「它 agent.space 对应的那个 space 行」属于「放回自己那一组」，是取消、不会
转成 space 关联；要把 agent 关联换成 space 关联，用详情窗里的「加到 `space`」。
也可以拖到「space 已不存在」组里的死关联上把它拖出来，顺带清掉那些已不存在的 id。

### Agents 栏

关联到 agent 的待办显示在 Agents 栏对应 agent 行下面（两种排序模式都有，子 agent 行下也
有）。点那条待办同样打开详情窗；agent 名下没有待办时那行不变，不占额外空间。
**它同时也显示在 Spaces 侧栏**（按关联当时记下的 space 归组），两个视图是同一批事的
两种看法：Agents 栏按「谁在做」，侧栏按「在哪个 space」。

agent 被关闭（终端结束）后，它的事项仍按**关联当时**记下的 space 显示在侧栏（位置不变，
不会随着 agent 搬家或关闭而跳），侧栏那一行带一个 `@ <agent 地址尾巴>` 标记说明它的
space 归属来自 agent，不是用户直接挂的 space。

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
- 标题：**直接点窗口顶部那行标题**改成输入框（没有单独的编辑按钮），回车保存、Esc 取消；
  标题里的 `-h`、`--space` 这类文本会原样保存，不会被当成命令行选项。
  空白标题与超过 200 字的标题在窗口里就被拦下并说明原因（不会静默截断）
- 关联：点 `×` 移除；点「加到」下的 space 名添加。关联了 agent 时这里显示 agent 名与 `×`
- 备注：点「编辑备注」修改
- 时间线：最近 8 条变更
- 归档：从所有列表收起，数据仍保留

关闭方式：右上角 ✕，或按 Esc（正在编辑标题或备注时，Esc 先退出编辑，再按一次才关窗）。标题编辑与
备注编辑不会同时开着——点其中一个就收掉另一个。改动立刻落盘，侧栏在三秒内跟上。

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
herdr-todo list --all              # 含已完成与已归档
herdr-todo show 12                 # 详情与完整时间线（#12 等价）
herdr-todo status 12 doing
herdr-todo priority 12 P0
herdr-todo title 12 "改过的标题"   # 改标题（详情窗里点标题走的就是这条命令）
herdr-todo note 12 -  < notes.md   # 从 stdin 读备注
herdr-todo note 12 "备注正文"
herdr-todo note 12 --note ""       # 显式清空（省略文本会报错，不会误清）
herdr-todo link 12 <space-id>      # 追加关联（会解掉 agent 关联）
herdr-todo unlink 12 <space-id>    # 移除关联
herdr-todo move 12 <space-id> --from <旧 space>   # 从一个 space 挪到另一个（省略目标=未关联）
herdr-todo set-spaces 12 <id...>   # 整体替换关联（脚本用；界面用 link/unlink 增量合并）
herdr-todo agent 12 dev5/t2 --in-space <space-id>   # 关联到 agent
herdr-todo agent 12 --clear                         # 解除 agent 关联
herdr-todo archive 12              # 归档：从列表收起，数据仍保留（--all 可见，可导出）
herdr-todo unarchive 12            # 取消归档，回到未处理列表
herdr-todo delete 12               # 删除：写墓碑，其它设备下次 pull 时消失
herdr-todo spaces                  # 数据里出现过的 space 及待办数
herdr-todo export                  # 完整的原始数据

herdr-todo pull                    # 拉取其它设备的改动，刷新本地缓存
herdr-todo devices                 # 列出已登记设备及其最后拉取位置
herdr-todo devices --revoke <id>   # 吊销一台设备（它不再计入墓碑回收的安全判定）
herdr-todo import-json <旧账本.json>   # 一次性导入单机账本（--dry-run 先看规模）
```

**事项用编号或 id 指代**：`12` 与 `#12` 都是这个人读编号，26 位大写字母数字是 id（ULID）。
`t12` 这种旧写法会明确报错并提示改用 `#12`——编号在迁移时重新分配过，旧号不再对应任何事项。

所有命令都接受 `--json`，此时 stdout 只有可解析的结果（`import-json` 的备份路径这类过程提示走 stderr），便于脚本处理。`--by <名字>` 记录时间线里的操作者（界面上操作记为
`panel`）。`link`/`unlink`/`set-spaces` 的 space 既可以写成位置参数，也可以写成 `--space <id>`。

**没有 `--file` 了**：数据在数据库里，而不是某份本地文件。指向另一台库用 `--db <dsn>`，
或设置 `HERDR_TODO_DSN`、写配置文件。传 `--file` 会以用法错误退出。

**也没有 `--owner` 了**：owner 标识「我是谁」，本机的缓存与同步游标都绑定在它上面。
临时换身份会拿另一个租户的游标去增量拉、把真实身份尚未拉取的事件永久跳过，所以
换身份只能改配置文件里的 `owner`——本机同步状态会发现身份变化，自动作废并从库里重建。

标题、备注这类用户文本可以用 `--` 与选项分隔：

```sh
herdr-todo add -- "--space 是标题的一部分"
```

`--` 之后一律当位置参数。界面就是这么传的，所以标题叫 `-h`、`--` 或 `--space` 也能
正常保存，不会被当成选项。

退出码：`0` 成功、`1` 运行时错误、`2` 用法错误、`3` 本地缓存竞争（同一份缓存被另一个进程
连续改写、几次重试仍没写进去，稍后重试即可；数据库里的写入不受影响——并发写已由数据库串行化，
不会再产生旧版那种「账本冲突」）、`4` 数据库连不上。面板据 `4` 显示「数据库不可达，显示的是缓存」。

**重试同一次操作要带同一个幂等键**：`--op <ulid>`。网络超时后再发一次、带同一个 `--op`，
只会生效一次（第二次返回第一次的结果）。不带 `--op` 时每条命令自己生成一个，所以重发会
真的执行两次——这是 shell 脚本要自己负责的。

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
就是那个必填的 `--in-space`）。agent 关掉后 Host 不再告诉你它属于哪个 space，所以关联
当时就得存下来。这个值一直用作侧栏的归组依据：agent 活着时事项按它显示在对应 space 下，
关掉后仍显示在同一个 space 下，agent 中途搬去别的 space 也不会让它跳位置。

**agent 与 space 互斥。** 一条事项要么挂在若干 space 上，要么挂在某一个 agent 上。
`link` 一个 space 会解掉 agent 关联，反过来也一样，时间线各记一条。这样「这条事的数据
关联」永远只有一个答案；显示上它仍同时出现在 Spaces 侧栏（按 agent 的 space）与 Agents 栏
（按 agent），这是按两种口径各看一次，不是两组互相冲突的关联。

## 数据

真相在 MySQL。建库与建表由人手工执行（应用账号只有增删改查权限，没有建表权限）：

```sh
sh db/create.sh herdr_todo            # 建库 + 建表（幂等）
mysql -u root herdr_todo < db/schema.sql   # 库已存在、只想建表时
```

`db/schema.sql` 只建表、不含 `CREATE DATABASE` / `USE`：库名由调用方给，所以生产库、
测试库、CI 库用的是同一份 DDL。重跑它不会改动已建好的列——改表结构要另写迁移。

表结构与同步协议的完整说明在 `docs/design-docs/herdr-todo/cloud-sync/spec.md`。要点：

- 一个 `owner` 是一个人，同一个人的多台设备共用同一份数据；不同 owner 互不可见。
- 事项的 id 是客户端生成的 ULID；`#12` 这种人读编号按 owner 连续分配，删除过的号不会复用。
- 每次变更写一条事件；时间线就是事件流。`items` 表是事件流推导出的当前快照。

### 配置

每台设备一份 `~/.config/herdr-todo/config.json`，权限 `0600`（里面有数据库口令）：

```json
{
  "owner": "me",
  "host": "mysql.example.com",
  "port": 3306,
  "database": "herdr_todo",
  "user": "herdr_todo",
  "password": "……",
  "ssl": { "ca": "~/certs/ca.pem" }
}
```

- 连接地址也可以从 `--db mysql://user:pass@host:3306/db` 或环境变量 `HERDR_TODO_DSN` 来，
  优先级 `--db` > 环境变量 > 配置文件。**`owner` 只能写在配置文件里**——它标识「我是谁」，
  不从连接串推断，免得换台机器连同一个库就变成另一个人了。
- TLS 默认开启；`ssl: false` 只用于本机回环测试库，必须显式写出来。
- **公有云实例不一定支持 TLS**：腾讯云 CynosDB 这类托管实例默认关闭 SSL 时，连接报
  `HANDSHAKE_NO_SSL_SUPPORT`（Server does not support secure connection）。这时只能在配置里
  显式写 `"ssl": false`，代价是口令与数据在网络上明文传输——务必确认连接走内网，或先在
  控制台打开实例的 SSL，再删掉这一项。
- 数据库账号只需 `SELECT, INSERT, UPDATE, DELETE`。不需要建表权限，也不该有。

### 本地缓存

`$HOME/.local/share/herdr-todo/todos.json` 是**派生缓存**，不是真相：删掉它只是让下一次
`pull` 慢一点（走一次全量重建），数据不会丢。面板读它（快、不需要网络），每 10 秒调一次
`herdr-todo pull` 刷新。

- 缓存头部有 `synced_through`：它防「慢速 pull 把刚提交的本机写入覆盖回旧内容」。
  看到 `Database is unreachable` 这类提示时，面板仍显示缓存内容，并说明是几点的缓存。
- `$HOME/.config/herdr-todo/sync.json` 是本机私有的同步位点（`device_id` 与 `pull_cursor`），
  与上面那个 `synced_through` **不是一回事**，不要合并。
- 文件权限跟随 umask（备注是明文，默认 0600/0644 由你的 umask 决定），每次原子重写都保持原权限。
- 缓存读不懂、被删掉或只剩 0 字节时（`> todos.json` 这类清空写法），写命令照常成功（真相在
  库里），缓存留给下一次 `pull` 整体重建；写命令、导入与 pull 的增量合并都不会凭空造出一份
  「只含刚才那几条」的缓存。`pull` 跑到一半时删掉缓存同样安全：它发现文件不在了就放弃增量、
  改走整体重建。

**写入仍然只有一条路径**：界面不自己写文件，它调 `herdr-todo` 命令。因此界面与命令行的
修改不会互相覆盖——并发安全由数据库的 owner 行锁负责。

### 多端同步

每台设备首次运行 `pull` 会做一次全量重建，之后是增量：按 `pull_cursor` 拉取新事件、读受影响
事项的当前行、合进缓存。10 秒一轮，同一时间只跑一个。

- 断网/数据库不可达时，**写命令会失败**（不支持离线写入），面板顶部显示一行「数据库不可达，
  显示的是 X 的缓存」。缓存本身仍可读。
- 删除是墓碑：删掉的事项在数据库里留着 `deleted_at`，其它设备拉到那条删除事件后从缓存移除。
  物理清除要等过了保留期（180 天）且所有未吊销设备都已拉过那条删除事件。**本版没有自动
  回收的执行者**——判定规则（`canPurge`）已就位并有测试，但没有任何命令触发它，墓碑会一直
  留着（只占空间，不影响正确性）。需要时用数据库账号手工执行。

侧栏通过 `readTextFile` 读缓存，那个接口的上限是 1 MiB（现在 18 条约 28 KB）。超过时会明确
提示「太大」，命令行不受影响。真到那个规模，用 `list`/`export` 读，并归档旧事项。

## 开发

```sh
npm test                     # 单测：规则层 / 只读侧 / 缓存原语 / 配置解析 / argv 形态 / 同步一致性 / 导入 / 脚本语法
npm run test:db              # 同上，并且**要求**真 MySQL：连不上直接失败，不跳过
sh tests/cli.test.sh         # CLI 端到端（连测试库；连不上会跳过并说明）
sh scripts/sync-core.sh      # 改完 src/core.js / todo-view.js / todo-drag.js / mod/store.js 后同步副本
```

集成测试与端到端脚本默认连 `mysql://root@127.0.0.1:3306/herdr_todo_test`，可用
`HERDR_TODO_TEST_DSN` 指向别的库。库先建好表：`sh db/create.sh herdr_todo_test`。
`npm test` 连不上时把集成用例标记为 SKIP 并打印原因（「没跑」与「跑了且通过」可区分）；
`npm run test:db` 则要求真库存在，连不上直接报错——CI 里应当用后者。端到端脚本同理：
设 `HERDR_TODO_REQUIRE_DB=1` 时连不上算失败，否则算跳过。

代码分层：`src/core.js` 是只读侧（规范化、排序、分组、统计），`src/rules.js` 是写入侧的
纯函数（应用一条变更、返回事项与事件），`src/store/mysql.js` 是唯一知道表形状的模块，
`src/sync.js` 把两者与缓存串起来，`src/cli.js` 只做参数解析与输出。`mod/store.js` 只负责
读缓存和拼 CLI 命令（界面不自己写库，见上面「数据」）。因为 Herdr 的 mod 沙箱不能 import
自己目录之外的文件，`mod/core.js` 是 `src/core.js` 的副本，由 `scripts/sync-core.sh` 生成并在
文件头写入源码哈希。`npm test` 里有一条测试比对哈希与正文，忘了同步会直接红。

改了表结构要同步 `db/schema.sql` 与 `docs/design-docs/herdr-todo/cloud-sync/spec.md`——
两者的一致性属于对外契约。

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
- **不支持离线写入**。数据库连不上时，命令行报错（退出码 4）、面板显示一行提示并继续显示
  缓存；缓存本身是只读快照，断网期间不能新增或修改事项。
- **不兼容旧编号**。`t12` 已不再可寻址，迁移时按创建时间重新分配了 `#1`–`#N`，旧号与新号
  只有顺序上的对应关系。迁移是一次性的：`import-json` 导入前会把源账本原样复制成
  `<原名>.bak-<时间戳>`，那份文件之后不再被写入（首次 `pull` 会把原路径重写成 v2 缓存）。
- 单条事项的**标题上限 200 字、备注上限 20000 字**，与数据库列宽一致。标题在详情窗里就
  被拦下并说明原因；备注没有前置检查，超限时保存失败、草稿留在编辑器里。命令行对两种超限值
  都报错退出（不会静默截断，也不会让命令成功后少了半句话）。
- 子待办、手动进度、按时间区间拉取时间线这三项**只预留了数据结构**（`items.parent_id`、
  `items.progress` 两列与事件形状），命令与界面都没有入口。
- space 关联以 App 的 space id 为准。App 若在某次升级中改变 id 生成方式，已有事项会落入
  「space 已不存在」组，需要重新关联（不会丢数据）。
- 不做截止日期与提醒；拖拽改的是**归属**（space ↔ space、space ↔ agent、→ 未关联），
  不做事项之间的手动排序。
- 拖拽在**终端区或窗口空白处**松手时不会取消：宿主不告诉脚本「左键是否仍按着」，也收不到
  那里的松开事件。这种残留会在 15 秒后自动清掉，或在下一次按下任何地方时立即作废——不影响
  数据，只是那段时间里拖动源的行仍显示为压暗。
- 关联 agent 的依据是 agent 的**地址**（`dev5/t2` 这种）。agent 重启后如果换到别的 space，
  它会带着原地址回来，关联仍然有效，侧栏仍按关联当时记下的 space 显示（不会跟着跳）。
  但如果地址本身变了，那条事项在 Agents 栏里就没有行可挂了，只留在侧栏对应 space 下。
  地址里带着 space 前缀，跨机器也不冲突。
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
