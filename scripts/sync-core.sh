#!/bin/sh
# Herdr mod 的沙箱禁止 import 自己目录之外的文件，所以 src/core.js 必须以副本形式
# 存在于 mod/ 里。这个脚本负责生成副本，并写入源码哈希；`npm test` 会校验它，
# 副本过期时测试直接失败（详见 tests/sync.test.js）。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SRC="$ROOT/src/core.js"
DST="$ROOT/mod/core.js"

[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }
mkdir -p "$ROOT/mod"

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

echo "synced mod/core.js (sha256 $(echo "$HASH" | cut -c1-12)…)"
