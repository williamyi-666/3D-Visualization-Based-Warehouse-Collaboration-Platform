import { placementError } from '../../packages/three-kit/layout-geometry.mjs';
import {capacityProduct,productKey,cellDimensions,updateCapacityRules} from '../../packages/three-kit/sku-capacity.mjs';
import { resolveEventLocation } from './event-location.mjs';
// apps/api/db.mjs
// 开发用嵌入式 SQLite 数据层（node:sqlite，零守护进程）。
// 生产环境切换 PostgreSQL：把这里换成 pg 客户端 + db/schema.sql，接口保持不变（见 db/index.mjs）。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { currentActor,actorStore } from './context.mjs';
import { createSpaceAudit } from './space-audit.mjs';
import { installMovementHistory } from './movement-history.mjs';
import {installItemCodes,createItemCodes} from './item-codes.mjs';
import {installStockReservations,reservationQuantities,stockAvailability} from './stock-reservations.mjs';
import {installMovementBusiness,businessDetails,movementBusiness} from './movement-business.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SPATIAL_DATA_DIR || join(__dirname, '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const TENANT = '00000000-0000-0000-0000-000000000001';
const db = new DatabaseSync(join(dataDir, 'spatial.db'));
db.exec('PRAGMA journal_mode = WAL;');
// 安全解析 JSON 数组（用于 tags 等）
function safeJsonArr(s) { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }

