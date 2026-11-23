#!/bin/sh
# CLI 端到端：只用真实二进制与真库，不 mock。
#
# 数据迁到 MySQL 后，这个脚本需要一条可写的测试库：
#   HERDR_TODO_TEST_DSN  默认 mysql://root@127.0.0.1:3306/herdr_todo_test
# 连不上时**跳过并说明**，而不是成功退出——「没跑」和「跑了且通过」必须能区分。
#
# 隔离用 owner：每组用例换一个随机 owner（写进临时的 config.json），彼此不看见
# 对方的数据。HOME 指向 TMP，缓存与 sync.json 都在里面，绝不碰真实账本。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BIN="$ROOT/bin/herdr-todo"
TMP=$(mktemp -d)

DSN=${HERDR_TODO_TEST_DSN:-mysql://root@127.0.0.1:3306/herdr_todo_test}

fail() { echo "FAIL: $1" >&2; exit 1; }
pass() { echo "  ok - $1"; }
skip_all() { echo "SKIP: $1" >&2; exit 0; }

MYSQL2="$ROOT/node_modules/mysql2/promise.js"
[ -f "$MYSQL2" ] || skip_all "缺少 node_modules/mysql2（先在仓库根目录 npm install）"

# 探库：连不上就跳过整份脚本，不伪装成通过。
if ! HERDR_TODO_DSN="$DSN" node -e '
  const mysql = require(process.argv[1]);
  const u = new URL(process.env.HERDR_TODO_DSN);
  mysql.createConnection({
    host: u.hostname, port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)), connectTimeout: 3000,
  }).then(function (k) {
    return k.query("SELECT 1 FROM meta WHERE k = \x27schema_version\x27").then(function () { return k.end(); });
  }).then(function () { process.exit(0); }).catch(function () { process.exit(1); });
' "$MYSQL2"; then
  # 要求跑集成测试时（CI / 交付验证），「连不上」是失败而不是跳过。
  [ "${HERDR_TODO_REQUIRE_DB:-}" = "1" ] \
    && fail "要求跑端到端测试（HERDR_TODO_REQUIRE_DB=1），但连不上测试库 ${DSN}"
  skip_all "连不上测试库 ${DSN}（设置 HERDR_TODO_TEST_DSN；未建库时先 sh db/create.sh herdr_todo_test）"
fi

export HOME="$TMP/home"
export HERDR_TODO_DSN="$DSN"
mkdir -p "$HOME/.config/herdr-todo"

OWNERS=""

cleanup_owners() {
  node -e '
    const mysql = require(process.argv[1]);
    const u = new URL(process.env.HERDR_TODO_DSN);
    (async () => {
      const c = await mysql.createConnection({
        host: u.hostname, port: Number(u.port) || 3306,
        user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
        database: decodeURIComponent(u.pathname.slice(1)),
      });
      for (const slug of process.argv.slice(2)) {
        if (!slug) continue;
        const [rows] = await c.query("SELECT id FROM owners WHERE slug = ?", [slug]);
        if (!rows.length) continue;
        const id = rows[0].id;
        await c.query("DELETE e FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.owner_id = ?", [id]);
        await c.query("DELETE p FROM item_places p JOIN items i ON i.id = p.item_id WHERE i.owner_id = ?", [id]);
        await c.query("DELETE FROM items WHERE owner_id = ?", [id]);
        await c.query("DELETE FROM devices WHERE owner_id = ?", [id]);
        await c.query("DELETE FROM owners WHERE id = ?", [id]);
      }
      await c.end();
    })().catch(() => {});
  ' "$MYSQL2" $OWNERS
}
trap 'cleanup_owners; rm -rf "$TMP"' EXIT

# 换一个干净的 owner 与干净的本机缓存。每组用例开头调它。
use_owner() {
  OWNER="cli-$$-$1-$(date +%s | tail -c 6)"
  OWNERS="$OWNERS $OWNER"
  printf '{"owner":"%s","ssl":false}\n' "$OWNER" > "$HOME/.config/herdr-todo/config.json"
  rm -rf "$HOME/.local" "$HOME/.config/herdr-todo/sync.json"
}

run() { node "$BIN" "$@"; }
# 文件内容指纹：用来断言「这份文件一个字节都没被改」。
if command -v shasum >/dev/null 2>&1; then
  csum() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  csum() { sha256sum "$1" | awk '{print $1}'; }
