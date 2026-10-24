-- ============================================================
-- 空间物品收纳管理平台 · 数据库骨架 (PostgreSQL 16)
-- 设计原则：物品 / 位置 / 库存 / 事务 四表分离，兼容 WMS/ERP 模型
-- 执行：psql -f schema.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "ltree";      -- 位置树路径查询
CREATE EXTENSION IF NOT EXISTS "vector";     -- pgvector 语义/图像检索
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- 模糊匹配

-- ---------- 租户与用户 ----------
CREATE TABLE tenant (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  plan         TEXT NOT NULL DEFAULT 'free',      -- free | team | enterprise
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_account (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT UNIQUE,
  email        TEXT UNIQUE,
  nickname     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE membership (
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',    -- owner | admin | member | viewer
  PRIMARY KEY (tenant_id, user_id)
);

-- ---------- 位置树（= WMS 的 Location / Bin） ----------
-- node_type: site 场地 | floor 楼层 | room 房间 | zone 库区
--          | rack 货架 | level 层 | cell 格/位 | box 收纳盒
CREATE TABLE space_node (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  parent_id    UUID REFERENCES space_node(id) ON DELETE CASCADE,
  path         LTREE NOT NULL,                   -- 如 home.br1.wd01.l03.b02
  loc_code     TEXT NOT NULL,                    -- 如 HOME-BR1-WD01-L03-B02
  node_type    TEXT NOT NULL,
  name         TEXT NOT NULL,
  -- 3D 几何：相对父节点的位置与尺寸(米)，rot 为绕 Y 轴弧度
  geom         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 参数化模板：{"template":"wardrobe","levels":4,"columns":3}
  template     JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_url    TEXT,                             -- 可选 glTF 模型
  capacity     NUMERIC,                          -- 容量（件或升）
  attributes   JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, loc_code)
);
CREATE INDEX idx_space_node_path   ON space_node USING GIST (path);
CREATE INDEX idx_space_node_parent ON space_node(parent_id);

-- ---------- 物品主数据（= WMS 的 Material / SKU） ----------
CREATE TABLE item (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  aliases      TEXT[] NOT NULL DEFAULT '{}',     -- 别名，提升召回
  category     TEXT,                             -- 一级/二级类目
  brand        TEXT,
  spec         TEXT,                             -- 规格型号
  sku_code     TEXT,                             -- 对接 ERP 的物料编码
  barcode      TEXT,
  unit         TEXT NOT NULL DEFAULT '件',
  cover_url    TEXT,
  photo_urls   TEXT[] NOT NULL DEFAULT '{}',
  attributes   JSONB NOT NULL DEFAULT '{}'::jsonb, -- 颜色/尺寸/保质期/价格等
  text_vec     VECTOR(1024),                     -- 文本语义向量
  image_vec    VECTOR(768),                      -- 图像向量(CLIP)
  search_tsv   TSVECTOR,
  created_by   UUID REFERENCES user_account(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_item_tsv      ON item USING GIN (search_tsv);
CREATE INDEX idx_item_name_trgm ON item USING GIN (name gin_trgm_ops);
CREATE INDEX idx_item_text_vec ON item USING hnsw (text_vec vector_cosine_ops);
CREATE INDEX idx_item_image_vec ON item USING hnsw (image_vec vector_cosine_ops);
CREATE INDEX idx_item_sku      ON item(tenant_id, sku_code);

-- ---------- 单件实例（唯一件/资产，耗材可不用） ----------
CREATE TABLE item_unit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  item_id      UUID NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  serial_no    TEXT,                             -- 序列号/资产编号
  batch_no     TEXT,
  status       TEXT NOT NULL DEFAULT 'in_stock', -- in_stock | lent_out | consumed | discarded
  expire_at    DATE,
  UNIQUE (tenant_id, serial_no)
);

-- ---------- 库存快照（= WMS 的 Stock） ----------
CREATE TABLE inventory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  node_id      UUID NOT NULL REFERENCES space_node(id) ON DELETE CASCADE,
  item_id      UUID NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  batch_no     TEXT NOT NULL DEFAULT '',
  qty          NUMERIC NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- 最后一次确认存在的时间
  UNIQUE (tenant_id, node_id, item_id, batch_no)
);
CREATE INDEX idx_inventory_item ON inventory(item_id);
CREATE INDEX idx_inventory_node ON inventory(node_id);

-- ---------- 库存事务流水（= WMS 的 Material Document，只追加不修改） ----------
CREATE TABLE movement (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES item(id),
  unit_id       UUID REFERENCES item_unit(id),
  from_node_id  UUID REFERENCES space_node(id),
  to_node_id    UUID REFERENCES space_node(id),
  qty           NUMERIC NOT NULL,
  move_type     TEXT NOT NULL,   -- inbound 入库 | transfer 移库 | outbound 出库
                                 -- | lend 借出 | return 归还 | adjust 盘盈亏 | discard 报废
  reason        TEXT,
  operator_id   UUID REFERENCES user_account(id),
  ref_doc       TEXT,            -- 外部单据号（对接 ERP 用）
  idem_key      TEXT,            -- 幂等键（客户端 UUID / 外部消息 ID）
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idem_key)
);
CREATE INDEX idx_movement_item ON movement(item_id, occurred_at DESC);
CREATE INDEX idx_movement_node ON movement(to_node_id, occurred_at DESC);

