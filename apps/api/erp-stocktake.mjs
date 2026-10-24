import {randomUUID} from 'node:crypto';

// 外部盘点只保存差异单；库存始终由来源快照更新，不写本地inventory表。
export function createErpStocktakes(sql,{inventory,sourceVersion,dispatch}){
  sql.exec(`CREATE TABLE IF NOT EXISTS erp_stocktake(id TEXT PRIMARY KEY,loc_code TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL)`);
  const flights=new Map();
  const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
  const who=actor=>({id:actor.id,name:actor.name||actor.username||actor.id});
  function check(loc,canAccess){if(canAccess&&!canAccess(loc))fail('没有此仓库的盘点权限',403);}
  function role(actor,roles){if(!roles.includes(actor.role)||actor.isService)fail('没有此操作权限',403);}
  function get(id,canAccess){const row=sql.prepare('SELECT payload FROM erp_stocktake WHERE id=?').get(id);if(!row)fail('差异单不存在',404);const record=JSON.parse(row.payload);check(record.loc_code,canAccess);return record;}
  const baseline=(loc,source)=>inventory().filter(r=>r.loc_code===loc&&r.source===source).map(r=>({id:r.id,sku:r.sku,name:r.name,unit:r.unit,qty:r.qty,batch_no:r.batch_no||'',status:r.status,external_loc_code:r.external_loc_code||null,snapshot_version:r.snapshot_version,placement:r.placement||'location'})).sort((a,b)=>a.id.localeCompare(b.id));
  function persist(record,expected,actor,action){
    record.revision=expected+1;record.updated_at=new Date().toISOString();record.history.push({action,state:record.state,at:record.updated_at,actor:who(actor)});
    const result=sql.prepare('UPDATE erp_stocktake SET state=?,revision=?,payload=? WHERE id=? AND revision=?').run(record.state,record.revision,JSON.stringify(record),record.id,expected);
    if(!result.changes)fail('差异单已更新，请重新加载',409);return record;
  }
  function current(id,revision,states,canAccess){const r=get(id,canAccess);if(r.revision!==revision||!states.includes(r.state))fail('差异单状态已变化，请重新加载',409);return r;}
  function unchanged(r){if(JSON.stringify(baseline(r.loc_code,r.source))!==JSON.stringify(r.baseline))fail('ERP库存或映射已变化，请重新盘点',409);}
  function create({loc_code,source},actor,canAccess){
    role(actor,['admin','operator']);check(loc_code,canAccess);
    const rows=baseline(loc_code,source);if(!rows.length)fail('请选择有外部库存的格位和来源');
    if(rows.some(r=>r.placement==='sku'))fail('此库存按SKU分配展示，尚不能按三维格位向ERP调账');
    const existing=sql.prepare("SELECT id FROM erp_stocktake WHERE loc_code=? AND source=? AND state IN ('draft','submitted','approved','sending','uncertain','waiting_sync')").get(loc_code,source);
    if(existing)return get(existing.id,canAccess);
    const now=new Date().toISOString(),r={id:randomUUID(),loc_code,source,state:'draft',revision:1,baseline:rows,counts:[],reason:'',created_at:now,updated_at:now,history:[{action:'create',state:'draft',at:now,actor:who(actor)}]};
    sql.prepare('INSERT INTO erp_stocktake VALUES(?,?,?,?,?,?)').run(r.id,loc_code,source,r.state,r.revision,JSON.stringify(r));return r;
  }
  function save(id,{revision,counts,reason},actor,canAccess){
    role(actor,['admin','operator']);const r=current(id,revision,['draft'],canAccess);
    if(typeof reason!=='string'||!reason.trim()||reason.length>500)fail('请填写盘点原因，最多500字');
    if(!Array.isArray(counts)||counts.length!==r.baseline.length||new Set(counts.map(c=>c.id)).size!==counts.length)fail('请逐项填写全部实盘数量');
    r.counts=r.baseline.map(item=>{const c=counts.find(c=>c.id===item.id);if(!c||typeof c.qty!=='number'||!Number.isFinite(c.qty)||c.qty<0)fail('实盘数量须为非负数字');return {...item,book_qty:item.qty,qty:c.qty,difference:c.qty-item.qty};});r.reason=reason.trim();
    return persist(r,revision,actor,'save');
  }
  function transition(id,{revision,action,note=''},actor,canAccess){
    role(actor,action==='approve'||action==='reject'?['admin']:['admin','operator']);
    const rules={submit:[['draft'],'submitted'],approve:[['submitted'],'approved'],reject:[['submitted'],'rejected'],cancel:[['draft','submitted','approved'],'cancelled']};
    if(!rules[action])fail('未知操作');const [states,state]=rules[action],r=current(id,revision,states,canAccess);
    if(action==='submit'||action==='approve'){unchanged(r);if(r.counts.length!==r.baseline.length||!r.reason)fail('请先保存实盘和原因');}
    if(action==='reject'&&(typeof note!=='string'||!note.trim()||note.length>500))fail('请填写驳回原因，最多500字');
    r.state=state;if(action==='reject')r.review_note=note.trim();return persist(r,revision,actor,action);
  }
  async function send(id,{revision},actor,canAccess){
    role(actor,['admin']);const existing=get(id,canAccess);
    if(flights.has(id))return flights.get(id);
    if(['waiting_sync','confirmed'].includes(existing.state))return {...existing,replayed:true};
    const r=current(id,revision,['approved','uncertain','sending'],canAccess);
    if(!dispatch)fail('尚未配置ERP盘点接口，差异单已保留',503);
    if(r.state==='approved')unchanged(r);
    r.state='sending';const sent=persist(r,revision,actor,'send');
    // 网络返回前已落盘；进程重启或响应丢失后用同一request_id核对，不能新建请求。
    const payload={request_id:r.id,source:r.source,loc_code:r.loc_code,reason:r.reason,lines:r.counts.map(c=>({sku:c.sku,external_loc_code:c.external_loc_code,batch_no:c.batch_no,status:c.status,unit:c.unit,book_qty:c.book_qty,counted_qty:c.qty,difference:c.difference,base_version:c.snapshot_version}))};
    const flight=(async()=>{
      try{
        const receipt=await Promise.resolve().then(()=>dispatch(payload));
        if(receipt?.request_id!==r.id||receipt.status!=='accepted'||typeof receipt.receipt_id!=='string'||!receipt.receipt_id)throw Error('ERP回执不完整，需核对原请求');
        const latest=get(id,canAccess);latest.state='waiting_sync';latest.receipt=receipt;delete latest.last_error;return persist(latest,sent.revision,actor,'accepted');
      }catch(error){const latest=get(id,canAccess);latest.state='uncertain';latest.last_error=String(error.message).slice(0,300);return persist(latest,sent.revision,actor,'uncertain');}
      finally{flights.delete(id);}
    })();flights.set(id,flight);return flight;
  }
  function reconcile(id,{revision},actor,canAccess){
    role(actor,['admin']);const r=current(id,revision,['waiting_sync'],canAccess),now=baseline(r.loc_code,r.source);
    // 先要求新的来源版本，再逐项核对；不因发送成功而自行改数量。
    const version=sourceVersion(r.source);
    const matched=r.counts.every(c=>{const n=now.find(n=>n.id===c.id);return version>c.snapshot_version&&(n?n.qty===c.qty&&n.unit===c.unit&&n.external_loc_code===c.external_loc_code:c.qty===0);})&&now.every(n=>r.counts.some(c=>c.id===n.id));
    if(!matched)return {...r,matched:false};r.state='confirmed';return {...persist(r,revision,actor,'reconciled'),matched:true};
  }
  function list(loc,canAccess){check(loc,canAccess);return sql.prepare('SELECT payload FROM erp_stocktake WHERE loc_code=? ORDER BY rowid DESC LIMIT 100').all(loc).map(row=>JSON.parse(row.payload));}
  return {create,get,save,transition,send,reconcile,list};
}
