#!/bin/sh
# CLI 端到端：只用真实二进制与真实文件，不 mock。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN="$ROOT/bin/herdr-todo"
TMP=$(mktemp -d)
FILE="$TMP/nested/todos.json"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "  ok - $1"; }
run() { node "$BIN" --file "$FILE" "$@"; }

echo "== add / list =="
run add "修 login" --priority P1 --space spA >/dev/null
run add "写文档" --space spB --note "先列大纲" >/dev/null
run add "没挂 space 的" >/dev/null

[ "$(node "$BIN" --file "$FILE" list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(i=>i.title).sort().join("|")))')" = "修 login|写文档|没挂 space 的" ] \
  || fail "list --json 应含三条"
pass "三条事项落盘"

LIST=$(run list)
echo "$LIST" | grep -q "未处理 3" || fail "统计行应为未处理 3，实际：$LIST"
echo "$LIST" | grep -q "P0 0" || fail "统计行应含 P0 0"
pass "统计行正确"

echo "== 状态流转与时间线 =="
ID=$(node "$BIN" --file "$FILE" list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const it=JSON.parse(s).find(i=>i.title==="修 login");console.log(it.id)})')
run status "$ID" doing >/dev/null
run priority "$ID" P0 >/dev/null
run note "$ID" "复现：点按钮无反应" >/dev/null

SHOW=$(run show "$ID")
echo "$SHOW" | grep -q "状态：doing" || fail "状态应为 doing"
echo "$SHOW" | grep -q "优先级：P0" || fail "优先级应为 P0"
echo "$SHOW" | grep -q "创建为 todo" || fail "时间线应有创建条目"
echo "$SHOW" | grep -q "状态 todo → doing" || fail "时间线应有状态变更"
echo "$SHOW" | grep -q "优先级 P1 → P0" || fail "时间线应有优先级变更"
echo "$SHOW" | grep -q "备注 0 → 9 字" || fail "时间线应只记备注长度，实际：$SHOW"
pass "时间线记录四类变更"

echo "== 终态保护 =="
run status "$ID" done >/dev/null
if run status "$ID" todo >/dev/null 2>&1; then fail "done 直接改回 todo 应失败"; fi
pass "终态需 reopen"
run status "$ID" todo --reopen >/dev/null
[ "$(run show "$ID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')" = "todo" ] \
  || fail "reopen 后应回到 todo"
pass "reopen 生效"

echo "== link / unlink =="
run link "$ID" spB spC >/dev/null
[ "$(run show "$ID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).spaces.sort().join(",")))')" = "spA,spB,spC" ] \
  || fail "link 应追加且去重"
run unlink "$ID" spA >/dev/null
[ "$(run show "$ID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).spaces.sort().join(",")))')" = "spB,spC" ] \
  || fail "unlink 应只删指定项"
pass "link/unlink 正确"

echo "== 已完成默认隐藏 =="
run status "$ID" done >/dev/null
if run list | grep -q "修 login"; then fail "默认列表不应含已完成"; fi
run list --all | grep -q "修 login" || fail "--all 应含已完成"
pass "已完成折叠行为正确"

echo "== spaces 计数 =="
run spaces | grep -q "spB  1 项未处理" || { run spaces; fail "spaces 计数不对"; }
pass "spaces 计数正确"

echo "== 备注从 stdin =="
ID2=$(node "$BIN" --file "$FILE" list --json --all | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const it=JSON.parse(s).find(i=>i.title==="写文档");console.log(it.id)})')
printf '第一行\n第二行\n' | node "$BIN" --file "$FILE" note "$ID2" - >/dev/null
[ "$(run show "$ID2" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).note)))')" = '"第一行\n第二行\n"' ] \
  || fail "stdin 备注应完整保留换行"
pass "stdin 备注保留换行"

echo "== 错误路径 =="
run add "" >/dev/null 2>&1 && fail "空标题应失败"
run add x --priority P9 >/dev/null 2>&1 && fail "非法优先级应失败"
run status nosuch doing >/dev/null 2>&1 && fail "不存在 id 应失败"
run bogus >/dev/null 2>&1 && fail "未知命令应失败"
pass "错误路径均按预期失败"

echo "== 并发写不丢数据 =="
FILE3="$TMP/conc.json"
for i in 1 2 3 4 5 6; do
  node "$BIN" --file "$FILE3" add "并发$i" >/dev/null &
done
wait
N=$(node "$BIN" --file "$FILE3" export | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).items.length))')
[ "$N" = "6" ] || fail "并发 6 次 add 应得到 6 条，实际 $N"
pass "6 个并发 CLI 进程全部落盘"


echo "== 参数边界：用户文本不得被当成选项 =="
FILE4="$TMP/argv.json"
# 面板把 "add <标题>" 传成：--json --by panel --file=… <子命令> -- <位置参数>
# 标题恰好叫 -h / -- / --space 时，必须仍被当成标题。
for t in "-h" "--" "--space" "--file=/etc/passwd" "-"; do
  node "$BIN" --json --by panel --file="$FILE4" add -- "$t" >/dev/null 2>&1 || fail "标题「$t」应能创建"