-- ---------- 二维码/RFID 标签绑定 ----------
CREATE TABLE container_label (
  code         TEXT PRIMARY KEY,                -- 二维码内容 / RFID EPC
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  node_id      UUID REFERENCES space_node(id) ON DELETE CASCADE,
  unit_id      UUID REFERENCES item_unit(id) ON DELETE CASCADE,
  label_type   TEXT NOT NULL DEFAULT 'qr',       -- qr | rfid | nfc
  printed_at   TIMESTAMPTZ,
  CHECK (node_id IS NOT NULL OR unit_id IS NOT NULL)
);

-- ---------- 盘点 ----------
CREATE TABLE stocktake (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  scope_node   UUID REFERENCES space_node(id),
  status       TEXT NOT NULL DEFAULT 'open',     -- open | counting | closed
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);

CREATE TABLE stocktake_line (
  id           BIGSERIAL PRIMARY KEY,
  stocktake_id UUID NOT NULL REFERENCES stocktake(id) ON DELETE CASCADE,
  node_id      UUID NOT NULL REFERENCES space_node(id),
  item_id      UUID NOT NULL REFERENCES item(id),
  expected_qty NUMERIC NOT NULL DEFAULT 0,
  counted_qty  NUMERIC,
  diff_qty     NUMERIC GENERATED ALWAYS AS (COALESCE(counted_qty,0) - expected_qty) STORED,
  counted_at   TIMESTAMPTZ
);

-- ---------- AI 识别与纠错（用于持续提升准确率） ----------
CREATE TABLE recognition_log (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  photo_url    TEXT NOT NULL,
  model        TEXT NOT NULL,
  raw_result   JSONB NOT NULL,                   -- 模型原始输出
  confidence   NUMERIC,
  accepted     BOOLEAN,                          -- 用户是否直接采纳
  final_item   UUID REFERENCES item(id),         -- 用户最终选定/修正的结果
  cost_tokens  INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 集成：外部系统映射 + 事件发件箱 ----------
CREATE TABLE external_system (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                    -- sap | kingdee | yonyou | wdt | flux | custom
  name         TEXT NOT NULL,
  config       JSONB NOT NULL DEFAULT '{}'::jsonb, -- endpoint / 认证 / 映射文件版本
  enabled      BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE external_mapping (
  id           BIGSERIAL PRIMARY KEY,
  system_id    UUID NOT NULL REFERENCES external_system(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,                    -- item | location | movement | order
  local_id     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  sync_state   TEXT NOT NULL DEFAULT 'synced',   -- synced | pending | conflict | error
  last_sync_at TIMESTAMPTZ,
  UNIQUE (system_id, entity_type, local_id),
  UNIQUE (system_id, entity_type, external_id)
);

CREATE TABLE outbox_event (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  topic        TEXT NOT NULL,                    -- item.created | movement.created ...
  payload      JSONB NOT NULL,
  idem_key     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | dead
  retry_count  INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  error_msg    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, topic, idem_key)
);
CREATE INDEX idx_outbox_pending ON outbox_event(status, next_retry_at);

CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  actor_id     UUID,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  diff         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 搜索向量自动维护 ----------
CREATE OR REPLACE FUNCTION item_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
      to_tsvector('simple',
        coalesce(NEW.name,'') || ' ' ||
        coalesce(array_to_string(NEW.aliases,' '),'') || ' ' ||
        coalesce(NEW.category,'') || ' ' ||
        coalesce(NEW.brand,'')  || ' ' ||
        coalesce(NEW.spec,''));
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_item_tsv BEFORE INSERT OR UPDATE ON item
  FOR EACH ROW EXECUTE FUNCTION item_tsv_trigger();

-- ---------- 常用视图：物品当前位置（含完整路径） ----------
CREATE OR REPLACE VIEW v_item_location AS
SELECT i.tenant_id,
       i.id            AS item_id,
       i.name          AS item_name,
       i.cover_url,
       inv.qty,
       n.id            AS node_id,
       n.loc_code,
       n.path,
       inv.last_seen_at
FROM inventory inv
JOIN item i       ON i.id = inv.item_id
JOIN space_node n ON n.id = inv.node_id
WHERE inv.qty > 0;

-- ---------- 样例数据：一个家庭空间 ----------
-- INSERT INTO tenant(id,name) VALUES ('00000000-0000-0000-0000-000000000001','我家');
-- INSERT INTO space_node(tenant_id,parent_id,path,loc_code,node_type,name,geom) VALUES
--  ('00000000-0000-0000-0000-000000000001',NULL,'home','HOME','site','我家','{}'),
--  ('00000000-0000-0000-0000-000000000001',NULL,'home.br1','HOME-BR1','room','主卧',
--   '{"w":4.0,"d":3.5,"h":2.7,"x":0,"y":0,"z":0}');
