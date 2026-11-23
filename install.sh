#!/bin/sh
# 安装 herdr-todo：CLI 进 PATH，mod 进 Herdr App，并生成一份带待办面板的布局。
# 可重复执行：已有文件先备份，不会静默覆盖。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOME_DIR=${HOME:?install.sh 需要 HOME 环境变量}
BIN_DIR="${HERDR_TODO_BIN_DIR:-$HOME_DIR/.local/bin}"
APP_HOME="${HERDR_APP_HOME:-$HOME_DIR/.config/herdr-app}"
CONFIG_DIR="$HOME_DIR/.config/herdr-todo"
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

# ---------- 安装清单：「要装哪些 mod、每个 mod 有哪些文件」只写这一份 ----------
# 前置检查、拷贝、替换全部由它派生。上一版把清单手写了两遍（检查一遍、拷贝一遍），
# 加新 mod 时只改了拷贝那份，于是删掉一个文件就能让安装「检查通过、装到一半失败」，
# 留下布局已指向、目录却残缺的半装状态。
# 每行：<安装目录名>|<仓库内源目录>|<文件，空格分隔>|<人话说明>
MOD_MANIFEST='
herdr-todo|.|main.js store.js core.js mod.json todo.svg|详情窗与快速记录窗
spaces-todo|spaces|main.js mod.json store.js core.js todo-view.js todo-drag.js jsconfig.json|左侧侧栏里的待办行
agents-todo|agents|main.js mod.json store.js core.js todo-view.js todo-drag.js jsconfig.json|Agents 栏里每个 agent 的待办行
tabs-todo|tabs|main.js mod.json codebuddy.js jsconfig.json|标签栏里的 CodeBuddy 按钮
menu-todo|menu|main.js mod.json codebuddy.js jsconfig.json|space 右键菜单
'

# 按清单逐行回调：fn <安装目录名> <源目录> <文件（空格分隔）> <说明>
each_mod() {
  while IFS='|' read -r _m_name _m_src _m_files _m_desc; do
    [ -n "${_m_name:-}" ] || continue
    "$1" "$_m_name" "$_m_src" "$_m_files" "$_m_desc"
  done <<EOF
$MOD_MANIFEST
EOF
}

# ---------- 前置检查：全部通过才开始改动任何东西 ----------
# 文件缺失是安装环境问题，不是「装到一半失败」——等步骤 4 才发现时，CLI 和
# mod 目录已经被改过，用户拿到的是半装状态。
[ -f "$ROOT/src/core.js" ] || die "找不到 $ROOT/src/core.js，请在仓库目录内运行"
[ -f "$ROOT/bin/herdr-todo" ] || die "找不到 $ROOT/bin/herdr-todo"
[ -f "$ROOT/scripts/install-layout.py" ] || die "缺少 $ROOT/scripts/install-layout.py"
[ -f "$ROOT/scripts/install-keys.py" ] || die "缺少 $ROOT/scripts/install-keys.py"
# 上面这份清单里的每个文件都得先在仓库里存在。与拷贝共用 MOD_MANIFEST，不维护第二份。
check_mod() {
  for _c_f in $3; do
    [ -f "$ROOT/mod/$2/$_c_f" ] || die "缺少 $ROOT/mod/$2/${_c_f}（$1 要用）"
  done
}
each_mod check_mod
unset -f check_mod
command -v node >/dev/null 2>&1 || die "需要 node（>=18），未找到"
command -v python3 >/dev/null 2>&1 || die "需要 python3，未找到"
# mysql2 是首个运行时依赖，而 CLI 是从 ~/.local/bin 链回本仓库的（bin/herdr-todo
# 用相对路径 import ../src/…），所以 node_modules 只需要在仓库里存在一次。
# 缺它时装出来的 CLI 能启动、连接时才崩——比装不上更糟，必须在这里拦下。
[ -d "$ROOT/node_modules/mysql2" ] || die "缺少 node_modules/mysql2。请在 $ROOT 运行：npm install"
[ -f "$ROOT/src/store/mysql.js" ] || die "缺少 $ROOT/src/store/mysql.js"
[ -d "$APP_HOME" ] || die "找不到 ${APP_HOME}；请先安装并运行过 Herdr App"
[ -f "$APP_HOME/layouts/main.json" ] || die "找不到 $APP_HOME/layouts/main.json；请先运行一次 Herdr App 让它生成默认布局"
[ -f "$APP_HOME/keys.json" ] || warn "警告：没有 $APP_HOME/keys.json，最后一步的快捷键会跳过"

