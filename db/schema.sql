-- herdr-todo 云端 schema（MySQL 8.0.13+）
--
-- 设计承诺见 docs/design-docs/herdr-todo/cloud-sync/spec.md。本文件与 spec §4.2
-- 的一致性要求等同效力；改动这里的列语义或约束属于改对外契约，需要先改 spec。
--
-- 本文件只建表，**不含 CREATE DATABASE / USE**：库名由调用方给，这样同一份 DDL
-- 能建生产库，也能建测试库（`herdr_todo_test`）与 CI 库。写死 USE 会让
-- `mysql <db> < db/schema.sql` 静默建到另一个库里。
--
--   sh db/create.sh herdr_todo        # 建库 + 建表（推荐）
--   mysql -u root herdr_todo < db/schema.sql   # 库已存在时
--
-- 建库与建表由人工执行（应用账号只有 DML 权限，没有 DDL）。
--
-- 连接建立后应用必须执行 SET SESSION time_zone = '+00:00'，本文件的 DATETIME(3)
-- 全部按 UTC 写入与比较（见 spec §3.3）。


-- 多租户的根。一个 owner 是一个人；同一 owner 的多台设备共享同一份数据。
CREATE TABLE IF NOT EXISTS owners (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- 配置里写的 "owner" 就对应这个 slug。用它而不是数字 id 做配置项，
  -- 是为了让配置文件人能读、能在建号前后手写。
  slug       VARCHAR(64) NOT NULL,
  -- 每 owner 连续的人读编号计数器。不能用 items.num 的全局 AUTO_INCREMENT：
  -- 两个 owner 交替添加时编号会跳成 1、3、5。
  item_num   INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_owner_slug (slug)
) ENGINE=InnoDB;

-- 事项当前快照。它由 item_events 推导而来，不是并行的第二份记录。
CREATE TABLE IF NOT EXISTS items (
  -- ULID，客户端生成。多端创建不能依赖数据库发号，否则离线/临时 id 无从表达。
  id          CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id    BIGINT UNSIGNED NOT NULL,
  -- 人读编号 #12，由 owner 行锁在写事务里分配，唯一键与 owner_id 复合。
  num         INT UNSIGNED NOT NULL,
  -- 预留：子待办。本期只建列，界面与命令都不使用。
  parent_id   CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  title       VARCHAR(200) NOT NULL,
  -- 备注上限 20000 字（规则层执行）；utf8mb4 下约 80KB，TEXT 的 64KB 不够。
  note        MEDIUMTEXT NOT NULL,
  status      ENUM('todo','doing','blocked','done','cancelled') NOT NULL DEFAULT 'todo',
  -- 0..3 对应 P0..P3。
  priority    TINYINT UNSIGNED NOT NULL DEFAULT 2,
  -- 预留：手动进度 0..100。NULL 表示从未设置过（与"设成 0"不同）。
  progress    TINYINT UNSIGNED NULL,
  created_at  DATETIME(3) NOT NULL,
  updated_at  DATETIME(3) NOT NULL,
  -- 最近一次进入 done/cancelled 的时间；重开时清空。
  closed_at   DATETIME(3) NULL,
  -- 「别在列表里烦我」。与 cancelled 是两回事，与 deleted_at 也是两回事。
  archived_at DATETIME(3) NULL,
  -- 墓碑。物理清除需同时满足保留期与所有设备已拉取（见 spec §4.4）。
  deleted_at  DATETIME(3) NULL,
  -- 乐观并发标记。当前不参与 UI，留给将来「你的编辑基于旧版本」提示。
  rev         INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_owner_num (owner_id, num),
  -- 取子待办（预留能力，但索引随列一起建好，事后补索引要锁表）。
  KEY idx_children (parent_id, created_at),
  -- 侧栏取「某 owner 未删除的未关闭事项」的主路径。
  KEY idx_owner_open (owner_id, deleted_at, status, closed_at, priority, updated_at),
  CONSTRAINT fk_items_owner FOREIGN KEY (owner_id) REFERENCES owners (id),
  CONSTRAINT fk_items_parent FOREIGN KEY (parent_id) REFERENCES items (id)
) ENGINE=InnoDB;

