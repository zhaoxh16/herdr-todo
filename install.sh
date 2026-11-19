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
# BSD date（macOS）不支持 %N，会原样输出字面量 "N"——那样两次运行的戳完全相同。
# 先探测 %N 是否可用；不可用时退化为「秒级戳 + 一个一定不冲突的序号」。
stamp() {
  _ms=$(date +%N 2>/dev/null || true)
  case "$_ms" in
    ''|*[!0-9]*) _ms=000 ;;
  esac
  _base="$(date +%Y%m%d%H%M%S)-$(echo "$_ms" | cut -c1-3)"
  _try=0
  _cand="$_base"
  # 同一秒内重复运行时，后缀递增到没被占用为止（备份是给人留后路的，
  # 宁可名字长一点，也不能覆盖上一次的备份）。
  while [ -e "$1.bak-$_cand" ]; do
    _try=$((_try + 1))
    _cand="$_base-$_try"
  done
  printf '%s' "$_cand"
}

say() { printf '%s\n' "$*"; }
warn() { printf 'install: %s\n' "$*" >&2; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
# 覆盖前备份：已安装的 mod 可能被用户改过，静默覆盖等于删掉他的改动。
# 备份失败必须中止——「以为备份了其实没有」比不备份更糟。
# 每个备份点各自取戳：同一秒内重复运行时，全局固定的戳会让后一次覆盖前一次。
# stamp 会检查目标名是否已被占用，冲突就加序号。
backup() {
  [ -e "$1" ] || return 0
  _stamp=$(stamp "$1")
  cp -R "$1" "$1.bak-$_stamp" || die "备份 $1 失败，已中止（未改动任何文件）"
  say "    已备份 $(basename "$1") → $(basename "$1").bak-$_stamp"
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
[ -f "$ROOT/mod/spaces/mod.json" ] || die "缺少 $ROOT/mod/spaces/mod.json（侧栏待办要用）"
[ -f "$ROOT/mod/spaces/main.js" ] || die "缺少 $ROOT/mod/spaces/main.js"
[ -f "$ROOT/mod/spaces/todo-view.js" ] || die "缺少 $ROOT/mod/spaces/todo-view.js"
[ -f "$ROOT/mod/todo-drag.js" ] || die "缺少 $ROOT/mod/todo-drag.js（拖拽契约要用）"
[ -f "$ROOT/mod/spaces/jsconfig.json" ] || die "缺少 $ROOT/mod/spaces/jsconfig.json"
[ -f "$ROOT/mod/agents/mod.json" ] || die "缺少 $ROOT/mod/agents/mod.json（Agents 栏待办要用）"
[ -f "$ROOT/mod/agents/main.js" ] || die "缺少 $ROOT/mod/agents/main.js"
[ -f "$ROOT/mod/agents/todo-view.js" ] || die "缺少 $ROOT/mod/agents/todo-view.js"
[ -f "$ROOT/mod/agents/jsconfig.json" ] || die "缺少 $ROOT/mod/agents/jsconfig.json"
[ -f "$ROOT/scripts/install-layout.py" ] || die "缺少 $ROOT/scripts/install-layout.py"
[ -f "$ROOT/scripts/install-keys.py" ] || die "缺少 $ROOT/scripts/install-keys.py"
command -v node >/dev/null 2>&1 || die "需要 node（>=18），未找到"
command -v python3 >/dev/null 2>&1 || die "需要 python3，未找到"
[ -d "$APP_HOME" ] || die "找不到 ${APP_HOME}；请先安装并运行过 Herdr App"
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
say "    已复制 5 个文件（详情窗与快速记录窗）"

# 待办列表住在左侧侧栏：克隆 App 自带的 spaces，并在末尾追加待办行。
# 沙箱禁止跨目录 import，所以 store.js / core.js / todo-view.js 都要同目录一份。
SIDEBAR_DIR="$APP_HOME/mods/spaces-todo"
mkdir -p "$SIDEBAR_DIR"
for f in main.js mod.json store.js core.js todo-view.js todo-drag.js jsconfig.json; do
  backup "$SIDEBAR_DIR/$f"
  cp "$ROOT/mod/spaces/$f" "$SIDEBAR_DIR/$f" || die "复制 spaces-todo/$f 失败"
done
say "    已安装 spaces-todo（左侧侧栏里的待办行）"

# Agents 栏同理：克隆自带的 agents，在每个 agent 行下面追加关联到它的待办。
AGENTS_DIR="$APP_HOME/mods/agents-todo"
mkdir -p "$AGENTS_DIR"
for f in main.js mod.json store.js core.js todo-view.js todo-drag.js jsconfig.json; do
  backup "$AGENTS_DIR/$f"
  cp "$ROOT/mod/agents/$f" "$AGENTS_DIR/$f" || die "复制 agents-todo/$f 失败"
done
say "    已安装 agents-todo（Agents 栏里每个 agent 的待办行）"

# 旧版本把 Todo 放在 tab bar 上的克隆件里（mods/tabs-todo + 旧布局里 `tabs` 指向它）。
# 顺序要紧：先让第 4 步把布局改成指向自带 tabs 并成功落盘，再删这个 mod。
# 反过来做的话，布局生成失败时用户剩下的是一份「指向已删除 mod」的布局，
# 重启 App 就少了 tab bar——那正是 die 想要的「不留下半装状态」的反面。
# 这里只记录它是否存在，真正的移除在第 4 步之后。
OLD_TABS_DIR=""
if [ -d "$APP_HOME/mods/tabs-todo" ]; then
  OLD_TABS_DIR="$APP_HOME/mods/tabs-todo"
fi

say "4/5 生成布局 $APP_HOME/layouts/herdr-todo.json"
# 这份布局用户可能手工调过（面板宽度、默认面板），install-layout.py 自己
# 负责先备份再覆盖。
HERDR_APP_HOME="$APP_HOME" python3 "$ROOT/scripts/install-layout.py" || die "布局生成失败"

# 布局已经指向自带 tabs 了，现在才能安全地移走旧 mod。
# 不能备份到 mods/ 里面：App 会把该目录下每个文件夹都当作一个 mod 加载，
# 备份目录会变成「一个已废弃的 mod」被扫描。挪到 backups/ 下。
if [ -n "$OLD_TABS_DIR" ]; then
  BACKUP_DIR="$APP_HOME/backups"
  mkdir -p "$BACKUP_DIR" || die "创建 $BACKUP_DIR 失败"
  _stamp=$(stamp "$BACKUP_DIR/tabs-todo")
  mv "$OLD_TABS_DIR" "$BACKUP_DIR/tabs-todo.bak-$_stamp" \
    || die "移除旧 tabs-todo 失败（布局已经改好，可以手工删除 ${OLD_TABS_DIR}）"
  say "    已移除旧版 tabs-todo（备份在 $BACKUP_DIR/tabs-todo.bak-${_stamp}）"
fi

# 更早的安装脚本把旧 mod 的备份直接放在 mods/ 里（`tabs-todo.bak-<戳>`）。
# mods/ 下每个文件夹都会被当作 mod 加载，这些备份同样要挪走。
# 只认本项目的名字前缀，不碰用户自己的 mod。
for _old in "$APP_HOME/mods"/tabs-todo.bak-* "$APP_HOME/mods"/herdr-todo.bak-* "$APP_HOME/mods"/spaces-todo.bak-* "$APP_HOME/mods"/agents-todo.bak-*; do
  [ -e "$_old" ] || continue
  BACKUP_DIR="$APP_HOME/backups"
  mkdir -p "$BACKUP_DIR" || die "创建 $BACKUP_DIR 失败"
  _base=$(basename "$_old")
  _stamp=$(stamp "$BACKUP_DIR/$_base")
  mv "$_old" "$BACKUP_DIR/$_base.old-$_stamp" \
    || die "移除 mods/ 里的旧备份 $_base 失败"
  say "    已移出 mods/ 里的旧备份 ${_base}（现在在 $BACKUP_DIR/）"
done

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
say "  herdr-app check $MOD_DIR          # 校验详情窗能加载"
say "  herdr-app check $SIDEBAR_DIR      # 校验侧栏待办能加载"
say "  herdr-app check $AGENTS_DIR       # 校验 Agents 栏待办能加载"
say "  herdr-app do layout.switch --name herdr-todo   # 切到带待办面板的布局"
say ""
say "数据文件：$HOME_DIR/.local/share/herdr-todo/todos.json"
say "命令行：  herdr-todo add \"要做的事\" --space <space-id>"
say ""
say "待办列表在左侧 Spaces 侧栏：每个 space 行下面就是它的待办，点一行看详情。"
say "关联到 agent 的待办显示在 Agents 栏的 agent 行下；把侧栏的待办行拖到 agent 行即可关联。"

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
    warn "  快速记录     → mod.open，参数 name=herdr-todo"
  fi

  if [ -n "$BOUND" ] && [ "$BOUND" != "-" ]; then
    say ""
    say "快捷键（App 的 Keyboard shortcuts 里可改）："
    has "$BOUND" ctrl-alt-n && say "  ctrl-alt-n  打开快速记录弹窗"
  fi
fi
