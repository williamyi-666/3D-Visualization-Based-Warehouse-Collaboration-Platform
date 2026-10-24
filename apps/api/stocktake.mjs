import {randomUUID} from 'node:crypto';
import {actorStore,currentActor} from './context.mjs';
import {installStocktakeReview,stocktakeRule,evaluateStocktakeReview} from './stocktake-review.mjs';

// 一张盘点单覆盖一个格位，多SKU逐项实盘；所有确认动作在同一事务中完成。
export function createStocktakes(sql,{tenant,logMovement,emit}) {
  installStocktakeReview(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS stocktake (
    id TEXT PRIMARY KEY,loc_code TEXT NOT NULL,node_id TEXT NOT NULL,
    baseline TEXT NOT NULL,counts TEXT NOT NULL DEFAULT '[]',movement_mark INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',revision INTEGER NOT NULL DEFAULT 1,reason TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,updated_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS stocktake_location_page ON stocktake(loc_code,created_at DESC,id DESC)');
  const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
  const decode=row=>({...row,baseline:JSON.parse(row.baseline),counts:JSON.parse(row.counts),created_by:JSON.parse(row.created_by),updated_by:JSON.parse(row.updated_by)});
  const check=(loc,canAccess)=>{if(canAccess&&!canAccess(loc))fail('没有此仓库的盘点权限',403);};
  const stock=node=>sql.prepare(`SELECT i.id AS item_id,i.name,i.sku,i.unit,v.qty FROM inventory v JOIN item i ON i.id=v.item_id WHERE v.node_id=? AND v.qty>0 ORDER BY i.id`).all(node);
  const mark=node=>sql.prepare('SELECT COALESCE(MAX(id),0) n FROM movement WHERE from_node_id=? OR to_node_id=?').get(node,node).n;
  const who=actor=>({id:actor.id,name:actor.name||actor.username||actor.id});
  const roomId=node=>sql.prepare('SELECT f.parent_id AS id FROM space_node c JOIN space_node f ON f.id=c.parent_id WHERE c.id=?').get(node)?.id;
  function history(id,{before}={},canAccess){
    const row=sql.prepare('SELECT loc_code FROM stocktake WHERE id=?').get(id);if(!row)fail('盘点单不存在',404);check(row.loc_code,canAccess);
    const cursor=before==null?null:Number(before);if(cursor!==null&&(!Number.isInteger(cursor)||cursor<1))fail('复核记录分页位置无效');
    const all=sql.prepare('SELECT * FROM stocktake_review_event WHERE stocktake_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 31').all(id,cursor,cursor);
    return {rows:all.slice(0,30).map(entry=>({...entry,actor:JSON.parse(entry.actor),details:JSON.parse(entry.details)})),next_before:all.length>30?all[29].id:null};
  }
  function get(id,canAccess){
    const raw=sql.prepare('SELECT * FROM stocktake WHERE id=?').get(id);if(!raw)fail('盘点单不存在',404);check(raw.loc_code,canAccess);const row=decode(raw);
    const saved=sql.prepare('SELECT * FROM stocktake_review WHERE stocktake_id=?').get(id);
    const review=saved?{...saved,policy:JSON.parse(saved.policy),triggers:JSON.parse(saved.triggers),submitted_by:JSON.parse(saved.submitted_by),reviewed_by:saved.reviewed_by?JSON.parse(saved.reviewed_by):null}:null;
    const events=history(id,{},canAccess);
    const rule=row.state==='draft'?stocktakeRule(sql,roomId(row.node_id)):row.state==='review'||review?.decision==='approved'?review.policy:events.rows.find(entry=>['confirm','cancel'].includes(entry.action))?.details.policy||null;
    return {...row,review_policy:rule,review_requirement:rule?evaluateStocktakeReview(rule,row.counts):{required:false,triggers:[]},review,history:events};
  }
  function transaction(run){sql.exec('SAVEPOINT stocktake_write');try{const result=run();sql.exec('RELEASE SAVEPOINT stocktake_write');return result;}catch(error){sql.exec('ROLLBACK TO SAVEPOINT stocktake_write; RELEASE SAVEPOINT stocktake_write');throw error;}}
  function create({loc_code},actor,canAccess){
    check(loc_code,canAccess);
    const node=sql.prepare("SELECT id FROM space_node WHERE loc_code=? AND node_type='cell'").get(loc_code);
    if(!node)fail('请选择有效格位');
    const existing=sql.prepare("SELECT id FROM stocktake WHERE node_id=? AND state IN ('draft','review')").get(node.id);
    if(existing)return get(existing.id,canAccess);
    const id=randomUUID(),now=new Date().toISOString(),who=JSON.stringify({id:actor.id,name:actor.name||actor.username||actor.id});
    sql.prepare('INSERT INTO stocktake(id,loc_code,node_id,baseline,movement_mark,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,loc_code,node.id,JSON.stringify(stock(node.id)),mark(node.id),who,who,now,now);
    return get(id,canAccess);
  }
  function save(id,{revision,counts,reason=''},actor,canAccess){return transaction(()=>{
    const row=get(id,canAccess);
    if(row.state!=='draft'||row.revision!==revision)fail('盘点单已更新，请重新加载',409);
    if(!Array.isArray(counts)||new Set(counts.map(r=>r.item_id)).size!==counts.length)fail('实盘货品不能重复');
    const baseline=new Map(row.baseline.map(r=>[r.item_id,r]));
    const normalized=counts.map(line=>{
      if(typeof line.qty!=='number'||!Number.isFinite(line.qty)||line.qty<0)fail('实盘数量须为大于等于0的数字');
      const item=baseline.get(line.item_id)||sql.prepare('SELECT id AS item_id,name,sku,unit FROM item WHERE id=?').get(line.item_id);
      if(!item)fail('实盘货品不存在');
      if(!baseline.has(line.item_id)&&canAccess){
        const locations=sql.prepare('SELECT n.loc_code FROM inventory v JOIN space_node n ON n.id=v.node_id WHERE v.item_id=?').all(line.item_id);
        if(!locations.some(n=>canAccess(n.loc_code)))fail('没有此货品的访问权限',403);
      }
      return {...item,book_qty:baseline.get(line.item_id)?.qty||0,qty:line.qty,difference:line.qty-(baseline.get(line.item_id)?.qty||0)};
    });
    if(row.baseline.some(item=>!normalized.some(line=>line.item_id===item.item_id)))fail('请填写全部账面货品的实盘数量，缺货请填0');
    if(typeof reason!=='string'||reason.length>500)fail('盘点说明最多500字');
    sql.prepare('UPDATE stocktake SET counts=?,reason=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?').run(JSON.stringify(normalized),reason.trim(),JSON.stringify({id:actor.id,name:actor.name||actor.username||actor.id}),new Date().toISOString(),id);
    return get(id,canAccess);
  });}
  function audit(row,action,actor,details={}){
    sql.prepare('INSERT INTO stocktake_review_event(stocktake_id,action,actor,details,created_at) VALUES(?,?,?,?,?)').run(row.id,action,JSON.stringify(who(actor)),JSON.stringify(details),new Date().toISOString());
  }
  function validate(row){
    if(row.baseline.some(item=>!row.counts.some(line=>line.item_id===item.item_id)))fail('请先保存全部实盘数量');
    const node=sql.prepare('SELECT loc_code FROM space_node WHERE id=?').get(row.node_id);
    if(node?.loc_code!==row.loc_code||mark(row.node_id)!==row.movement_mark||JSON.stringify(stock(row.node_id))!==JSON.stringify(row.baseline))fail('盘点期间库存或货品已变化，请退回重盘或取消后重新盘点',409);
    if(row.counts.some(line=>line.difference!==0)&&!row.reason)fail('存在差异，请填写调账原因');
    for(const line of row.counts){
      const item=sql.prepare('SELECT unit FROM item WHERE id=?').get(line.item_id);
      if(!item||item.unit!==line.unit)fail('货品或单位已变化，请重新盘点',409);
      const reserved=sql.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM stock_reservation WHERE node_id=? AND item_id=?').get(row.node_id,line.item_id).qty;
      if(line.qty<reserved)fail('实盘数量低于任务预占，请先核对或调整对应团队任务',409);
    }
  }
  function apply(row,actor,reviewed){
    return actorStore.run({...currentActor(),...actor,business:{stocktake_id:row.id,counted_by:reviewed?row.review.submitted_by.id:row.updated_by.id,...(reviewed?{reviewed_by:actor.id}:{})}},()=>{
      for(const line of row.counts){
        if(!line.difference)continue;
        const inv=sql.prepare('SELECT id FROM inventory WHERE node_id=? AND item_id=?').get(row.node_id,line.item_id);
        if(inv)sql.prepare("UPDATE inventory SET qty=?,last_seen_at=datetime('now') WHERE id=?").run(line.qty,inv.id);
        else sql.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)').run(randomUUID(),tenant,row.node_id,line.item_id,line.qty);
        logMovement({item_id:line.item_id,from_node_id:line.difference<0?row.node_id:null,to_node_id:line.difference>0?row.node_id:null,qty:Math.abs(line.difference),move_type:'stocktake',idem_key:'stocktake:'+row.id+':'+line.item_id});
        emit('inventory.changed',{item_id:line.item_id,node_id:row.node_id,loc_code:row.loc_code,qty:line.qty,stocktake_id:row.id,reason:row.reason});
      }
    });
  }
  function finish(id,{revision,action,note=''},actor,canAccess){return transaction(()=>{
    const row=get(id,canAccess);
    if(!['confirm','cancel','approve','return'].includes(action))fail('未知盘点操作');
    if(['approve','return'].includes(action)&&actor.role!=='admin')fail('需要管理员复核盘点差异',403);
    if(typeof note!=='string'||note.length>500)fail('复核说明最多500字');note=note.trim();
    if(action==='confirm'&&['confirmed','review'].includes(row.state)||action==='approve'&&row.state==='confirmed'&&row.review?.decision==='approved'||action==='cancel'&&row.state==='cancelled')return {...row,replayed:true};
    if(row.revision!==revision)fail('盘点单已更新，请重新加载',409);
    let state;
    if(action==='cancel'){
      if(!['draft','review'].includes(row.state))fail('盘点单已完成，不能取消',409);
      if(row.state==='review'&&actor.role!=='admin'&&row.review.submitted_by.id!==actor.id)fail('只能由提交人或管理员撤回复核',403);
      state='cancelled';audit(row,'cancel',actor,{note,policy:row.review_policy});
    }else if(action==='return'){
      if(row.state!=='review')fail('此盘点单没有等待复核',409);if(!note)fail('请填写退回重盘原因');
      const node=sql.prepare('SELECT loc_code FROM space_node WHERE id=?').get(row.node_id);if(node?.loc_code!==row.loc_code)fail('原格位已变化，请取消后重新盘点',409);
      audit(row,'return',actor,{note,baseline:row.baseline,counts:row.counts,reason:row.reason});
      sql.prepare("UPDATE stocktake SET baseline=?,counts='[]',reason='',movement_mark=? WHERE id=?").run(JSON.stringify(stock(row.node_id)),mark(row.node_id),id);
      sql.prepare("UPDATE stocktake_review SET decision='returned',reviewed_by=?,reviewed_at=?,note=? WHERE stocktake_id=?").run(JSON.stringify(who(actor)),new Date().toISOString(),note,id);state='draft';
    }else{
      if(row.state!==(action==='approve'?'review':'draft'))fail('盘点状态已变化，请重新加载',409);
      validate(row);
      if(action==='confirm'&&row.review_requirement.required){
        const now=new Date().toISOString();
        sql.prepare('INSERT OR REPLACE INTO stocktake_review(stocktake_id,policy,triggers,submitted_by,submitted_at) VALUES(?,?,?,?,?)').run(id,JSON.stringify(row.review_policy),JSON.stringify(row.review_requirement.triggers),JSON.stringify(who(actor)),now);
        audit(row,'submit',actor,{baseline:row.baseline,counts:row.counts,reason:row.reason,policy:row.review_policy,triggers:row.review_requirement.triggers});state='review';
      }else{
        apply(row,actor,action==='approve');state='confirmed';
        if(action==='approve')sql.prepare("UPDATE stocktake_review SET decision='approved',reviewed_by=?,reviewed_at=?,note=? WHERE stocktake_id=?").run(JSON.stringify(who(actor)),new Date().toISOString(),note,id);
        audit(row,action,actor,{note,counts:row.counts,reason:row.reason,policy:row.review_policy});
      }
    }
    sql.prepare('UPDATE stocktake SET state=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?').run(state,JSON.stringify({id:actor.id,name:actor.name||actor.username||actor.id}),new Date().toISOString(),id);
    return get(id,canAccess);
  });}
  function list(loc,canAccess){check(loc,canAccess);return sql.prepare('SELECT * FROM stocktake WHERE loc_code=? ORDER BY created_at DESC,id DESC LIMIT 100').all(loc).map(decode);}
  function page(loc,{limit=20,before=''}={},canAccess){
    check(loc,canAccess);
    const size=Number(limit);
    if(!Number.isInteger(size)||size<1||size>50)fail('每页盘点记录须为1至50条');
    let anchor=null;
    if(before){
      anchor=sql.prepare('SELECT created_at,id FROM stocktake WHERE id=? AND loc_code=?').get(before,loc);
      if(!anchor)fail('分页位置无效，请重新打开盘点列表');
    }
    // 用时间和单号共同定位，避免同毫秒记录或新记录插入导致翻页重复。
    const rows=anchor?sql.prepare('SELECT * FROM stocktake WHERE loc_code=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?').all(loc,anchor.created_at,anchor.created_at,anchor.id,size+1)
      :sql.prepare('SELECT * FROM stocktake WHERE loc_code=? ORDER BY created_at DESC,id DESC LIMIT ?').all(loc,size+1);
    const records=rows.slice(0,size).map(decode);
    return {records,next_before:rows.length>size?records.at(-1).id:null,has_draft:!!sql.prepare("SELECT 1 FROM stocktake WHERE loc_code=? AND state IN ('draft','review') LIMIT 1").get(loc)};
  }
  return {create,get,save,finish,list,page,history};
}