// ---------- 建表（SQLite 适配版；ltree/vector 仅生产 PG 需要） ----------
// 建表与补列共用一次提交，避免首次启动在虚拟磁盘上反复同步日志。
db.exec('BEGIN IMMEDIATE');
try {
db.exec(`
CREATE TABLE IF NOT EXISTS tenant (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT DEFAULT 'free', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS space_node (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_id TEXT,
  loc_code TEXT UNIQUE, node_type TEXT NOT NULL, name TEXT NOT NULL,
  geom TEXT DEFAULT '{}', template TEXT DEFAULT '{}', attributes TEXT DEFAULT '{}'
);
-- 写实模型资源：Blender 导出的 glTF/GLB，按 loc_code 关联到「库区」或「货架」节点
CREATE TABLE IF NOT EXISTS node_asset (
  loc_code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  asset_url TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'glb',
  transform_json TEXT DEFAULT '{}', submesh_map_json TEXT DEFAULT '{}',
  created_by TEXT, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS item (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  category TEXT, unit TEXT DEFAULT '件', cover_url TEXT,
  photo_urls TEXT DEFAULT '[]', attributes TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, node_id TEXT NOT NULL, item_id TEXT NOT NULL,
  batch_no TEXT DEFAULT '', qty REAL DEFAULT 0, last_seen_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS movement (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, item_id TEXT,
  from_node_id TEXT, to_node_id TEXT, qty REAL, move_type TEXT,
  idem_key TEXT UNIQUE, occurred_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS container_label (
  code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, node_id TEXT, label_type TEXT DEFAULT 'qr'
);
-- 事件发件箱（开放 API Webhook + WMS/ERP 上行同步的统一来源）
CREATE TABLE IF NOT EXISTS outbox_event (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0, last_error TEXT, created_at TEXT DEFAULT (datetime('now'))
);
-- 别名词表：检索时做同义扩展（"充电头" → "充电器"）
CREATE TABLE IF NOT EXISTS alias (
  word TEXT PRIMARY KEY, target TEXT NOT NULL
);
-- 本地 ID ↔ 外部系统 ID 映射（WMS/ERP 集成必备）
CREATE TABLE IF NOT EXISTS external_mapping (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
  external_system TEXT NOT NULL, local_type TEXT NOT NULL, local_id TEXT NOT NULL,
  external_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(external_system, local_type, local_id)
);
-- 用户与角色（企业级：登录、权限、操作追溯）
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator', status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')), last_login_at TEXT
);
-- 登录会话（服务端可吊销；token 为随机串，不存明文密码）
CREATE TABLE IF NOT EXISTS session (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')), expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_token (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  name TEXT NOT NULL, token_hash TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '[]',
  created_by TEXT, created_at TEXT DEFAULT (datetime('now')),
  revoked_at TEXT, last_used_at TEXT
);
`);
// 老库补列：space_node 增加 photo_urls（格位现场照片，存 dataURL 数组）
try { db.exec("ALTER TABLE space_node ADD COLUMN photo_urls TEXT DEFAULT '[]'"); } catch (_) {}
// 老库补列：格位扩展属性（容量/承重/状态/标签/备注）
for (const col of [
  "ALTER TABLE space_node ADD COLUMN capacity INTEGER",
  "ALTER TABLE space_node ADD COLUMN capacity_rules TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE space_node ADD COLUMN max_load REAL",
  "ALTER TABLE space_node ADD COLUMN status TEXT DEFAULT 'normal'",
  "ALTER TABLE space_node ADD COLUMN tags TEXT DEFAULT '[]'",
  "ALTER TABLE space_node ADD COLUMN note TEXT DEFAULT ''",
  "ALTER TABLE space_node ADD COLUMN label_mode TEXT DEFAULT 'code'",
]) { try { db.exec(col); } catch (_) {} }

// 索引：企业数据量上来后，流水/库存/用户的常见查询都要走索引
db.exec(`
CREATE INDEX IF NOT EXISTS idx_inventory_node ON inventory(node_id);
CREATE INDEX IF NOT EXISTS idx_inventory_item ON inventory(item_id);
CREATE INDEX IF NOT EXISTS idx_movement_item ON movement(item_id);
CREATE INDEX IF NOT EXISTS idx_movement_time ON movement(occurred_at);
CREATE INDEX IF NOT EXISTS idx_space_parent ON space_node(parent_id);
CREATE INDEX IF NOT EXISTS idx_space_type ON space_node(node_type);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
`);

// ERP 集成：movement 增加 synced_at 列（增量拉取水印 / 回执），幂等添加
try { db.exec('ALTER TABLE movement ADD COLUMN synced_at TEXT'); } catch (_) {}
// 货品型号 / 编码（可扫码识别，手机端扫货品出入库用），幂等添加
try { db.exec('ALTER TABLE item ADD COLUMN sku TEXT'); } catch (_) {}
// 流水操作人（企业级审计：谁在什么时候动了这批货），幂等添加
try { db.exec('ALTER TABLE movement ADD COLUMN actor_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE movement ADD COLUMN actor_name TEXT'); } catch (_) {}
// ERP 入站幂等：idem_key 唯一索引（ERP 业务单据号去重，防网络重试导致库存重复增减）
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_movement_idem ON movement(idem_key)'); } catch (_) {}

// 库存唯一约束：同一「格位 × 物品」只允许一行。
// 背景：inventory 原无此约束，重复导入同一格位的同一产品会叠出多行，导致 3D 重复堆叠、库存统计翻倍。
// 建索引前先合并历史重复行：保留 rowid 最小的一行，其余行的数量累加进去后再删除（数量不丢失）。
try {
  const dups = db.prepare('SELECT node_id, item_id FROM inventory GROUP BY node_id, item_id HAVING COUNT(*)>1').all();
  if (dups.length) {
    let merged = 0;
    for (const d of dups) {
      const rows = db.prepare('SELECT id, qty FROM inventory WHERE node_id=? AND item_id=? ORDER BY rowid ASC').all(d.node_id, d.item_id);
      const keep = rows[0];
      const sum = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      db.prepare('UPDATE inventory SET qty=? WHERE id=?').run(sum, keep.id);
      for (const r of rows.slice(1)) { db.prepare('DELETE FROM inventory WHERE id=?').run(r.id); merged++; }
    }
    console.log('[db] 库存重复行合并：' + dups.length + ' 组、删除 ' + merged + ' 行（数量已累加到保留行）');
  }
} catch (e) { console.warn('[db] 库存重复行合并跳过（不影响启动）:', e.message); }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_node_item ON inventory(node_id, item_id)'); } catch (_) {}

// 流水统一写入口：所有出/入/移库/ERP 同步/合并/迁移都走这里，
// 由 AsyncLocalStorage 的当前请求上下文自动补 actor（无需调用方逐层透传）。
// 术语迁移（幂等）：仓储化命名 —— node_type 'furniture' → 'rack'（家具 → 货架）
// 只改内部枚举取值；loc_code / geom / 格位编码一律不变，故不影响 LOC 与历史数据。
try {
  const n = db.prepare("UPDATE space_node SET node_type='rack' WHERE node_type='furniture'").run().changes;
  if (n) console.log('[db] 术语迁移 furniture→rack：' + n + ' 条');
} catch (_) {}

installMovementHistory(db);
installItemCodes(db);
installStockReservations(db);
installMovementBusiness(db);
db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

export const itemCodes=createItemCodes(db,{tenant:TENANT,onChanged:item_id=>{
  emit('item.updated',{item_id});
  for(const row of db.prepare('SELECT node_id,qty FROM inventory WHERE item_id=?').all(item_id))emit('inventory.changed',{item_id,...row});
}});

export function logMovement({ item_id = null, from_node_id = null, to_node_id = null,
  qty = 0, move_type = '', idem_key = null } = {}) {
  const a = currentActor();
  const result=db.prepare(`INSERT INTO movement(tenant_id,item_id,from_node_id,to_node_id,
                     qty,move_type,idem_key,actor_id,actor_name)
                     VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(TENANT, item_id, from_node_id, to_node_id, qty, move_type,
      idem_key || randomUUID(), a?.id||null, a?.name||null);
  if(a?.business&&Object.keys(a.business).length)db.prepare('INSERT INTO movement_business VALUES(?,?)').run(result.lastInsertRowid,JSON.stringify(a.business));
  return result;
}

// ---------- 样例数据（与前端 prototype/seed.js 对齐；幂等，仅首次建） ----------
function seedIfEmpty() {
  const t = db.prepare('SELECT COUNT(*) c FROM tenant').get();
  if (t.c > 0) return;

  const siteId = randomUUID();
  const roomId = randomUUID();
  db.prepare('INSERT INTO tenant(id,name) VALUES(?,?)').run(TENANT, '我的仓库');
  db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
              VALUES(?,?,?,?,?,?,?)`).run(siteId, TENANT, null, 'WH', 'site', '主仓库', '{}');
  db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
              VALUES(?,?,?,?,?,?,?)`).run(roomId, TENANT, siteId, 'WH-1', 'room', '1号库区',
              JSON.stringify({ w: 12, d: 8, h: 4, x: 0, y: 0, z: 0, door: 'back', window: ['left', 'right'] }));

  // 仓库货架 A / B / C（开放货架，按 层×位 生成货位，无"格内层"概念）
  const racks = [
    // rows 含「开放顶层」：最上面那层没有顶板，可直接往上堆货（L0(rows)）
    { code: 'A', name: 'A货架', rows: 5, cols: 6 },
    { code: 'B', name: 'B货架', rows: 5, cols: 6 },
    { code: 'C', name: 'C货架', rows: 5, cols: 6 },
  ];
  const seedItems = {
    'WH-1-A': {
      'L01-B01': [{ name: '包装纸箱', qty: 24, note: '60×40' }, { name: '封箱胶带', qty: 50 }],
      'L02-B03': [{ name: '螺丝配件包', qty: 500, note: 'M6×20' }],
      'L03-B02': [{ name: '防护手套', qty: 30 }],
    },
    'WH-1-B': {
      'L01-B01': [{ name: '原料桶', qty: 8, note: '化工原料' }, { name: '标签纸卷', qty: 200 }],
      'L02-B04': [{ name: '塑料周转箱', qty: 15 }],
    },
    'WH-1-C': {
      'L01-B01': [{ name: '成品工件', qty: 12 }],
      'L02-B02': [{ name: '备品轴承', qty: 40 }],
    },
  };
  for (const rk of racks) {
    const xPos = rk.code === 'A' ? -2.0 : (rk.code === 'C' ? 2.0 : 0);
    const furnId = randomUUID();
    db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom,template)
                VALUES(?,?,?,?,?,?,?,?)`).run(furnId, TENANT, roomId, `WH-1-${rk.code}`, 'rack', rk.name,
                JSON.stringify({ w: 1.2, h: 2.0, d: 0.5, x: xPos, y: 0, z: 0, type: 'rack', open: 1 }),
                JSON.stringify({ rows: rk.rows, cols: rk.cols }));
    for (let r = 1; r <= rk.rows; r++) {
      for (let c = 1; c <= rk.cols; c++) {
        const lr = 'L' + String(r).padStart(2, '0');
        const bc = 'B' + String(c).padStart(2, '0');
        const cellId = randomUUID();
        const cellCode = `WH-1-${rk.code}-${lr}-${bc}`;
        db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
                    VALUES(?,?,?,?,?,?,?)`).run(cellId, TENANT, furnId, cellCode, 'cell', `格位${lr}-${bc}`, '{}');
        const items = (seedItems[`WH-1-${rk.code}`] || {})[`${lr}-${bc}`] || [];
        for (const it of items) {
          const itemId = randomUUID();
          const itAttrs = it.note ? { note: it.note } : {};
          db.prepare('INSERT INTO item(id,tenant_id,name,category,attributes) VALUES(?,?,?,?,?)')
            .run(itemId, TENANT, it.name, '货物', JSON.stringify(itAttrs));
          db.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)')
            .run(randomUUID(), TENANT, cellId, itemId, it.qty);
          logMovement({ item_id: itemId, to_node_id: cellId, qty: it.qty, move_type: 'inbound' });
        }
      }
    }
  }
  // 别名词表种子
  const aliases = [['数据线', '充电线'], ['外套', '羽绒服'], ['木箱', '包装纸箱'], ['螺丝', '螺丝配件包']];
  const insA = db.prepare('INSERT OR IGNORE INTO alias(word,target) VALUES(?,?)');
  for (const [w, t] of aliases) insA.run(w, t);
}
// 首次初始化整体提交，避免逐格刷盘；中断时也不会留下已建租户但缺少格位的半套数据。
db.exec('BEGIN IMMEDIATE');
try {
  seedIfEmpty();
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

// 别名词表独立幂等：即使库已存在（tenant 已建），也保证别名填充
function ensureAliases() {
  const c = db.prepare('SELECT COUNT(*) c FROM alias').get().c;
  if (c > 0) return;
  const aliases = [['充电头', '充电器'], ['数据线', '充电线'], ['外套', '羽绒服'], ['毛裤', '毛毯']];
  const insA = db.prepare('INSERT OR IGNORE INTO alias(word,target) VALUES(?,?)');
  for (const [w, t] of aliases) insA.run(w, t);
}
ensureAliases();

// 演示数据由 seedIfEmpty 统一生成（仓库货架 A/B/C），无需额外补充。

// ---------- 事件发件箱助手 ----------
export function prepareOutboundPayload(payload) { return resolveEventLocation(db,payload); }
export function emit(eventType, payload) {
  payload=prepareOutboundPayload(payload ?? {});
  db.prepare('INSERT INTO outbox_event(id,tenant_id,event_type,payload_json) VALUES(?,?,?,?)')
    .run(randomUUID(), TENANT, eventType, JSON.stringify(payload ?? {}));
}
export function getPendingOutbox() {
  return db.prepare("SELECT * FROM outbox_event WHERE status='pending' ORDER BY created_at").all();
}
export function markOutboxSent(id) {
  db.prepare("UPDATE outbox_event SET status='sent' WHERE id=?").run(id);
}
export function markOutboxRetry(id, err) {
  db.prepare("UPDATE outbox_event SET attempts=attempts+1,last_error=? WHERE id=?").run(String(err.message || err).slice(0,500), id);
}
export function markOutboxDead(id, err) {
  db.prepare("UPDATE outbox_event SET status='dead', attempts=attempts+1, last_error=? WHERE id=?")
    .run(String(err && err.message || err || '').slice(0, 500), id);
}

// ---------- ERP / 外部系统映射辅助（经 external_mapping，external_system='erp'） ----------
// 解析货品对应的 ERP 物料编码
export function erpOf(itemId) {
  const m = db.prepare("SELECT external_id FROM external_mapping WHERE external_system='erp' AND local_type='item' AND local_id=?").get(itemId);
  return m ? m.external_id : null;
}
// 设置/更新货品 ERP 编码（写映射表，不做物理列）
export function setItemErpCode(itemId, erpCode) {
  if (erpCode == null || erpCode === '') return;
  const ex = db.prepare("SELECT id FROM external_mapping WHERE external_system='erp' AND local_type='item' AND local_id=?").get(itemId);
  if (ex) db.prepare("UPDATE external_mapping SET external_id=? WHERE id=?").run(String(erpCode), ex.id);
  else db.prepare("INSERT INTO external_mapping(tenant_id,external_system,local_type,local_id,external_id) VALUES(?,?,?,?,?)")
    .run(TENANT, 'erp', 'item', itemId, String(erpCode));
}
// 反向：按 ERP 编码找本地 item_id
export function getItemByErp(erpCode) {
  const m = db.prepare("SELECT local_id FROM external_mapping WHERE external_system='erp' AND local_type='item' AND external_id=?").get(String(erpCode));
  return m ? m.local_id : null;
}
// 按货品码（sku / erp_code / item.id）解析本地货品，供手机扫码识别（货品二维码编码的就是这些之一）
export function getItemByCode(code) {
  const c = (code || '').toString().trim();
  if (!c) return null;
  const serialize = (id) => {
    const r = db.prepare('SELECT id, name, sku, unit FROM item WHERE id=?').get(id);
    return r ? { item_id: r.id, name: r.name, sku: r.sku || '', unit:r.unit || '件', erp_code: erpOf(r.id) || '' } : null;
  };
  const id=itemCodes.resolve(c);
  return id?serialize(id):null;
}
// 货品清单（按需按 erp_code 过滤），供 ERP 全量拉取/对齐 + 货品二维码标签
export function listItems({ erpCode = null } = {}) {
  let sql = `SELECT i.id, i.name, i.category, i.unit, i.sku,
                    json_extract(i.attributes,'$.note') AS note,
                    em.external_id AS erp_code
             FROM item i
             LEFT JOIN external_mapping em ON em.external_system='erp' AND em.local_type='item' AND em.local_id=i.id`;
  const params = [];
  if (erpCode) { sql += ' WHERE em.external_id=?'; params.push(String(erpCode)); }
  sql += ' ORDER BY i.name';
  return db.prepare(sql).all(...params);
}
// 标记流水已同步（ERP 拉取后回执），仅填未同步的
export function markMovementsSynced(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const stmt = db.prepare("UPDATE movement SET synced_at=datetime('now') WHERE id=? AND synced_at IS NULL");
  let n = 0;
  for (const id of ids) { n += stmt.run(Number(id)).changes; }
  return n;
}
// ERP → 本系统：按 ERP 编码推送库存增量（delta>0 入 / <0 出），落库并记 erp_sync 流水。
// idempotency_key（ERP 业务单据号）：相同 key 视为同一笔推送，已处理则直接返回原结果，
// 防止 ERP 网络重试 / 补发导致库存被重复增减（至少一次投递 → 实际恰好一次）。
export function syncErpStock({ erp_code, loc_code, delta, idempotency_key = null } = {}) {
  if (!erp_code || !loc_code) throw new Error('erp_code 与 loc_code 必填');
  const itemId = getItemByErp(erp_code);
  if (!itemId) throw new Error('未找到 erp_code 对应货品，请先建立映射');
  const node = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(loc_code);
  if (!node) throw new Error('位置不存在: ' + loc_code);
  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) throw new Error('delta 必须为非零数字');
  const key = idempotency_key != null ? String(idempotency_key).trim() : null;

  // 幂等：同一 idem_key 已落库 → 视为重复推送，直接返回原结果，不再增减库存
  if (key) {
    const prev = db.prepare('SELECT id, qty, from_node_id, to_node_id FROM movement WHERE idem_key=?').get(key);
    if (prev) return replayErpSync(prev, { erp_code, loc_code, delta: d, key });
  }

  // 单笔应用（库存变动 + 流水 + 出站事件）。带 key 时包事务：并发重试若触发唯一索引冲突，
  // 回退为「已处理」结果，杜绝竞态下库存被加两次。
  const apply = () => {
    const inv = db.prepare('SELECT id, qty FROM inventory WHERE item_id=? AND node_id=?').get(itemId, node.id);
    if (d > 0) {
      const newQty = (inv ? Number(inv.qty) : 0) + d;
      if (inv) db.prepare('UPDATE inventory SET qty=?, last_seen_at=datetime(\'now\') WHERE id=?').run(newQty, inv.id);
      else db.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)').run(randomUUID(), TENANT, node.id, itemId, d);
      logMovement({ item_id: itemId, to_node_id: node.id, qty: d, move_type: 'erp_sync', idem_key: key });
    } else {
      const take = -d;
      const have = inv ? Number(inv.qty) : 0;
      if (take > have) throw new Error('源格位库存不足: ' + loc_code);
      const newQty = have - take;
      if (newQty <= 0) db.prepare('DELETE FROM inventory WHERE id=?').run(inv.id);
      else db.prepare('UPDATE inventory SET qty=? WHERE id=?').run(newQty, inv.id);
      logMovement({ item_id: itemId, from_node_id: node.id, qty: take, move_type: 'erp_sync', idem_key: key });
    }
    emit('inventory.changed', { item_id: itemId, node_id: node.id, erp_code, source: 'erp_sync' });
    return { erp_code, loc_code, delta: d, ok: true, idempotency_key: key || undefined };
  };

  if (key) {
    try {
      db.exec('BEGIN');
      const r = apply();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      if (isUniqueViolation(e)) {
        const prev = db.prepare('SELECT id, qty, from_node_id, to_node_id FROM movement WHERE idem_key=?').get(key);
        if (prev) return replayErpSync(prev, { erp_code, loc_code, delta: d, key });
      }
      throw e;
    }
  }
  return apply();
}

// 把已存在的 erp_sync 流水重组成幂等回包（replayed:true 告知调用方这是重复推送的兜底返回）
function replayErpSync(prev, { erp_code, loc_code, delta, key }) {
  return { erp_code, loc_code, delta, ok: true, replayed: true, movement_id: prev.id, idempotency_key: key };
}

// 判断是否为 SQLite 唯一约束冲突（不同驱动/版本的错误码文案略有差异，宽匹配）
function isUniqueViolation(e) {
  if (!e) return false;
  const msg = String(e.message || '').toLowerCase();
  const code = String(e.code || '').toUpperCase();
  return msg.includes('unique constraint') || code.includes('UNIQUE') || code.includes('CONSTRAINT');
}

// ---------- ERP 映射批量维护（供前端「ERP 编码批量导入」与初始化对账） ----------
// localType/local_type: 'item' | 'node'；localCode/local_code: 货品码(sku/erp/id) 或 库位 loc_code；erpCode/erp_code: ERP 侧编码。
// 同时兼容驼峰与蛇形键（API 与 CSV 均为蛇形）。解析不到本地记录时抛错（由 importErpMappings 收集为 errors，不中断整批）。
export function upsertErpMapping(row = {}) {
  const type = String(row.localType || row.local_type || 'item') === 'node' ? 'node' : 'item';
  const code = String(row.localCode != null ? row.localCode : (row.local_code || '')).trim();
  const erp = String(row.erpCode != null ? row.erpCode : (row.erp_code || '')).trim();
  if (!code || !erp) throw new Error('local_code 与 erp_code 均必填');
  let localId = null;
  if (type === 'item') {
    const it = getItemByCode(code);
    if (it) localId = it.item_id;
  } else {
    const n = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(code);
    if (n) localId = n.id;
  }
  if (!localId) throw new Error(`未找到 ${type} 对应本地记录: ${code}`);
  const ex = db.prepare("SELECT id FROM external_mapping WHERE external_system='erp' AND local_type=? AND local_id=?")
    .get(type, localId);
  if (ex) db.prepare("UPDATE external_mapping SET external_id=? WHERE id=?").run(erp, ex.id);
  else db.prepare("INSERT INTO external_mapping(tenant_id,external_system,local_type,local_id,external_id) VALUES(?,?,?,?,?)")
    .run(TENANT, 'erp', type, localId, erp);
  return { localType: type, localCode: code, erpCode: erp, localId, action: ex ? 'updated' : 'created' };
}
// 批量导入：返回 { total, created, updated, errors }
export function importErpMappings(rows = []) {
  if (!Array.isArray(rows)) throw new Error('rows 必须是数组');
  const created = [], updated = [], errors = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const res = upsertErpMapping(rows[i]);
      (res.action === 'created' ? created : updated).push(res);
    } catch (e) {
      errors.push({ row: i + 1, local_code: rows[i]?.local_code, erp_code: rows[i]?.erp_code, error: e.message });
    }
  }
  return { total: rows.length, created: created.length, updated: updated.length, errors };
}

// ---------- 查询接口 ----------
// roomId 可为 null（取第一个房间）或房间 id / loc_code，用于多房间切换
export function getScene(roomId = null) {
  const reservations=reservationQuantities(db);
  let room;
  if (roomId) room = db.prepare("SELECT * FROM space_node WHERE node_type='room' AND (id=? OR loc_code=?)").get(roomId, roomId);
  if (!room) room = db.prepare("SELECT * FROM space_node WHERE node_type='room' LIMIT 1").get();
  const rg = JSON.parse(room?.geom || '{}');
  const furniture = [];
  const fr = db.prepare("SELECT * FROM space_node WHERE node_type='rack' AND parent_id=?").all(room.id);
  // 一次读取库区格位及库存，避免随格位数量增长执行数千条相同查询。
  const cellsByRack = new Map(), inventoryByCell = new Map();
  const roomCells = db.prepare("SELECT c.* FROM space_node c JOIN space_node r ON r.id=c.parent_id WHERE c.node_type='cell' AND r.node_type='rack' AND r.parent_id=? ORDER BY c.rowid").all(room.id);
  for (const cell of roomCells) {
    if (!cellsByRack.has(cell.parent_id)) cellsByRack.set(cell.parent_id, []);
    cellsByRack.get(cell.parent_id).push(cell);
  }
  const roomInventory = db.prepare(`SELECT inv.node_id, i.id AS item_id, i.name, i.cover_url, inv.qty, i.attributes, i.sku, i.unit, em.external_id AS erp_code
    FROM inventory inv JOIN item i ON i.id=inv.item_id
    JOIN space_node c ON c.id=inv.node_id AND c.node_type='cell'
    JOIN space_node r ON r.id=c.parent_id AND r.node_type='rack'
    LEFT JOIN external_mapping em ON em.external_system='erp' AND em.local_type='item' AND em.local_id=i.id
    WHERE r.parent_id=? AND inv.qty>0 ORDER BY inv.rowid`).all(room.id);
  for (const row of roomInventory) {
    if (!inventoryByCell.has(row.node_id)) inventoryByCell.set(row.node_id, []);
    inventoryByCell.get(row.node_id).push(row);
  }
  for (const f of fr) {
    const fg = JSON.parse(f.geom || '{}');
    const tp = JSON.parse(f.template || '{}');
    const cells = cellsByRack.get(f.id) || [];
    const items = {};
    const cellPhotos = {};
    const cellMeta = {};
    for (const cell of cells) {
      const suffix = cell.loc_code.split('-').slice(-2).join('-');
      cellPhotos[suffix] = (() => { try { return JSON.parse(cell.photo_urls || '[]'); } catch (_) { return []; } })();
      cellMeta[suffix] = {
        revision: cellMetaRevision(cell),
        name: cell.name || '',
        label_mode: cell.label_mode || 'code',
        capacity: cell.capacity != null ? Number(cell.capacity) : null,
        ...(safeJsonArr(cell.capacity_rules).length?{capacity_rules:safeJsonArr(cell.capacity_rules)}:{}),
        max_load: cell.max_load != null ? Number(cell.max_load) : null,
        status: cell.status || 'normal',
        tags: safeJsonArr(cell.tags),
        note: cell.note || '',
      };
      const inv = inventoryByCell.get(cell.id) || [];
      items[suffix] = inv.map((r) => {
        const a = JSON.parse(r.attributes || '{}');
        return stockAvailability({
          id: r.item_id,
          name: r.name, qty: r.qty,
          sku: r.sku || '',
          unit: r.unit || '件',
          ...(a.storage_profile?{storage_profile:a.storage_profile}:{}),
          ...(Number(a.weight_kg)>0?{unit_weight_kg:Number(a.weight_kg)}:{}),
          note: a.note || '',
          depth: a.depth || '',
          cover: r.cover_url || '',
          erp_code: r.erp_code || '',
        },cell.id,reservations);
      });
    }
    furniture.push({
      code: f.loc_code, label: f.name,
      position: [fg.x ?? 0, fg.y ?? 0, fg.z ?? 0],
      rotation: fg.rot || 0,
      width: fg.w, height: fg.h, depth: fg.d,
      rows: tp.rows, cols: tp.cols, capacityPerCell: null,
      merges: tp.merges || {}, // 格位合并方案：{ L01: [[1,2],[4,6]] }
      capacityRevision: rackCapacityRevision(f, cells),
      cellNames: (() => {
        const m = {};
        for (const cell of cells) {
          const nm = cell.name || '';
          // 只暴露用户自定义名；系统默认名（「格位XX-XX」）不暴露，避免污染显示
          if (nm && !nm.startsWith('格位')) m[cell.loc_code.split('-').slice(-2).join('-')] = nm;
        }
        return m;
      })(),
      type: fg.type || 'wardrobe', open: fg.open || 0, items, cellPhotos, cellMeta,
    });
  }
  return {
    roomId: room?.id, roomCode: room?.loc_code, roomName: room?.name,
    room: { width: rg.w, depth: rg.d, height: rg.h, door: normOpenings(rg.door), window: normOpenings(rg.window) },
    furniture,
    // 写实模型：库区及其下属货架按 loc_code 关联的 GLB（前端「写实」模式加载）
    assets: getSceneAssets(room?.loc_code),
  };
}

// ---------- 写实模型资源（Blender 导出的 glTF/GLB，按 loc_code 关联） ----------
export function setNodeAsset({ locCode, assetUrl, transform = {}, submeshMap = {} } = {}) {
  if (!locCode) throw new Error('loc_code 必填');
  const node = db.prepare('SELECT id, tenant_id FROM space_node WHERE loc_code=?').get(locCode);
  if (!node) throw new Error('位置不存在: ' + locCode);
  const actor = currentActor();
  db.prepare(`INSERT INTO node_asset(loc_code, tenant_id, asset_url, format, transform_json, submesh_map_json, created_by, updated_at)
    VALUES(@loc_code, @tenant_id, @asset_url, 'glb', @transform_json, @submesh_map_json, @created_by, datetime('now'))
    ON CONFLICT(loc_code) DO UPDATE SET asset_url=excluded.asset_url, transform_json=excluded.transform_json,
      submesh_map_json=excluded.submesh_map_json, created_by=excluded.created_by, updated_at=datetime('now')`)
    .run({ loc_code: locCode, tenant_id: node.tenant_id, asset_url: assetUrl,
      transform_json: JSON.stringify(transform || {}), submesh_map_json: JSON.stringify(submeshMap || {}), created_by: actor?.id || null });
  return getNodeAsset(locCode);
}
export function getNodeAsset(locCode) {
  const row = db.prepare('SELECT * FROM node_asset WHERE loc_code=?').get(locCode);
  if (!row) return null;
  return { locCode: row.loc_code, assetUrl: row.asset_url, format: row.format,
    transform: JSON.parse(row.transform_json || '{}'), submeshMap: JSON.parse(row.submesh_map_json || '{}'),
    createdBy: row.created_by, updatedAt: row.updated_at };
}
export function deleteNodeAsset(locCode) {
  const row = db.prepare('SELECT asset_url FROM node_asset WHERE loc_code=?').get(locCode);
  if (row) db.prepare('DELETE FROM node_asset WHERE loc_code=?').run(locCode);
  return row ? row.asset_url : null;
}
// 收集某房间（库区）及其下属货架的写实模型，供前端 scene 注入。
// 新增「按名称复用」fallback：当某个货架没有自身 loc_code 对应的模型时，若其可编辑名称与某个已有资产的 loc_code 后缀一致，
// 则复用该资产。这样用户上传 A/B/C 三类标准模型后，所有命名为 A/B/C 的货架都能自动写实，无需逐个上传。
export function getSceneAssets(roomLocCode) {
  const room = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='room' AND (id=? OR loc_code=?)").get(roomLocCode, roomLocCode);
  if (!room) return {};
  const nodes = db.prepare("SELECT loc_code, name FROM space_node WHERE id=? OR (node_type='rack' AND parent_id=?)").all(room.id, room.id);
  const assets = {};
  for (const n of nodes) {
    const a = getNodeAsset(n.loc_code);
    if (a) assets[n.loc_code] = a;
  }
  const out = {};
  // 1) 优先使用本 loc_code 绑定的专属模型
  for (const n of nodes) {
    const a = assets[n.loc_code];
    if (a) out[n.loc_code] = { url: a.assetUrl, transform: a.transform, submeshMap: a.submeshMap };
  }
  // 2) 无专属模型时，按可编辑名称复用：例如 name='A' 的货架复用 WH-1-A 的模型
  for (const n of nodes) {
    if (out[n.loc_code]) continue;
    const name = (n.name || '').trim();
    if (!name) continue;
    const srcLoc = Object.keys(assets).find((k) => k.split('-').pop() === name);
    if (srcLoc) {
      const a = assets[srcLoc];
      out[n.loc_code] = { url: a.assetUrl, transform: a.transform, submeshMap: a.submeshMap };
    }
  }
  return out;
}

// 列出场地下的所有房间（多房间切换）。siteCode 给定时只返回该仓库下的库区；
// 若 siteCode 对应的仓库不存在，返回空数组（而非全部），避免跨仓库泄漏。
export function listRooms(siteCode = null) {
  if (siteCode) {
    const site = db.prepare("SELECT id FROM space_node WHERE node_type='site' AND (id=? OR loc_code=?)").get(siteCode, siteCode);
    if (!site) return [];
    return db.prepare("SELECT id, loc_code, name, geom FROM space_node WHERE node_type='room' AND parent_id=? ORDER BY name").all(site.id);
  }
  return db.prepare("SELECT id, loc_code, name, geom FROM space_node WHERE node_type='room' ORDER BY name").all();
}

// 列出所有仓库（场地），用于前端仓库切换下拉
export function listSites() {
  return db.prepare("SELECT id, loc_code, name FROM space_node WHERE node_type='site' ORDER BY loc_code").all();
}

// 新建一个仓库（场地）。自动附带首个库区，避免空仓库无法渲染场景。
// code 不传时自动生成 WH2/WH3…（种子为 WH）；传了则必须唯一且为 1-8 位字母/数字。
function createSiteImpl({ code = null, name = '新仓库' } = {}) {
  let useCode = (code || '').toString().trim().toUpperCase();
  if (useCode) {
    if (!/^[A-Z0-9]{1,8}$/.test(useCode)) throw new Error('仓库编码需为 1-8 位字母/数字（不含空格）');
    if (db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(useCode)) throw new Error('仓库编码已存在：' + useCode);
  } else {
    let n = 2;
    while (db.prepare('SELECT id FROM space_node WHERE loc_code=?').get('WH' + n)) n++;
    useCode = 'WH' + n;
  }
  const siteId = randomUUID();
  db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
              VALUES(?,?,?,?,?,?,?)`).run(siteId, TENANT, null, useCode, 'site', name || useCode, '{}');
  // 首个库区，沿用种子尺寸，确保场景可渲染
  const roomId = randomUUID();
  const roomCode = `${useCode}-1`;
  const rg = { w: 12, d: 8, h: 4, x: 0, y: 0, z: 0, door: 'back', window: ['left', 'right'] };
  db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
              VALUES(?,?,?,?,?,?,?)`).run(roomId, TENANT, siteId, roomCode, 'room', '1号库区', JSON.stringify(rg));
  emit('site.created', { site_code: useCode, name: name || useCode });
  return { id: siteId, loc_code: useCode, name: name || useCode };
}

// 新建一个房间（空房间，用户可后续添加家具）。siteCode 给定时把房间挂到该仓库下，
// 库区编码为 ${仓库}-${序号}（WH-1 → WH-2；CK-1 → CK-2），而不是旧的 HOME-BR 硬编码。
function createRoomNodeImpl({ name = '新库区', w = 12, d = 8, h = 4, door = null, window = null, siteCode = null } = {}) {
  let site;
  if (siteCode) site = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='site' AND (id=? OR loc_code=?)").get(siteCode, siteCode);
  if (!site) site = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='site' LIMIT 1").get();
  if (!site) throw new Error('请先创建场地');
  const rooms = db.prepare("SELECT loc_code FROM space_node WHERE node_type='room' AND parent_id=?").all(site.id);
  let maxN = 0;
  for (const r of rooms) { const m = /-(\d+)$/.exec(r.loc_code); if (m) maxN = Math.max(maxN, parseInt(m[1], 10)); }
  const locCode = `${site.loc_code}-${maxN + 1}`;
  const id = randomUUID();
  const g = { w: Number(w), d: Number(d), h: Number(h), x: 0, y: 0, z: 0, door, window };
  db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
              VALUES(?,?,?,?,?,?,?)`).run(id, TENANT, site.id, locCode, 'room', name || locCode, JSON.stringify(g));
  emit('room.created', { room_code: locCode });
  return { id, loc_code: locCode, name: name || locCode };
}

