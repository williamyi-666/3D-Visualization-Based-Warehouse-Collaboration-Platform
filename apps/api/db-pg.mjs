// apps/api/db-pg.mjs
// 生产用 PostgreSQL 数据层（与 db.mjs 同接口，DB_DRIVER=pg 时启用）。
// 启用前提：1) 本地/远端跑着 PostgreSQL 16；2) 已执行 db/schema.sql；3) `npm i pg`；4) 设置环境变量 PGURL。
//
// 与 schema.sql 的对应：
//   - geom / template / attributes 为 JSONB，SELECT 时 CAST ...::text 以保持与 SQLite 版一致（JS 里 JSON.parse）。
//   - 高级检索（ltree 子树、pg_bigm 中文分词、pgvector 图像/语义向量）在 search() 中留了注释扩展点。
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

export const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-000000000001';
const pool = new Pool({ connectionString: process.env.PGURL || 'postgresql://postgres@localhost:5432/spatial' });

async function q(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}
async function run(sql, params = []) {
  await pool.query(sql, params);
}

// ---------- 查询接口 ----------
export async function getScene() {
  const room = (await q("SELECT * FROM space_node WHERE node_type='room' LIMIT 1"))[0];
  const rg = JSON.parse(room?.geom || '{}');
  const fr = await q("SELECT * FROM space_node WHERE node_type='furniture'");
  const furniture = [];
  for (const f of fr) {
    const fg = JSON.parse(f.geom || '{}');
    const tp = JSON.parse(f.template || '{}');
    const cells = await q("SELECT * FROM space_node WHERE parent_id=$1 AND node_type='cell'", [f.id]);
    const items = {};
    for (const cell of cells) {
      const suffix = cell.loc_code.split('-').slice(-2).join('-');
      const inv = await q(`SELECT i.id AS item_id, i.name, i.cover_url, inv.qty, i.attributes::text AS attributes
                           FROM inventory inv JOIN item i ON i.id=inv.item_id
                           WHERE inv.node_id=$1 AND inv.qty>0`, [cell.id]);
      items[suffix] = inv.map((r) => ({
        id: r.item_id, name: r.name, qty: Number(r.qty),
        note: (JSON.parse(r.attributes || '{}').note) || '', cover: r.cover_url || '',
      }));
    }
    furniture.push({
      code: f.loc_code, label: f.name,
      position: [fg.x ?? 0, fg.y ?? 0, fg.z ?? 0],
      width: fg.w, height: fg.h, depth: fg.d,
      rows: tp.rows, cols: tp.cols, capacityPerCell: 6, items,
    });
  }
  return { room: { width: rg.w, depth: rg.d, height: rg.h }, furniture };
}

export async function getCells() {
  return q("SELECT loc_code, name, node_type FROM space_node WHERE node_type='cell' ORDER BY loc_code");
}

export async function getLocationTree() {
  const nodes = await q("SELECT id, parent_id, loc_code, node_type, name FROM space_node ORDER BY loc_code");
  const byId = {};
  for (const n of nodes) byId[n.id] = { ...n, children: [] };
  const roots = [];
  for (const n of nodes) {
    if (n.parent_id && byId[n.parent_id]) byId[n.parent_id].children.push(byId[n.id]);
    else roots.push(byId[n.id]);
  }
  return roots;
}