# 迁移期的致命顺序必须在**改动任何文件之前**拦下。
#
# 旧版 mod 从不调用 pull，所以「缓存路径上放着 v1 旧账本」在旧版本里是安全的。
# 新 mod 装好后两个侧栏每 10 秒自动 pull，而 pull 不认识 v1——它把这份文件当成
# 一份可疑的缓存，整体替换成 v2 空快照（实测 254 字节 → 81 字节），且不留备份。
# 那时 import-json 只能读到空缓存，报「旧账本里没有事项」，数据再也回不来。
#
# 所以：发现缓存路径上是一份非空的 v1 账本，就停下来让用户先导入。
# 判断放在这里而不是「装完再提示」——提示出现在装完之后，伤害已经造成。
LEDGER="$HOME_DIR/.local/share/herdr-todo/todos.json"
is_v1_ledger() {
  [ -f "$1" ] || return 1
  node -e '
    try {
      const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(s && s.v === 1 && Array.isArray(s.items) && s.items.length ? 0 : 1);
    } catch { process.exit(1); }
  ' "$1" 2>/dev/null
}
if is_v1_ledger "$LEDGER"; then
  die "检测到 $LEDGER 还是一份旧版账本（v1，$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(s.items.length))' "$LEDGER") 条事项）。
新面板每 10 秒会自动 pull，而 pull 会把它覆盖成空缓存——这一步必须在装 mod **之前**做完：

  1. cp \"$LEDGER\" \"$LEDGER.v1\"                      # 先留一份
  2. 写好 ${CONFIG_DIR}/config.json，然后：
     herdr-todo import-json \"$LEDGER.v1\" --dry-run     # 确认条数
     herdr-todo import-json \"$LEDGER.v1\"
  3. 再重新运行 ./install.sh

如果你确认这份账本已经不需要（例如已在别的机器上导入过），把它移走后再装。"
fi

# 暂存目录在 $APP_HOME 下（与 mods/ 同一文件系统，rename 才是原子的），
# 失败时统一清掉，不把半成品留在用户目录里。
STAGE="$APP_HOME/.install-stage.$$"
trap 'rm -rf "$STAGE" 2>/dev/null || true' EXIT

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

say "3/5 安装 mod 到 $APP_HOME/mods"
# 每个 mod 都先在暂存目录里装完整，再用一次 rename 换上去。
# 逐文件 cp 进在用目录时，中途失败会留下「main.js 已引用 ./codebuddy.js、而它缺失」
# 的目录；布局正指向这些 mod，App 又对 mods/<name>/ 热重载，结果就是标签栏或侧栏
# 整体加载失败。目标位置是目录时 cp 甚至会退出 0 —— 装完照样坏。
rm -rf "$STAGE"
mkdir -p "$STAGE" || die "创建暂存目录 $STAGE 失败"

# 先在暂存区把每个 mod 装齐：源文件缺一个、cp 失败，都在碰在用目录之前中止。
stage_mod() {
  _s_name=$1 _s_src=$2 _s_files=$3
  _s_dir="$STAGE/$_s_name"
  mkdir -p "$_s_dir"
  for _s_f in $_s_files; do
    cp "$ROOT/mod/$_s_src/$_s_f" "$_s_dir/$_s_f" || die "暂存 $_s_name/$_s_f 失败，已中止（在用目录未改动）"
    # cp 到同名目录会把源拷进去并返回 0；暂存目录是新建的，正常不会发生，
    # 但保持这条断言，免得将来有人改了暂存方式却以为还是原子的。
    [ -f "$_s_dir/$_s_f" ] || die "暂存后的 $_s_name/$_s_f 不是普通文件"
  done
}
each_mod stage_mod
unset -f stage_mod