// 门/窗开口规范化：统一成数组 [{ side, offset }]
//   side:   'back'|'left'|'right'|'front'
//   offset: 沿墙位置比例 0~1（0.5 = 墙正中），钳制到 [0.05,0.95] 保证开口完整落在墙上
// 兼容旧数据：纯字符串 'back' / ['left','right'] 会自动补成 offset=0.5，无需数据迁移
function normOpenings(v) {
  if (v == null) return null;
  const SIDES = ['back', 'left', 'right', 'front'];
  const clampOff = (o) => {
    const n = Number(o);
    if (!Number.isFinite(n)) return 0.5;
    return Math.min(0.95, Math.max(0.05, n));
  };
  const one = (x) => {
    if (typeof x === 'string') return SIDES.includes(x) ? { side: x, offset: 0.5 } : null;
    if (x && typeof x === 'object') {
      const s = x.side || x.s || null;
      if (!SIDES.includes(s)) return null;
      const o = { side: s, offset: clampOff(x.offset != null ? x.offset : x.t) };
      if (x.double === true || x.double === 1 || x.double === 'true') o.double = true;
      // 镜像开门方向（门轴换到墙的另一端）。⚠️ 必须在这里透传，否则 /api/room 会把它丢掉。
      if (x.flip === true || x.flip === 1 || x.flip === 'true') o.flip = true;
      return o;
    }
    return null;
  };
  const arr = (Array.isArray(v) ? v : [v]).map(one).filter(Boolean);
  return arr.length ? arr : null;
}

// 设置房间门/窗（可带沿墙位置）+ 尺寸
//   door/window: 'back' | { side, offset } | 以上两者组成的数组 | null
// id 为房间主键；缺省则作用于第一个房间（兼容旧调用）
function setRoomImpl({ door = null, window = null, width, depth, height, name, id = null } = {}) {
  let room;
  if (id) room = db.prepare("SELECT id, name, geom FROM space_node WHERE id=? OR loc_code=?").get(id, id);
  if (!room) room = db.prepare("SELECT id, name, geom FROM space_node WHERE node_type='room' LIMIT 1").get();
  if (!room) return null;
  const g = JSON.parse(room.geom || '{}');
  g.door = normOpenings(door);
  g.window = normOpenings(window);
  if (width != null) { const v = Number(width); if (!(v > 0)) throw new Error('房间宽度必须 > 0'); g.w = v; }
  if (depth != null) { const v = Number(depth); if (!(v > 0)) throw new Error('房间进深必须 > 0'); g.d = v; }
  if (height != null) { const v = Number(height); if (!(v > 0)) throw new Error('房间高度必须 > 0'); g.h = v; }
  db.prepare("UPDATE space_node SET geom=? WHERE id=?").run(JSON.stringify(g), room.id);
  let updatedName = room.name;
  if (name && String(name).trim()) {
    updatedName = String(name).trim();
    db.prepare("UPDATE space_node SET name=? WHERE id=?").run(updatedName, room.id);
  }
  return { width: g.w, depth: g.d, height: g.h, door: g.door, window: g.window, name: updatedName };
}

// 更新单个家具的位置 / 旋转 / 尺寸（按 loc_code 匹配）
function updateRackImpl(code, patch = {}) {
  const f = db.prepare("SELECT * FROM space_node WHERE node_type='rack' AND loc_code=?").get(code);
  if (!f) throw new Error('家具不存在: ' + code);
  const g = JSON.parse(f.geom || '{}');
  const t = JSON.parse(f.template || '{}');
  if (patch.x != null) g.x = Number(patch.x);
  if (patch.z != null) g.z = Number(patch.z);
  if (patch.rot != null) g.rot = Number(patch.rot);
  if (patch.w != null) { const v = Number(patch.w); if (!(v > 0)) throw new Error('家具宽度必须 > 0'); g.w = v; }
  if (patch.h != null) { const v = Number(patch.h); if (!(v > 0)) throw new Error('家具高度必须 > 0'); g.h = v; }
  if (patch.d != null) { const v = Number(patch.d); if (!(v > 0)) throw new Error('家具进深必须 > 0'); g.d = v; }
  // 允许传空串清空名称（前端「留空则回退显示库位末段」），故只判 null/undefined
  if (patch.name != null) db.prepare("UPDATE space_node SET name=? WHERE id=?").run(patch.name, f.id);
  if (patch.type) { t.type = patch.type; g.type = patch.type; db.prepare("UPDATE space_node SET template=? WHERE id=?").run(JSON.stringify(t), f.id); }
  if (patch.open != null) { g.open = patch.open ? 1 : 0; }
  else if (patch.type) { g.open = OPEN_RACK_TYPES.has(patch.type) ? 1 : 0; } // 改类型但未显式给 open 时按目录兜底
  if (patch.rows != null || patch.cols != null) {
    const nRows = patch.rows != null ? Math.max(1, Math.floor(Number(patch.rows))) : (t.rows || 3);
    const nCols = patch.cols != null ? Math.max(1, Math.floor(Number(patch.cols))) : (t.cols || 4);
    if (nRows !== (t.rows || 3) || nCols !== (t.cols || 4)) {
      resizeRackCells(f.id, code, nRows, nCols);
      t.rows = nRows; t.cols = nCols;
      // 层/列变化后裁剪合并配置，丢弃已越界的区间（如原 cols=6 的 [4,6] 在 cols=4 时失效）
      if (t.merges) t.merges = normalizeMerges(t.merges, nRows, nCols);
      db.prepare("UPDATE space_node SET template=? WHERE id=?").run(JSON.stringify(t), f.id);
    }
  }
  db.prepare("UPDATE space_node SET geom=? WHERE id=?").run(JSON.stringify(g), f.id);
  emit('rack.updated', { rack_code: code, furn_code: code }); // furn_code 为兼容旧集成保留
  return { code };
}

// ============ 格位合并：把一层里相邻的几个列合并成一个宽格位 ============
// 存储位置：rack.template.merges = { "L01": [[1,2],[4,6]], "L03": [[1,3]] }
//   含义：L01 层第 1–2 列合并成一个宽格位，第 4–6 列合并成一个宽格位。
//   每个区间的**首列**是主格位（承载库存、可扫码、可录入），其余列被吞并（不渲染、不可录入）。
//
// 关键设计：**loc_code 一律不变**。合并只影响显示宽度与可用性，因此已经贴在货架上的
//   二维码标签继续有效——扫到被吞并的列（如 B02）会自动重定向到主格位（B01）。
//
// 显示编号：主格位默认显示为区间号（B01-02），可由用户自定义名称（存在 cell.name）。

// 校验并规范化合并配置：剔除越界、重叠、长度不足 2 的区间，并按列号排序
function normalizeMerges(merges, rows, cols) {
  const out = {};
  for (const [row, spans] of Object.entries(merges || {})) {
    if (!/^L\d{2}$/.test(row)) continue;
    const n = parseInt(row.slice(1), 10);
    if (!(n >= 1 && n <= rows)) continue;
    const taken = new Set();
    const list = [];
    for (const sp of (spans || [])) {
      if (!Array.isArray(sp) || sp.length < 2) continue;
      let a = Math.max(1, Math.min(cols, Math.floor(Number(sp[0]))));
      let b = Math.max(1, Math.min(cols, Math.floor(Number(sp[1]))));
      if (a > b) { const tmp = a; a = b; b = tmp; }
      if (b - a < 1) continue; // 至少合并 2 列，单列不算合并
      let clash = false;
      for (let c = a; c <= b; c++) if (taken.has(c)) clash = true;
      if (clash) continue;
      for (let c = a; c <= b; c++) taken.add(c);
      list.push([a, b]);
    }
    if (list.length) { list.sort((x, y) => x[0] - y[0]); out[row] = list; }
  }
  return out;
}

function rackCapacityRevision(rack, cells) {
  const template = JSON.parse(rack.template || '{}');
  cells ||= db.prepare("SELECT id,loc_code,capacity,capacity_rules FROM space_node WHERE parent_id=? AND node_type='cell'").all(rack.id);
  const values = cells.map(c => [c.id,c.loc_code,c.capacity,c.capacity_rules]).sort((a,b) => a[1].localeCompare(b[1]));
  return createHash('sha256').update(JSON.stringify([template.rows,template.cols,template.merges || {},values])).digest('hex');
}
function checkRackCapacityRevision(code, capacities, revision) {
  if (capacities === undefined) return;
  if (!capacities || typeof capacities !== 'object' || Array.isArray(capacities)) throw Error('合并容量格式错误');
  const rack = db.prepare("SELECT * FROM space_node WHERE loc_code=? AND node_type='rack'").get(code);
  if (!rack && revision === 'new') return;
  if (!rack || revision !== rackCapacityRevision(rack)) {
    const error = Error('格位容量或合并方案已变化，请重新打开格位布局并核对容量');
    error.status = 409; throw error;
  }
}
function applyRackCapacities(code, capacities) {
  if (capacities === undefined) return;
  const rack = db.prepare("SELECT id FROM space_node WHERE loc_code=? AND node_type='rack'").get(code);
  for (const [suffix, capacity] of Object.entries(capacities)) {
    if (!/^L\d{2}-B\d{2}$/.test(suffix)) throw Error('容量格位编码错误');
    const values=capacity && typeof capacity==='object'?{capacity:capacity.capacity,capacity_rule:capacity}:{capacity};
    validateCellMeta(values);
    const loc = `${code}-${suffix}`;
    const cell = db.prepare("SELECT id FROM space_node WHERE loc_code=? AND parent_id=? AND node_type='cell'").get(loc,rack.id);
    if (!cell || resolveCellCode(loc) !== loc) throw Error('容量只能设置到有效主格位：'+suffix);
    applyCellMeta(cell.id,values);
  }
}