-- 事项与 space / agent 的关联。取代旧模型里 items 上的 spaces 数组与 agent 对象。
CREATE TABLE IF NOT EXISTS item_places (
  item_id  CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind     ENUM('space','agent') NOT NULL,
  -- space id，或 agent 地址（"dev5/t2" 这种，跨机器不冲突）。
  ref      VARCHAR(191) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  -- agent 关联当时所在的 space。agent 关闭后宿主不再报告它属于哪个 space，
  -- 回退显示只能靠这个值，所以它是关联的一部分而不是可选装饰。
  in_space VARCHAR(191) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  -- 让「一条事项最多一个 agent 关联」在结构上无法违反：kind='agent' 时值是
  -- item_id，否则 NULL；唯一键允许多个 NULL，因此多 space 关联不受影响。
  agent_item CHAR(26) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (IF(kind = 'agent', item_id, NULL)) STORED,
  PRIMARY KEY (item_id, kind, ref),
  UNIQUE KEY uk_one_agent (agent_item),
  -- 「这个 space / agent 下有哪些待办」。
  KEY idx_place_ref (kind, ref, item_id),
  CONSTRAINT fk_places_item FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB;

-- 时间线 = 变更流 = 同步增量源。一次用户操作恰好一条；三者读的是同一份数据。
CREATE TABLE IF NOT EXISTS item_events (
  -- 同步游标。AUTO_INCREMENT 允许空洞（回滚会消耗一个值），游标跨过即可。
  seq          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id     BIGINT UNSIGNED NOT NULL,
  item_id      CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- created/status/priority/title/note/spaces/agent/archived/unarchived/deleted
  -- （预留 parent/progress）。未知 kind 必须被渲染层降级显示，不得抛错。
  kind         VARCHAR(16) CHARACTER SET ascii NOT NULL,
  -- 形状随 kind，写入端校验。备注只记长度，正文留在 items.note。
  data         JSON NOT NULL,
  -- 操作者：panel@mac-mini、cli@dev5 之类。
  actor        VARCHAR(64) NOT NULL,
  -- 幂等键。网络超时重试时命中唯一键，命令回滚并返回首次结果。
  -- 全局唯一（不含 owner_id）：两个 owner 用了同一个 ULID 时，后到者回滚并
  -- 报错——ULID 是 26 位随机+时间，跨 owner 碰撞实际上不会发生，而报错比
  -- 静默把两次操作合并安全。读回时仍按 owner_id 过滤，不会读到别人的事件。
  client_op_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- 客户端时钟，只用于展示与「一段时间内」的检索。
  occurred_at  DATETIME(3) NOT NULL,
  -- 服务端时钟，用于审计与运维观察；同步排序与游标一律用 seq，不用它。
  recorded_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (seq),
  UNIQUE KEY uk_op (client_op_id),
  -- 单条事项的完整时间线（show 用）。
  KEY idx_item_seq (item_id, seq),
  -- 增量拉取的主路径：WHERE owner_id = ? AND seq > ?。
  KEY idx_owner_seq (owner_id, seq),
  -- 「这段时间发生了什么」与「所有进度记录」（预留功能 3 的主路径）。
  KEY idx_kind_time (owner_id, kind, occurred_at, seq),
  CONSTRAINT fk_events_item FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB;

-- 设备登记。唯一用途：判断墓碑何时可以物理清除。
-- 一台设备离线两个月后回来时，若它还没拉过某条删除记录，那条墓碑必须留着，
-- 否则缓存里已删的事项会被重新拉进来。
CREATE TABLE IF NOT EXISTS devices (
  id            CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_id      BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(64) NOT NULL,
  created_at    DATETIME(3) NOT NULL,
  last_seen_at  DATETIME(3) NULL,
  -- 该设备已拉取到的事件序号。
  last_pull_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  revoked       TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_devices_owner (owner_id, last_pull_seq),
  CONSTRAINT fk_devices_owner FOREIGN KEY (owner_id) REFERENCES owners (id)
) ENGINE=InnoDB;

-- schema 版本与最低客户端版本。客户端启动时比对，比自己认识的新就拒绝运行，
-- 对应旧实现里账本 "v" 字段的作用。
CREATE TABLE IF NOT EXISTS meta (
  k VARCHAR(64) NOT NULL,
  v VARCHAR(255) NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB;

INSERT INTO meta (k, v) VALUES ('schema_version', '1')
  ON DUPLICATE KEY UPDATE v = VALUES(v);
