# activity — cursor-open

### [2026-11-27 15:40] Gate — 起草完成，呈 Gate: Plan Approval
- **结论/动作**：用户锁定两件事：入口范围是「标签栏按钮 + space 右键菜单」（与 CodeBuddy 同构），不提 MR。起草期实测关闭了三个关键假设：Cursor CLI 在最小 PATH 下可用；本地第二个目录也会新开窗（不依赖「Cursor 未运行」）；远程 `vscode-remote://ssh-remote+<host><path>` 真的连上 dev8 并在远端自装 cursor-server。由此确定 Cursor 与 CodeBuddy 只差三个常量与 authority，方案是泛化现有 `mod/codebuddy.js` 而不是复制第二份打开模块。
- **证据**：`.agent/cursor-open/plan.md`「已实测的技术事实」；Cursor `exthost.log` 15:33:35–43、dev8 `~/.cursor-server/bin/linux-x64/` 时间戳

### [2026-11-27 16:10] Result — 实现与验证完成，234/234 绿，变异 6/6 捕获
- **结论/动作**：`mod/codebuddy.js` 改成 `EDITORS` 差异表 + `openInEditor(host, key, …)`，tabs 与 menu 两个入口都改调它；`host.opening` 变成按编辑器一把锁并由 `openInEditor` 惰性建表。六处变异（cursor authority 换成 codebuddy 前缀、两编辑器共用一把锁、删 Cursor 菜单项、分发落空走 `run()`、删 Cursor 按钮、两个按钮都接成 CodeBuddy）全部被测试捕获，恢复后 `npm test` 234/234。`sh install.sh` 后 5 个 mod `herdr-app check` 全 passed，安装件与仓库 `cmp` SAME。
- **证据**：`tests/codebuddy.test.js`（16 条）、`tests/mod-runtime.test.js`（37 条）、`tests/sync.test.js`；`.agent/cursor-open/plan.md`「验证」
- **插曲**：做「删菜单项」变异后用 `git checkout -- mod/menu/main.js` 恢复，把本任务对该文件的改动一并冲掉了。已重新逐处应用 5 处内联改动并复跑全套测试确认最终状态；后续变异恢复改用文件副本。

### [2026-11-27 16:12] Gate — 呈 Gate: Final Review
- **结论/动作**：按用户批准的验证范围（不做本机真实点击与截图），完成全部可执行检查并呈最终审查。
- **证据**：`.agent/cursor-open/plan.md`「当前状态」「验证」「步骤」