// 全库所有「被吞并」的格位 loc_code（供录入下拉 / 标签排除使用）
function allMergedCells() {
  const out = new Set();
  for (const f of db.prepare("SELECT loc_code, template FROM space_node WHERE node_type='rack'").all()) {
    let t = {};
    try { t = JSON.parse(f.template || '{}'); } catch (_) { t = {}; }
    for (const [row, spans] of Object.entries(t.merges || {})) {
      for (const sp of (spans || [])) {
        const a = Math.min(sp[0], sp[1]), b = Math.max(sp[0], sp[1]);
        for (let c = a + 1; c <= b; c++) out.add(`${f.loc_code}-${row}-B${String(c).padStart(2, '0')}`);
      }
    }
  }
  return out;
}

// 把被吞并的列解析到其主格位；本身就是主格位或无关编码则原样返回。
// 用于扫码入库/出库/移库时，让已贴在被吞列上的旧标签仍然可用。
export function resolveCellCode(locCode, templates) {
  const m = String(locCode || '').match(/^(.*-L\d{2})-B(\d{2})$/);
  if (!m) return locCode;
  const prefix = m[1], row = prefix.slice(-3), col = parseInt(m[2], 10);
  const rack=prefix.slice(0,-4);
  const f = templates ? templates.get(rack) : db.prepare("SELECT template FROM space_node WHERE node_type='rack' AND loc_code=?").get(rack);
  if (!f) return locCode;
  let t = {};
  try { t = JSON.parse(f.template || '{}'); } catch (_) { t = {}; }
  for (const sp of ((t.merges || {})[row] || [])) {
    const a = Math.min(sp[0], sp[1]), b = Math.max(sp[0], sp[1]);
    if (col > a && col <= b) return `${prefix}-B${String(a).padStart(2, '0')}`;
  }
  return locCode;
}

// 设置某家具的格位合并方案。合并区间内非首列的库存会迁到首列（同货品累加数量），
// 并记一条 move_type='merge' 的流水，可追溯。
function setRackMergesImpl(code, merges) {
  const f = db.prepare("SELECT * FROM space_node WHERE node_type='rack' AND loc_code=?").get(code);
  if (!f) throw new Error('家具不存在: ' + code);
  const t = JSON.parse(f.template || '{}');
  const rows = t.rows || 3, cols = t.cols || 4;
  const clean = normalizeMerges(merges || {}, rows, cols);
  db.exec('SAVEPOINT inner_setRackMerges');
  try {
    for (const [row, spans] of Object.entries(clean)) {
      for (const sp of spans) {
        const a = Math.min(sp[0], sp[1]), b = Math.max(sp[0], sp[1]);
        const head = db.prepare("SELECT id FROM space_node WHERE loc_code=?")
          .get(`${code}-${row}-B${String(a).padStart(2, '0')}`);
        if (!head) continue;
        for (let c = a + 1; c <= b; c++) {
          const sub = db.prepare("SELECT id FROM space_node WHERE loc_code=?")
            .get(`${code}-${row}-B${String(c).padStart(2, '0')}`);
          if (!sub || sub.id === head.id) continue;
          for (const iv of db.prepare("SELECT * FROM inventory WHERE node_id=?").all(sub.id)) {
            const exist = db.prepare("SELECT id FROM inventory WHERE node_id=? AND item_id=?").get(head.id, iv.item_id);
            if (exist) {
              db.prepare("UPDATE inventory SET qty=qty+? WHERE id=?").run(iv.qty, exist.id);
              db.prepare("DELETE FROM inventory WHERE id=?").run(iv.id);
            } else {
              db.prepare("UPDATE inventory SET node_id=? WHERE id=?").run(head.id, iv.id);
            }
            logMovement({ item_id: iv.item_id, from_node_id: sub.id, to_node_id: head.id, qty: iv.qty, move_type: 'merge' });
          }
        }
      }
    }
    t.merges = clean;
    db.prepare("UPDATE space_node SET template=? WHERE id=?").run(JSON.stringify(t), f.id);
    db.exec('RELEASE SAVEPOINT inner_setRackMerges');
  } catch (e) { db.exec('ROLLBACK TO SAVEPOINT inner_setRackMerges; RELEASE SAVEPOINT inner_setRackMerges'); throw e; }
  emit('rack.updated', { rack_code: code, furn_code: code }); // furn_code 为兼容旧集成保留
  return { code, merges: clean };
}

// 给家具下的「每一格」设置自定义名称（如「螺丝区」「A 类货」）。
//   names: { "L01-B01": "螺丝区", "L01-B02": "A类货", ... }，key 为相对家具的 suffix（行-列）。
// 合并后被吞并的列（如宽格位 B01-02 里的 B02）不可单独命名，会被跳过——它们属于左侧主格位。
// 名称存到 space_node.name（真实字段），长度上限 24，空串表示清空。
function setCellNamesImpl(code, names) {
  const f = db.prepare("SELECT * FROM space_node WHERE node_type='rack' AND loc_code=?").get(code);
  if (!f) throw new Error('家具不存在: ' + code);
  const tp = JSON.parse(f.template || '{}');
  const rows = tp.rows || 3, cols = tp.cols || 4;
  const swallowed = new Set();
  for (const [row, spans] of Object.entries(normalizeMerges(tp.merges || {}, rows, cols))) {
    for (const sp of spans) {
      const a = Math.min(sp[0], sp[1]), b = Math.max(sp[0], sp[1]);
      for (let c = a + 1; c <= b; c++) swallowed.add(`${row}-B${String(c).padStart(2, '0')}`);
    }
  }
  const stmt = db.prepare("UPDATE space_node SET name=? WHERE loc_code=? AND node_type='cell'");
  for (const [suffix, name] of Object.entries(names || {})) {
    if (swallowed.has(suffix)) continue; // 被吞列不可命名
    const loc = `${code}-${suffix}`;
    const v = (name == null ? '' : String(name)).trim().slice(0, 24);
    stmt.run(v, loc);
  }
  emit('rack.updated', { rack_code: code, furn_code: code }); // furn_code 为兼容旧集成保留
  return { code };
}

// 导出完整布局模板（房间 + 家具坐标/旋转/尺寸），支持按房间导出
export function getLayout(roomId = null) {
  let r;
  if (roomId) r = db.prepare("SELECT * FROM space_node WHERE node_type='room' AND (id=? OR loc_code=?)").get(roomId, roomId);
  if (!r) r = db.prepare("SELECT * FROM space_node WHERE node_type='room' LIMIT 1").get();
  const rg = JSON.parse(r.geom || '{}');
  const fr = db.prepare("SELECT * FROM space_node WHERE node_type='rack' AND parent_id=?").all(r.id);
  const furniture = fr.map((f) => {
    const g = JSON.parse(f.geom || '{}');
    const t = JSON.parse(f.template || '{}');
    return {
      code: f.loc_code, label: f.name,
      merges:t.merges || {},
      cellNames:Object.fromEntries(db.prepare("SELECT loc_code,name FROM space_node WHERE parent_id=? AND node_type='cell'").all(f.id).map(c=>[c.loc_code.split('-').slice(-2).join('-'),c.name || ''])),
      x: g.x ?? 0, z: g.z ?? 0, rot: g.rot || 0,
      w: g.w, h: g.h, d: g.d, rows: t.rows, cols: t.cols,
      type: g.type || 'wardrobe', open: g.open || 0,
    };
  });
  const layout = {
    roomId: r.id, roomCode: r.loc_code,
    room: { width: rg.w, depth: rg.d, height: rg.h, door: normOpenings(rg.door), window: normOpenings(rg.window) },
    furniture,
  };
  return {...layout,revision:createHash('sha256').update(JSON.stringify(layout)).digest('hex')};
}

// 应用布局模板（整体写回房间尺寸 + 各家具坐标），roomId 指定作用房间
function saveLayoutImpl({ room, furniture, roomId, replace = false, revision } = {}) {
  // 先固定实际库区；无效显式编号不能悄悄改写默认库区。
  const targetRoom = roomId
    ? db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='room' AND (id=? OR loc_code=?)").get(roomId, roomId)
    : db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='room' LIMIT 1").get();
  if (!targetRoom) throw new Error('目标库区不存在');
  roomId = targetRoom.id;
  // 在审计事务内比较布局内容；库存同步不改变此版本，独立货架编辑会改变。
  if(revision !== undefined && revision !== getLayout(roomId).revision) {
    const error=new Error('布局已被其他操作修改，草稿已保留。可先导出草稿，再关闭并重新打开最新布局后核对。');
    error.status=409;throw error;
  }
  for (const f of (Array.isArray(furniture) ? furniture : [])) {
    if (!f?.code) continue;
    const rack = db.prepare("SELECT parent_id FROM space_node WHERE node_type='rack' AND loc_code=?").get(f.code);
    if (rack && rack.parent_id !== roomId) throw new Error('货架不属于目标库区：' + f.code);
    checkRackCapacityRevision(f.code,f.mergeCapacities,f.mergeCapacityRevision);
  }
  if (room) setRoom(Object.assign({}, room, roomId ? { id: roomId } : {}));
  if (Array.isArray(furniture)) {
    // 替换模式（拍照生成 / 外部导入整份新布局）：先删掉本房间内「不在提交列表里」的旧家具。
    // 注意：deleteRack 会级联清掉格位与其库存，属破坏性操作，仅当调用方显式传 replace 才执行。
    if (replace) {
      const roomRow = targetRoom;
      if (roomRow) {
        const keep = new Set(furniture.filter((f) => f && f.code).map((f) => String(f.code)));
        const existing = db.prepare("SELECT loc_code FROM space_node WHERE parent_id=? AND node_type='rack'").all(roomRow.id);
        for (const r of existing) {
          if (!keep.has(String(r.loc_code))) deleteRack(String(r.loc_code));
        }
      }
    }
    for (let f of furniture) {
      if (!f || !f.code) continue;
      const exists = db.prepare("SELECT id FROM space_node WHERE node_type='rack' AND loc_code=?").get(f.code);
      if (exists) {
        updateRack(f.code, { x: f.x, z: f.z, rot: f.rot, w: f.w, h: f.h, d: f.d, name: f.label, rows: f.rows, cols: f.cols, type: f.type, open: f.open });
      } else {
        // 外部工具（CAD/BIM）导入的新家具：在数据库中创建并自动生成格位
        const created = createRack({
          name: f.label || f.code,
          type: f.type || 'rack',
          rows: f.rows || 3,
          cols: f.cols || (f.type === 'floor' ? 4 : 3),
          open: f.open != null ? f.open : 1,
          roomCode: roomId,
          geom: { x: f.x, z: f.z, rot: f.rot, w: f.w, h: f.h, d: f.d },
        });
        f = { ...f, code: created.furn_code };
      }
      if (f.merges) setRackMerges(f.code,f.merges);
      if (f.cellNames) setCellNames(f.code,f.cellNames);
      applyRackCapacities(f.code,f.mergeCapacities);
    }
  }
  const furnCount = db.prepare("SELECT COUNT(*) AS count FROM space_node WHERE node_type='rack' AND parent_id=?").get(roomId).count;
  emit('layout.saved', { roomId, room_code: targetRoom.loc_code, furn_count: furnCount });
  return { ok: true };
}

export function getCells() {
  const all = db.prepare("SELECT loc_code, name, node_type FROM space_node WHERE node_type='cell' ORDER BY loc_code").all();
  // 排除被合并吞掉的列：它们物理上已属于左侧的宽格位，若还能录入，
  // 物品会落在一个 3D 中根本不渲染的格位上（看不见、点不到）。
  const merged = allMergedCells();
  return merged.size ? all.filter((c) => !merged.has(c.loc_code)) : all;
}

export function getLocationTree() {
  const nodes = db.prepare("SELECT id, parent_id, loc_code, node_type, name FROM space_node ORDER BY loc_code").all();
  const byId = {};
  for (const n of nodes) byId[n.id] = { ...n, children: [] };
  const roots = [];
  for (const n of nodes) {
    if (n.parent_id && byId[n.parent_id]) byId[n.parent_id].children.push(byId[n.id]);
    else roots.push(byId[n.id]);
  }
  return roots;
}

// 格位现场照片：追加一张（dataURL），最多保留最近 12 张
export function addCellPhoto(code, photo) {
  const cell = db.prepare("SELECT id, photo_urls FROM space_node WHERE loc_code=? AND node_type='cell'").get(code);
  if (!cell) throw new Error('格位不存在');
  let arr = [];
  try { arr = JSON.parse(cell.photo_urls || '[]'); } catch (_) { arr = []; }
  if (photo) arr.push(photo);
  if (arr.length > 12) arr = arr.slice(-12);
  db.prepare("UPDATE space_node SET photo_urls=? WHERE id=?").run(JSON.stringify(arr), cell.id);
  return arr;
}

// 同时校验位置和原图片，避免列表更新后按旧下标删除另一张照片。
export function removeCellPhoto(code, index, photo) {
  const cell=db.prepare("SELECT id,photo_urls FROM space_node WHERE loc_code=? AND node_type='cell'").get(code);
  if(!cell)throw Error('格位不存在');
  const photos=JSON.parse(cell.photo_urls || '[]');
  if(!Number.isInteger(index) || index<0 || index>=photos.length || typeof photo!=='string' || photos[index]!==photo)
    throw Error('照片列表已变化，请刷新后重试');
  photos.splice(index,1);
  db.prepare('UPDATE space_node SET photo_urls=? WHERE id=?').run(JSON.stringify(photos),cell.id);
  return photos;
}

// 设置单个格位扩展属性（容量/承重/状态/标签/备注）。code 支持全码 WH-1-A-L01-B01 或经合并重定向。
// 属性版本不包含库存和照片；包含节点身份，防止删除重建或合并后写入旧目标。
function cellMetaRevision(cell) {
  return createHash('sha256').update(JSON.stringify([cell.id,cell.loc_code,cell.name,cell.capacity,cell.max_load,cell.status,cell.tags,cell.note,cell.label_mode,cell.capacity_rules])).digest('hex');
}
function checkCellMetaRevision(cell, revision) {
  if (revision !== undefined && revision !== cellMetaRevision(cell)) {
    const error = new Error('格位属性已被修改，请保留当前输入并重新读取最新属性：' + cell.loc_code);
    error.status = 409; throw error;
  }
}
function setCellMetaImpl(code, meta = {}, revision) {
  validateCellMeta(meta);
  const loc = resolveCellCode(code);
  const cell = db.prepare("SELECT * FROM space_node WHERE loc_code=? AND node_type='cell'").get(loc);
  if (!cell) throw new Error('格位不存在: ' + code);
  checkCellMetaRevision(cell, revision);
  applyCellMeta(cell.id, meta);
  emit('rack.updated', { rack_code: cell.loc_code.split('-').slice(0, 3).join('-') });
  return { code: loc };
}

