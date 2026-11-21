# 发现阶段原始输出 — 克隆件漂移风险与测试有效性

> 原样保留，不改写 reviewer 结论。

## 结论

本维度未发现 P0/P1 级缺陷；克隆件与上游的逐字一致性、资源完整性、安装路径均经机械验证通过。
发现 5 个 P2 级问题，集中在「重新克隆时功能静默消失」和「测试的预期断言无法捕获某些真实 bug」两类。

---

## A. 已验证为「无问题」的事实

**A1. 正文逐字一致（机械比对）**

- `mod/tabs/main.js`：删掉新增的 import 行（第 4 行）后，前 157 行与 `~/.config/herdr-app/mods/tabs/main.js`
  **逐字节一致**（`diff -u <(sed '4d' mod/tabs/main.js | head -157) ~/.config/herdr-app/mods/tabs/main.js` 退出码 0）。
- `mod/menu/main.js`：`diff -U0` 显示只有 5 处差异：第 9 行 import、第 67 行菜单项、第 85 行 `menuIcon` 内联修改、
  第 116–117 行取 `target`、第 120 行 `choose` 分发。**注意这与评审材料提示的「只有两处新增」不符：实际是 5 处**
  ——这也是下面 P2-1 的依据之一（即材料本身低估了 menu 的改动面）。
- 辅助文件 sha256 全部一致。

**A3/A4. 资源齐全；`herdr-app check` 不检查资源**

- tabs 上游 9 个文件、仓库 9 个（`gpui-kit.d.ts` 被 `.gitignore:13` 忽略、install 不复制，但 check 不需要它；
  删掉后 `check` 仍通过）。menu 上游 4 个文件，全部齐备。**当前没有缺失资源。**
- 缺资源时 check 发现不了（实测删掉 `win-close.svg` 后 `check passed`）；缺 svg 只表现为空白图标。

**A2. 封装失败模式（用变异副本实测 `herdr-app check`）**

| 上游改动 | check 结果 | 运行时后果 |
|---|---|---|
| `Tabs.prototype.init` 改名 | `check failed: cannot read property 'call' of undefined` | 整条标签栏 View 在 init 时抛错，**整条标签栏消失** |
| `Tabs.prototype.render` 改名 | 同上 | 同上 |
| 扩展段在但 import 丢了 | `check failed: spacePath is not defined` | 同上 |
| 上游返回元素不再支持 `.child` | `check failed: unknown element method` | 同上 |
| 整份重新克隆（尾部丢失） | **check passed** | 按钮静默消失（见 P2-1） |
| menu 的 `choose()` 抛错 | **check passed**（check 不执行 `choose`） | 点任意菜单项都抛错，**整个 space 右键菜单失效** |

与先例对比：`spaces-todo`/`agents-todo` 同样整块视图消失，但 README 明确写了「2 行标了 `[herdr-todo]` 的插入」，
正文里也确实有标记。本次 **menu 克隆件全文没有任何 `[herdr-todo]` 标记**（grep 为空），tabs 只有末尾注释块。

---

## 候选问题

### P2-1 重新克隆会静默删掉功能，且现有全部检查仍然通过

- **claim**：按 README 的升级流程「重新克隆上游文件、再贴回扩展段」整体替换后，CodeBuddy 按钮/菜单项消失，
  而 `npm test` 102/102 全绿、两个 `herdr-app check` 全过——没有任何检查能发现。
- **file:line**：`mod/tabs/main.js:4`、`:159-207`；`mod/menu/main.js:9`、`:67`、`:85`、`:116-120`；
  `tests/sync.test.js:90-114`；`README.md:250-256`
- **severity**：P2
- **evidence**（均在仓库外副本实测）：
  1. 用上游 `{tabs,menu}/main.js` 覆盖两个克隆件 → `npm test` 102/102；两个 `check` 均 passed；
     `grep -c codebuddy` 两个文件都是 0。功能完全消失、全部检查通过。
  2. 照 README 字面重新克隆 menu、只补 `items()` 那条菜单项（不含 import、`menuIcon`、`choose()` 分支）→
     102 全绿、check 通过；代码走 `else run("codebuddy", …)`，**菜单项静默无动作**。
  3. 在 `items()` 的 `case "space"` 或 tabs 的 active space 路径注入 `throw`，check 仍 passed
     （check 下 `spaces()`/`props()` 为空，走不到这些分支）。
- **与本次改动的关系**：本次引入。先例靠 `[herdr-todo]` 标记 + README 精确说明兜底；本次 menu 的 3 处内联修改
  既无标记、README 也未列全，且全部检查仍通过，属同等或更差。

### P2-2 `remoteUri` 不编码 `#` 与 `?`，远程空间会静默打开错误的目录

- **claim**：远程 space 的 cwd 含 `#` 或 `?` 时，`encodeURI` 不转义，CodeBuddy 解析后 path 被截断，
  打开的是父目录而非目标目录。
- **file:line**：`mod/codebuddy.js:32`；测试缺口 `tests/codebuddy.test.js:80-88`（只测空格与中文）
- **severity**：P2
- **evidence**：`encodeURI("/repo/a#b")` → 原样；`new URL(...)` → `pathname=/repo/a, hash=#b`；`?` 同理变 query。
  CodeBuddy 侧 `out/main.js` 的 `cliArgToUri(e)` 用 `W.parse(e)`（vscode-uri）后只检查 scheme 与 path，
  随即 `resolveOpenable({folderUri})`——path 已被截断。authority 常量已与扩展核对一致。
  触发条件：远程 cwd 目录名含 `#`/`?`（合法 POSIX 路径，如 `issue #123`）。本机 space 直接传 argv，不受影响。
  未核实前提：用 Node `URL` 近似 vscode-uri 的 RFC 3986 解析。
