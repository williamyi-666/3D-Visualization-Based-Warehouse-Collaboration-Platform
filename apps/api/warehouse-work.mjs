import {randomUUID,createHash} from 'node:crypto';
import {installStocktakeReview,stocktakeRule,normalizeStocktakeRule,saveStocktakeRule} from './stocktake-review.mjs';
import {createWarehouseRouter} from '../../packages/three-kit/warehouse-route.mjs';
import {readStorageProfile} from './item-storage.mjs';
import {storageFit} from './storage-fit.mjs';

export function createWarehouseWork(sql,{db}) {
  installStocktakeReview(sql);
  const openingSchema=`CREATE TABLE IF NOT EXISTS opening_stock (
    loc_code TEXT NOT NULL,node_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,
    signature TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);`;
  sql.exec(openingSchema);
  if(sql.prepare('PRAGMA table_info(opening_stock)').all().some(c=>c.name==='loc_code'&&c.pk)) {
    // 编号可以复用，格位 ID 不复用；迁移保留旧回执和原请求编号。
    sql.exec('SAVEPOINT opening_identity_upgrade');
    try {
      sql.exec('ALTER TABLE opening_stock RENAME TO opening_stock_previous');
      sql.exec(openingSchema);
      sql.exec('INSERT INTO opening_stock SELECT * FROM opening_stock_previous; DROP TABLE opening_stock_previous');
      sql.exec('RELEASE SAVEPOINT opening_identity_upgrade');
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT opening_identity_upgrade; RELEASE SAVEPOINT opening_identity_upgrade');throw error;}
  }
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS opening_stock_request ON opening_stock(actor_id,request_id);
    CREATE TABLE IF NOT EXISTS warehouse_work_policy (
    room_code TEXT PRIMARY KEY,count_days INTEGER NOT NULL DEFAULT 0,thresholds TEXT NOT NULL DEFAULT '[]',room_id TEXT);`);
  if(!sql.prepare('PRAGMA table_info(warehouse_work_policy)').all().some(c=>c.name==='room_id')) {
    sql.exec('SAVEPOINT work_policy_identity_upgrade');
    try {
      sql.exec('ALTER TABLE warehouse_work_policy ADD COLUMN room_id TEXT');
      sql.exec("UPDATE warehouse_work_policy SET room_id=(SELECT id FROM space_node WHERE loc_code=room_code AND node_type='room')");
      sql.exec('RELEASE SAVEPOINT work_policy_identity_upgrade');
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT work_policy_identity_upgrade; RELEASE SAVEPOINT work_policy_identity_upgrade');throw error;}
  }
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
  const check=(code,canAccess)=>{if(canAccess&&!canAccess(code))fail('当前账号没有此仓库的访问权限',403);};
  function room(code,canAccess) {
    const node=sql.prepare("SELECT * FROM space_node WHERE node_type='room' AND (loc_code=? OR id=?)").get(code,code);
    if(!node)fail('库区不存在',404);check(node.loc_code,canAccess);return node;
  }
  function cell(code,canAccess) {
    const canonical=db.resolveCellCode(code),node=sql.prepare("SELECT * FROM space_node WHERE node_type='cell' AND loc_code=?").get(canonical);
    if(!node)fail('格位不存在',404);check(node.loc_code,canAccess);return node;
  }
  const stock=node=>sql.prepare('SELECT item_id,qty FROM inventory WHERE node_id=? AND qty>0 ORDER BY item_id').all(node);
  const mark=node=>sql.prepare('SELECT COALESCE(MAX(id),0) AS n FROM movement WHERE from_node_id=? OR to_node_id=?').get(node,node).n;
  const baseline=node=>hash([node.id,node.loc_code,stock(node.id),mark(node.id)]);
  function cells(code,canAccess) {
    const r=room(code,canAccess),valid=new Set(db.getCells().map(c=>c.loc_code));
    return sql.prepare("SELECT c.* FROM space_node c JOIN space_node f ON f.id=c.parent_id WHERE c.node_type='cell' AND f.parent_id=? ORDER BY c.loc_code").all(r.id).filter(c=>valid.has(c.loc_code)&&(!canAccess||canAccess(c.loc_code)));
  }
  function opening(code,canAccess) {
    const node=cell(code,canAccess),receipt=sql.prepare('SELECT result FROM opening_stock WHERE node_id=?').get(node.id);
    return {loc_code:node.loc_code,node_id:node.id,baseline:baseline(node),items:db.getCellItems(node.loc_code),completed:receipt?JSON.parse(receipt.result):null};
  }
  function establish(input,actor,canAccess) {
    const node=cell(input.loc_code,canAccess);
    if(typeof input.request_id!=='string'||!input.request_id||input.request_id.length>128)fail('需要建账请求编号');
    const signature=hash({...input,loc_code:node.loc_code}),previous=sql.prepare('SELECT * FROM opening_stock WHERE actor_id=? AND request_id=?').get(actor.id,input.request_id);
    if(previous){check(previous.loc_code,canAccess);if(previous.signature!==signature)fail('请求内容已修改，请使用新的请求编号',409);return {...JSON.parse(previous.result),replayed:true};}
    if(sql.prepare('SELECT node_id FROM opening_stock WHERE node_id=?').get(node.id))fail('此格位已建立底账；调整数量请使用盘点',409);
    if(input.baseline!==baseline(node))fail('库存已变化，请重新核对当前格位',409);
    if(stock(node.id).length)fail('此格位已有库存，请使用盘点核对数量',409);
    if(!Array.isArray(input.rows)||input.rows.length>100)fail('需要货品数组，最多100行');
    // 底账是实盘绝对数，只允许对尚未建账的空格位确认一次。
    sql.exec('SAVEPOINT opening_write');
    try {
      const resultRows=[],ids=new Set();
      for(const row of input.rows) {
        const qty=Number(row.qty),name=String(row.name||'').trim(),sku=String(row.sku||'').trim();
        if(!name||name.length>200||!Number.isFinite(qty)||qty<=0)fail('请填写货品名称和大于零的实盘数量；空格位可直接确认空位');
        const linked=sku?db.getItemByCode(sku):null;
        if(row.item_id&&linked&&row.item_id!==linked.item_id)fail('货品与条码不一致，请重新选择');
        let item=row.item_id?sql.prepare('SELECT * FROM item WHERE id=?').get(row.item_id):linked?sql.prepare('SELECT * FROM item WHERE id=?').get(linked.item_id):null;
        if(row.item_id&&!item)fail('所选货品已不存在');
        if(!item&&!sku) {
          const matches=sql.prepare('SELECT * FROM item WHERE name=?').all(name);
          if(matches.length>1)fail('同名货品不唯一，请选择已有SKU');
          item=matches[0];
        }
        if(item&&canAccess) {
          const locations=sql.prepare('SELECT n.loc_code FROM inventory i JOIN space_node n ON n.id=i.node_id WHERE item_id=?').all(item.id);
          if(!locations.some(l=>canAccess(l.loc_code)))fail('请选择当前仓库可访问的货品',403);
        }
        const unit=String(row.unit||item?.unit||'件').trim();
        if(!unit||unit.length>20)fail('库存单位为1至20个字');
        if(item&&unit!==(item.unit||'件'))fail('已有货品单位不能改变');
        if(!item) {
          const id=randomUUID(),temporary=sku||'TMP-'+id.slice(0,8).toUpperCase();
          sql.prepare('INSERT INTO item(id,tenant_id,name,sku,unit,attributes) VALUES(?,?,?,?,?,?)').run(id,db.TENANT,name,temporary,unit,JSON.stringify({temporary_sku:!sku}));
          item={id,name,sku:temporary,unit};
        }
        if(ids.has(item.id))fail('同一货品请合并成一行填写');ids.add(item.id);
        sql.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?) ON CONFLICT(node_id,item_id) DO UPDATE SET qty=excluded.qty').run(randomUUID(),db.TENANT,node.id,item.id,qty);
        db.logMovement({item_id:item.id,to_node_id:node.id,qty,move_type:'opening',idem_key:`opening:${node.id}:${item.id}`});
        db.emit('inventory.changed',{item_id:item.id,node_id:node.id,qty});
        resultRows.push({item_id:item.id,name:item.name,sku:item.sku,unit,qty});
      }
      const now=new Date().toISOString(),result={loc_code:node.loc_code,node_id:node.id,rows:resultRows,empty:!resultRows.length,created_at:now};
      sql.prepare('INSERT INTO opening_stock VALUES(?,?,?,?,?,?,?)').run(node.loc_code,node.id,actor.id,input.request_id,signature,JSON.stringify(result),now);
      // 空位确认也应被其他设备观察到。
      if(!resultRows.length)db.emit('inventory.changed',{node_id:node.id,qty:0});
      sql.exec('RELEASE SAVEPOINT opening_write');return result;
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT opening_write; RELEASE SAVEPOINT opening_write');throw error;}
  }
  function progress(code,canAccess) {
    const all=cells(code,canAccess),receipts=new Set(sql.prepare('SELECT node_id FROM opening_stock').all().map(r=>r.node_id));
    const counts=sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stocktake'").get()
      ?sql.prepare("SELECT node_id,state FROM stocktake WHERE state IN ('confirmed','draft','review')").all():[];
    const confirmed=new Set(counts.filter(row=>row.state==='confirmed').map(row=>row.node_id)),drafts=new Set(counts.filter(row=>row.state==='draft').map(row=>row.node_id)),reviewing=new Set(counts.filter(row=>row.state==='review').map(row=>row.node_id));
    const rows=all.map(c=>{const completed=receipts.has(c.id)||confirmed.has(c.id);return {loc_code:c.loc_code,node_id:c.id,name:c.name,completed,has_stock:stock(c.id).length>0,status:reviewing.has(c.id)?'reviewing':drafts.has(c.id)?'counting':completed?'verified':'unverified'};});
    return {total:rows.length,completed:rows.filter(r=>r.completed).length,unverified:rows.filter(r=>!r.completed).length,counting:rows.filter(r=>r.status==='counting').length,rows};
  }
  function catalogue(code,canAccess,actor) {
    const r=room(code,canAccess),locations=new Set(cells(r.loc_code,canAccess).map(c=>c.loc_code));
    const inventory=sql.prepare(`SELECT t.id AS item_id,t.name,t.sku,t.unit,n.loc_code
      FROM inventory i JOIN item t ON t.id=i.item_id JOIN space_node n ON n.id=i.node_id
      JOIN space_node f ON f.id=n.parent_id WHERE f.parent_id=?`).all(r.id).filter(i=>locations.has(i.loc_code));
    // 数量归零/移走后，已在本库区办理过的货品仍可快捷选取和设置阈值。
    const historical=sql.prepare(`SELECT DISTINCT t.id AS item_id,t.name,t.sku,t.unit,n.loc_code FROM movement m
      JOIN item t ON t.id=m.item_id JOIN space_node n ON n.id=m.from_node_id OR n.id=m.to_node_id
      JOIN space_node f ON f.id=n.parent_id WHERE f.parent_id=?`).all(r.id).filter(i=>locations.has(i.loc_code));
    const items=[...new Map([...inventory,...historical].map(i=>[i.item_id,{item_id:i.item_id,name:i.name,sku:i.sku,unit:i.unit}])).values()];
    const recent=new Map();
    for(const m of sql.prepare(`SELECT m.item_id,n.loc_code FROM movement m JOIN space_node n ON n.id=COALESCE(m.to_node_id,m.from_node_id) WHERE m.actor_id=? ORDER BY m.id DESC LIMIT 200`).all(actor?.id||''))if(locations.has(m.loc_code))recent.set(m.item_id,true);
    return items.sort((a,b)=>Number(recent.has(b.item_id))-Number(recent.has(a.item_id))||a.name.localeCompare(b.name,'zh-CN'));
  }
  function recommend(input,canAccess) {
    const r=room(input.room,canAccess),all=cells(r.loc_code,canAccess),qty=Number(input.qty);
    if(!Number.isFinite(qty)||qty<=0)fail('请填写本次存放数量');
    const linked=input.sku?db.getItemByCode(input.sku):null;
    const item=input.item_id?sql.prepare('SELECT * FROM item WHERE id=?').get(input.item_id):linked?sql.prepare('SELECT * FROM item WHERE id=?').get(linked.item_id):null;
    if((input.item_id||input.sku)&&!item)fail('货品不存在或不可访问',404);
    if(item&&canAccess&&!sql.prepare('SELECT n.loc_code FROM inventory i JOIN space_node n ON n.id=i.node_id WHERE i.item_id=?').all(item.id).some(row=>canAccess(row.loc_code)))fail('货品不存在或不可访问',404);
    const unit=String(input.unit||item?.unit||'件');if(item&&unit!==(item.unit||'件'))fail('请使用货品库存单位 '+(item.unit||'件'));
    const profile=readStorageProfile(item?.attributes||'{}');
    const weight=input.unit_weight==null||input.unit_weight===''?profile.weight_kg:Number(input.unit_weight);
    if(weight!==null&&(!Number.isFinite(weight)||weight<=0))fail('单件重量须大于零');
    const layout=db.getLayout(r.loc_code),racks=new Map(layout.furniture.map(f=>[f.code,f])),byCell=new Map();
    for(const row of sql.prepare('SELECT inv.node_id,inv.item_id,inv.qty,t.sku,t.unit,t.attributes FROM inventory inv JOIN item t ON t.id=inv.item_id JOIN space_node n ON n.id=inv.node_id JOIN space_node rack ON rack.id=n.parent_id WHERE rack.parent_id=? AND inv.qty>0').all(r.id)){if(!byCell.has(row.node_id))byCell.set(row.node_id,[]);byCell.get(row.node_id).push(row);}
    let candidates=[];const excluded={status:0,conditions:0,unreachable:0};
    for(const c of all) {
      if((c.status||'normal')!=='normal'||c.loc_code===input.from_loc){excluded.status++;continue;}
      const candidate=storageFit({cell:c,rack:racks.get(c.loc_code.replace(/-L\d+-B\d+$/,'')),profile,inventory:byCell.get(c.id)||[],itemId:item?.id,product:item,qty,unit,weight});
      if(candidate)candidates.push(candidate);else excluded.conditions++;
    }
    const start_loc=input.start_loc?db.resolveCellCode(input.start_loc):'';
    if(start_loc&&!all.some(c=>c.loc_code===start_loc))fail('起点不属于当前可访问库区',403);
    let router,origin,routeMessage='';
    try{
      router=createWarehouseRouter(layout);
      origin=router.origin({start_loc,entry:input.entry??router.entrances[0]?.index??0});
      if(!router.segmentClear(origin.point,origin.point))throw Error('起点附近没有可通行空间，请选择其他入口或格位附近');
    }catch(error){if(start_loc||input.entry!==undefined)throw error;routeMessage=error.message;}
    if(origin&&!routeMessage){
      const paths=router.pathsFrom(origin.point,candidates.map(c=>({...c,point:router.approach(c.loc_code)}))),reachable=[];
      for(const result of paths){if(result.distance===null){excluded.unreachable++;continue;}const {point,points,...candidate}=result;candidate.distance=Math.round(candidate.distance*10)/10;candidate.reasons.push('从'+(origin.kind==='location'?'格位 '+origin.loc_code:origin.label)+'按通道约 '+candidate.distance.toFixed(1)+' 米');reachable.push(candidate);}
      candidates=reachable;
    }else for(const candidate of candidates){candidate.distance=null;candidate.warnings.push('通道距离未计算：'+routeMessage);}
    return {candidates:candidates.sort((a,b)=>b.score-a.score||(a.distance??Infinity)-(b.distance??Infinity)||a.loc_code.localeCompare(b.loc_code)).slice(0,8),checked:all.length,eligible:candidates.length,excluded,profile,route:{available:!!origin&&!routeMessage,origin:origin||null,message:routeMessage},layout_revision:layout.revision};
  }
  function routeOptions(code,canAccess){
    const all=cells(code,canAccess),r=room(code,canAccess),layout=db.getLayout(r.loc_code),router=createWarehouseRouter(layout);
    return {room:r.loc_code,layout,locations:all.map(c=>({loc_code:c.loc_code,name:c.name})),entrances:router.entrances.map(({index,label})=>({index,label}))};
  }
  function route(input,canAccess){
    const r=room(input.room,canAccess),layout=db.getLayout(r.loc_code),valid=new Set(cells(r.loc_code,canAccess).map(c=>c.loc_code));
    if(input.revision&&input.revision!==layout.revision)fail('布局已更新，请重新打开路线预览',409);
    if(!Array.isArray(input.locations)||!input.locations.length||input.locations.length>50)fail('每次请选择1至50个格位');
    const resolve=code=>{const canonical=db.resolveCellCode(code);if(!valid.has(canonical))fail('路线包含不可访问或不属于当前库区的格位',403);return canonical;};
    const locations=input.locations.map(resolve),start_loc=input.start_loc?resolve(input.start_loc):'';
    const clearance=Number(input.clearance??.25);if(!Number.isFinite(clearance)||clearance<.1||clearance>1.5)fail('每侧通行余量须为0.1至1.5米');
    return createWarehouseRouter(layout,{clearance}).plan({locations,start_loc,entry:input.entry??0});
  }
  function policy(code,canAccess) {
    const r=room(code,canAccess),p=sql.prepare('SELECT * FROM warehouse_work_policy WHERE room_code=? AND room_id=?').get(r.loc_code,r.id);
    return {...(p?{...p,thresholds:JSON.parse(p.thresholds)}:{room_code:r.loc_code,count_days:0,thresholds:[]}),stocktake_review:stocktakeRule(sql,r.id)};
  }
  function savePolicy(code,input,canAccess,actor) {
    const r=room(code,canAccess),days=Number(input.count_days),available=new Set(catalogue(r.loc_code,canAccess).map(i=>i.item_id));
    if(!Number.isInteger(days)||days<0||days>3650||!Array.isArray(input.thresholds)||input.thresholds.length>500)fail('请填写盘点周期（0为关闭）和库存阈值');
    const thresholds=input.thresholds.map(row=>{
      const minimum=Number(row.minimum);if(!available.has(row.item_id)||!Number.isFinite(minimum)||minimum<0)fail('请选择当前库区货品并填写非负库存阈值');
      return {item_id:row.item_id,minimum};
    });
    if(new Set(thresholds.map(t=>t.item_id)).size!==thresholds.length)fail('同一货品只设置一个阈值');
    const rule=input.stocktake_review===undefined?null:normalizeStocktakeRule(input.stocktake_review);
    sql.exec('SAVEPOINT work_policy_save');
    try{
      sql.prepare('INSERT INTO warehouse_work_policy(room_code,count_days,thresholds,room_id) VALUES(?,?,?,?) ON CONFLICT(room_code) DO UPDATE SET room_id=excluded.room_id,count_days=excluded.count_days,thresholds=excluded.thresholds').run(r.loc_code,days,JSON.stringify(thresholds),r.id);
      if(rule)saveStocktakeRule(sql,r.id,rule,actor);
      sql.exec('RELEASE SAVEPOINT work_policy_save');
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT work_policy_save; RELEASE SAVEPOINT work_policy_save');throw error;}
    return policy(r.loc_code,canAccess);
  }
  function tasks(code,canAccess,actor) {
    const all=cells(code,canAccess),locations=new Set(all.map(c=>c.loc_code)),nodeIds=new Set(all.map(c=>c.id)),p=policy(code,canAccess),rows=[];
    const drafts=sql.prepare("SELECT s.id,s.node_id,s.loc_code,s.created_by,s.updated_at,r.submitted_by FROM stocktake s LEFT JOIN stocktake_review r ON r.stocktake_id=s.id WHERE s.state='draft' ORDER BY s.updated_at DESC").all().filter(d=>nodeIds.has(d.node_id)&&(JSON.parse(d.created_by).id===actor.id||d.submitted_by&&JSON.parse(d.submitted_by).id===actor.id));
    for(const d of drafts)rows.push({kind:'draft',id:d.id,loc_code:d.loc_code,title:'继续未完成的盘点',updated_at:d.updated_at,evidence:{stocktake_id:d.id,state:'draft'}});
    const reviews=sql.prepare("SELECT id,node_id,loc_code,created_by,updated_by,reason,updated_at FROM stocktake WHERE state='review' ORDER BY updated_at DESC").all().filter(row=>nodeIds.has(row.node_id)&&(actor.role==='admin'||JSON.parse(row.created_by).id===actor.id||JSON.parse(row.updated_by).id===actor.id));
    for(const review of reviews){const record=sql.prepare('SELECT triggers,submitted_at FROM stocktake_review WHERE stocktake_id=?').get(review.id);rows.push({kind:'review',id:review.id,loc_code:review.loc_code,title:actor.role==='admin'?'复核盘点差异':'盘点已提交，等待管理员复核',detail:review.reason,updated_at:record?.submitted_at||review.updated_at,evidence:{stocktake_id:review.id,triggers:record?JSON.parse(record.triggers):[]}});}
    const draftLocs=new Set(sql.prepare("SELECT node_id,loc_code FROM stocktake WHERE state IN ('draft','review')").all().filter(row=>nodeIds.has(row.node_id)).map(row=>row.loc_code));
    if(p.count_days)for(const c of all) {
      if(draftLocs.has(c.loc_code)||!stock(c.id).length)continue;
      const counted=sql.prepare("SELECT MAX(updated_at) AS at FROM stocktake WHERE node_id=? AND state='confirmed'").get(c.id)?.at;
      const opened=sql.prepare('SELECT created_at FROM opening_stock WHERE node_id=?').get(c.id)?.created_at;
      const last=[counted,opened].filter(Boolean).sort().at(-1);
      if(!last||Date.now()-Date.parse(last)>p.count_days*86400000)rows.push({kind:'count',loc_code:c.loc_code,title:'到期盘点',detail:last?`上次核对 ${last.slice(0,10)}`:'尚无盘点记录',updated_at:last||null,evidence:{last_counted_at:last||null,count_days:p.count_days}});
    }
    const inventory=db.listInventory().filter(i=>locations.has(i.loc_code));
    for(const t of p.thresholds) {
      const item=sql.prepare('SELECT name,sku,unit FROM item WHERE id=?').get(t.item_id);
      const stocks=inventory.filter(i=>i.item_id===t.item_id),qty=stocks.reduce((sum,i)=>sum+i.qty,0);
      if(item&&qty<t.minimum)rows.push({kind:'low',item_id:t.item_id,title:`${item.name} 库存偏低`,sku:item.sku,loc_code:stocks[0]?.loc_code||'',detail:`现有 ${qty} ${item.unit||'件'} / 最低 ${t.minimum}`,evidence:{item_id:t.item_id,qty,minimum:t.minimum,unit:item.unit||'件'}});
    }
    return {rows,total:rows.length,policy:p,progress:progress(code,canAccess)};
  }
  return {room,opening,establish,progress,catalogue,recommend,routeOptions,route,policy,savePolicy,tasks};
}