// 批量设置多个格位（同一组属性），codes 为全码数组
function setCellsMetaImpl(codes = [], meta = {}, revisions) {
  validateCellMeta(meta);
  // 同一事务内只读取一次合并模板，复用校验后的节点和更新语句。
  const templates=new Map(db.prepare("SELECT loc_code,template FROM space_node WHERE node_type='rack'").all().map(r=>[r.loc_code,r]));
  const lookup=db.prepare("SELECT * FROM space_node WHERE loc_code=? AND node_type='cell'");
  const targets=[];
  for (const code of codes) {
    const loc=resolveCellCode(code,templates),cell=lookup.get(loc);
    if (!cell) throw new Error('格位不存在: ' + code);
    checkCellMetaRevision(cell, revisions === undefined ? undefined : revisions[code]);
    targets.push(cell);
  }
  const apply=createCellMetaWriter(meta);
  for(const cell of targets)apply(cell.id);
  return {updated:targets.map(cell=>cell.loc_code)};
}

function validateCellMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('非法格位属性');
  if (meta.name != null && (typeof meta.name !== 'string' || meta.name.length > 24)) throw new Error('格位名称最多24个字符');
  const allowed = ['capacity','capacity_rule','max_load','status','tags','note','name','label_mode'];
  if (Object.keys(meta).some(key => !allowed.includes(key))) throw new Error('不支持的格位属性');
  for (const key of ['capacity','max_load']) {
    const n = meta[key];
    if (n != null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (key === 'capacity' && !Number.isInteger(n)))) throw new Error('容量或承重格式错误');
  }
  if(Object.hasOwn(meta,'capacity_rule')) {
    const rule=meta.capacity_rule;
    if(!rule || typeof rule!=='object' || Array.isArray(rule))throw Error('SKU容量标准格式错误');
    if(rule.clear!==true) {
      const product=capacityProduct(rule.product);
      if(!product || !productKey(product) || [product.sku,product.item_id,product.source,product.unit].some(v=>v.length>200))throw Error('请选择容量对应的SKU和库存单位');
      if(rule.capacity!==null && (!Number.isInteger(rule.capacity)||rule.capacity<0))throw Error('SKU容量须为非负整数，自动估算请留空');
    }
  }
  if (meta.label_mode != null && !['code','name','sku','name_sku'].includes(meta.label_mode)) throw new Error('非法格位显示方式');
  if (meta.status != null && !['normal','locked','stocktaking'].includes(meta.status)) throw new Error('非法格位状态');
  if (meta.tags != null && (!Array.isArray(meta.tags) || meta.tags.some(tag => typeof tag !== 'string'))) throw new Error('标签须为字符串列表');
  if (meta.note != null && typeof meta.note !== 'string') throw new Error('备注须为文本');
}
function applyCellMeta(cellId, meta = {}) { return createCellMetaWriter(meta)(cellId); }
function createCellMetaWriter(meta = {}) {
  const updates = [];
  const params = [];
  if (meta.label_mode != null) { updates.push('label_mode=?'); params.push(meta.label_mode); }
  if (meta.name != null) { updates.push('name=?'); params.push(meta.name.trim()); }
  if (Object.hasOwn(meta, 'capacity')) { updates.push('capacity=?'); params.push(meta.capacity); }
  if (Object.hasOwn(meta, 'max_load')) { updates.push('max_load=?'); params.push(meta.max_load); }
  if (meta.status != null) { updates.push('status=?'); params.push(String(meta.status)); }
  if (meta.tags != null) { updates.push('tags=?'); params.push(JSON.stringify(Array.isArray(meta.tags) ? meta.tags : [])); }
  if (meta.note != null) { updates.push('note=?'); params.push(String(meta.note)); }
  const statement=updates.length?db.prepare(`UPDATE space_node SET ${updates.join(', ')} WHERE id=?`):null;
  return cellId => {
    statement?.run(...params,cellId);
    if(meta.capacity_rule) {
      const cell=db.prepare('SELECT loc_code,parent_id,capacity_rules FROM space_node WHERE id=?').get(cellId);
      const rack=db.prepare('SELECT geom,template FROM space_node WHERE id=?').get(cell.parent_id);
      const spec={...JSON.parse(rack.geom),...JSON.parse(rack.template)};
      const rules=meta.capacity_rule.clear?[]:updateCapacityRules({capacity_rules:safeJsonArr(cell.capacity_rules)},meta.capacity_rule.product,meta.capacity_rule.capacity,cellDimensions(spec,cell.loc_code.split('-').slice(-2).join('-')));
      db.prepare('UPDATE space_node SET capacity_rules=? WHERE id=?').run(JSON.stringify(rules),cellId);
    }
    return {ok:true};
  };
}

// 格位流转时间线：返回涉及该格位的 movement 记录（按时间倒序）
export function getCellHistory(code, allowedLocations) {
  // 同一编码被重新使用时，仍可看到各代节点的历史；节点ID保留在流水中用于区分。
  return movementBusiness(db,db.prepare(`SELECT m.id,m.item_id,m.from_node_id,m.to_node_id,m.qty,m.move_type,m.occurred_at,m.idem_key,
    json_extract(m.history_json,'$.item_name') AS item_name,
    json_extract(m.history_json,'$.sku') AS sku,
    json_extract(m.history_json,'$.unit') AS unit,m.actor_id,m.actor_name,
    json_extract(m.history_json,'$.from_loc') AS from_loc,
    json_extract(m.history_json,'$.to_loc') AS to_loc
    FROM movement m WHERE (json_extract(m.history_json,'$.from_loc')=? OR json_extract(m.history_json,'$.to_loc')=?)
    AND (? IS NULL OR (
      (json_extract(m.history_json,'$.from_loc') IS NULL OR json_extract(m.history_json,'$.from_loc') IN (SELECT value FROM json_each(?)))
      AND (json_extract(m.history_json,'$.to_loc') IS NULL OR json_extract(m.history_json,'$.to_loc') IN (SELECT value FROM json_each(?)))
    )) ORDER BY m.id DESC LIMIT 120`).all(code,code,allowedLocations==null?null:JSON.stringify(allowedLocations),JSON.stringify(allowedLocations??[]),JSON.stringify(allowedLocations??[])));
}

function inventoryUnit(unit,existing) {
  const requested=unit==null?'':String(unit).trim();
  if(requested.length>20)throw Error('库存单位不能超过20字');
  if(existing&&requested&&requested!==(existing.unit||'件'))throw Error('该货品单位为 '+(existing.unit||'件')+'，请按原单位入库');
  return existing?.unit || requested || '件';
}
export function createItem(input = {}) {
  return counterOperation('createItem',input,createItemImpl);
}
function createItemImpl({ name, category, qty, loc_code, photo, note, depth, erp_code, sku, unit } = {}) {
  if (!name || !loc_code) throw new Error('name 与 loc_code 必填');
  const realLoc = resolveCellCode(loc_code);
  const node = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(realLoc);
  if (!node) throw new Error('位置不存在: ' + loc_code);
  // ⚠️ 数量下限校验：CSV 批量导入那条路径早就有（qty<=0 直接报错），
  // 但「单条录入 createItem」和「入库 inbound」这两个入口都漏了。
  // 不校验的话 qty 传 -5 会被原样存成负库存 —— 而格位物品列表只取 qty>0，
  // 于是变成"看不见却存在"的脏数据，还会让「物品总数 / 占用率」偏大。
  const itemQty = (qty === '' || qty == null) ? 1 : Number(qty);
  if (!Number.isFinite(itemQty) || itemQty <= 0) throw new Error('数量必须是不小于 1 的数字');
  const skuTrim = sku ? String(sku).trim() : '';

  // 复用：录入时填了 SKU 且命中已有货品 → 追加库存 + 记入库流水（避免同 SKU 拆成多条库存）
  if (skuTrim) {
    const resolved=itemCodes.resolve(skuTrim);
    const hit=resolved?db.prepare('SELECT id,unit FROM item WHERE tenant_id=? AND id=?').get(TENANT,resolved):null;
    if (hit) {
      inventoryUnit(unit,hit);
      if (photo) {
        const cur = db.prepare('SELECT photo_urls FROM item WHERE id=?').get(hit.id);
        let arr = [];
        try { arr = JSON.parse(cur.photo_urls || '[]'); } catch (_) { arr = []; }
        if (!Array.isArray(arr)) arr = [];
        arr.push(photo);
        if (arr.length > 6) arr = arr.slice(-6);
        db.prepare('UPDATE item SET cover_url=?, photo_urls=? WHERE id=?').run(photo, JSON.stringify(arr), hit.id);
      }
      const existing = db.prepare('SELECT id, qty FROM inventory WHERE node_id=? AND item_id=?').get(node.id, hit.id);
      const newQty = (existing ? Number(existing.qty) || 0 : 0) + itemQty;
      if (existing) db.prepare("UPDATE inventory SET qty=?, last_seen_at=datetime('now') WHERE id=?").run(newQty, existing.id);
      else db.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)').run(randomUUID(), TENANT, node.id, hit.id, itemQty);
      logMovement({ item_id: hit.id, to_node_id: node.id, qty: itemQty, move_type: 'inbound' });
      emit('inventory.changed', { item_id: hit.id, node_id: node.id, qty: newQty, erp_code: erpOf(hit.id) });
      const r = db.prepare('SELECT name, sku FROM item WHERE id=?').get(hit.id);
      return { id: hit.id, loc_code, name: r.name, sku: r.sku || '', unit:hit.unit||'件', reused: true, qty: newQty, added: itemQty };
    }
  }

  // 新建货品
  const id = randomUUID();
  const attrs = {};
  if (note) attrs.note = note;
  db.prepare('INSERT INTO item(id,tenant_id,name,category,unit,cover_url,photo_urls,attributes,sku) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, TENANT, name, category || null, inventoryUnit(unit), photo || null,
         JSON.stringify(photo ? [photo] : []), JSON.stringify(attrs), skuTrim || null);
  if (erp_code) setItemErpCode(id, erp_code);
  db.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)')
    .run(randomUUID(), TENANT, node.id, id, itemQty);
  logMovement({ item_id: id, to_node_id: node.id, qty: itemQty, move_type: 'inbound' });
  emit('item.created', { item_id: id, name, qty: itemQty, loc_code, erp_code: erp_code || null });
  emit('inventory.changed', { item_id: id, node_id: node.id, qty: itemQty, erp_code: erp_code || null });
  return { id, loc_code, name, erp_code: erp_code || null, reused: false };
}

// 运行时创建参数化家具（衣柜/书架/储物箱…）+ 自动生成格位；roomCode 指定归属房间（多房间）
const FURN_PREFIX = { wardrobe: 'WD', shelf: 'SH', box: 'BX', cabinet: 'CB', rack: 'RK' };