done
node "$BIN" --file "$FILE4" export > "$TMP/argv.json.out"
grep -c '"title"' "$TMP/argv.json.out" | grep -qx 5 || fail "5 个特殊标题应各自创建一条"
for t in -h -- --space; do
  node "$BIN" --file "$FILE4" export | WANT="$t" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const want = process.env.WANT;
      const titles = JSON.parse(s).items.map((i) => i.title);
      if (!titles.includes(want)) { console.error("missing " + JSON.stringify(want)); process.exit(1); }
      const linked = JSON.parse(s).items.filter((i) => i.spaces.length);
      if (linked.length) { console.error("标题被当成 space: " + JSON.stringify(linked.map((i) => i.spaces))); process.exit(1); }
    });' || fail "标题 [$t] 没有原样落盘或改变了语义"
done
pass "特殊标题原样落盘、不改变语义"

echo "== --space= 形式与位置参数等价 =="
FILE5="$TMP/eq.json"
node "$BIN" --json --by panel --file="$FILE5" --space=spX add -- "带 space 的事" >/dev/null 2>&1 \
  || fail "--space= 形式应可用"
[ "$(node "$BIN" --json --file "$FILE5" show -- t1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).spaces.join(",")))')" = "spX" ] \
  || fail "--space= 应写入关联"
pass "--space= 生效"

echo "== link/unlink/set-spaces 不吃掉 --space 形式 =="
# --space 必须在 -- 之前：-- 之后一切皆位置参数（这正是它保护标题的方式）。
node "$BIN" --file "$FILE5" link t1 spY --space spZ >/dev/null
node "$BIN" --json --file "$FILE5" show -- t1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const sp=JSON.parse(s).spaces.sort().join(",");if(sp!=="spX,spY,spZ"){console.error(sp);process.exit(1)}})' \
  || fail "link 应同时接受位置参数与 --space"
node "$BIN" --file "$FILE5" set-spaces t1 --space spOnly >/dev/null
node "$BIN" --json --file "$FILE5" show -- t1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const sp=JSON.parse(s).spaces.join(",");if(sp!=="spOnly"){console.error(sp);process.exit(1)}})' \
  || fail "set-spaces 用 --space 传参不应清空关联"
pass "三种关联命令的两种传参形式一致"

echo "== --file= 空值必须报错，不能回退默认账本 =="
if node "$BIN" --file= add "不该落盘" >/dev/null 2>&1; then fail "--file= 空值应报错"; fi
CODE=0; node "$BIN" --file= add x >/dev/null 2>&1 || CODE=$?
[ "$CODE" = "2" ] || fail "--file= 空值应是用法错误（exit 2），实际 $CODE"
pass "--file= 空值被拒"

echo "== 归档：reopen 清掉归档标记 =="
FILE6="$TMP/arch.json"
node "$BIN" --file "$FILE6" add "要归档的" >/dev/null
node "$BIN" --file "$FILE6" archive t1 >/dev/null
node "$BIN" --file "$FILE6" status t1 doing --reopen >/dev/null
node "$BIN" --file "$FILE6" export | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).items[0];if(i.status!=="doing"){console.error("status "+i.status);process.exit(1)}if(i.archived!==undefined){console.error("archived still set");process.exit(1)}})' \
  || fail "reopen 后应清掉归档"
node "$BIN" --file "$FILE6" list | grep -q "要归档的" || fail "reopen 后应回到未处理列表"
node "$BIN" --file "$FILE6" archive t1 >/dev/null
node "$BIN" --file "$FILE6" unarchive t1 >/dev/null
node "$BIN" --file "$FILE6" list | grep -q "要归档的" || fail "unarchive 后应回到未处理列表"
# 统计行与列表行数必须一致：归档项不能只出现在其中一边。
OUT=$(node "$BIN" --file "$FILE6" list)
echo "$OUT" | grep -q "未处理 1" || fail "归档项不应计入未处理，实际：$OUT"
pass "归档可被 reopen / unarchive 解开，统计与列表一致"

echo "== 坏时间线条目：读取时报错而不是半路 TypeError =="
FILE7="$TMP/badtl.json"
mkdir -p "$(dirname "$FILE7")"
cat > "$FILE7" <<'JSON'
{"v":1,"seq":1,"items":[{"id":"t1","title":"x","status":"todo","priority":"P2","spaces":[],"created":1,"updated":1,"timeline":[{"kind":"spaces","at":1,"from":null,"to":"spA"}]}]}
JSON
if node "$BIN" --file "$FILE7" show t1 >/dev/null 2>&1; then fail "畸形时间线应报错"; fi
node "$BIN" --file "$FILE7" show t1 2>&1 | grep -q "时间线" || fail "报错信息应指出时间线"
pass "畸形时间线条目被定位并拒绝"

echo "== 悬空符号链接：写到目标，不替换链接 =="
mkdir -p "$TMP/linkhome" "$TMP/linkrepo/sub"
ln -s "$TMP/linkrepo/sub/todos.json" "$TMP/dangling.json"
HOME="$TMP/linkhome" node "$BIN" --file "$TMP/dangling.json" add "经由链接" >/dev/null || fail "悬空链接写入应成功"
[ -L "$TMP/dangling.json" ] || fail "悬空链接不应被替换成普通文件"
[ -f "$TMP/linkrepo/sub/todos.json" ] || fail "应写入链接指向的目标"
pass "悬空符号链接保持、目标被创建"

echo "== 新文件权限跟随 umask =="
FILE8="$TMP/perm-$(date +%s).json"
( umask 077; node "$BIN" --file "$FILE8" add a >/dev/null )
PERM=$(ls -l "$FILE8" | cut -c1-10)
[ "$PERM" = "-rw-------" ] || fail "umask 077 下应为 -rw-------，实际 $PERM"
pass "umask 077 下权限为 600"

echo ""
echo "ALL CLI TESTS PASSED"