mkdir -p "$APP_HOME/mods"
install_mod() {
  _i_name=$1 _i_files=$3 _i_desc=$4
  _i_src="$STAGE/$_i_name"
  _i_dst="$APP_HOME/mods/$_i_name"
  _i_old="" # POSIX sh 没有 local：每轮清空，免得失败信息引用上一轮的备份路径
  # 旧目录整个挪进 backups/：既是本次的备份，也让新目录能一次性整体就位。
  # 用整目录而不是逐文件 `.bak`，因为逐文件备份在「整体替换」下会被一起换走。
  if [ -e "$_i_dst" ] || [ -L "$_i_dst" ]; then
    mkdir -p "$APP_HOME/backups" || die "创建 $APP_HOME/backups 失败"
    _i_old="$APP_HOME/backups/$_i_name.bak-$(stamp "$APP_HOME/backups/$_i_name")"
    mv "$_i_dst" "$_i_old" || die "备份 $_i_name 失败，已中止（$APP_HOME/mods 未改动）"
    say "    已备份 $_i_name → backups/$(basename "$_i_old")"
  fi
  mv "$_i_src" "$_i_dst" || die "替换 $_i_name 失败：新目录无法就位（旧目录在 $(basename "${_i_old:-无}")）"
  # 就位后核对：目录存在、清单里的文件都在。这一步挡住「看起来装好了其实是半个」。
  for _i_f in $_i_files; do
    [ -f "$_i_dst/$_i_f" ] || die "安装 $_i_name 后缺少 ${_i_f}（旧目录在 backups/）"
  done
  say "    已安装 ${_i_name}（${_i_desc}）"
}
each_mod install_mod
unset -f install_mod
rm -rf "$STAGE"

# 历史上（v0.1 的 tabs-todo）标签栏克隆件曾被移除，改回自带 tabs。
# 现在 tabs-todo 又回来了，但含义完全不同：它只多一个 CodeBuddy 按钮，
# 布局也明确指向它。所以**不能**再自动移除它——那会把刚装好的 mod 删掉，
# 布局就指向一个不存在的 mod。旧版本留下的 `tabs-todo.bak-<戳>` 备份仍按
# 「mods/ 里不留备份」的规矩挪到 backups/（见下面的循环）。

say "4/5 生成布局 $APP_HOME/layouts/herdr-todo.json"
# 这份布局用户可能手工调过（面板宽度、默认面板），install-layout.py 自己
# 负责先备份再覆盖。
HERDR_APP_HOME="$APP_HOME" python3 "$ROOT/scripts/install-layout.py" || die "布局生成失败"

# 更早的安装脚本把旧 mod 的备份直接放在 mods/ 里（`tabs-todo.bak-<戳>`）。
# mods/ 下每个文件夹都会被当作 mod 加载，这些备份同样要挪走。
# 只认本项目的名字前缀，不碰用户自己的 mod。
for _old in "$APP_HOME/mods"/tabs-todo.bak-* "$APP_HOME/mods"/menu-todo.bak-* "$APP_HOME/mods"/herdr-todo.bak-* "$APP_HOME/mods"/spaces-todo.bak-* "$APP_HOME/mods"/agents-todo.bak-*; do
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
say "  herdr-app check $APP_HOME/mods/$MOD_NAME      # 校验详情窗能加载"
say "  herdr-app check $APP_HOME/mods/spaces-todo    # 校验侧栏待办能加载"
say "  herdr-app check $APP_HOME/mods/agents-todo    # 校验 Agents 栏待办能加载"
say "  herdr-app check $APP_HOME/mods/tabs-todo      # 校验标签栏 CodeBuddy 按钮能加载"
say "  herdr-app check $APP_HOME/mods/menu-todo      # 校验 space 右键菜单能加载"
say "  herdr-app do layout.switch --name herdr-todo   # 切到带待办面板的布局"
say ""
say "还要连上数据库，面板才有数据（读 README「接入一 / 接入二」）："
say "  新设备、数据已在云端：写好 ${CONFIG_DIR}/config.json（owner 与其它设备一致）后"
say "    herdr-todo pull        # 首次全量重建，并把本机登记成一台设备"
say "  本机有旧账本要迁上云：安装脚本已在前面拦下这种情况，按它给的步骤先导入。"
say ""
say "数据文件：$HOME_DIR/.local/share/herdr-todo/todos.json（派生缓存，真相在 MySQL）"
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