export async function createItem({ name, category, qty, loc_code, photo, note }) {
  if (!name || !loc_code) throw new Error('name 与 loc_code 必填');
  const node = (await q('SELECT id FROM space_node WHERE loc_code=$1', [loc_code]))[0];
  if (!node) throw new Error('位置不存在: ' + loc_code);
  const id = randomUUID();
  await run('INSERT INTO item(id,tenant_id,name,category,unit,cover_url,photo_urls,attributes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, TENANT, name, category || null, '件', photo || null, JSON.stringify(photo ? [photo] : []), JSON.stringify(note ? { note } : {})]);
  await run('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES($1,$2,$3,$4,$5)',
    [randomUUID(), TENANT, node.id, id, qty || 1]);
  await run('INSERT INTO movement(tenant_id,item_id,to_node_id,qty,move_type,idem_key) VALUES($1,$2,$3,$4,$5,$6)',
    [TENANT, id, node.id, qty || 1, 'inbound', randomUUID()]);
  await emit('item.created', { item_id: id, name, qty: qty || 1, loc_code });
  await emit('inventory.changed', { item_id: id, node_id: node.id, qty: qty || 1 });
  return { id, loc_code, name };
}

const FURN_PREFIX = { wardrobe: 'WD', shelf: 'SH', box: 'BX', cabinet: 'CB', rack: 'RK' };
// 兼容别名：仓储化改名（家具→货架）后保留旧函数名
export const createFurniture = createRack;
export async function createRack({ name, type = 'shelf', rows = 3, cols = 4, geom }) {
  const room = (await q("SELECT id, loc_code FROM space_node WHERE node_type='room' LIMIT 1"))[0];
  if (!room) throw new Error('请先创建房间');
  const prefix = FURN_PREFIX[type] || 'BX';
  const cnt = (await q(`SELECT COUNT(*) c FROM space_node WHERE loc_code LIKE $1`, [`%-${prefix}%`]))[0].c;
  const furnCode = `${room.loc_code}-${prefix}${String(cnt + 1).padStart(2, '0')}`;
  const furnId = randomUUID();
  const g = geom || { w: 1.2, h: 1.8, d: 0.4, x: 0, y: 0, z: -0.8 };
  await run(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom,template)
              VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
    [furnId, TENANT, room.id, furnCode, 'furniture', name || furnCode, JSON.stringify(g), JSON.stringify({ rows, cols })]);
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const lr = 'L' + String(r).padStart(2, '0');
      const bc = 'B' + String(c).padStart(2, '0');
      await run(`INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,geom)
                  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [randomUUID(), TENANT, furnId, `${furnCode}-${lr}-${bc}`, 'cell', `格位${lr}-${bc}`, '{}']);
    }
  }
  await emit('furniture.created', { furn_code: furnCode, name: name || furnCode, rows, cols });
  return { furn_code: furnCode, rows, cols };
}

export async function addAlias(word, target) {
  await run('INSERT INTO alias(word,target) VALUES($1,$2) ON CONFLICT(word) DO UPDATE SET target=$2', [word, target]);
  return { word, target };
}

// 检索：扩展点 —— 生产可改为 pg_bigm 全文 / pgvector 向量；此处保留 ILIKE + 别名词表
export async function search(q) {
  const term = (q || '').trim();
  let rows = await directSearch(term);
  if (!rows.length) {
    const a = (await q('SELECT target FROM alias WHERE word=$1', [term]))[0];
    if (a) rows = await directSearch(a.target);
  }
  return rows;
}
async function directSearch(term) {
  return q(`SELECT i.name AS name, inv.qty AS qty, n.loc_code AS loc_code, i.cover_url AS cover
            FROM inventory inv JOIN item i ON i.id=inv.item_id JOIN space_node n ON n.id=inv.node_id
            WHERE inv.qty>0 AND i.name ILIKE $1 ORDER BY i.name LIMIT 50`, [`%${term}%`]);
}

export async function updateItem(id, { name, category, qty, loc_code, note, photo }) {
  const it = (await q('SELECT id FROM item WHERE id=$1', [id]))[0];
  if (!it) throw new Error('物品不存在: ' + id);
  const sets = [], params = [id];
  if (name !== undefined) { sets.push('name=$' + (params.push(name))); }
  if (category !== undefined) { sets.push('category=$' + (params.push(category || null))); }
  if (note !== undefined) { sets.push('attributes=$' + (params.push(JSON.stringify(note ? { note } : {})))); }
  if (photo !== undefined) {
    sets.push('cover_url=$' + (params.push(photo || null)));
    sets.push('photo_urls=$' + (params.push(JSON.stringify(photo ? [photo] : []))));
  }
  if (sets.length) await run(`UPDATE item SET ${sets.join(',')} WHERE id=$1`, params);

  if (loc_code !== undefined && loc_code) {
    const node = (await q('SELECT id FROM space_node WHERE loc_code=$1', [loc_code]))[0];
    if (node) {
      const inv = (await q('SELECT id FROM inventory WHERE item_id=$1 LIMIT 1', [id]))[0];
      if (inv) { await run('UPDATE inventory SET node_id=$1 WHERE id=$2', [node.id, inv.id]); await emit('inventory.changed', { item_id: id, node_id: node.id }); }
    }
  }
  if (qty !== undefined) {
    const inv = (await q('SELECT id FROM inventory WHERE item_id=$1 LIMIT 1', [id]))[0];
    if (inv) { await run('UPDATE inventory SET qty=$1 WHERE id=$2', [Number(qty) || 0, inv.id]); await emit('inventory.changed', { item_id: id, qty: Number(qty) || 0 }); }
  }
  await emit('item.updated', { item_id: id });
  return { id };
}

export async function deleteItem(id) {
  await run('DELETE FROM movement WHERE item_id=$1', [id]);
  await run('DELETE FROM inventory WHERE item_id=$1', [id]);
  await run('DELETE FROM item WHERE id=$1', [id]);
  await emit('item.deleted', { item_id: id });
  return { id };
}

export async function importItems(rows) {
  let imported = 0, skipped = 0;
  for (const row of rows || []) {
    const name = (row.name || '').trim();
    const loc = (row.loc_code || '').trim();
    if (!name || !loc) { skipped++; continue; }
    const node = (await q('SELECT id FROM space_node WHERE loc_code=$1', [loc]))[0];
    if (!node) { skipped++; continue; }
    const id = randomUUID();
    const qty = Number(row.qty) || 1;
    await run('INSERT INTO item(id,tenant_id,name,category,unit,cover_url,photo_urls,attributes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, TENANT, name, row.category || null, '件', row.photo || null, JSON.stringify(row.photo ? [row.photo] : []), JSON.stringify(row.note ? { note: row.note } : {})]);
    await run('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), TENANT, node.id, id, qty]);
    await run('INSERT INTO movement(tenant_id,item_id,to_node_id,qty,move_type,idem_key) VALUES($1,$2,$3,$4,$5,$6)',
      [TENANT, id, node.id, qty, 'inbound', randomUUID()]);
    await emit('item.created', { item_id: id, name, qty, loc_code: loc });
    imported++;
  }
  if (imported) await emit('inventory.changed', { bulk: imported });
  return { imported, skipped };
}

export async function listInventory() {
  return q(`SELECT i.id AS item_id, i.name, inv.qty, n.loc_code, n.name AS loc_name
            FROM inventory inv JOIN item i ON i.id=inv.item_id JOIN space_node n ON n.id=inv.node_id
            WHERE inv.qty>0 ORDER BY n.loc_code, i.name`);
}
export async function listMovements(limit = 50) {
  return q('SELECT * FROM movement ORDER BY occurred_at DESC LIMIT $1', [limit]);
}

// ---------- 事件发件箱 ----------
export async function emit(eventType, payload) {
  await run('INSERT INTO outbox_event(id,tenant_id,event_type,payload_json) VALUES($1,$2,$3,$4)',
    [randomUUID(), TENANT, eventType, JSON.stringify(payload ?? {})]);
}
export async function getPendingOutbox() {
  return q("SELECT * FROM outbox_event WHERE status='pending' ORDER BY created_at");
}
export async function markOutboxSent(id) {
  await run("UPDATE outbox_event SET status='sent' WHERE id=$1", [id]);
}
export async function markOutboxDead(id, err) {
  await run("UPDATE outbox_event SET status='dead', attempts=attempts+1, last_error=$1 WHERE id=$2",
    [String((err && err.message) || err || '').slice(0, 500), id]);
}

export default pool;
export async function markOutboxRetry(id, err) {
  await run("UPDATE outbox_event SET attempts=attempts+1,last_error=$1 WHERE id=$2", [String(err.message || err).slice(0,500), id]);
}
