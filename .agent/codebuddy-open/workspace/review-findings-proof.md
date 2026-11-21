# 发现阶段原始输出 — 固定 Proof Obligations Reviewer

> 原样保留（Phase 3 与覆盖检查；Phase 1/1.5/2 的完整台账见 agent 记录）。本文件不改写 reviewer 结论。

## Phase 3：提升为缺陷的候选

### PO-1
```
claim: Remote folder URIs are built with encodeURI, which leaves '#' and '?' unescaped; a legitimate remote cwd containing either character is parsed as a URI fragment/query, so CodeBuddy opens a truncated/wrong directory — violating the approved "不误开错目录" goal.
file:line: mod/codebuddy.js:32
area: proof-obligations
severity: P1
confidence: 78
evidence: |
  Obligation: O7
  Contract-change: remoteUri() newly exports "this URI names <path> on <machine>" to the CodeBuddy CLI (Phase 1, Post-conditions).
  Call-chain: Tabs::render()/Menu::choose() -> openInCodeBuddy() -> remoteUri(machine, "/data/a#b/c") -> exec(CODEBUDDY_CLI, ["--folder-uri", "vscode-remote://codebuddy-remote-ssh+dev8/data/a#b/c"]) -> CodeBuddy URI.parse -> folder "/data/a"
  Witness: Node confirmation: encodeURI("/data/a#b/c") === "/data/a#b/c"; new URL(...) yields pathname "/data/a", hash "#b/c". Same for "?" (search).
  Delta: introduced
  Root-cause: whole-string encodeURI is not a path-component encoder.
  Systemic impact: wrong workspace opened silently (CLI can exit 0 and the success toast names the intended path), user edits the wrong tree; remote-only.
  Remediation: encode per path segment (split on "/", encodeURIComponent each segment, rejoin) or escape "#"->"%23"/"?"->"%3F" after encodeURI; add a unit test with "#" and "?" in the path.
```

### PO-2
```
claim: The single-in-flight proof "if (host.opening) return null" is keyed on the caller's view object; the newly added menu entry passes a per-overlay Menu instance (a different object from the Tabs view), so the lock never sees a concurrent open — the documented "打开动作进行中时连点会被忽略，不会开出一串窗口" guarantee is not provided across the two new entry points.
file:line: mod/codebuddy.js:48
area: proof-obligations
severity: P2
confidence: 68
evidence: |
  Obligation: O11, O25
  Delta: incomplete-fix-in-modified-logic
  Root-cause: in-flight state is owned by a per-view field rather than a place shared by both entry points; each mod sandbox has its own copy of codebuddy.js, so a module-level variable would not help either.
  Systemic impact: duplicate windows and duplicate remote server setup, increasing the chance of the known intermittent remote connection failure; no data loss.
  Remediation: move the flag to shared state both mods can read (shared()/setShared with a timestamp TTL, cleared in finally), or narrow the README/plan claim to "同一入口连点" explicitly.
```

### PO-3
```
claim: spacePath() collapses an empty-string space folder to "no directory" via "|| space.folder || null", but Herdr documents an empty folder as that machine's home; spaces with no pane cwd and folder "" get a disabled button and a warning even though a legal directory exists.
file:line: mod/codebuddy.js:25
area: proof-obligations
severity: P2
confidence: 55
evidence: |
  Obligation: O4
  Delta: introduced
  Witness: spaces() entry {id:"s", machine:null, folder:"", tabs:[{id:"tb"}]} with panes:[{tab:"tb", cwd:null}]. herdr.d.ts:131 documents folder "" as "empty: that machine's home"; herdr-app's own test test("没有目录…") codifies "" as no-directory.
  Remediation: distinguish null/undefined from ""; for local spaces resolve "" to home(); for remote resolve via exec(..., {on: machine}); or keep disabled but say "home of <machine>" and update the test.
```

### PO-4
```
claim: The new install preflight extends the "all required files exist before any mutation" proof to the new mods but checks a strict subset of the files the very next copy loop consumes (jsconfig.json and the four win-*.svg are copied but not preflighted); a partial checkout therefore passes preflight and install.sh mutates ~/.local/bin and mods/ before dying mid-loop.
file:line: install.sh:63
area: proof-obligations
severity: P2
confidence: 62
evidence: |
  Obligation: O28
  Delta: incomplete-fix-in-modified-logic
  Root-cause: required-file set is enumerated twice (preflight vs copy loops) and the two lists drifted when the new loops were added.
  Remediation: derive both preflight and copy lists from one list, or add the missing jsconfig.json/svg checks.
```

## 结构性建议（非缺陷，t-mode #2/#4）

- `install.sh:123` 把四个 `win-*.svg` 拷进 `mods/tabs-todo`，但 `mod/tabs/main.js` 仍引用 `mods/tabs/win-*.svg`（自带 mod 的资源），这些拷贝是死负载。
- `mod/menu/main.js:12` 定义了 `place(s)`，同时又 import 了 `spacePath`，"这个 space 现在在哪" 的规则在一个文件里写了两份，可能各自漂移。

## Mandatory Coverage Check

- Total modified functions: 14
- Total changed branches / proofs: 37
- Total obligations created: 37（O1–O37）
- Obligations fully verified: 37
- Candidate-defect obligations: O4, O7, O11, O25, O28
- Closed-no-defect obligations: 其余全部
- Unreviewed changed branches: none

## 覆盖声明（原文要点）

读了 review-brief、plan、activity、git diff 全集、mod/codebuddy.js、mod/tabs/main.js、mod/menu/main.js、
mod/spaces/main.js、install.sh、scripts/*、tests/*、herdr.d.ts、AGENTS.md、layouts、已装 mods、~/.ssh/config、
CodeBuddy open-remote-ssh 扩展的 authority 常量与 bin/code。
跑了 npm test（102/102）、sh tests/cli.test.sh、herdr-app check ×5、node 探针验证 encodeURI/URL 语义。
未做 GUI 点击、未真实打开含 `#`/`?` 的远程目录、未证明 panes() 顺序保证、未验证 openOverlay 指向不存在 mod 的行为、未覆盖 Windows。
