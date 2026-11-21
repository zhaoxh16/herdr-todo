# 发现阶段原始输出 — mod 运行时行为

> 原样保留，不改写 reviewer 结论。

## 结论

共报 5 条问题（1×P1、4×P2），另有 2 个未能核实的前提单独标出。`npm test` 102/102、`node --check`、
`herdr-app check mod/tabs|mod/menu` 均通过——这些不是「跑不起来」的问题，而是边界条件下的行为偏差。

---

### RT-1（P1）远程路径含 `#` 或 `?` 时 URI 被截断，静默打开错误目录

- claim：`remoteUri` 用 `encodeURI` 拼 folder URI，`#`/`?` 不编码，远程路径被 URI 解析截成 fragment/query。
- file:line：`mod/codebuddy.js:32`
- severity：P1
- evidence：
  - `encodeURI` 不转义 `#`、`?`（也不转义 `& ; + = $ , @ : ' ( ) * ! ~`），实测：`encodeURI("/data/a#b") === "/data/a#b"`。
  - 解析后果实测：`new URL("vscode-remote://codebuddy-remote-ssh+dev8/data/a#b").pathname === "/data/a"`；
    `.../data/a?b` 的 `pathname === "/data/a"`、`search === "?b"`。CLI 收到的 `--folder-uri`
    （`mod/codebuddy.js:52`）最终是这条被截断的 URI：要么打开 `/data/a`（另一个目录，静默误开），
    要么因带 query/fragment 被拒。触发条件：远程 space 的 `panes()[*].cwd` 或 `space.folder` 含 `#` 或 `?`
    —— Linux 上合法，且 git 分支名允许 `#`（如 `fix#42` 的 worktree 目录），不是纯理论。
  - 同一条朴素拼接的另两处更边缘形态（同一行）：路径不带前导 `/` 时 `machine + path` 粘连成 authority
    （`remoteUri("dev8","data/a")` → `vscode-remote://codebuddy-remote-ssh+dev8data/a`，等于连到 `dev8data`）；
    `machine` 含空格或 `#` 时同理。当前 `cwd` 为绝对路径、`space.folder` 为空时走 `null`，触发概率更低。
  - 反例（这些是对的）：`%`、空格、非 ASCII —— `encodeURI("/a%20b")` → `%2520`（还原后是字面量 `%20`）、
    `/a b` → `%20`、中文 → `%E4%B8%AD...`，与 `tests/codebuddy.test.js` 断言一致。
  - 不是注入面：`argv` 是数组元素、`exec` 不经 shell，`notify` 的 body 是纯文本。
- 与本次改动的关系：本次引入（`remoteUri` 是新代码）。

### RT-2（P2）按钮用「上次 render 时捕获的 path」，菜单用「点击时重算」，两个入口可能不一致

- claim：按钮 `on_click` 把 render 阶段算好的 `path` 传给 `openInCodeBuddy`，函数里 `path ?? spacePath(...)`
  让这个快照永远优先；菜单入口则在点击时现算。
- file:line：`mod/tabs/main.js:187`、`:204`；`mod/codebuddy.js:40`
- severity：P2
- evidence：`mod/tabs/main.js:187` 在 render 中算 `path`，`:204` 点击时原样传入；`mod/codebuddy.js:40` 的
  `path ?? spacePath(space, panes)` 使点击时传的 `panes: panes()` 实际不参与决策（菜单在
  `mod/menu/main.js:120` 传的是 `spacePath(target, panes())`，是最新值）。若第一个终端的 cwd 在上一次 render
  之后变过、而下一次 render 尚未到达（cwd 变化是否触发重渲染未能核实），按钮会打开上一个目录，同时 tooltip
  显示的也是那个旧目录——两个入口对同一动作给出不同目录。契约要求「实时 cwd」。修法是把 `space` 交给
  `openInCodeBuddy`、点击时算，与菜单一致。
- 与本次改动的关系：本次引入。