// 重建某家具的格位（按新 rows×cols），尽量保留仍在范围内的原有物品；
// 缩小网格时，被裁掉的格位里的物品连同其库存/流水一并清理，避免孤儿数据。全程事务包裹。
function resizeRackCells(furnId, furnCode, nRows, nCols) {
  db.exec('SAVEPOINT inner_resizeRackCells');
  try {
    const wanted=new Set();
    for(let r=1;r<=nRows;r++) for(let c=1;c<=nCols;c++) wanted.add(`${furnCode}-L${String(r).padStart(2,'0')}-B${String(c).padStart(2,'0')}`);
    const existing=db.prepare("SELECT id,loc_code FROM space_node WHERE parent_id=? AND node_type='cell'").all(furnId);
    const removed=existing.filter(c=>!wanted.has(c.loc_code));
    for(const c of removed) if(db.prepare('SELECT 1 FROM inventory WHERE node_id=? AND qty>0 LIMIT 1').get(c.id)) throw new Error('缩减范围仍有库存: '+c.loc_code);
    for(const c of removed) {
      db.prepare('DELETE FROM inventory WHERE node_id=?').run(c.id);
      db.prepare('DELETE FROM space_node WHERE id=?').run(c.id);
    }
    const kept=new Set(existing.map(c=>c.loc_code));
    for(const code of wanted) if(!kept.has(code)) db.prepare('INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(),TENANT,furnId,code,'cell','格位'+code.split('-').slice(-2).join('-'),'{}');
    // 保留范围内节点、照片、库存和流水原封不动，不生成虚假的移库流水。
    db.exec('RELEASE SAVEPOINT inner_resizeRackCells');
  } catch(e) { db.exec('ROLLBACK TO SAVEPOINT inner_resizeRackCells; RELEASE SAVEPOINT inner_resizeRackCells'); throw e; }
}

// 开放式货架类型集合：决定货架 3D 外壳是否半透明可视穿。
// 与前端 RACK_TYPES.open 保持一致；新增类型时同步在此登记，避免后端兜底把新类型误判为封闭柜。
const OPEN_RACK_TYPES = new Set([
  'shelf', 'rack', 'drivein', 'shuttle', 'pushback', 'doubledeep', 'vna',
  'flow', 'cantilever', 'mezzanine', 'asrs', 'pegboard', 'floor',
]);

function createRackImpl({ name, type = 'rack', rows = 4, cols = 6, geom, roomCode = null, open = null, x = null, z = null } = {}) {
  const isFloor = type === 'floor';
  // 仓库货架字母编号：0->A, 1->B, ... 25->Z, 26->AA
  const rackLetter = (n) => {
    let s = '', k = n + 1;
    while (k > 0) {
      const r = (k - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      k = Math.floor((k - 1) / 26);
    }
    return s;
  };
  let room;
  if (roomCode) room = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='room' AND (id=? OR loc_code=?)").get(roomCode, roomCode);
  if (!room) room = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='room' LIMIT 1").get();
  if (!room) throw new Error('请先创建房间');
  // 家具编号段：
  //  - 货架/柜：纯字母 A/B/C…（loc_code 形如 WH-1-A）
  //  - 地面区：F1/F2…（Floor），与货架字母段区分，避免混淆
  //  均取「第一个未被占用的编号」而非「已有数量+1」——否则删掉中间的 B 后再新增会算成 C，撞 loc_code UNIQUE 而失败。
  const used = new Set(
    db.prepare("SELECT loc_code FROM space_node WHERE parent_id=? AND node_type='rack'").all(room.id)
      .map((r) => String(r.loc_code).split('-').pop())
  );
  let furnCode = null;
  if (isFloor) {
    for (let n = 1; n < 1000; n++) { if (!used.has('F' + n)) { furnCode = `${room.loc_code}-F${n}`; break; } }
  } else {
    for (let n = 0; n < 1000; n++) { if (!used.has(rackLetter(n))) { furnCode = `${room.loc_code}-${rackLetter(n)}`; break; } }
  }
  if (!furnCode) throw new Error(isFloor ? '地面区编号已用尽，无法继续新增' : '货架编号已用尽，无法继续新增');
  const furnId = randomUUID();
  const openFlag = isFloor ? 1 : (open != null ? !!open : OPEN_RACK_TYPES.has(type));
  // 新家具默认排在已有家具右侧，避免多个家具叠在同一坐标（前端若不传坐标也能用）
  const maxX = db.prepare("SELECT geom FROM space_node WHERE parent_id=? AND node_type='rack'").all(room.id)
    .reduce((m, r) => { try { return Math.max(m, Number(JSON.parse(r.geom || '{}').x) || 0); } catch { return m; } }, -Infinity);
  const baseX = Number.isFinite(maxX) ? maxX + 2.4 : 0;
  // 显式传入 x/z（如复制货架时由前端算好的室内坐标）则优先使用，确保复制出的货架落在房间内
  const reqGeom = Object.assign({}, geom || {});
  if (x != null) reqGeom.x = Number(x);
  if (z != null) reqGeom.z = Number(z);
  // 地面区：贴地薄板，无高度概念（h 恒为 0.05），w/d 即地面区域的物理长宽
  const fRows = isFloor ? (rows || 6) : rows;
  const fCols = isFloor ? (cols || 6) : cols;
  let g;
  if (isFloor) {
    const fw = (reqGeom.w) ? reqGeom.w : 3;
    const fd = (reqGeom.d) ? reqGeom.d : 2;
    g = { w: fw, h: 0.05, d: fd, x: (reqGeom.x != null ? reqGeom.x : baseX), y: 0, z: (reqGeom.z != null ? reqGeom.z : 0), rot:reqGeom.rot || 0, type: 'floor', open: 1 };
  } else {
    g = Object.assign({}, { w: 1.2, h: 1.8, d: 0.4, x: baseX, y: 0, z: -0.8 }, reqGeom, { type, open: openFlag ? 1 : 0 });
  }
  db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom,template)
              VALUES(?,?,?,?,?,?,?,?)`).run(furnId, TENANT, room.id, furnCode, 'rack', name || furnCode,
              JSON.stringify(g), JSON.stringify({ rows: fRows, cols: fCols }));
  // 格位编码统一沿用 -Lxx-Bxx（地面区：L=行、B=列），从而合并/命名/扫码/入库全部零改动复用
  for (let r = 1; r <= fRows; r++) {
    for (let c = 1; c <= fCols; c++) {
      const lr = 'L' + String(r).padStart(2, '0');
      const bc = 'B' + String(c).padStart(2, '0');
      db.prepare(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
                  VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), TENANT, furnId, `${furnCode}-${lr}-${bc}`, 'cell',
                  `格位${lr}-${bc}`, '{}');
    }
  }
  emit('rack.created', { rack_code: furnCode, furn_code: furnCode, name: name || furnCode, rows: fRows, cols: fCols, type });
  return { furn_code: furnCode, rows: fRows, cols: fCols, type, open: 1 };
}

export function addAlias(word, target) {
  db.prepare('INSERT OR REPLACE INTO alias(word,target) VALUES(?,?)').run(word, target);
  return { word, target };
}

export function getAliases() {
  return db.prepare('SELECT word, target FROM alias ORDER BY word').all();
}

export function search(q, allowedLocations) {
  const term = (q || '').trim();
  let rows = directSearch(term, allowedLocations);
  if (rows.length === 0) {
    const a = db.prepare('SELECT target FROM alias WHERE word=?').get(term);
    if (a) rows = directSearch(a.target, allowedLocations);
  }
  return rows;
}
// 搜索维度：物品名 + 库位码 + SKU + ERP 编码。
// 只按物品名搜的话，手上有 SKU 或看到库位码（WH-1-A-L01-B01）时搜不到任何东西，
// 这对仓管是高频操作。SKU / ERP / 库位码统一按大写比对，避免大小写漏匹配。
function directSearch(term, allowedLocations) {
  const up = String(term || '').toUpperCase();
  return db.prepare(`SELECT i.id AS item_id, i.name AS name, i.sku AS sku, i.unit AS unit, inv.qty AS qty, n.loc_code AS loc_code, i.cover_url AS cover,
                            em.external_id AS erp_code
                     FROM inventory inv
                     JOIN item i ON i.id=inv.item_id
                     JOIN space_node n ON n.id=inv.node_id
                     LEFT JOIN external_mapping em ON em.external_system='erp' AND em.local_type='item' AND em.local_id=i.id
                     WHERE inv.qty>0 AND (? IS NULL OR n.loc_code IN (SELECT value FROM json_each(?))) AND (
                              INSTR(i.name, ?) > 0
                           OR INSTR(UPPER(n.loc_code), ?) > 0
                           OR INSTR(UPPER(COALESCE(i.sku, '')), ?) > 0
                           OR INSTR(UPPER(COALESCE(em.external_id, '')), ?) > 0
                           OR UPPER(i.id) = ?
                           OR EXISTS(SELECT 1 FROM item_code c WHERE c.item_id=i.id AND INSTR(UPPER(c.code),?)>0)
                     )
                     ORDER BY i.name LIMIT 50`).all(allowedLocations == null ? null : JSON.stringify(allowedLocations), JSON.stringify(allowedLocations ?? []), term, up, up, up, up, up);
}

export function updateItem(id, { name, category, qty, loc_code, note, photo, depth, erp_code } = {}) {
  db.exec('SAVEPOINT update_item');
  try {
    const it = db.prepare('SELECT id FROM item WHERE id=?').get(id);
    if (!it) throw new Error('物品不存在: ' + id);
    const inventory = db.prepare(`SELECT inv.id, inv.node_id, inv.qty, n.loc_code
      FROM inventory inv LEFT JOIN space_node n ON n.id=inv.node_id WHERE inv.item_id=?`).all(id);
    const changesInventory = qty !== undefined || Boolean(loc_code);
    if (changesInventory && inventory.length !== 1) throw new Error('数量或位置修改需要唯一库存库位，请使用指定库位的库存操作');
    const nextQty = qty === undefined ? inventory[0]?.qty : Number(qty);
    if (qty !== undefined && (qty === null || qty === '' || !Number.isFinite(nextQty) || nextQty < 0)) throw new Error('数量必须是非负有限数字');
    let target;
    if (loc_code) {
      target = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='cell' AND loc_code=?").get(resolveCellCode(loc_code));
      if (!target) throw new Error('目标库位不存在');
    }
    const sets = [], params = [];
    if (name !== undefined) { sets.push('name=?'); params.push(name); }
    if (category !== undefined) { sets.push('category=?'); params.push(category || null); }
    if (note !== undefined) {
      const cur = JSON.parse((db.prepare('SELECT attributes FROM item WHERE id=?').get(id) || {}).attributes || '{}');
      if (note) cur.note = note; else delete cur.note;
      const pruned = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== undefined));
      sets.push('attributes=?'); params.push(JSON.stringify(pruned));
    }
    if (photo !== undefined) {
      sets.push('cover_url=?'); params.push(photo || null);
      sets.push('photo_urls=?'); params.push(JSON.stringify(photo ? [photo] : []));
    }
    if (sets.length) db.prepare(`UPDATE item SET ${sets.join(',')} WHERE id=?`).run(...params, id);
    if (erp_code !== undefined) setItemErpCode(id, erp_code);

    if (changesInventory) {
      const inv = inventory[0];
      const nextNode = target?.id || inv.node_id;
      db.prepare('UPDATE inventory SET node_id=?, qty=? WHERE id=?').run(nextNode, nextQty, inv.id);
      // 移动时通知旧库位已清空，再记录新库位最终数量，均冻结在本次事务中。
      if (nextNode !== inv.node_id) emit('inventory.changed', { item_id:id, node_id:inv.node_id, loc_code:inv.loc_code, qty:0, erp_code:erpOf(id) });
      emit('inventory.changed', { item_id:id, node_id:nextNode, loc_code:target?.loc_code || inv.loc_code, qty:nextQty, erp_code:erpOf(id) });
    }
    const identity = db.prepare('SELECT name, sku, unit, category FROM item WHERE id=?').get(id);
    const locations = db.prepare(`SELECT inv.node_id, inv.qty, n.loc_code FROM inventory inv
      LEFT JOIN space_node n ON n.id=inv.node_id WHERE inv.item_id=?`).all(id);
    for (const location of (locations.length ? locations : [{}])) emit('item.updated', { item_id:id, ...identity, erp_code:erpOf(id), ...location });
    db.exec('RELEASE SAVEPOINT update_item');
    return { id };
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT update_item; RELEASE SAVEPOINT update_item');
    throw error;
  }
}

export function deleteItem(id) {
  db.exec('SAVEPOINT delete_item');
  try {
    const item = db.prepare('SELECT id, name, sku, unit FROM item WHERE id=?').get(id);
    if (!item) { db.exec('RELEASE SAVEPOINT delete_item'); return { id }; }
    // 删除前捕获所有实际库位，不用删除后的现状反推历史。
    const locations = db.prepare(`SELECT inv.node_id, n.loc_code, inv.qty AS previous_qty
      FROM inventory inv LEFT JOIN space_node n ON n.id=inv.node_id
      WHERE inv.item_id=? ORDER BY inv.node_id`).all(id);
    const identity = { item_id: id, name: item.name, sku: item.sku, unit: item.unit, erp_code: erpOf(id) };
    db.prepare('DELETE FROM inventory WHERE item_id=?').run(id);
    db.prepare('DELETE FROM item WHERE id=?').run(id);
    for (const location of (locations.length ? locations : [{}])) {
      emit('item.deleted', { ...identity, ...location });
    }
    db.exec('RELEASE SAVEPOINT delete_item');
    return { id };
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT delete_item; RELEASE SAVEPOINT delete_item');
    throw error;
  }
}

// 删除家具（清理当前格位/库存，历史流水通过快照保留），事务包裹
function deleteRackImpl(code) {
  const f = db.prepare("SELECT id FROM space_node WHERE node_type='rack' AND loc_code=?").get(code);
  if (!f) throw new Error('家具不存在: ' + code);
  db.exec('SAVEPOINT inner_deleteRack');
  try {
    const cells = db.prepare("SELECT id FROM space_node WHERE parent_id=? AND node_type='cell'").all(f.id);
    const droppedItems = [];
    for (const c of cells) {
      for (const i of db.prepare("SELECT DISTINCT item_id FROM inventory WHERE node_id=?").all(c.id)) droppedItems.push(i.item_id);


      db.prepare("DELETE FROM inventory WHERE node_id=?").run(c.id);
    }
    db.prepare("DELETE FROM space_node WHERE parent_id=?").run(f.id); // 格位
    db.prepare("DELETE FROM space_node WHERE id=?").run(f.id);        // 家具
    for (const itemId of [...new Set(droppedItems)]) {
      const remain = db.prepare("SELECT COUNT(*) c FROM inventory WHERE item_id=?").get(itemId).c;
      if (!remain) {  db.prepare("DELETE FROM item WHERE id=?").run(itemId); }
    }
    db.exec('RELEASE SAVEPOINT inner_deleteRack');
  } catch (e) { db.exec('ROLLBACK TO SAVEPOINT inner_deleteRack; RELEASE SAVEPOINT inner_deleteRack'); throw e; }
  emit('rack.deleted', { rack_code: code, furn_code: code });
  return { code };
}

// 删除房间（级联当前家具/格位/库存/物品，保留历史流水），事务包裹；禁止删除最后一个房间
function deleteRoomImpl(roomId) {
  const room = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='room' AND (id=? OR loc_code=?)").get(roomId, roomId);
  if (!room) throw new Error('房间不存在: ' + roomId);
  const total = db.prepare("SELECT COUNT(*) c FROM space_node WHERE node_type='room'").get().c;
  if (total <= 1) throw new Error('至少保留一个房间，不能删除最后一个');
  db.exec('SAVEPOINT inner_deleteRoom');
  try {
    const furns = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='rack' AND parent_id=?").all(room.id);
    for (const f of furns) {
      const cells = db.prepare("SELECT id FROM space_node WHERE parent_id=? AND node_type='cell'").all(f.id);
      const droppedItems = [];
      for (const c of cells) {
        for (const i of db.prepare("SELECT DISTINCT item_id FROM inventory WHERE node_id=?").all(c.id)) droppedItems.push(i.item_id);


        db.prepare("DELETE FROM inventory WHERE node_id=?").run(c.id);
      }
      db.prepare("DELETE FROM space_node WHERE parent_id=?").run(f.id);
      db.prepare("DELETE FROM space_node WHERE id=?").run(f.id);
      for (const itemId of [...new Set(droppedItems)]) {
        const remain = db.prepare("SELECT COUNT(*) c FROM inventory WHERE item_id=?").get(itemId).c;
        if (!remain) {  db.prepare("DELETE FROM item WHERE id=?").run(itemId); }
      }
    }
    db.prepare("DELETE FROM space_node WHERE id=?").run(room.id);
    db.exec('RELEASE SAVEPOINT inner_deleteRoom');
  } catch (e) { db.exec('ROLLBACK TO SAVEPOINT inner_deleteRoom; RELEASE SAVEPOINT inner_deleteRoom'); throw e; }
  emit('room.deleted', { room_code: room.loc_code });
  return { code: room.loc_code };
}

// 批量导入：rows = [{name, category, qty, loc_code, note, photo?}]，跳过缺字段或位置不存在的行
// ---- 批量导入辅助 ----
// 库位短码解析：表格里的库位允许三种写法，逐个降级匹配。
//   1) 完整库位码  WH-1-A-L01-B01
//   2) 货架+层位   A-L01-B01
//   3) 层位         L01-B01 —— 此时必须配合「货架」列，否则 A/B/C 三排货架无法区分
// 用 substr 取尾部比较而非 LIKE，避免库位码里的 % 和 _ 被当成通配符导致误匹配。
export function resolveImportLoc(raw, rackHint) {
  const code = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!code) return { error: '库位为空' };
  const byCode = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='cell' AND loc_code=?").get(code);
  if (byCode) return { ok: true, locCode: byCode.loc_code, nodeId: byCode.id };

  const segs = code.split('-').filter(Boolean);
  const rack = String(rackHint == null ? '' : rackHint).trim().toUpperCase();
  // 层位形如 L01-B01：倒数第二段是 L+两位数字
  const hasLayer = /^L\d{2}$/.test(segs[segs.length - 2] || '');
  let suffix = code;
  // 只给了层位（2 段）且填了货架列 → 补成「货架-层-位」
  if (rack && hasLayer && segs.length === 2) suffix = rack + '-' + code;

  const hits = db.prepare("SELECT id, loc_code FROM space_node WHERE node_type='cell' AND (loc_code=? OR substr(loc_code, length(loc_code)-?) = ?)")
    .all(suffix, suffix.length, '-' + suffix);
  if (hits.length === 1) return { ok: true, locCode: hits[0].loc_code, nodeId: hits[0].id };
  if (hits.length > 1) {
    const sample = hits.slice(0, 3).map((h) => h.loc_code).join('、');
    return { error: `库位「${code}」匹配到 ${hits.length} 个位置（${sample}…），请补「货架」列或写完整库位码` };
  }
  return { error: `未找到库位：${code}` };
}

// 批量导入：表格 → 库存。
// 两阶段：
//  1) 预检（不写库）：数量合法、库位可解析、产品无「歧义同名」。任一不过则整批不导并回报错误明细。
//  2) 事务内：解析产品（SKU→ERP→名称，都不命中则新建）并写库存；同批内用 batchItem 缓存
//     已解析/已建货品，保证同一新货品在单批次里只建一条；格位已有该货品则累加数量。
// 产品解析放在事务里（而非预检），既避免预检失败留下孤儿记录，也保证同批同款正确复用。
export function importItems(rows, { preview = false, request_id } = {}) {
  return preview?importItemsImpl(rows,true):counterOperation('import',{rows,request_id},body=>importItemsImpl(body.rows));
}
function importItemsImpl(rows, preview = false) {
  const list = Array.isArray(rows) ? rows : [];
  const errors = [];
  const plan = [];
  const batchItem = new Map(); // key = sku || erp || name → itemId（本批内复用）

  const resolveItemPrecheck = (r) => {
    const name = String(r.name == null ? '' : r.name).trim();
    if (!name) return { error: '产品名称为空' };
    // 仅查「歧义同名」这类非新建错误；具体复用/新建在事务里定
    if(String(r.sku||'').trim()||String(r.erp_code||'').trim())return null;
    const byName = db.prepare("SELECT id FROM item WHERE tenant_id=? AND name=? AND (sku IS NULL OR trim(sku)='')").all(TENANT, name);
    if (byName.length > 1) return { error: `产品「${name}」在系统里有 ${byName.length} 条同名记录，请填 SKU 区分` };
    return null;
  };

  list.forEach((row, i) => {
    const rowNo = i + 2; // CSV/Excel 首行为表头，数据从第 2 行起
    const r = row || {};
    const qtyRaw = r.qty;
    const qty = (qtyRaw === '' || qtyRaw == null) ? 1 : Number(qtyRaw);
    if (!Number.isFinite(qty) || qty <= 0) { errors.push({ row: rowNo, error: `数量无效：${qtyRaw}` }); return; }

    const loc = resolveImportLoc(r.loc_code || r.loc || r.location, r.rack || r.shelf);
    if (!loc.ok) { errors.push({ row: rowNo, loc_code: r.loc_code, name: r.name, error: loc.error }); return; }
    const finalLoc = resolveCellCode(loc.locCode); // 合并格位重定向到主格位
    const node = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(finalLoc);
    if (!node) { errors.push({ row: rowNo, loc_code: finalLoc, name: r.name, error: `库位不存在：${finalLoc}` }); return; }

    const pc = resolveItemPrecheck(r);
    if (pc && pc.error) { errors.push({ row: rowNo, loc_code: finalLoc, name: r.name, error: pc.error }); return; }

    plan.push({ rowNo, nodeId: node.id, locCode: finalLoc, r, qty, name: String(r.name).trim(), erp: r.erp_code || null });
  });

  // 预检未过：整批不导入，回报错误明细供用户改完重试
  if (errors.length) return { imported: 0, skipped: errors.length, updated: 0, created: 0, errors: errors.slice(0, 50) };

  // 事务内解析产品：先查本批缓存，再查库（SKU→ERP→名称），都不命中才新建并写回缓存
  const resolveItemTx = (r) => {
    const name = String(r.name == null ? '' : r.name).trim();
    const sku = String(r.sku == null ? '' : r.sku).trim();
    const erp = String(r.erp_code == null ? '' : r.erp_code).trim();
    const key = JSON.stringify(sku?['sku',sku]:erp?['erp',erp]:['name',name]);
    const reuse = id => {
      const item=db.prepare('SELECT id,unit,sku FROM item WHERE id=?').get(id);
      inventoryUnit(r.unit,item);
      if(sku&&itemCodes.resolve(sku)!==id)throw Error('SKU与ERP编码对应的货品不一致');
      if(erp&&getItemByErp(erp)&&getItemByErp(erp)!==id)throw Error('ERP编码已绑定其他货品');
      batchItem.set(key,id);return {itemId:id,created:false};
    };
    if (batchItem.has(key)) return reuse(batchItem.get(key));
    if (sku) {
      const hit=itemCodes.resolve(sku);
      if (hit) return reuse(hit);
    }
    if (erp) {
      const id = getItemByErp(erp);
      if (id) return reuse(id);
    }
    if(!sku&&!erp){
      const byName = db.prepare("SELECT id FROM item WHERE tenant_id=? AND name=? AND (sku IS NULL OR trim(sku)='')").all(TENANT, name);
      if (byName.length === 1) return reuse(byName[0].id);
    }
    // 新建
    const id = randomUUID();
    db.prepare('INSERT INTO item(id,tenant_id,name,category,unit,cover_url,photo_urls,attributes) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, TENANT, name, r.category || null, inventoryUnit(r.unit), null, '[]', JSON.stringify(r.note ? { note: r.note } : {}));
    if (erp) setItemErpCode(id, erp);
    if (sku) db.prepare('UPDATE item SET sku=? WHERE id=?').run(sku, id);
    batchItem.set(key, id);
    return { itemId: id, created: true };
  };

  let imported = 0, updated = 0, created = 0, currentRow = null;
  const previewRows=[];
  db.exec('SAVEPOINT inventory_import');
  try {
    for (const p of plan) {
      currentRow=p.rowNo;
      const it = resolveItemTx(p.r);
      const itemId = it.itemId;
      const inv = db.prepare('SELECT id, qty FROM inventory WHERE node_id=? AND item_id=?').get(p.nodeId, itemId);
      if(preview){
        const item=db.prepare('SELECT name,sku,unit FROM item WHERE id=?').get(itemId);
        previewRows.push({row:p.rowNo,loc_code:p.locCode,...item,qty:p.qty,before:Number(inv?.qty)||0,after:(Number(inv?.qty)||0)+p.qty,action:it.created?'新建货品并入库':'追加库存'});
      }
      if (inv) {
        // 该格位已有此产品 → 累加（补货语义）；uq_inv_node_item 唯一索引保证不会叠出第二行
        db.prepare('UPDATE inventory SET qty=?, last_seen_at=datetime(\'now\') WHERE id=?').run((Number(inv.qty) || 0) + p.qty, inv.id);
        updated++;
      } else {
        db.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)').run(randomUUID(), TENANT, p.nodeId, itemId, p.qty);
      }
      if (it.created) { created++; emit('item.created', { item_id: itemId, name: p.name, qty: p.qty, loc_code: p.locCode, erp_code: p.erp }); }
      logMovement({ item_id: itemId, to_node_id: p.nodeId, qty: p.qty, move_type: 'inbound' });
      // 冻结本次变更后的数量，与库存同一事务提交；补发时不读取后来的库存。
      const currentQty = (Number(inv?.qty) || 0) + p.qty;
      emit('inventory.changed', { item_id: itemId, node_id: p.nodeId, loc_code: p.locCode, qty: currentQty, erp_code: erpOf(itemId) });
      imported++;
    }
    if(preview)db.exec('ROLLBACK TO SAVEPOINT inventory_import');
    db.exec('RELEASE SAVEPOINT inventory_import');
  } catch (e) {
    db.exec('ROLLBACK TO SAVEPOINT inventory_import; RELEASE SAVEPOINT inventory_import');
    throw new Error('导入失败，已整体回滚'+(currentRow?'（第 '+currentRow+' 行）':'')+'：' + e.message);
  }
  return { imported:preview?0:imported, skipped: 0, updated, created, errors: [], ...(preview?{preview:true,rows:previewRows}: {}) };
}

export function listInventory() {
  const reservations=reservationQuantities(db);
  return db.prepare(`SELECT inv.node_id AS _node_id, i.id AS item_id, i.name, i.sku, i.unit, i.category AS category, json_extract(i.attributes,'$.note') AS note,
                            inv.qty, n.loc_code, n.name AS loc_name,
                            em.external_id AS erp_code
                     FROM inventory inv
                     JOIN item i ON i.id=inv.item_id
                     JOIN space_node n ON n.id=inv.node_id
                     LEFT JOIN external_mapping em ON em.external_system='erp' AND em.local_type='item' AND em.local_id=i.id
                     WHERE inv.qty>0 ORDER BY n.loc_code, i.name`).all().map(({_node_id,...row})=>stockAvailability(row,_node_id,reservations));
}

// ERP 拉取用：增量流水，带 erp_code、起止库位码、after 游标（按 id 单调，避免同时间戳丢事件）
export function listMovements({ limit = 50, after = 0, allowedLocations } = {}) {
  return movementBusiness(db,db.prepare(`SELECT m.id,m.item_id,m.from_node_id,m.to_node_id,m.qty,m.move_type,m.idem_key,m.occurred_at,m.synced_at,m.actor_id,m.actor_name,
    json_extract(m.history_json,'$.item_name') AS item_name,
    json_extract(m.history_json,'$.sku') AS sku,
    json_extract(m.history_json,'$.unit') AS unit,
    json_extract(m.history_json,'$.erp_code') AS erp_code,
    json_extract(m.history_json,'$.from_loc') AS from_loc_code,
    json_extract(m.history_json,'$.to_loc') AS to_loc_code,
    json_extract(m.history_json,'$.from_erp_loc') AS from_erp_loc,
    json_extract(m.history_json,'$.to_erp_loc') AS to_erp_loc
    FROM movement m WHERE m.id>? AND (? IS NULL OR (
      (json_extract(m.history_json,'$.from_loc') IS NOT NULL OR json_extract(m.history_json,'$.to_loc') IS NOT NULL)
      AND (json_extract(m.history_json,'$.from_loc') IS NULL OR json_extract(m.history_json,'$.from_loc') IN (SELECT value FROM json_each(?)))
      AND (json_extract(m.history_json,'$.to_loc') IS NULL OR json_extract(m.history_json,'$.to_loc') IN (SELECT value FROM json_each(?)))
    )) ORDER BY m.id ASC LIMIT ?`).all(Number(after)||0,allowedLocations == null ? null : JSON.stringify(allowedLocations),JSON.stringify(allowedLocations ?? []),JSON.stringify(allowedLocations ?? []),Number(limit)||50));
}

// 某格位内当前在库物品（出库台列出可出选项）
export function getCellItems(locCode) {
  const node = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(resolveCellCode(locCode));
  if (!node) return null;
  const reservations=reservationQuantities(db);
  return db.prepare(`SELECT i.id AS item_id, i.name, i.sku, i.unit, inv.qty, i.attributes
                     FROM inventory inv JOIN item i ON i.id=inv.item_id
                     WHERE inv.node_id=? AND inv.qty>0 ORDER BY i.name`).all(node.id)
    .map((r) => {
      const a = JSON.parse(r.attributes || '{}');
      return stockAvailability({ item_id: r.item_id, name: r.name, sku: r.sku || '', unit:r.unit || '件', qty: r.qty, note: a.note || '', depth: a.depth || '', erp_code: erpOf(r.item_id) || '' },node.id,reservations);
    });
}

// 入库：按 sku（优先）或名称复用已有货品，叠加库存 + 记 inbound 流水（手机扫货品码即用 sku 复用）
function inboundImpl({ name, category, qty, loc_code, note, depth, photo, sku, unit, item_id } = {}) {
  if (!name || !loc_code) throw new Error('name 与 loc_code 必填');
  // 若扫到被合并吞掉的列（旧标签 B02），自动落到其主格位 B01，旧标签继续可用
  const realLoc = resolveCellCode(loc_code);
  const node = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(realLoc);
  if (!node) throw new Error('位置不存在: ' + loc_code);
  // ⚠️ 数量下限校验：CSV 批量导入那条路径早就有（qty<=0 直接报错），
  // 但「单条录入 createItem」和「入库 inbound」这两个入口都漏了。
  // 不校验的话 qty 传 -5 会被原样存成负库存 —— 而格位物品列表只取 qty>0，
  // 于是变成"看不见却存在"的脏数据，还会让「物品总数 / 占用率」偏大。
  const itemQty = (qty === '' || qty == null) ? 1 : Number(qty);
  if (!Number.isFinite(itemQty) || itemQty <= 0) throw new Error('数量必须是不小于 1 的数字');
  const skuTrim = sku ? String(sku).trim() : '';
  let item = null;
  if(item_id){item=db.prepare('SELECT id,unit,name FROM item WHERE tenant_id=? AND id=?').get(TENANT,item_id);if(!item)throw Error('所选货品已不存在');name=item.name;}
  if(item&&skuTrim){const linked=itemCodes.resolve(skuTrim);if(linked&&linked!==item.id)throw Error('货品与条码不一致，请重新选择');}
  if (!item&&skuTrim) {const linked=itemCodes.resolve(skuTrim);if(linked)item=db.prepare('SELECT id,unit,name FROM item WHERE tenant_id=? AND id=?').get(TENANT,linked);}
  // 提供 SKU 时只按 SKU 匹配；未编号货品也不能归入同名的已编号货品。
  if (!item&&!skuTrim) item = db.prepare("SELECT id,unit FROM item WHERE tenant_id=? AND name=? AND (sku IS NULL OR trim(sku)='')").get(TENANT, String(name).trim());
  const resolvedUnit=inventoryUnit(unit,item);
  if (!item) {
    const id = randomUUID();
    const attrs = {};
    if (note) attrs.note = note;
    db.prepare('INSERT INTO item(id,tenant_id,name,category,unit,cover_url,photo_urls,attributes,sku) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, TENANT, String(name).trim(), category || null, resolvedUnit, null, '[]', JSON.stringify(attrs), skuTrim || null);
    item = { id };
  }
  // 拍照入库：无论新建还是复用 SKU，只要传了照片就更新封面并把照片追加进 photo_urls（最多保留 6 张）
  if (photo) {
    const cur = db.prepare('SELECT photo_urls FROM item WHERE id=?').get(item.id);
    let arr = [];
    try { arr = JSON.parse(cur.photo_urls || '[]'); } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.push(photo);
    if (arr.length > 6) arr = arr.slice(-6);
    db.prepare('UPDATE item SET cover_url=?, photo_urls=? WHERE id=?').run(photo, JSON.stringify(arr), item.id);
  }
  const existing = db.prepare('SELECT id, qty FROM inventory WHERE node_id=? AND item_id=?').get(node.id, item.id);
  let newQty;
  if (existing) {
    newQty = (Number(existing.qty) || 0) + itemQty;
    db.prepare("UPDATE inventory SET qty=?, last_seen_at=datetime('now') WHERE id=?").run(newQty, existing.id);
  } else {
    newQty = itemQty;
    db.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)')
      .run(randomUUID(), TENANT, node.id, item.id, newQty);
  }
  logMovement({ item_id: item.id, to_node_id: node.id, qty: itemQty, move_type: 'inbound' });
  emit('inventory.changed', { item_id: item.id, node_id: node.id, qty: newQty, erp_code: erpOf(item.id) });
  const skuNow = db.prepare('SELECT sku FROM item WHERE id=?').get(item.id).sku || '';
  return { item_id: item.id, loc_code, name: String(name).trim(), sku: skuNow, unit:resolvedUnit, qty: newQty, added: itemQty };
}

// 出库：扣减某格位某物品的库存，记 outbound 流水（from=格位, to=NULL 表示出库/外部）；不足额报错
function outboundImpl({ loc_code, item_id, qty } = {}) {
  if (!loc_code || !item_id) throw new Error('loc_code 与 item_id 必填');
  const realLoc = resolveCellCode(loc_code); // 被合并吞掉的列 → 主格位
  const node = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(realLoc);
  if (!node) throw new Error('位置不存在: ' + loc_code);
  const inv = db.prepare('SELECT id, qty FROM inventory WHERE node_id=? AND item_id=?').get(node.id, item_id);
  if (!inv) throw new Error('该格位没有此物品');
  const have = Number(inv.qty) || 0;
  const take = Number(qty);
  if (!Number.isFinite(take) || take <= 0) throw new Error('出库数量必须是大于 0 的有效数字');
  if (take > have) throw new Error(`库存不足：现有 ${have}，请求 ${take}`);
  const newQty = have - take;
  db.prepare('UPDATE inventory SET qty=? WHERE id=?').run(newQty, inv.id);
  logMovement({ item_id, from_node_id: node.id, qty: take, move_type: 'outbound' });
  emit('inventory.changed', { item_id, node_id: node.id, qty: newQty, erp_code: erpOf(item_id) });
  return { item_id, loc_code, taken: take, remain: newQty };
}

// 移库：把某格位某物品的 N 件移动到另一格位。原子操作（事务），并记一条 move 流水（from→to）
function moveItemImpl({ item_id, qty, from_loc, to_loc } = {}) {
  if (!item_id || !from_loc || !to_loc) throw new Error('item_id / from_loc / to_loc 必填');
  // 被合并吞掉的列 → 主格位（这样从旧标签 B02 移到 B05 也能正常工作）
  const realFrom = resolveCellCode(from_loc), realTo = resolveCellCode(to_loc);
  if (realFrom === realTo) throw new Error('源位置与目标位置不能相同');
  const take = Number(qty);
  if (!Number.isFinite(take) || take <= 0) throw new Error('移动数量必须是大于 0 的有效数字');
  const from = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(realFrom);
  const to = db.prepare('SELECT id FROM space_node WHERE loc_code=?').get(realTo);
  if (!from) throw new Error('源位置不存在: ' + from_loc);
  if (!to) throw new Error('目标位置不存在: ' + to_loc);
  const inv = db.prepare('SELECT id, qty FROM inventory WHERE node_id=? AND item_id=?').get(from.id, item_id);
  if (!inv) throw new Error('源格位没有该物品');
  const have = Number(inv.qty) || 0;
  if (take > have) throw new Error(`源格位库存不足：现有 ${have}，请求 ${take}`);

  let newFrom, newTo;
  try {
    db.exec('SAVEPOINT counter_move');
    // 1) 源格位扣减（归零则删除行）
    newFrom = have - take;
    if (newFrom <= 0) db.prepare('DELETE FROM inventory WHERE id=?').run(inv.id);
    else db.prepare('UPDATE inventory SET qty=? WHERE id=?').run(newFrom, inv.id);
    // 2) 目标格位增加（复用已有行或新建）
    const destInv = db.prepare('SELECT id, qty FROM inventory WHERE node_id=? AND item_id=?').get(to.id, item_id);
    if (destInv) {
      newTo = (Number(destInv.qty) || 0) + take;
      db.prepare("UPDATE inventory SET qty=?, last_seen_at=datetime('now') WHERE id=?").run(newTo, destInv.id);
    } else {
      newTo = take;
      db.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)')
        .run(randomUUID(), TENANT, to.id, item_id, newTo);
    }
    // 3) 记一条 move 流水（同时带 from / to）
    logMovement({ item_id, from_node_id: from.id, to_node_id: to.id, qty: take, move_type: 'move' });
    db.exec('RELEASE SAVEPOINT counter_move');
  } catch (err) {
    db.exec('ROLLBACK TO SAVEPOINT counter_move; RELEASE SAVEPOINT counter_move');
    throw err;
  }
  emit('inventory.changed', { item_id, node_id: from.id, qty: newFrom, erp_code: erpOf(item_id) });
  emit('inventory.changed', { item_id, node_id: to.id, qty: newTo, erp_code: erpOf(item_id) });
  return { item_id, from_loc, to_loc, moved: take, from_remain: newFrom, to_total: newTo };
}

// ================= 用户 / 会话 / 权限（企业级 P0） =================
// 库存、流水、出站事件、重复请求结果作为同一笔事务提交。
db.exec(`CREATE TABLE IF NOT EXISTS counter_request (
  actor TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL,
  PRIMARY KEY(actor,request_id))`);
function counterOperation(kind,input,run) {
  const {request_id,...body}=input;
  if(request_id!==undefined&&(typeof request_id!=='string'||!request_id.trim()||request_id.length>128))throw Error('无效的业务请求编号');
  const actor=currentActor()?.id || 'local';
  // 递归排序对象键，数组保留顺序；导入的每一行都必须参与摘要。
  const signature=createHash('sha256').update(kind+JSON.stringify(body,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)).digest('hex');
  db.exec('SAVEPOINT counter_operation');
  try {
    if(request_id){
      const previous=db.prepare('SELECT signature,result FROM counter_request WHERE actor=? AND request_id=?').get(actor,request_id);
      if(previous){
        if(previous.signature!==signature)throw Error('业务请求编号已使用，请勿修改重试内容');
        db.exec('RELEASE SAVEPOINT counter_operation');return {...JSON.parse(previous.result),replayed:true};
      }
    }
    const business={...currentActor()?.business,...businessDetails(body)};
    const result=Object.keys(business).length?actorStore.run({...currentActor(),business},()=>run(body)):run(body);
    if(request_id)db.prepare('INSERT INTO counter_request VALUES(?,?,?,?)').run(actor,request_id,signature,JSON.stringify(result));
    db.exec('RELEASE SAVEPOINT counter_operation');return result;
  } catch(error){db.exec('ROLLBACK TO SAVEPOINT counter_operation; RELEASE SAVEPOINT counter_operation');throw error;}
}
export const inbound=(input={})=>counterOperation('inbound',input,inboundImpl);
export const outbound=(input={})=>counterOperation('outbound',input,outboundImpl);
export const moveItem=(input={})=>counterOperation('move',input,moveItemImpl);

// 角色：admin 全权（含用户管理与备份）；operator 出入库与布局；viewer 只读
export const ROLES = ['admin', 'operator', 'viewer'];
const VALID_ROLES = new Set(ROLES);

export function countUsers() {
  return db.prepare("SELECT COUNT(*) c FROM user WHERE tenant_id=?").get(TENANT).c;
}
export function listUsers() {
  return db.prepare(`SELECT id, username, name, role, status, created_at, last_login_at
                     FROM user WHERE tenant_id=? ORDER BY created_at`).all(TENANT)
    .map((u) => ({ ...u, pw_hash: undefined }));
}
export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM user WHERE tenant_id=? AND username=?').get(TENANT, String(username || '').trim());
}
export function getUserById(id) {
  return db.prepare('SELECT id, username, name, role, status FROM user WHERE id=?').get(id);
}
export function createUser({ username, pw_hash, pw_salt, name, role = 'operator' }) {
  const u = String(username || '').trim();
  if (!u) throw new Error('用户名不能为空');
  if (getUserByUsername(u)) throw new Error('用户名已存在: ' + u);
  if (!VALID_ROLES.has(role)) throw new Error('角色不合法: ' + role);
  const id = randomUUID();
  db.prepare(`INSERT INTO user(id,tenant_id,username,pw_hash,pw_salt,name,role)
              VALUES(?,?,?,?,?,?,?)`).run(id, TENANT, u, pw_hash, pw_salt, String(name || u), role);
  return { id, username: u, name: String(name || u), role };
}
export function updateUser(id, patch = {}) {
  const u = db.prepare('SELECT * FROM user WHERE id=?').get(id);
  if (!u) throw new Error('用户不存在: ' + id);
  const sets = [], params = [];
  if (patch.name != null) { sets.push('name=?'); params.push(String(patch.name)); }
  if (patch.role != null) {
    if (!VALID_ROLES.has(patch.role)) throw new Error('角色不合法: ' + patch.role);
    sets.push('role=?'); params.push(patch.role);
  }
  if (patch.status != null) { sets.push('status=?'); params.push(String(patch.status)); }
  if (patch.pw_hash != null && patch.pw_salt != null) {
    sets.push('pw_hash=?'); sets.push('pw_salt=?'); params.push(patch.pw_hash, patch.pw_salt);
  }
  if (!sets.length) return getUserById(id);
  params.push(id);
  db.prepare(`UPDATE user SET ${sets.join(',')} WHERE id=?`).run(...params);
  return getUserById(id);
}
export function touchLogin(id) {
  db.prepare("UPDATE user SET last_login_at=datetime('now') WHERE id=?").run(id);
}
/** 创建会话，返回 token 与过期时间（默认 12 小时） */
export function createSession(userId, hours = 12) {
  const token = randomUUID() + randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO session(token,user_id,expires_at) VALUES(?,?,?)').run(token, userId, expires);
  return { token, expires_at: expires };
}
export function getSessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM session WHERE token=?').get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM session WHERE token=?').run(token); // 过期即清理
    return null;
  }
  const u = getUserById(s.user_id);
  if (!u || u.status !== 'active') return null;
  return u;
}
export function deleteSession(token) {
  db.prepare('DELETE FROM session WHERE token=?').run(token);
}
export function purgeExpiredSessions() {
  const r = db.prepare("DELETE FROM session WHERE expires_at < datetime('now')").run();
  return r.changes || 0;
}

// ---------- 服务凭证（机器令牌，供 ERP / 设备网关等无人工会话的调用方使用） ----------
// 令牌明文仅在创建时返回一次；库内只存 sha256 哈希。scopes 控制可调用的接口范围。
export function createServiceToken({ name, scopes = [], createdBy = null } = {}) {
  if (!name || !String(name).trim()) throw new Error('凭证名称必填');
  const raw = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const token_hash = createHash('sha256').update(raw).digest('hex');
  const id = randomUUID();
  const sc = JSON.stringify(Array.isArray(scopes) ? scopes : []);
  db.prepare(`INSERT INTO service_token(id,tenant_id,name,token_hash,scopes,created_by,created_at)
              VALUES(?,?,?,?,?,?,datetime('now'))`).run(id, TENANT, String(name).trim(), token_hash, sc, createdBy || null);
  return { id, name: String(name).trim(), token: raw, scopes: JSON.parse(sc) };
}
export function listServiceTokens() {
  return db.prepare(`SELECT id, name, substr(token_hash,1,8) AS token_prefix, scopes, created_at, revoked_at, last_used_at
                     FROM service_token WHERE tenant_id=? ORDER BY created_at DESC`).all(TENANT)
    .map((t) => ({ ...t, scopes: JSON.parse(t.scopes || '[]'), revoked: !!t.revoked_at }));
}
export function revokeServiceToken(id) {
  db.prepare("UPDATE service_token SET revoked_at=datetime('now') WHERE id=? AND tenant_id=? AND revoked_at IS NULL")
    .run(id, TENANT);
  return { id, revoked: true };
}
export function getServiceTokenByRaw(raw) {
  if (!raw) return null;
  const token_hash = createHash('sha256').update(raw).digest('hex');
  const t = db.prepare('SELECT * FROM service_token WHERE token_hash=? AND revoked_at IS NULL').get(token_hash);
  if (!t) return null;
  db.prepare("UPDATE service_token SET last_used_at=datetime('now') WHERE id=?").run(t.id);
  return { id: t.id, name: t.name, scopes: JSON.parse(t.scopes || '[]') };
}

/** 审计视图：按操作人/类型筛选流水（倒序分页，供审计与导出） */
export function listAuditMovements({ limit = 200, offset = 0, actor = null, move_type = null } = {}) {
  const where = [], params = [];
  if (actor) { where.push('m.actor_name LIKE ?'); params.push('%' + actor + '%'); }
  if (move_type) { where.push('m.move_type=?'); params.push(move_type); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.prepare(`SELECT m.id, m.item_id, json_extract(m.history_json,'$.item_name') AS item_name, m.from_node_id, m.to_node_id,
                            m.qty, m.move_type, m.occurred_at, m.synced_at,
                            m.actor_id, m.actor_name,
                            json_extract(m.history_json,'$.from_loc') AS from_loc,
                            json_extract(m.history_json,'$.to_loc') AS to_loc
                     FROM movement m
                     ${w} ORDER BY m.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Math.min(Number(limit) || 200, 2000), Math.max(0, Number(offset) || 0));
}