else
  csum() { wc -c < "$1" | tr -d ' '; }  # 退化成字节数：本用例里内容不变即可
fi
# 从 stdin 的 JSON 里取一个值；参数是一段 JS 表达式体（v 是解析后的值）。
jq1() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log((function(){return eval(process.argv[1])})())})' "$1"; }

echo "== add / list =="
use_owner add
run add "修 login" --priority P1 --space spA >/dev/null
run add "写文档" --space spB --note "先列大纲" >/dev/null
run add "没挂 space 的" >/dev/null

[ "$(run list --json | jq1 'v.map(i=>i.title).sort().join("|")')" = "修 login|写文档|没挂 space 的" ] \
  || fail "list --json 应含三条"
pass "三条事项落库"

LIST=$(run list)
echo "$LIST" | grep -q "未处理 3" || fail "统计行应为未处理 3，实际：$LIST"
echo "$LIST" | grep -q "P0 0" || fail "统计行应含 P0 0"
echo "$LIST" | grep -q "#1" || fail "列表应显示人读编号 #1，实际：$LIST"
pass "统计行与编号显示正确"

echo "== 编号寻址：n / #n / ULID 可用，t12 被拒 =="
N=$(run list --json | jq1 'v.find(i=>i.title==="修 login").num')
ID=$(run list --json | jq1 'v.find(i=>i.title==="修 login").id')
run show "#$N" >/dev/null || fail "show #n 应可用"
run show "$N" >/dev/null || fail "show n（无 #）应可用"
run show "$ID" >/dev/null || fail "show ULID 应可用"
if run show t1 >/dev/null 2>&1; then fail "t1 旧编号应被拒绝"; fi
run show t1 2>&1 | grep -q "旧编号" || fail "拒绝 t1 时应提示改用 #n"
pass "编号寻址：n / #n / ULID 可用，t1 被拒"

echo "== 状态流转与时间线 =="
run status "#$N" doing >/dev/null
run priority "#$N" P0 >/dev/null
run note "#$N" "复现：点按钮无反应" >/dev/null

SHOW=$(run show "#$N")
echo "$SHOW" | grep -q "状态：doing" || fail "状态应为 doing"
echo "$SHOW" | grep -q "优先级：P0" || fail "优先级应为 P0"
echo "$SHOW" | grep -q "创建为 todo" || fail "时间线应有创建条目"
echo "$SHOW" | grep -q "状态 todo → doing" || fail "时间线应有状态变更"
echo "$SHOW" | grep -q "优先级 P1 → P0" || fail "时间线应有优先级变更"
echo "$SHOW" | grep -q "备注 0 → 9 字" || fail "时间线应只记备注长度，实际：$SHOW"
pass "时间线记录四类变更"