### RT-3（P2）exec 抛错（超时/机器不可达）那条路径没有远程「可再点一次」提示

- claim：远程失败提示「远程首次连接需在远端准备 CodeBuddy Server，可以再点一次」只出现在 `r.code !== 0`
  分支；`exec` reject（超时、起不来、机器不可达）走 catch，只有裸错误文本。
- file:line：`mod/codebuddy.js:62-64`（非 0 分支）对比 `:68-70`（catch）；超时设在 `:53` 的 `{ timeout: 20000 }`
- severity：P2
- evidence：`gpui-kit.d.ts:22269-22271` 明确「Rejects when it can't start…」，`exec` 超时也是 reject；
  plan 自己记录远程首次会慢、偶发失败。所以「慢到 20s 以上」→ catch → 用户看到 `devX:/path：timed out`，
  没有重试建议，与 plan 的缓解措施在该分支上缺失。错误本身不会静默（有 error toast），只是少一句引导。
- 与本次改动的关系：本次引入。

### RT-4（P2）按钮挂在根元素最末尾：有系统窗口按钮（Linux/Windows）时跑到关闭按钮右边

- claim：`body.child(button)` 追加在根 h_flex 的最后一个子节点，而根 h_flex 末尾是 `w?.buttons` 时的
  最小化/最大化/关闭三连；因此带 `window().buttons` 的平台上按钮排在**关闭按钮之后**，关闭按钮不再贴右边。
- file:line：`mod/tabs/main.js:154-156`（窗口按钮）与 `:190-206`（追加）
- severity：P2
- evidence：`gpui-kit.d.ts:22543-22548`：`buttons` 为 true 表示系统不画窗口按钮、由标签栏画，
  「on macOS the traffic lights always stay」（macOS 上 `buttons` 为 false）。所以 macOS 上当前布局正确
  （截图 `00-button-in-tabbar.png`、`03-button-tooltip-remote.png` 可见 `+ Files Changes CodeBuddy`），
  只有 Linux/Windows 上错位；功能不坏（有 `.on_mouse_down` stop，不会与 `window_drag` 冲突），但与
  plan 的「在 `+` 按钮之后、Files 按钮之前」在所有平台上都不一致。本机 macOS 不触发。
- 与本次改动的关系：本次引入（仅跨平台表现）。

### RT-5（P2，前提未核实）菜单入口在 `closeOverlay` 之后才启动异步打开，收尾通知是否随 overlay 回收而丢失未能核实

- claim：`choose()` 先关自己 overlay，再调用 `openInCodeBuddy`；成功/失败的 `notify` 发生在 overlay 关闭之后；
  overlay 副本被回收后该 promise 的续段是否还能发通知，未经核实。
- file:line：`mod/menu/main.js:118-120`；通知在 `mod/codebuddy.js:55`、`:58-66`、`:69`
- severity：P2
- evidence：`exec` 在事件处理器的同一次同步执行里就被派发（`openInCodeBuddy` 在第一个 `await` 之前调用 `exec`），
  所以窗口一定能开——证据 `workspace/06-menu-dev6-opened.png` 也证明菜单路径确实开出了 dev6 窗口。但文档只说
  「Closing a mod copy cancels its pending calls」（`gpui-kit.d.ts:22726`，语境是 watchFolder），没有说
  overlay 关闭后普通 async 续段与 `notify` 是否仍可达。若不可达，菜单路径在失败时会「点了没声」，与契约
  「不弹失败也无声」冲突。仓库内其它 mod 的「close 后再动作」都是同步 `run()`，没有先例可对照。
  **这一条是待核实风险，不是已确认缺陷。**
- 与本次改动的关系：本次引入。

### RT-6（P2，前提未核实）`spacePath` 实际是「panes() 顺序里第一个属于该 space 且有 cwd 的 pane」