// ---- 兼容别名 ----
// 仓储化改名（家具→货架）后保留旧函数名，避免破坏既有集成（ERP / supOS / 自研脚本）。
// 新代码请用 createRack / updateRack / deleteRack / setRackMerges。
export const createFurniture = createRack;
export const updateFurniture = updateRack;
export const deleteFurniture = deleteRack;
export const setFurnitureMerges = setRackMerges;


// 空间写入统一事务和审计，嵌套调用只记录最外层操作。
const spaceAudit = createSpaceAudit(db);
export function createSite(...args) { return spaceAudit.run("createSite", () => createSiteImpl(...args)); }
export function createRoomNode(...args) { return spaceAudit.run("createRoomNode", () => createRoomNodeImpl(...args)); }
export function setRoom(...args) { return spaceAudit.run("setRoom", () => setRoomImpl(...args)); }
export function updateRack(...args) { return spaceAudit.run("updateRack", () => updateRackImpl(...args)); }
export function setRackMerges(...args) { return spaceAudit.run("setRackMerges", () => setRackMergesImpl(...args)); }
// 合并方案与名称属于同一次用户提交，任一失败时连同事件和审计回滚。
export function setRackCells(code, {merges, names, capacities, capacityRevision}) {
  return spaceAudit.run('setRackCells', () => {
    checkRackCapacityRevision(code,capacities,capacityRevision);
    const result = setRackMergesImpl(code, merges);
    setCellNamesImpl(code, names);
    applyRackCapacities(code,capacities);
    return {...result, names};
  });
}
export function setCellNames(...args) { return spaceAudit.run("setCellNames", () => setCellNamesImpl(...args)); }
export function saveLayout(...args) { return spaceAudit.run("saveLayout", () => saveLayoutImpl(...args)); }
export function createRack(...args) { return spaceAudit.run("createRack", () => createRackImpl(...args)); }
export function quickBuildRacks(input,plan) {
  return counterOperation('quickBuild',input,body=>spaceAudit.run('quickBuild',()=>{
    const layout=getLayout(body.roomCode);
    if(body.revision!==layout.revision)throw Error('库区布局已变化，请重新预览');
    const preview=plan(layout,body);
    if(preview.problems.length)throw Error(preview.problems[0]);
    const created=preview.furniture.map((f,i)=>createRackImpl({
      roomCode:layout.roomCode,name:`${body.name?.trim()||preview.spec.name}-${i+1}`,type:f.type,
      rows:f.rows,cols:f.cols,geom:{w:f.w,h:f.h,d:f.d,x:f.x,z:f.z,rot:0},
    }).furn_code);
    return {created,cellCount:preview.cellCount,roomCode:layout.roomCode};
  }));
}
export function deleteRack(...args) { return spaceAudit.run("deleteRack", () => deleteRackImpl(...args)); }
export function deleteRoom(...args) { return spaceAudit.run("deleteRoom", () => deleteRoomImpl(...args)); }
export const pageSpaceOperations = options => spaceAudit.page(options);
export const listSpaceOperations = () => spaceAudit.list();
export const getSpaceOperation = id => spaceAudit.detail(id);

