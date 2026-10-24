import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {createStocktakes} from '../apps/api/stocktake.mjs';
import {actorStore} from '../apps/api/context.mjs';

test('盘点：差异调账、取消、过期基线、权限与事务回滚',async()=>{
  const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'warehouse-stocktake-'));
  process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),actor={id:'test-operator',name:'盘点员',role:'operator'},reviewer={id:'test-admin',name:'复核员',role:'admin'};
  let fail=false;
  const service=createStocktakes(db.default,{tenant:db.TENANT,logMovement:db.logMovement,emit:(...args)=>{if(fail)throw Error('模拟事件失败');db.emit(...args);}});
  try{await actorStore.run(actor,async()=>{
    const rack=db.createRack({name:'盘点测试架',rows:1,cols:2}).furn_code,loc=rack+'-L01-B01',other=rack+'-L01-B02';
    const a=db.inbound({name:'盘点A',sku:'COUNT-A',unit:'kg',qty:5,loc_code:loc});
    const b=db.inbound({name:'盘点B',sku:'COUNT-B',qty:2,loc_code:loc});
    const qty=id=>db.getCellItems(loc).find(row=>row.item_id===id)?.qty||0;
    let record=service.create({loc_code:loc},actor);
    assert.equal(service.create({loc_code:loc},actor).id,record.id);
    assert.throws(()=>service.get(record.id,()=>false),/权限/);
    assert.throws(()=>service.save(record.id,{revision:record.revision,counts:[{item_id:a.item_id,qty:4}]},actor),/全部/);
    record=service.save(record.id,{revision:record.revision,counts:[{item_id:a.item_id,qty:3.5},{item_id:b.item_id,qty:4}],reason:'实物复核差异'},actor);
    assert.equal(qty(a.item_id),5);assert.equal(qty(b.item_id),2);
    record=service.finish(record.id,{revision:record.revision,action:'confirm'},actor);assert.equal(record.state,'review');assert.equal(qty(a.item_id),5);
    fail=true;
    assert.throws(()=>service.finish(record.id,{revision:record.revision,action:'approve'},reviewer),/模拟事件失败/);
    assert.equal(qty(a.item_id),5);assert.equal(service.get(record.id).state,'review');
    fail=false;
    const done=service.finish(record.id,{revision:record.revision,action:'approve'},reviewer);
    assert.equal(done.state,'confirmed');assert.equal(qty(a.item_id),3.5);assert.equal(qty(b.item_id),4);
    const moves=db.listMovements({limit:1000}).filter(row=>row.move_type==='stocktake');
    assert.equal(moves.length,2);assert.ok(moves.every(row=>row.actor_id===reviewer.id&&row.idem_key.includes(record.id)&&row.business.counted_by===actor.id));
    assert.equal(service.finish(record.id,{revision:record.revision,action:'confirm'},actor).replayed,true);
    assert.equal(db.listMovements({limit:1000}).filter(row=>row.move_type==='stocktake').length,2);
    record=service.create({loc_code:loc},actor);
    const cancelled=service.finish(record.id,{revision:record.revision,action:'cancel'},actor);
    assert.equal(cancelled.state,'cancelled');assert.equal(qty(a.item_id),3.5);
    record=service.create({loc_code:loc},actor);
    record=service.save(record.id,{revision:record.revision,counts:record.baseline.map(row=>({item_id:row.item_id,qty:row.qty})),reason:''},actor);
    // 出库再入库，数量不变也已改变盘点基线。
    db.outbound({loc_code:loc,item_id:a.item_id,qty:1});db.inbound({name:'盘点A',sku:'COUNT-A',qty:1,loc_code:loc});
    assert.throws(()=>service.finish(record.id,{revision:record.revision,action:'confirm'},actor),/期间/);
    service.finish(record.id,{revision:record.revision,action:'cancel'},actor);
    const extra=db.inbound({name:'发现的货品',sku:'COUNT-EXTRA',qty:1,loc_code:other});
    record=service.create({loc_code:loc},actor);
    const counts=[...record.baseline.map(row=>({item_id:row.item_id,qty:0})),{item_id:extra.item_id,qty:2}];
    assert.throws(()=>service.save(record.id,{revision:record.revision,counts,reason:'清点'},actor,code=>code===loc),/货品.*权限/);
    record=service.save(record.id,{revision:record.revision,counts,reason:'货品实际位置核对'},actor);
    record=service.finish(record.id,{revision:record.revision,action:'confirm'},actor);
    service.finish(record.id,{revision:record.revision,action:'approve'},reviewer);
    assert.equal(qty(a.item_id),0);assert.equal(qty(b.item_id),0);assert.equal(qty(extra.item_id),2);
    assert.ok(service.list(loc).some(row=>row.id===record.id&&row.state==='confirmed'));
  });}finally{
    db.default.close();const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});
  }
});