- claim：实现只按 tab 集合过滤，再按 `panes()` 的数组顺序取第一个，并未按 tab 索引排序；契约里
  「切 pane 不改变指向」依赖 `panes()` 是稳定的模型顺序。
- file:line：`mod/codebuddy.js:22-26`
- severity：P2
- evidence：`tests/codebuddy.test.js:48-49` 直接把「`panes()` 里先出现的 `tb2` 压过 `tb1`」写成期望值。
  `gpui-kit.d.ts:22488-22489` 对 `panes()` 只写「Every pane in every tab. Live.」，没有顺序保证；
  只有 `agents()` 明确写了「in space, tab, pane order」。若 `panes()` 的顺序随焦点变化，切 pane 就会改变目标，
  违反已批准合同。另一方面它与上游 `menu/place()`、`spaces-todo/place()` 完全同口径，用真实快照核对过 7 个
  space 的 tooltip，说明当前版本至少是模型顺序。**未能核实的正是「顺序保证」本身。**
- 与本次改动的关系：本次引入（与上游存量 `place()` 同口径，风险面与存量一致）。

---

## 六个问题的直接回答（要点，未成缺陷的部分）

1. **目录选择**：`space === null` → `null`；`tabs` 缺失 → 空集合 → 回退 `space.folder`；`panes` 缺失 → 回退；
   `p.cwd` 真值判断（`""`/`null` 跳过继续找）；`space.folder === ""` → `null`；`space.folder === "   "` 是
   truthy 会被当目录发出去（极低概率，未单列）。
2. **远程 URI**：见 RT-1；`%`/空格/非 ASCII 正确；无注入面。
3. **并发**：锁本身正确——检查与置位之间没有 `await`；无目标时在取锁之前提前返回，不泄漏；`finally` 三条路径
   都释放；包装 `init` 传参给无参上游无害；即便 `init` 从未调用、`opening` 为 `undefined`，第一次调用会置 true，
   第二次仍被挡住（mock 实测：并发两次只有 1 次 exec）。两个入口各持一把锁确实可以各开一个窗口——
   这是注释声明的范围，README 的「连点」说的是同一按钮。（Proof Obligations 维度给了相反的 P2 判断。）
4. **按钮渲染**：上游 `render` 只有一条 `return h_flex()...`，今天安全；每次 render 多一次 `spaces()`+`panes()`，
   开销可忽略；`.on_mouse_down(stop)` + `.on_click` 与同文件 `button()`/`panelButton()` 同构，不与 `window_drag`
   冲突；`ready === false` 时文字 `t.dim`、hover 只换底色。位置问题见 RT-4。
5. **菜单分支**：`target` 在 `closeOverlay` 之前取；`it[2].space === undefined` → warning toast，不崩；
   `"codebuddy"` 不会被 `run()` 误命中；`menuIcon` 的 `file-text` 资产存在。异步收尾见 RT-5。
6. **错误路径**：`notify` 的 level 全在宿主集合内；`firstLine` 对空值返回 `""` 并被兜住；唯一缺陷是 RT-3。

## 覆盖声明

读了 review-brief、mod/codebuddy.js、mod/tabs/main.js、mod/menu/main.js、tests/*、mod/spaces/main.js、
mod/main.js、mod/gpui-kit.d.ts、App 自带 mods/tabs|menu|toast|new-menu|prompt|confirm、layouts、README 改动段、
plan、activity、storage.txt、截图 00/03、CodeBuddy bin/code。
跑了 git status/diff/stat/ls-files、npm test（102/102）、node --check ×3、herdr-app check ×2、
herdr-app ls/status/commands/--skill、hc machine ls、hc ls --json、diff -rq、若干 Node 探针。
未覆盖：真实 GUI 点击与真实远程打开；Windows/Linux 窗口按钮布局；`panes()` 顺序是否随焦点变化（RT-6）；
overlay 关闭后异步续段可达性（RT-5）；CodeBuddy 对带 query/fragment 的 folder URI 的具体处理方式（RT-1）。
