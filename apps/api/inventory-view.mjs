import {createSkuPlacement} from './sku-placement.mjs';
import {createBusinessEvents} from './business-events.mjs';
import {createInventoryPager} from './inventory-page.mjs';
import {createSourceStatus} from './source-status.mjs';
import { createSyncHistory } from './sync-history.mjs';
import { createHash } from 'node:crypto';
import {normalizeStorageProfile} from './item-storage.mjs';
// ERP/WMS 快照独立存放，不调用本地出入库逻辑，也不产生反向库存事件。
export function createInventoryView(sql, { getUsableCells } = {}) {
  sql.exec(`CREATE TABLE IF NOT EXISTS external_inventory_snapshot (
    source TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS external_location_mapping (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_loc_code TEXT NOT NULL,
    loc_code TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source,external_loc_code)
  )`);
  const rawRows=()=>sql.prepare('SELECT payload,version,received_at FROM external_inventory_snapshot').all().flatMap(x=>JSON.parse(x.payload).map(row=>({...row,snapshot_version:x.version,received_at:x.received_at})));
  const skuPlacement=createSkuPlacement(sql,{getUsableCells,rawRows});
  const businessEvents=createBusinessEvents(sql);
  const validCell = (code, usable) => (!usable || usable.has(code)) && sql.prepare("SELECT id FROM space_node WHERE loc_code=? AND node_type='cell'").get(code);
  const mappings = () => sql.prepare('SELECT * FROM external_location_mapping ORDER BY source,external_loc_code').all();
  const inUse = m => list().some(r => r.source === m.source && r.external_loc_code === m.external_loc_code);
  function saveMapping({ source, external_loc_code, loc_code }) {
    for (const value of [source,external_loc_code,loc_code]) if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 120) throw new Error('来源和库位编码必填、首尾无空格且不超过120字');
    if (!validCell(loc_code,getUsableCells?.())) throw new Error('未知或不可用的三维格位: ' + loc_code);
    const prior = sql.prepare('SELECT * FROM external_location_mapping WHERE source=? AND external_loc_code=?').get(source,external_loc_code);
    if (prior && prior.loc_code !== loc_code && inUse(prior)) throw new Error('当前快照仍引用此映射，请先由来源系统同步移出库存，再修改映射');
    sql.prepare('INSERT INTO external_location_mapping(source,external_loc_code,loc_code,updated_at) VALUES(?,?,?,?) ON CONFLICT(source,external_loc_code) DO UPDATE SET loc_code=excluded.loc_code,updated_at=excluded.updated_at')
      .run(source,external_loc_code,loc_code,new Date().toISOString());
    return { source,external_loc_code,loc_code };
  }
  function deleteMapping(id) {
    const prior = sql.prepare('SELECT * FROM external_location_mapping WHERE id=?').get(id);
    if (!prior) throw new Error('映射不存在');
    if (inUse(prior)) throw new Error('当前快照仍引用此映射，不能删除');
    sql.prepare('DELETE FROM external_location_mapping WHERE id=?').run(id);
    return { deleted:true };
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS external_inventory_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, version TEXT, actor TEXT,
    result TEXT NOT NULL, row_count INTEGER NOT NULL, message TEXT, created_at TEXT NOT NULL
  )`);
  for (const [name,type] of [['request_json','TEXT'],['kind',"TEXT DEFAULT 'snapshot'"],['retry_of','INTEGER'],['result_json','TEXT']]) {
    if (!sql.prepare('PRAGMA table_info(external_inventory_sync_log)').all().some(c=>c.name===name)) sql.exec(`ALTER TABLE external_inventory_sync_log ADD COLUMN ${name} ${type}`);
  }
  sql.exec('CREATE TABLE IF NOT EXISTS external_inventory_message (source TEXT NOT NULL,message_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(source,message_id))');
  const byId=(a,b)=>a.id.localeCompare(b.id);
  function canonical(value) {
    if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
    if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
    return JSON.stringify(value);
  }
  const conflict=message=>{const e=new Error(message);e.status=409;throw e;};
  const inputRow=row=>{const copy={...row};if(copy.external_loc_code!=null || copy.placement==='sku') delete copy.loc_code;return copy;};
  function delta(request) {
    const {source,version,base_version,message_id,changes}=request;
    if (typeof source!=='string' || !source.trim() || typeof message_id!=='string' || !message_id.trim() || message_id.length>200 || !Array.isArray(changes)) throw new Error('增量需要source、message_id和changes数组');
    if (!Number.isSafeInteger(base_version) || base_version<1 || version!==base_version+1) throw new Error('增量version必须等于base_version加1');
    const fingerprint=createHash('sha256').update(canonical(request)).digest('hex');
    const priorMessage=sql.prepare('SELECT * FROM external_inventory_message WHERE source=? AND message_id=?').get(source,message_id);
    if (priorMessage) {
      if (priorMessage.fingerprint!==fingerprint) conflict('同一message_id内容冲突');
      return {...JSON.parse(priorMessage.result_json),applied:false,replayed:true,reason:'消息已处理，未重复写入'};
    }
    const current=read(source);
    if (!current || current.version!==base_version) conflict('基线版本不匹配，当前版本：'+(current?.version || 0));
    const rows=new Map(JSON.parse(current.payload).map(r=>[r.id,inputRow(r)]));
    const touched=new Set();
    for(const change of changes) {
      if (!['upsert','delete'].includes(change?.op)) throw new Error('增量op必须为upsert或delete');
      const raw={...change};delete raw.op;
      const row=normalize(source,[change.op==='delete'?{...raw,name:'删除标识',qty:0}:raw])[0];
      if (touched.has(row.id)) throw new Error('增量中同一库存行出现多次');touched.add(row.id);
      if(change.op==='delete') rows.delete(row.id);else rows.set(row.id,raw);
    }
    const result=apply({source,version,rows:[...rows.values()]});
    sql.prepare('INSERT INTO external_inventory_message VALUES(?,?,?,?)').run(source,message_id,fingerprint,JSON.stringify(result));
    return result;
  }
  function reconcile({source,version,rows}) {
    if(typeof source!=='string' || !source.trim() || !Number.isSafeInteger(version) || !Array.isArray(rows)) throw new Error('对账需要source、version、rows');
    const current=read(source);
    if(!current || current.version!==version) conflict('对账版本不匹配，当前版本：'+(current?.version || 0));
    const expected=new Map(normalize(source,rows).map(r=>[r.id,r]));
    const actual=new Map(JSON.parse(current.payload).map(r=>[r.id,r]));
    const differences=[];
    for(const id of new Set([...expected.keys(),...actual.keys()])) {
      const e=expected.get(id),a=actual.get(id);
      if(canonical(e)!==canonical(a)) differences.push({kind:!a?'missing':!e?'unexpected':'changed',expected:e || null,actual:a || null});
    }
    return {reconciled:true,matched:!differences.length,version,expected_count:expected.size,actual_count:actual.size,difference_count:differences.length,differences:differences.slice(0,100),truncated:differences.length>100};
  }
  const read = source => sql.prepare('SELECT * FROM external_inventory_snapshot WHERE source=?').get(source);
  function normalize(source, rows) {
    const keys = new Set();
    const usable = getUsableCells?.();
    return rows.map(row => {
      for (const field of ['sku', 'name']) if (typeof row[field] !== 'string' || !row[field].trim()) throw new Error(field + ' 必填');
      if (!Number.isFinite(row.qty) || row.qty < 0) throw new Error('qty 必须为非负数');
      // 每库存单位重量；未提供时保留未知，不能按零重量计算。
      if (row.unit_weight_kg != null && (!Number.isFinite(row.unit_weight_kg) || row.unit_weight_kg < 0 || !Number.isFinite(row.unit_weight_kg * row.qty))) throw new Error('unit_weight_kg 必须为非负数，且总重量不能溢出');
      const skuOnly=row.placement==='sku';
      if(skuOnly && (row.loc_code!=null || row.external_loc_code!=null))throw new Error('SKU 归位行只需 warehouse_code，不要同时提供库位');
      if(skuOnly && (!row.warehouse_code || skuPlacement.siteFor(row.warehouse_code)!==row.warehouse_code))throw new Error('SKU 归位需要本应用仓库编码 warehouse_code');
      let loc = skuOnly ? null : row.loc_code;
      if (row.external_loc_code != null) {
        if (row.loc_code != null) throw new Error('external_loc_code 与 loc_code 只能提供一个');
        if (typeof row.external_loc_code !== 'string' || !row.external_loc_code.trim()) throw new Error('外部库位编码不能为空');
        loc = sql.prepare('SELECT loc_code FROM external_location_mapping WHERE source=? AND external_loc_code=?').get(source,row.external_loc_code)?.loc_code;
        if (!loc) throw new Error('未配置库位映射: ' + row.external_loc_code);
      }
      if (!skuOnly && (typeof loc !== 'string' || !validCell(loc,usable))) throw new Error('未知库位或格位已合并: ' + loc);
      const key = JSON.stringify(skuOnly ? ['sku',row.sku,row.warehouse_code,row.batch_no || '',row.status || '可用'] : [row.sku, loc, row.batch_no || '', row.status || '可用']);
      if (keys.has(key)) throw new Error('快照存在重复库存行');
      keys.add(key);
      return { id: `${source}:${key}`, item_id: `${source}:${row.sku}`, sku: row.sku, erp_code: row.sku,
        name: row.name, loc_code: loc, ...(skuOnly?{placement:'sku',warehouse_code:row.warehouse_code}:{}), qty: row.qty, unit: String(row.unit || '件'),
        batch_no: String(row.batch_no || ''), status: String(row.status || '可用'), source, category: String(row.category || ''), cover: '', note: '',
        ...(row.unit_weight_kg != null ? { unit_weight_kg:row.unit_weight_kg } : {}),
        ...(row.storage_profile != null ? {storage_profile:normalizeStorageProfile(row.storage_profile)} : {}),
        ...(row.external_loc_code != null ? { external_loc_code:row.external_loc_code } : {}) };
    });
  }
  function apply({ source, version, rows }) {
    if (typeof source !== 'string' || !source.trim() || !Number.isSafeInteger(version) || version < 1 || !Array.isArray(rows)) throw new Error('source、正整数 version、rows 必填');
    const clean = normalize(source, rows);
    skuPlacement.project(clean);
    sql.exec('SAVEPOINT apply_inventory');
    try {
      const prior = read(source);
      if (prior && version <= prior.version) {
        if (version === prior.version && canonical(clean.slice().sort(byId)) !== canonical(JSON.parse(prior.payload).sort(byId))) throw new Error('同版本快照内容冲突');
        sql.exec('RELEASE SAVEPOINT apply_inventory');
        return { applied: false, version: prior.version, reason: '重复或过期版本' };
      }
      sql.prepare('INSERT INTO external_inventory_snapshot VALUES(?,?,?,?) ON CONFLICT(source) DO UPDATE SET version=excluded.version,payload=excluded.payload,received_at=excluded.received_at')
        .run(source, version, JSON.stringify(clean), new Date().toISOString());
      sql.exec('RELEASE SAVEPOINT apply_inventory');
      return { applied: true, version, count: clean.length };
    } catch (e) { sql.exec('ROLLBACK TO SAVEPOINT apply_inventory; RELEASE SAVEPOINT apply_inventory'); throw e; }
  }
  function list() { return skuPlacement.project(rawRows()); }
  const {status,saveSourcePolicy} = createSourceStatus(sql);
  function receive(request, actor, retryOf = null) {
    let result;
    sql.exec('SAVEPOINT receive_inventory');
    try {
      if (request?.mode && !['snapshot','delta','reconcile','events'].includes(request.mode)) throw new Error('未知同步模式');
      result = request?.mode === 'events' ? businessEvents.receive(request) : request?.mode === 'delta' ? delta(request) : request?.mode === 'reconcile' ? reconcile(request) : apply(request);
      logRequest(request,actor,result.reconciled ? (result.matched?'matched':'different') : result.applied?'applied':'skipped',result.reason || (result.reconciled?'对账差异 '+result.difference_count+' 条':'已应用'),retryOf,false,result.reconciled?result:null);
      sql.exec('RELEASE SAVEPOINT receive_inventory');
      return result;
    } catch(e) {
      sql.exec('ROLLBACK TO SAVEPOINT receive_inventory; RELEASE SAVEPOINT receive_inventory');
      logRequest(request,actor,'failed',e.message,retryOf,true);
      throw e;
    }
  }
  function logRequest(request,actor,result,message,retryOf,keep=false,details=null) {
    sql.prepare('INSERT INTO external_inventory_sync_log(source,version,actor,result,row_count,message,created_at,request_json,kind,retry_of,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(String(request?.source || '').slice(0,120),String(request?.version ?? '').slice(0,32),String(actor || ''),result,
        Array.isArray(request?.events) ? request.events.length : Array.isArray(request?.changes) ? request.changes.length : Array.isArray(request?.rows) ? request.rows.length : 0,String(message).slice(0,500),new Date().toISOString(),keep?JSON.stringify(request ?? null):null,String(request?.mode || 'snapshot').slice(0,32),retryOf,details?JSON.stringify(details):null);
  }
  function retry(id,actor) {
    const row=sql.prepare("SELECT request_json FROM external_inventory_sync_log WHERE id=? AND result='failed'").get(id);
    if (!row?.request_json) throw new Error('该记录没有可补发的请求');
    return receive(JSON.parse(row.request_json),actor,Number(id));
  }
  function historyDetail(id) {
    const row=sql.prepare('SELECT id,source,version,created_at,result,result_json FROM external_inventory_sync_log WHERE id=?').get(id);
    if(!row)return null;
    const {result_json,...meta}=row;return {...meta,details:result_json?JSON.parse(result_json):null};
  }
  function history() { return sql.prepare('SELECT id,source,version,actor,result,row_count,message,created_at,kind,retry_of,request_json IS NOT NULL AS retryable FROM external_inventory_sync_log ORDER BY id DESC LIMIT 100').all(); }
  function scene(base) {
    // 先按库位分组，避免每个格位重复扫描整份库存。
    const byLocation = new Map();
    for (const row of list()) {
      if (row.qty <= 0 || !row.loc_code) continue;
      if (!byLocation.has(row.loc_code)) byLocation.set(row.loc_code,[]);
      byLocation.get(row.loc_code).push({...row,note:`单位：${row.unit} · 批次：${row.batch_no || '无'} · 状态：${row.status}`});
    }
    for (const rack of base.furniture) {
      // 集成模式不能把演示场景默认容量当成真实规格。
      rack.capacityPerCell = null;
      for (const suffix of Object.keys(rack.items)) rack.items[suffix] = byLocation.get(rack.code + '-' + suffix) || [];
    }
    return { ...base, inventorySource: 'external', sync: status() };
  }
  const historyPage = createSyncHistory(sql);
  const inventoryPage = createInventoryPager(sql,list);
  return { skuPlacement, references:()=>[...rawRows(),...skuPlacement.bindings()], businessEvents, apply, receive, inventoryPage, saveSourcePolicy, historyDetail, historyPage, history, list, status, scene, retry, mappings, saveMapping, deleteMapping };
}