echo "== 终态保护 =="
run status "#$N" done >/dev/null
if run status "#$N" todo >/dev/null 2>&1; then fail "done 直接改回 todo 应失败"; fi
run status "#$N" todo 2>&1 | grep -q "重新打开" || fail "应提示需要 reopen"
run status "#$N" todo --reopen >/dev/null
[ "$(run show "#$N" --json | jq1 'v.status')" = "todo" ] || fail "reopen 后应回到 todo"
pass "终态需 reopen"

echo "== link / unlink =="
run link "#$N" spB spC >/dev/null
[ "$(run show "#$N" --json | jq1 'v.spaces.sort().join(",")')" = "spA,spB,spC" ] || fail "link 应追加且去重"
run unlink "#$N" spA >/dev/null
[ "$(run show "#$N" --json | jq1 'v.spaces.sort().join(",")')" = "spB,spC" ] || fail "unlink 应只删指定项"
pass "link/unlink 正确"

echo "== 并发写不丢数据、编号连续唯一 =="
use_owner conc
for i in 1 2 3 4 5 6; do
  run add "并发$i" >/dev/null &
done
wait
[ "$(run list --all --json | jq1 'v.length')" = "6" ] || fail "并发 6 次 add 应得到 6 条"
NUMS=$(run list --all --json | jq1 'v.map(i=>i.num).sort((x,y)=>x-y).join(",")')
[ "$NUMS" = "1,2,3,4,5,6" ] || fail "并发 add 的编号应为 1..6，实际 $NUMS"
pass "6 个并发 CLI 进程全部落库，编号连续唯一"

echo "== 已完成默认隐藏 =="
use_owner closed
run add "完成的" >/dev/null
run status "#1" done >/dev/null
# 断言条目数而不是 grep 标题：默认列表为空时打印「（没有未完成的事项）」，
# 里面就含「完成的」三个字，grep 会把提示文案当成数据。
[ "$(run list --json | jq1 'v.length')" = "0" ] || fail "默认列表不应含已完成"
[ "$(run list --all --json | jq1 'v.length')" = "1" ] || fail "--all 应含已完成"
pass "已完成折叠行为正确"

echo "== spaces 计数 =="
use_owner spaces
run add "挂 spB 的" --space spB >/dev/null
run add "挂 spB 与 spC 的" --space spB --space spC >/dev/null
run spaces | grep -q "spB  2 项未处理" || { run spaces; fail "spaces 计数不对"; }
run spaces | grep -q "spC  1 项未处理" || { run spaces; fail "spC 计数不对"; }
pass "spaces 计数正确"

echo "== 备注从 stdin =="
use_owner stdin
run add "带备注的" >/dev/null
printf '第一行\n第二行\n' | run note "#1" - >/dev/null
[ "$(run show "#1" --json | jq1 'JSON.stringify(v.note)')" = '"第一行\n第二行\n"' ] \
  || fail "stdin 备注应完整保留换行"
pass "stdin 备注保留换行"

echo "== title：改名落盘 + 时间线记录 from/to =="
use_owner title
run --json --by panel add -- "原来的标题" >/dev/null
BEFORE=$(run show "#1" --json)
run --json --by panel title -- "#1" "改成新标题" >/dev/null || fail "title 应成功"
AFTER=$(run show "#1" --json)
BEFORE="$BEFORE" AFTER="$AFTER" node -e '
  const before = JSON.parse(process.env.BEFORE);
  const after = JSON.parse(process.env.AFTER);
  if (after.title !== "改成新标题") { console.error("title 未落盘：" + after.title); process.exit(1); }
  const last = after.timeline.at(-1);
  if (last.kind !== "title" || last.from !== "原来的标题" || last.to !== "改成新标题" || last.by !== "panel") {
    console.error("时间线条目不对：" + JSON.stringify(last)); process.exit(1);
  }
  if (!(after.updated >= before.updated)) { console.error("updated 不该倒退"); process.exit(1); }
' || fail "title 应改名、刷新 updated 并记时间线"
run show "#1" | grep -q "标题改为「改成新标题」" || fail "show 应渲染标题变更条目"
pass "title 改名、updated 与时间线正确"

echo "== title：空白标题被拒且数据不变 =="
BEFORE=$(run show "#1" --json)
if run title -- "#1" "   " >/dev/null 2>&1; then fail "空白标题应失败"; fi
[ "$(run show "#1" --json)" = "$BEFORE" ] || fail "失败的 title 不该改写数据"
pass "空白标题被拒、数据未变"

echo "== title：标题看起来像选项时原样落盘 =="
run --json --by panel title -- "#1" "-h" >/dev/null || fail "标题「-h」应能保存"
[ "$(run show "#1" --json | jq1 'v.title')" = "-h" ] || fail "标题「-h」没有原样落盘"
run --json --by panel title -- "#1" "--space x" >/dev/null || fail "标题「--space x」应能保存"
run show "#1" --json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const it = JSON.parse(s);
    if (it.title !== "--space x") { console.error("特殊标题未原样落盘：" + JSON.stringify(it.title)); process.exit(1); }
    if (it.spaces.length) { console.error("标题被当成 space：" + JSON.stringify(it.spaces)); process.exit(1); }
  });' || fail "特殊字符标题应原样落盘"
pass "特殊标题原样落盘、不被当成选项或 space"

echo "== 错误路径 =="
run add "" >/dev/null 2>&1 && fail "空标题应失败"
run add x --priority P9 >/dev/null 2>&1 && fail "非法优先级应失败"
run status 999 doing >/dev/null 2>&1 && fail "不存在编号应失败"
run bogus >/dev/null 2>&1 && fail "未知命令应失败"
# 越界参数在边界处拒绝：让它到 INSERT 才失败，用户只会看到驱动的
# 「Data too long for column」，既不知道哪项错了也不改得动。
run --op "$(printf 'Z%.0s' $(seq 40))" add "长幂等键" 2>&1 | grep -q "ULID" || fail "非法 --op 应被拒并说明格式"
BYNUM=$(run --by "$(printf 'b%.0s' $(seq 100))" add "长操作者" --json | jq1 'v.num') \
  || fail "超长 --by 应被截到 64，而不是让写失败"
LONGBY=$(run show "#$BYNUM" --json | jq1 'v.timeline.at(-1).by')
[ ${#LONGBY} = 64 ] || fail "actor 应截到 64 字符，实际 ${#LONGBY}"
# 超长标题报错而不是静默截断：用户得知道「没保存」，而不是看到「已添加」
# 却发现少了半句话。
LONGTITLE=$(printf '长%.0s' $(seq 201))
run add "$LONGTITLE" 2>&1 | grep -q "标题最多 200 字" || fail "超长标题应报错并说明上限"
CT=$(run list --all --json | jq1 'v.map(i=>i.title).filter(t=>t.length==201).length')
[ "$CT" = "0" ] || fail "超长标题不得被截断后写入"
pass "错误路径均按预期失败"

echo "== --file 已删除：任何形态都报用法错误（exit 2） =="
# 两种形态都要测：`--file=x` 走等号分支，`--file x` 走「取下一个 argv 当值」
# 的分支，解析器里是两段代码，只测一种会漏掉另一种被悄悄放行。
for form in "--file=$TMP/x.json" "--file"; do
  CODE=0
  if [ "$form" = "--file" ]; then
    node "$BIN" --file "$TMP/x.json" add "不该落盘" >/dev/null 2>&1 || CODE=$?
  else
    node "$BIN" "$form" add "不该落盘" >/dev/null 2>&1 || CODE=$?
  fi
  [ "$CODE" = "2" ] || fail "$form 应是用法错误（exit 2），实际 $CODE"
done
node "$BIN" --file=/x add y 2>&1 | grep -q "已删除" || fail "--file 的报错应说明已删除并给出替代"
pass "--file 被显式拒绝"

echo "== 参数边界：用户文本不得被当成选项 =="
use_owner argv
for t in "-h" "--" "--space" "-"; do
  run --json --by panel add -- "$t" >/dev/null 2>&1 || fail "标题「${t}」应能创建"
done
COUNT=$(run list --all --json | jq1 'v.length')
[ "$COUNT" = "4" ] || fail "4 个特殊标题应各自创建一条，实际 $COUNT"
[ "$(run list --all --json | jq1 'v.map(i=>i.title).sort().join("|")')" = "-|--|--space|-h" ] \
  || fail "四个标题应原样落盘"
run list --all --json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const items = JSON.parse(s);
    const linked = items.filter((i) => i.spaces.length);
    if (linked.length) { console.error("标题被当成 space: " + JSON.stringify(linked.map((i) => i.spaces))); process.exit(1); }
  });' || fail "标题不该被当成 space"
pass "特殊标题原样落盘、不改变语义"

echo "== --space= 形式与位置参数等价 =="
use_owner eq
run --json --by panel --space=spX add -- "带 space 的事" >/dev/null 2>&1 || fail "--space= 形式应可用"
[ "$(run show "#1" --json | jq1 'v.spaces.join(",")')" = "spX" ] || fail "--space= 应写入关联"
pass "--space= 生效"

echo "== link/unlink/set-spaces 不吃掉 --space 形式 =="
run link "#1" spY --space spZ >/dev/null
[ "$(run show "#1" --json | jq1 'v.spaces.sort().join(",")')" = "spX,spY,spZ" ] || fail "link 应同时接受位置参数与 --space"
run set-spaces "#1" --space spOnly >/dev/null
[ "$(run show "#1" --json | jq1 'v.spaces.join(",")')" = "spOnly" ] || fail "set-spaces 用 --space 传参不应清空关联"
pass "三种关联命令的两种传参形式一致"

echo "== 归档：reopen 清掉归档标记 =="
use_owner arch
run add "要归档的" >/dev/null
run archive "#1" >/dev/null
run status "#1" doing --reopen >/dev/null
run show "#1" --json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const i=JSON.parse(s);
    if(i.status!=="doing"){console.error("status "+i.status);process.exit(1)}
    if(i.archived!==undefined && i.archived!==null){console.error("archived still set");process.exit(1)}
  })' || fail "reopen 后应清掉归档"
run list | grep -q "要归档的" || fail "reopen 后应回到未处理列表"
run archive "#1" >/dev/null
run unarchive "#1" >/dev/null
run list | grep -q "要归档的" || fail "unarchive 后应回到未处理列表"
OUT=$(run list)
echo "$OUT" | grep -q "未处理 1" || fail "归档项不应计入未处理，实际：$OUT"
pass "归档可被 reopen / unarchive 解开，统计与列表一致"

echo "== 删除：写墓碑，列表里消失，show 明确说已删除 =="
use_owner del
run add "会被删的" >/dev/null
run delete "#1" >/dev/null || fail "delete 应成功"
if run list --all | grep -q "会被删的"; then fail "已删除的事项不该出现在 --all 列表里"; fi
if run show "#1" >/dev/null 2>&1; then fail "已删除的事项 show 应失败"; fi
run show "#1" 2>&1 | grep -q "已被删除" || fail "show 已删除事项应说明原因"
pass "删除写墓碑、列表消失、show 说明原因"

echo "== agent 关联：替代 space，且回退位置记下来 =="
use_owner agent
run add "要挂 agent 的" --space spA >/dev/null
run --in-space=spFallback agent "#1" dev5/t2 >/dev/null || fail "agent 关联应成功"
run show "#1" --json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const it = JSON.parse(s);
    if (!it.agent) { console.error("agent 未落盘"); process.exit(1); }
    if (it.agent.address !== "dev5/t2" || it.agent.space !== "spFallback") { console.error(JSON.stringify(it.agent)); process.exit(1); }
    if (it.spaces.length) { console.error("agent 关联应清空 spaces：" + JSON.stringify(it.spaces)); process.exit(1); }
  });' || fail "agent 关联应替代 space 且记录回退 space"
run link "#1" spB >/dev/null
run show "#1" --json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const it = JSON.parse(s);
    if (it.agent) { console.error("挂 space 后 agent 应被解除"); process.exit(1); }
    if (it.spaces.join(",") !== "spB") { console.error(JSON.stringify(it.spaces)); process.exit(1); }
  });' || fail "link space 应解除 agent 关联"
pass "agent 与 space 互斥"

echo "== agent 关联：不暴露成 space =="
run --in-space=spFallback agent "#1" dev5/t2 >/dev/null
run show "#1" | grep -q "agent dev5/t2" || fail "show 应显示 agent 关联"
if run show "#1" | grep -q "未关联"; then fail "show 不应把 agent 关联说成未关联"; fi
run list | grep -q "agent dev5/t2" || fail "list 应显示 agent 关联"
run spaces | grep -q "spFallback  1 项未处理" || { run spaces; fail "spaces 应按回退 space 计数"; }
pass "agent 关联在输出里不被当成 space"

echo "== agent 关联：--clear 与缺参 =="
if run agent "#1" >/dev/null 2>&1; then fail "agent 缺 address 且无 --clear 应失败"; fi
if run agent "#1" dev5/t2 >/dev/null 2>&1; then fail "缺 --in-space 应失败"; fi
run agent "#1" --clear >/dev/null || fail "--clear 应成功"
run show "#1" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(JSON.parse(s).agent){console.error("--clear 后 agent 应消失");process.exit(1)}})' \
  || fail "--clear 应移除 agent 关联"
