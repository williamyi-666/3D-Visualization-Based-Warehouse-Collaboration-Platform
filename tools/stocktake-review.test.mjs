import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStocktakes} from '../apps/api/stocktake.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';

test('盘点复核：锁定提交、权限、退回重盘、规则快照与账面变化拦截',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'stocktake-review-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,work=createWarehouseWork(sql,{db});let failAudit=false;
  const counts=createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:(...args)=>{if(failAudit)throw Error('模拟复核出站失败');db.emit(...args);}});
  const worker={id:'count-operator',role:'operator',name:'盘点员'},admin={id:'count-admin',role:'admin',name:'管理员'},other={id:'count-other',role:'operator',name:'其它作业员'};
  const room=db.createRoomNode({name:'复核库区',w:12,d:8,h:4}),rack=db.createRack({roomCode:room.loc_code,rows:1,cols:3}),loc=rack.furn_code+'-L01-B01';
  const item=db.inbound({name:'复核轴承',sku:'REVIEW-6204',qty:20,unit:'套',loc_code:loc});
  const qty=()=>db.getCellItems(loc).find(row=>row.item_id===item.item_id).qty;
  const draft=amount=>{let row=counts.create({loc_code:loc},worker);return counts.save(row.id,{revision:row.revision,counts:[{item_id:item.item_id,qty:amount}],reason:'现场逐件核对'},worker);};
  const policy=rule=>work.savePolicy(room.loc_code,{count_days:7,thresholds:[],stocktake_review:rule},null,admin);
  try{
    await t.test('默认任何差异须管理员复核；提交不改库存，不能旁路或改实盘',()=>{
      let row=draft(18);assert.equal(row.review_requirement.required,true);
      row=counts.finish(row.id,{revision:row.revision,action:'confirm'},worker);assert.equal(row.state,'review');assert.equal(qty(),20);
      assert.equal(counts.create({loc_code:loc},other).id,row.id);
      assert.throws(()=>counts.save(row.id,{revision:row.revision,counts:[{item_id:item.item_id,qty:17}]},worker),/已更新/);
      assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'approve'},worker),error=>error.status===403);
      assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'return',note:'非法退回'},worker),error=>error.status===403);
      assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'cancel'},other),error=>error.status===403);
      assert.ok(work.tasks(room.loc_code,null,admin).rows.some(task=>task.kind==='review'&&task.id===row.id));
      assert.ok(work.tasks(room.loc_code,null,worker).rows.some(task=>task.kind==='review'&&task.id===row.id));
      assert.ok(!work.tasks(room.loc_code,null,other).rows.some(task=>task.id===row.id));
      assert.equal(work.progress(room.loc_code).rows.find(cell=>cell.loc_code===loc).status,'reviewing');
      failAudit=true;assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'approve'},admin),/模拟复核/);failAudit=false;
      assert.equal(qty(),20);assert.equal(counts.get(row.id).state,'review');assert.equal(counts.history(row.id).rows.length,1);
      const done=counts.finish(row.id,{revision:row.revision,action:'approve',note:'二次清点一致'},admin);assert.equal(done.state,'confirmed');assert.equal(qty(),18);
      assert.equal(done.review.reviewed_by.id,admin.id);assert.equal(done.review.submitted_by.id,worker.id);
      assert.equal(counts.finish(row.id,{revision:row.revision,action:'approve'},admin).replayed,true);assert.equal(qty(),18);
      const movement=db.getCellHistory(loc).find(entry=>entry.move_type==='stocktake');assert.equal(movement.business.stocktake_id,row.id);assert.equal(movement.business.counted_by,worker.id);assert.equal(movement.business.reviewed_by,admin.id);
    });
    await t.test('退回保留原实盘并以当前账面重盘；提交后变更规则不能绕过复核',()=>{
      let row=draft(15);row=counts.finish(row.id,{revision:row.revision,action:'confirm'},worker);
      policy({mode:'off'});assert.equal(counts.get(row.id).review_policy.mode,'all');
      assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'confirm'},worker,()=>false),error=>error.status===403);
      db.inbound({loc_code:loc,item_id:item.item_id,name:'复核轴承',qty:2,unit:'套'});assert.equal(qty(),20);
      assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'approve'},admin),error=>error.status===409);assert.equal(qty(),20);
      assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'return'},admin),/退回重盘原因/);
      row=counts.finish(row.id,{revision:row.revision,action:'return',note:'收货期间库存变化，请按现账重盘'},admin);
      assert.equal(row.state,'draft');assert.equal(row.baseline[0].qty,20);assert.deepEqual(row.counts,[]);assert.equal(row.review.note,'收货期间库存变化，请按现账重盘');
      const snapshot=row.history.rows.find(event=>event.action==='submit');assert.equal(snapshot.details.counts[0].qty,15);assert.equal(snapshot.details.baseline[0].qty,18);
      row=counts.save(row.id,{revision:row.revision,counts:[{item_id:item.item_id,qty:19}],reason:'重新清点'},worker);
      row=counts.finish(row.id,{revision:row.revision,action:'confirm'},worker);assert.equal(row.state,'confirmed');assert.equal(qty(),19);
      policy({mode:'all'});assert.equal(counts.get(row.id).review_policy.mode,'off');
    });
    await t.test('数量和比例阈值任一超限即复核；等于阈值、不变数量无需复核',()=>{
      policy({mode:'threshold',qty_limit:2,percent_limit:10});let row=draft(18);assert.equal(row.review_requirement.required,false);
      row=counts.finish(row.id,{revision:row.revision,action:'confirm'},worker);assert.equal(row.state,'confirmed');
      row=draft(16);assert.equal(row.review_requirement.required,true);assert.ok(row.review_requirement.triggers[0].reasons.some(reason=>reason.includes('比例')));
      counts.finish(row.id,{revision:row.revision,action:'cancel'},worker);
      policy({mode:'threshold',qty_limit:1});row=draft(16);assert.equal(row.review_requirement.required,true);assert.ok(row.review_requirement.triggers[0].reasons.some(reason=>reason.includes('数量')));counts.finish(row.id,{revision:row.revision,action:'cancel'},worker);
      assert.throws(()=>policy({mode:'threshold'}),/至少设置/);assert.equal(work.policy(room.loc_code).stocktake_review.qty_limit,1);
      assert.throws(()=>policy({mode:'threshold',qty_limit:-1}),/阈值/);
      policy({mode:'all'});row=draft(qty());assert.equal(row.review_requirement.required,false);assert.equal(counts.finish(row.id,{revision:row.revision,action:'confirm'},worker).state,'confirmed');
    });
    await t.test('账外库存不会因分母为0跳过比例复核；原格位重建后不得给新格位调账',()=>{
      const empty=rack.furn_code+'-L01-B02';policy({mode:'threshold',percent_limit:10});
      let row=counts.create({loc_code:empty},worker);row=counts.save(row.id,{revision:row.revision,counts:[{item_id:item.item_id,qty:1}],reason:'发现移错位置货品'},worker);
      assert.equal(row.review_requirement.required,true);assert.equal(row.review_requirement.triggers[0].percent,null);
      row=counts.finish(row.id,{revision:row.revision,action:'confirm'},worker);
      db.deleteRack(rack.furn_code);db.createRack({roomCode:room.loc_code,code:'A',rows:1,cols:3});
      assert.throws(()=>counts.finish(row.id,{revision:row.revision,action:'approve'},admin),error=>error.status===409);
    });
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
