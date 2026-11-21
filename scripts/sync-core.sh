#!/bin/sh
# Herdr mod 的沙箱禁止 import 自己目录之外的文件，所以 src/core.js 必须以副本形式
# 存在于 mod/ 里。这个脚本负责生成副本，并写入源码哈希；`npm test` 会校验它，
# 副本过期时测试直接失败（详见 tests/sync.test.js）。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC="$ROOT/src/core.js"
DST="$ROOT/mod/core.js"
# 侧栏克隆件（spaces-todo）也 import "./core.js" 与 "./store.js"：沙箱同样禁止
# 跨目录 import，所以它需要自己目录下的副本。由这里统一生成，避免三份各自漂移。
SIDEBAR_DIR="$ROOT/mod/spaces"
# Agents 栏克隆件（agents-todo）同理：它也要 import "./core.js"、"./store.js"
# 和 "./todo-view.js"，同样只能有同目录副本。
AGENTS_DIR="$ROOT/mod/agents"

[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
mkdir -p "$ROOT/mod" "$SIDEBAR_DIR" "$AGENTS_DIR"

if command -v shasum >/dev/null 2>&1; then
  HASH=$(shasum -a 256 "$SRC" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "$SRC" | awk '{print $1}')
else
  # 悄悄写一个空哈希会让人以为同步受保护了，实际没有。
  echo "sync-core: 需要 shasum 或 sha256sum" >&2
  exit 1
fi

{
  echo "// 由 scripts/sync-core.sh 从 src/core.js 生成，请勿手工编辑。"
  echo "// source-sha256: $HASH"
  cat "$SRC"
} > "$DST.tmp"
mv "$DST.tmp" "$DST"

# 侧栏副本：带同样的哈希头。正文一致是目标，两份副本各自可被 npm test 校验。
# store.js 不参与哈希（它只依赖 herdr 宿主），但同样必须有同目录副本，
# 否则侧栏 import "./store.js" 会解析失败。一并复制，避免手工漏拷。
cp "$DST" "$SIDEBAR_DIR/core.js"
cp "$ROOT/mod/store.js" "$SIDEBAR_DIR/store.js"

# Agents 栏的那份：core/store 同源，todo-view 抄侧栏那份（两边算「该显示在哪」
# 必须是同一套规则，测试守着不许分叉）。
cp "$DST" "$AGENTS_DIR/core.js"
cp "$ROOT/mod/store.js" "$AGENTS_DIR/store.js"
cp "$SIDEBAR_DIR/todo-view.js" "$AGENTS_DIR/todo-view.js"

# 拖拽契约同理：两个 mod 都要按同一套规则读「手上拿着哪条待办」，也要用同一套
# 跟随标签。分叉的话会出现「侧栏画了标签、Agents 栏不认这次拖拽」这种半边坏。
cp "$ROOT/mod/todo-drag.js" "$SIDEBAR_DIR/todo-drag.js"
cp "$ROOT/mod/todo-drag.js" "$AGENTS_DIR/todo-drag.js"

# 「用 CodeBuddy 打开」同理：标签栏按钮与 space 右键菜单各持一份副本。
# 分叉的话会出现「按钮开对目录、菜单开错目录」这种半边坏，而且两边都看着正常。
TABS_DIR="$ROOT/mod/tabs"
MENU_DIR="$ROOT/mod/menu"
mkdir -p "$TABS_DIR" "$MENU_DIR"
cp "$ROOT/mod/codebuddy.js" "$TABS_DIR/codebuddy.js"
cp "$ROOT/mod/codebuddy.js" "$MENU_DIR/codebuddy.js"

echo "synced mod/core.js + mod/spaces/{core,store}.js + mod/agents/{core,store,todo-view}.js + mod/{tabs,menu}/codebuddy.js (sha256 $(echo "$HASH" | cut -c1-12)…)"
