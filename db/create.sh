#!/bin/sh
# 建库 + 建表。schema.sql 只建表、不含库名，库名在这里给——
# 这样生产库、测试库与 CI 库用的是同一份 DDL。
#
#   sh db/create.sh                    # 建默认库 herdr_todo
#   sh db/create.sh herdr_todo_test    # 建测试库
#
# 连接参数走标准的 MYSQL_* 环境变量（mysql 客户端自身支持），
# 例如：MYSQL_HOST=... MYSQL_USER=... MYSQL_PWD=... sh db/create.sh herdr_todo
#
# 幂等：库与表都用 IF NOT EXISTS。已存在时不会改动任何已建好的列——
# 改表结构需要另写迁移，不能靠重跑本脚本（它不会 ALTER 任何东西）。
set -eu

DB=${1:-herdr_todo}

# 库名会被拼进 SQL，不能带反引号或分号。
case "$DB" in
  *[\`\;\ ]*|"") echo "库名不合法：$DB" >&2; exit 2 ;;
esac

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -f "$DIR/schema.sql" ] || { echo "缺少 $DIR/schema.sql" >&2; exit 1; }

mysql -e "CREATE DATABASE IF NOT EXISTS \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
mysql "$DB" < "$DIR/schema.sql"
echo "已就绪：${DB}（表结构来自 $DIR/schema.sql）"