- **与本次改动的关系**：本次引入。

### P2-3 space 右键菜单成为对 `menu-todo` 的硬依赖，失败时整份菜单消失

- **claim**：`spaces-todo` 把 space 右键菜单唯一入口指向 `menu-todo`；该 mod 缺失或加载失败时，
  重命名、关闭、worktree 等**全部 space 菜单动作**一起失效，而此前用的是 App 自带、永远与版本匹配的 `menu`。
- **file:line**：`mod/spaces/main.js:294`（唯一 opener，无回退）；`install.sh:102-108` 与 `:130-136`、`:147`
- **severity**：P2
- **evidence**：`grep 'mod: "menu' mod/` 只有两处：`mod/spaces/main.js:294` → `menu-todo`，
  `mod/tabs/main.js:120` → `menu`（tabs 反而仍用自带 menu，形成不对称）。安装顺序：spaces-todo 先于 menu-todo
  落盘；第二段失败 `die` 时，既有布局已指向 spaces-todo，留下「侧栏可用、space 右键菜单全灭」的半装状态。
  `openOverlay` 指向不存在 mod 时是抛错还是静默不弹，未核实；结果都是菜单不出现。
- **与本次改动的关系**：本次引入（失败模式放大）。克隆 menu 本身是批准设计；问题在于没有回退兜底，
  且 check 不会走到该分支。

### P2-4 无目录路径的锁释放没有断言，一个会永久锁死按钮的变异能存活

- **claim**：`tests/codebuddy.test.js` 对「无目录」只断言「不发 exec + 一条 warning」，不断言锁状态；
  把「先设锁再 return」这种会永久锁死按钮的实现放进去，8 条测试仍全绿。
- **file:line**：`tests/codebuddy.test.js:90-96`；被测代码 `mod/codebuddy.js:44-49`（当前实现正确）
- **severity**：P2
- **evidence**：变异体 D（把 `if (host.opening) return null; host.opening = true;` 移到 `if (!target)` 之前，
  并删掉原设置）→ `node --test`：`# pass 8 # fail 0`。该变异行为是「无目录点击一次后 `opening` 永远为 true，
  之后所有点击被吞」。其余变异均被捕获：去掉 tab 集合过滤 → 测试 1 红；`encodeURIComponent` → 测试 3、4 红；
  删 finally → 测试 2、7 红；去掉锁 → 测试 8 红；去掉 folder 回退 → 测试 1 红；忽略显式 path → 测试 2、3 红。
- **与本次改动的关系**：本次引入（测试义务缺口；当前代码无 bug）。

### P2-5 对 `install.sh` 的「不移除 tabs-todo」断言绑定了变量名，换一种写法即可绕过

- **claim**：`assert.equal(/mv "\$OLD_TABS_DIR"/.test(text), false)` 只拦截历史上那一种字面写法；
  其他等价移除逻辑全部放行，而测试名声称守护的是「不再自动移除 tabs-todo」。
- **file:line**：`tests/sync.test.js:111-114`
- **severity**：P2
- **evidence**：在 /tmp 副本里于布局生成前插入
  `if [ -d "$APP_HOME/mods/tabs-todo" ]; then rm -rf "$APP_HOME/mods/tabs-todo"; fi` →
  `node --test tests/sync.test.js` 15/15 全过。逐条验证：`mv "$TABS_DIR" …`、`mv "${TABS_DIR}" …`、
  `rm -rf "$TABS_DIR"`、`mv   "$OLD_TABS_DIR"    x` 均不被正则匹配。当前 `install.sh` 确实没有此类移除，
  所以是测试有效性问题而非现存 bug。
- **与本次改动的关系**：本次引入。

---

## B. 两刀检验的其余问答（无缺陷）

- **B1 预期值独立性**：`spacePath` 的字面量与 `remoteUri` 的整串 URI 都是按合同写死的，不是用被测函数反推；
  `cmd` 断言虽引用 `mod.CODEBUDDY_CLI`，但同时用 `/CodeBuddy CN\.app\/...\/bin\/code$/` 独立校验。
- **B3 实现细节绑定**：stub 的 import 替换断言了替换生效，改 import 形态会以明确的断言失败报出，
  属于可接受的「响错」设计。
- **B5**：扩展段本身无直接单测；`herdr-app check` 只跑 init + 一次空世界的 render（注入 throw 到 space 分支仍通过），
  因此不能说 check 已经足够。

## 覆盖声明

读了 review-brief、mod/codebuddy.js、mod/tabs/main.js、mod/menu/main.js、mod/spaces/main.js、tests/*、install.sh、
scripts/*、README 相关段、上游 mods/{tabs,menu,spaces,...}、AGENTS.md、gpui-kit.d.ts、CodeBuddy bin/code、
out/cli.js、out/main.js（cliArgToUri）、extensions/open-remote-ssh/*。
跑了 git 系列命令、diff -u/-U0/-r、shasum、npm test（102/102）、node --test 两个测试文件（8/8、15/15）、
herdr-app check ×2 + 10 组 /tmp 变异副本、两次完整 install.sh（/tmp 环境）、7 组 codebuddy.js 变异 +
2 组重跑、3 种「重新克隆」场景。
未执行：真实 App 点击、真实 Remote-SSH 连接、openOverlay 指向缺失 mod 的运行时表现、vscode-uri 精确解析、
Windows 分支。

> 材料勘误：评审材料写 `tests/codebuddy.test.js` 有 10 条，实际文件是 8 条 `test(...)`（另有 2 个可参数化处）。