run show "#1" | grep -q "未关联" || fail "解除后应显示未关联"
pass "agent --clear 与缺参校验"

echo "== move：从一个 space 挪到另一个（一次事务） =="
use_owner move
run add "要挪的" --space spA >/dev/null
run move "#1" spB --from spA >/dev/null || fail "move 应成功"
[ "$(run show "#1" --json | jq1 'v.spaces.join(",")')" = "spB" ] || fail "move 应去掉来源、加上目标"
run move "#1" --from spB >/dev/null || fail "move 到未关联应成功"
run show "#1" | grep -q "未关联" || fail "move 到未关联后应显示未关联"
if run move "#1" spB spC >/dev/null 2>&1; then fail "move 只接受一个目标 space"; fi
if run move 999 spB >/dev/null 2>&1; then fail "move 找不到事项时应失败"; fi
pass "move 从来源移到目标 / 未关联"

echo "== move：多个 --from（孤儿组清理） =="
use_owner orphan
run add "双孤儿" --space spDEAD1 --space spDEAD2 --space spB >/dev/null
run move "#1" spC --from spDEAD1 --from spDEAD2 >/dev/null || fail "多个 --from 应成功"
GOT=$(run show "#1" --json | jq1 'v.spaces.sort().join(",")')
[ "$GOT" = "spB,spC" ] || fail "应摘掉两个死来源并保留 spB、加上 spC，实际 $GOT"
pass "move 支持多个 --from（孤儿清理）"

echo "== move：--from 等于目标时是空操作 =="
use_owner moveself
run add "原地" --space spB >/dev/null
run move "#1" spB --from spB >/dev/null || fail "原地 move 应成功"
run show "#1" --json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const it = JSON.parse(s);
    if (it.spaces.join(",") !== "spB") { console.error(JSON.stringify(it.spaces)); process.exit(1); }
    const kinds = it.timeline.map((e) => e.kind).filter((k) => k !== "created");
    if (kinds.length) { console.error("原地 move 不该产生时间线：" + kinds.join(",")); process.exit(1); }
  });' || fail "原地 move 应是空操作"
