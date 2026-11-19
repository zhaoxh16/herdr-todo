#!/bin/sh
# 安装 herdr-todo：CLI 进 PATH，mod 进 Herdr App，并生成一份带待办面板的布局。
# 可重复执行：已有文件先备份，不会静默覆盖。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOME_DIR=${HOME:?install.sh 需要 HOME 环境变量}
BIN_DIR="${HERDR_TODO_BIN_DIR:-$HOME_DIR/.local/bin}"
APP_HOME="${HERDR_APP_HOME:-$HOME_DIR/.config/herdr-app}"
MOD_NAME="herdr-todo"
# 备份戳带毫秒：同一秒内跑两次会互相覆盖，把真正的原始内容弄丢。
TS=$(date +%Y%m%d%H%M%S)-$(date +%N 2>/dev/null | cut -c1-3 || echo 000)

say() { printf '%s\n' "$*"; }
warn() { printf 'install: %s\n' "$*" >&2; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
# 覆盖前备份：已安装的 mod 可能被用户改过，静默覆盖等于删掉他的改动。
# 备份失败必须中止——「以为备份了其实没有」比不备份更糟。
backup() {
  [ -e "$1" ] || return 0
  cp -R "$1" "$1.bak-$TS" || die "备份 $1 失败，已中止（未改动任何文件）"
  say "    已备份 $(basename "$1") → $(basename "$1").bak-$TS"
}

# ---------- 前置检查：全部通过才开始改动任何东西 ----------
# 文件缺失是安装环境问题，不是「装到一半失败」——等步骤 4 才发现时，CLI 和
# mod 目录已经被改过，用户拿到的是半装状态。
[ -f "$ROOT/src/core.js" ] || die "找不到 $ROOT/src/core.js，请在仓库目录内运行"
[ -f "$ROOT/bin/herdr-todo" ] || die "找不到 $ROOT/bin/herdr-todo"
[ -f "$ROOT/mod/main.js" ] || die "缺少 $ROOT/mod/main.js"
[ -f "$ROOT/mod/store.js" ] || die "缺少 $ROOT/mod/store.js"
[ -f "$ROOT/mod/mod.json" ] || die "缺少 $ROOT/mod/mod.json"
[ -f "$ROOT/mod/todo.svg" ] || die "缺少 $ROOT/mod/todo.svg"
[ -f "$ROOT/mod/tabs/mod.json" ] || die "缺少 $ROOT/mod/tabs/mod.json（tab bar 上的 Todo 按钮要用）"
[ -f "$ROOT/mod/tabs/main.js" ] || die "缺少 $ROOT/mod/tabs/main.js"
[ -f "$ROOT/scripts/install-layout.py" ] || die "缺少 $ROOT/scripts/install-layout.py"
[ -f "$ROOT/scripts/install-keys.py" ] || die "缺少 $ROOT/scripts/install-keys.py"
command -v node >/dev/null 2>&1 || die "需要 node（>=18），未找到"
command -v python3 >/dev/null 2>&1 || die "需要 python3，未找到"
[ -d "$APP_HOME" ] || die "找不到 $APP_HOME；请先安装并运行过 Herdr App"
[ -f "$APP_HOME/layouts/main.json" ] || die "找不到 $APP_HOME/layouts/main.json；请先运行一次 Herdr App 让它生成默认布局"
[ -f "$APP_HOME/keys.json" ] || warn "警告：没有 $APP_HOME/keys.json，最后一步的快捷键会跳过"

say "1/5 同步共享核心到 mod/"
sh "$ROOT/scripts/sync-core.sh"

say "2/5 安装命令行工具到 $BIN_DIR"
mkdir -p "$BIN_DIR"
TARGET="$BIN_DIR/herdr-todo"
# 目标是真实目录时 ln -sfn 会把链接建到目录里面，脚本却打印成功。
[ -d "$TARGET" ] && [ ! -L "$TARGET" ] && die "$TARGET 是个目录，请先移开"
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  backup "$TARGET"
fi
chmod +x "$ROOT/bin/herdr-todo"
ln -sfn "$ROOT/bin/herdr-todo" "$TARGET"
say "    $TARGET -> $ROOT/bin/herdr-todo"

say "3/5 安装 mod 到 $APP_HOME/mods/$MOD_NAME"
MOD_DIR="$APP_HOME/mods/$MOD_NAME"
mkdir -p "$MOD_DIR"
for f in main.js store.js core.js mod.json todo.svg; do
  backup "$MOD_DIR/$f"
  cp "$ROOT/mod/$f" "$MOD_DIR/$f" || die "复制 $f 失败"
done
say "    已复制 5 个文件"

# tab bar 上的 Todo 开关按钮：App 自带的 tabs mod 不含它，用克隆件替换。
TABS_DIR="$APP_HOME/mods/tabs-todo"
mkdir -p "$TABS_DIR"
backup "$TABS_DIR/main.js"
backup "$TABS_DIR/mod.json"
cp "$ROOT/mod/tabs/main.js" "$TABS_DIR/main.js" || die "复制 tabs-todo/main.js 失败"
cp "$ROOT/mod/tabs/mod.json" "$TABS_DIR/mod.json" || die "复制 tabs-todo/mod.json 失败"
say "    已安装 tabs-todo（tab bar 上的 Todo 按钮）"

say "4/5 生成布局 $APP_HOME/layouts/herdr-todo.json"
# 这份布局用户可能手工调过（面板宽度、默认面板），install-layout.py 自己
# 负责先备份再覆盖。
HERDR_APP_HOME="$APP_HOME" python3 "$ROOT/scripts/install-layout.py" || die "布局生成失败"

say "5/5 写入快捷键到 $APP_HOME/keys.json"
KEYS_OK=1
KEYS_OUT=$(HERDR_APP_HOME="$APP_HOME" python3 "$ROOT/scripts/install-keys.py") || KEYS_OK=0
[ -n "${KEYS_OUT:-}" ] && printf '%s\n' "$KEYS_OUT"

say ""
if [ "$KEYS_OK" = "1" ]; then
  say "安装完成。"
else
  # 失败时不能仍宣称装好、更不能宣传两条未必存在的快捷键。
  warn "安装基本完成，但快捷键未写入 $APP_HOME/keys.json（见上面的报错）。"
  warn "可以稍后手动在 App 的 Keyboard shortcuts 里配置。"
fi
say ""
say "下一步："
say "  herdr-app check $MOD_DIR          # 校验 mod 能加载"
say "  herdr-app do layout.switch --name herdr-todo   # 切到带待办面板的布局"
say ""
say "数据文件：$HOME_DIR/.local/share/herdr-todo/todos.json"
say "命令行：  herdr-todo add \"要做的事\" --space <space-id>"

# 只宣传真的绑上的键。install-keys.py 用一行 SUMMARY 告诉我们哪几条落地了。
if [ "$KEYS_OK" = "1" ]; then
  SUMMARY=$(printf '%s\n' "${KEYS_OUT:-}" | grep '^SUMMARY ' | tail -1)
  BOUND=$(printf '%s' "$SUMMARY" | sed -n 's/.*bound=\([^ ]*\).*/\1/p')
  SKIPPED=$(printf '%s' "$SUMMARY" | sed -n 's/.*skipped=\([^ ]*\).*/\1/p')
  has() { case ",$1," in *",$2,"*) return 0 ;; *) return 1 ;; esac; }

  if [ -n "$SKIPPED" ] && [ "$SKIPPED" != "-" ]; then
    warn ""
    warn "以下快捷键已被其他动作占用，未绑定：$SKIPPED"
    warn "可在 App 的 Keyboard shortcuts 里手工绑定："
    warn "  展开/收起侧栏 → layout.toggle，参数 id=panel"
    warn "  快速记录     → mod.open，参数 name=herdr-todo"
  fi

  if [ -n "$BOUND" ] && [ "$BOUND" != "-" ]; then
    say ""
    say "快捷键（App 的 Keyboard shortcuts 里可改）："
    has "$BOUND" ctrl-alt-t && say "  ctrl-alt-t  展开 / 收起待办侧栏"
    has "$BOUND" ctrl-alt-n && say "  ctrl-alt-n  打开快速记录弹窗"
  fi
fi