export default db;

export function setCellMeta(...args) { return spaceAudit.run("setCellMeta", () => setCellMetaImpl(...args)); }
export function setCellsMeta(...args) { return spaceAudit.run("setCellsMeta", () => setCellsMetaImpl(...args)); }

// 复制规格、合并和名称作为一次事务；任一步失败，不留下半成品，也不改源货架位置。
export function cloneRack(code, {positions, source} = {}) {
  return spaceAudit.run('cloneRack', () => {
    const original = db.prepare("SELECT * FROM space_node WHERE node_type='rack' AND loc_code=?").get(code);
    if (!original) throw new Error('源货架不存在');
    if (!Array.isArray(positions) || positions.length < 1 || positions.length > 20) throw new Error('复制数量须为1至20');
    const layout = getLayout(original.parent_id);
    const g=source?.geom || {};
    for(const key of ['w','h','d']) if(!Number.isFinite(g[key]) || g[key]<=0)throw new Error('非法货架尺寸');
    if(!Number.isFinite(g.rot || 0))throw new Error('非法旋转角度');
    for(const key of ['rows','cols']) if(!Number.isInteger(source[key]) || source[key]<1 || source[key]>100)throw new Error('非法层列数');
    const created=[], cloneData=[];
    for(const p of positions) {
      if(!Number.isFinite(p.x) || !Number.isFinite(p.z))throw new Error('非法货架位置');
      const f={...g,...p,type:source.type};
      const problem=placementError(f,layout.room,layout.furniture);
      if(problem)throw new Error(problem);
      const result=createRack({...source,roomCode:original.parent_id,geom:{...g,...p}});
      const newCode=result.furn_code;
      if(source.merges && Object.keys(source.merges).length)setRackMerges(newCode,source.merges);
      if(source.cellNames)setCellNames(newCode,source.cellNames);
      layout.furniture.push({...f,code:newCode});created.push(newCode);
      cloneData.push({code:newCode,label:source.name || '',position:[p.x,0,p.z],rotationY:g.rot || 0,
        width:g.w,height:g.h,depth:g.d,type:source.type,open:source.open,rows:source.rows,cols:source.cols,
        merges:source.merges || {},cellNames:source.cellNames || {}});
    }
    return {created,cloneData};
  });
}