pass "move --from 等于目标时是空操作"

echo "== 幂等键：同一次操作重复提交只生效一次 =="
use_owner idem
OP="01J$$${TMP##*/}"
OP=$(printf '%s' "$OP" | tr -cd '0-9A-HJKMNP-TV-Z' | cut -c1-26)
[ ${#OP} -eq 26 ] || OP=01J00000000000000000000001
run add "幂等的" >/dev/null
run --op="$OP" status "#1" doing >/dev/null || fail "首次带 --op 的写应成功"
run --op="$OP" status "#1" blocked >/dev/null || fail "重试同 --op 应返回成功（而不是报错）"
[ "$(run show "#1" --json | jq1 'v.status')" = "doing" ] || fail "重试不该改掉第一次的结果"
KINDS=$(run show "#1" --json | jq1 'v.timeline.filter(e=>e.kind==="status").length')
[ "$KINDS" = "1" ] || fail "幂等键相同的两次提交只能留一条状态事件，实际 $KINDS"
pass "同一 --op 重复提交只生效一次"

echo "== pull / devices：拉取与设备登记 =="
use_owner pull
run add "同步用的" >/dev/null
# 首次 pull 没有 sync.json，走全量重建——它必须能被区分出来，否则「缓存被重建过」
# 这件事在输出里看不见。
run pull | grep -q "已重建缓存" || fail "首次 pull 应报告全量重建"
run pull | grep -q "已是最新" || fail "第二次 pull 应报告已是最新"
[ "$(run devices --json | jq1 'v.length')" = "1" ] || fail "devices 应登记本机"
DEV_SEQ=$(run devices --json | jq1 'v[0].lastPullSeq')
[ "$DEV_SEQ" != "0" ] || fail "pull 之后设备位点应大于 0"
# --revoke 在 --json 下也必须只输出可解析的 JSON（stdout 是对外契约）。
DEV_ID=$(run devices --json | jq1 'v[0].id')
[ "$(run devices --revoke "$DEV_ID" --json | jq1 'v.revoked')" = "$DEV_ID" ] \
  || fail "devices --revoke --json 应输出 {revoked: <id>}"
[ "$(run devices --json | jq1 'v[0].revoked')" = "true" ] || fail "吊销后 devices --json 应标 revoked"
pass "pull 幂等、设备登记与位点正确"

echo "== 缓存：损坏时 CLI 仍可用（真相在库） =="
use_owner cache
CACHE="$HOME/.local/share/herdr-todo/todos.json"
# 缓存文件缺失时写命令**不**建它（否则 pull 就失去「整体重建」的触发信号）。
run add "有数据的" >/dev/null
[ -f "$CACHE" ] && fail "缓存缺失时写命令不该凭空建出一份只含本条的快照"
run pull >/dev/null || fail "缓存缺失时 pull 应能重建"
[ -f "$CACHE" ] || fail "pull 应生成缓存 $CACHE"
# 缓存损坏：写命令照常成功（真相在库），pull 负责整体重建。
printf '{not json' > "$CACHE"
run list >/dev/null || fail "缓存损坏时 CLI 仍应可用（真相在库）"
run add "损坏后写入" >/dev/null || fail "缓存损坏时写命令仍应成功"
run pull >/dev/null || fail "缓存损坏时 pull 应能重建缓存"
[ "$(run list --all --json | jq1 'v.length')" = "2" ] || fail "重建后两条都应回到缓存"
pass "CLI 以库为准：缓存损坏不影响命令"

echo "== 升级路径：缓存路径上是 v1 旧账本时 pull 停下，不覆盖 =="
use_owner legacy
# 新装 mod、还没 import-json：旧账本就在默认缓存路径上，sync.json 也没有。
mkdir -p "$(dirname "$CACHE")"
printf '{"v":1,"items":[{"id":"t1","title":"没导入的旧数据","status":"todo","priority":"P2","spaces":[],"timeline":[]}]}' > "$CACHE"
BEFORE=$(csum "$CACHE")
if run pull >/dev/null 2>"$TMP/legacy.err"; then fail "缓存路径上是 v1 账本时 pull 必须失败（先导入）"; fi
grep -q "import-json" "$TMP/legacy.err" || fail "错误提示应告诉用户先跑 import-json：$(cat "$TMP/legacy.err")"
[ "$(csum "$CACHE")" = "$BEFORE" ] || fail "v1 旧账本不能被 pull 改掉"
# 写命令同样不许碰它（事务已提交，跳过缓存即可）。
printf '{"owner":"%s","ssl":false}\n' "$OWNER" > "$HOME/.config/herdr-todo/config.json"
run add "还能写库" >/dev/null || fail "缓存路径上是 v1 时写命令仍应成功（真相在库）"
[ "$(csum "$CACHE")" = "$BEFORE" ] || fail "写命令也不能改掉 v1 旧账本"
pass "v1 旧账本被保护：pull 拒绝、写命令跳过缓存"

echo "== --owner 已移除：它会让本机游标跨租户 =="
if run --owner someone-else pull >/dev/null 2>"$TMP/owner.err"; then fail "--owner 必须被拒绝"; fi
grep -q "owner" "$TMP/owner.err" || fail "错误提示应说明 owner 只能改配置文件：$(cat "$TMP/owner.err")"
pass "--owner 报用法错误"

echo "== 改配置换 owner：本机缓存与 sync.json 自动作废（写命令不必先 pull） =="
use_owner switchA
run add "A 的事" >/dev/null
run pull >/dev/null
[ "$(run list --json | jq1 'v.length')" = "1" ] || fail "A 应看到自己的 1 条"
# 换配置成另一个 owner，**不先 pull**，直接写一条：身份检查必须自己发生。
OWNER="${OWNER}-B"
OWNERS="$OWNERS $OWNER"
printf '{"owner":"%s","ssl":false}\n' "$OWNER" > "$HOME/.config/herdr-todo/config.json"
run add "B 的事" >/dev/null 2>"$TMP/switch.err" || fail "换身份后写命令应成功：$(cat "$TMP/switch.err")"
grep -q "属于另一个 owner" "$TMP/switch.err" || fail "换身份时应提示本机状态已作废：$(cat "$TMP/switch.err")"
ls "$HOME/.local/share/herdr-todo/" | grep -q "owner-switch-" || fail "作废前应留一份备份"
run pull >/dev/null || fail "换身份后 pull 应能重建"
[ "$(run list --json | jq1 'v.map(i=>i.title).join("|")')" = "B 的事" ] \
  || fail "B 的缓存里不能有 A 的事项，实际：$(run list --json | jq1 'v.map(i=>i.title).join("|")')"
pass "换 owner 后本机状态作废重建，不残留对方事项"

echo "== 缓存权限跟随 umask（备注是明文） =="
use_owner perm
run add "权限测试" >/dev/null
# 写命令不新建缓存（见上），由 pull 建；两者都要保持 umask 给的权限。
( umask 077; run pull >/dev/null )
PERM=$(ls -l "$CACHE" | cut -c1-10)
[ "$PERM" = "-rw-------" ] || fail "umask 077 下缓存应为 -rw-------，实际 $PERM"
( umask 077; run note 1 --note "改写一次" >/dev/null )
PERM=$(ls -l "$CACHE" | cut -c1-10)
[ "$PERM" = "-rw-------" ] || fail "重写后仍应保持 -rw-------，实际 $PERM"
pass "缓存权限跟随 umask"

echo "== 数据库不可达：退出码 4，与用法错误（2）区分 =="
CODE=0
node "$BIN" --db=mysql://nobody:x@127.0.0.1:1/nope list >/dev/null 2>&1 || CODE=$?
[ "$CODE" = "4" ] || fail "连不上库应是 exit 4，实际 $CODE"
pass "数据库不可达 → exit 4"

echo ""
echo "ALL CLI TESTS PASSED"
