# 修复计划：ultra-review 确认缺陷

> 由 `Gate: Final Review` 之后的 ultra-review 产生。基线不变（用户已批准的合同），
> 修复只改正与合同冲突的实现，不扩大范围。

## 确认缺陷（按严重度）

### D-1 [P1] `remoteUri` 不编码 `#` 与 `?`，远程静默打开错误目录
`mod/codebuddy.js:29-33`。逐段 `encodeURIComponent` 拼接；补一条含 `#`/`?` 的断言。

### D-2 [P1] 前置检查漏掉 7 个实际会被拷贝的输入
`install.sh:63-67` vs `:123`/`:132`。按安装清单循环检查，消除两份手工清单。

### D-3 [P1] 逐文件拷贝非原子，失败会让布局引用的 mod 半损坏
`install.sh:123-126`、`:132-135`。改为「先写临时目录、成功后整体替换」。

### D-4 [P2] 空字符串 folder 被当成「没有目录」
`mod/codebuddy.js:25` + `tests/codebuddy.test.js:92`。区分 `null/undefined` 与 `""`。

### D-5 [P2] `menu-todo` 缺回退，失败时整份 space 菜单失效
`mod/spaces/main.js:294`。D-3 修好后主要靠安装完整性；文档注明。

### D-6 [P2] 4 个 `win-*.svg` 是死拷贝，且正是 D-2 的故障触发输入
`install.sh:123` + 删除 `mod/tabs/win-*.svg`。

### D-7 [P2] `install.sh` 的「不移除 tabs-todo」断言只匹配字面量
`tests/sync.test.js:111-114`。

### D-8 [P2] 重新克隆会静默丢功能，menu 克隆件无 `[herdr-todo]` 标记
`mod/menu/main.js`、`mod/tabs/main.js`、`README.md` 克隆件一节。

## 已推翻（不修）
C-3 跨入口锁、C-4 render 快照、C-5 缺重试提示、C-6 panes() 顺序、C-10 无目录路径锁断言。
