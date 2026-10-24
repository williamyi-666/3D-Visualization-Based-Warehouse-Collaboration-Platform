import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {makeBackup,restoreBackup} from './backup-data.mjs';
import {createStocktakes} from '../apps/api/stocktake.mjs';
import {actorStore} from '../apps/api/context.mjs';

test('业务备份恢复：盘点历史、草稿、待复核、流水与请求结果随整库恢复，新进程可继续盘点',async()=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'warehouse-stocktake-backup-'));
 const data=join(root,'data'),assets=join(root,'assets'),backup=join(root,'backup'),restored=join(root,'restored');
 mkdirSync(data);mkdirSync(assets);process.env.SPATIAL_DATA_DIR=data;
 const db=await import('../apps/api/db.mjs'),actor={id:'backup-operator',name:'恢复验收员',role:'operator'},reviewer={id:'backup-admin',name:'恢复复核员',role:'admin'};
 let closed=false;
 try {
  const state=await actorStore.run(actor,async()=>{
   const rack=db.createRack({name:'备份测试架',rows:1,cols:3}).furn_code,loc=rack+'-L01-B01',other=rack+'-L01-B02',waitingLoc=rack+'-L01-B03';
   const input={name:'恢复测试货品',sku:'BACKUP-COUNT',unit:'kg',qty:5,loc_code:loc,request_id:'backup-inbound-1'};
   const item=db.inbound(input);
   db.inbound({...input,loc_code:other,qty:2,request_id:'backup-inbound-2'});
   const service=createStocktakes(db.default,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
   let done=service.create({loc_code:loc},actor);
   done=service.save(done.id,{revision:done.revision,counts:[{item_id:item.item_id,qty:3.5}],reason:'现场清点盘亏'},actor);
   done=service.finish(done.id,{revision:done.revision,action:'confirm'},actor);
   done=service.finish(done.id,{revision:done.revision,action:'approve'},reviewer);
   let draft=service.create({loc_code:other},actor);
   draft=service.save(draft.id,{revision:draft.revision,counts:[{item_id:item.item_id,qty:1}],reason:'恢复后继续核对'},actor);
   db.inbound({...input,loc_code:waitingLoc,qty:2,request_id:'backup-inbound-3'});
   let waiting=service.create({loc_code:waitingLoc},actor);
   waiting=service.save(waiting.id,{revision:waiting.revision,counts:[{item_id:item.item_id,qty:1}],reason:'等待管理员复盘'},actor);
   waiting=service.finish(waiting.id,{revision:waiting.revision,action:'confirm'},actor);assert.equal(waiting.state,'review');
   return {actor,reviewer,input,itemId:item.item_id,loc,other,waitingLoc,done,draft,waiting,history:db.getCellHistory(loc),requests:db.default.prepare('SELECT * FROM counter_request ORDER BY request_id').all()};
  });
  writeFileSync(join(assets,'photo.txt'),'对应备份的附件');
  db.default.close();closed=true;makeBackup(data,assets,backup);
  restoreBackup(backup,restored,join(root,'restored-assets'));
  assert.equal(readFileSync(join(root,'restored-assets/photo.txt'),'utf8'),'对应备份的附件');
  // 使用真实应用数据库模块重开恢复副本，验证迁移后仍可继续业务；不只比较SQLite文件。
  const script=`
   import {actorStore} from './apps/api/context.mjs';
   import {createStocktakes} from './apps/api/stocktake.mjs';
   import * as db from './apps/api/db.mjs';
   const s=JSON.parse(process.env.BACKUP_EXPECTED);
   await actorStore.run(s.actor,async()=>{
    const service=createStocktakes(db.default,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
    const before={done:service.get(s.done.id),draft:service.get(s.draft.id),waiting:service.get(s.waiting.id),history:db.getCellHistory(s.loc),requests:db.default.prepare('SELECT * FROM counter_request ORDER BY request_id').all()};
    const replay=db.inbound(s.input),confirmReplay=service.finish(s.done.id,{revision:s.done.revision,action:'confirm'},s.actor);
    const afterReplay=db.getCellHistory(s.loc);
    const submitted=service.finish(s.draft.id,{revision:s.draft.revision,action:'confirm'},s.actor);
    const continued=service.finish(submitted.id,{revision:submitted.revision,action:'approve'},s.reviewer);
    const reviewed=service.finish(s.waiting.id,{revision:s.waiting.revision,action:'approve'},s.reviewer);
    const qty=loc=>db.getCellItems(loc).find(r=>r.item_id===s.itemId)?.qty;
    console.log(JSON.stringify({before,replay,confirmReplay,afterReplay,continued,reviewed,qtyA:qty(s.loc),qtyB:qty(s.other),qtyC:qty(s.waitingLoc),historyB:db.getCellHistory(s.other)}));
   });db.default.close();`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,SPATIAL_DATA_DIR:restored,BACKUP_EXPECTED:JSON.stringify(state)},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const actual=JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(actual.before,JSON.parse(JSON.stringify({done:state.done,draft:state.draft,waiting:state.waiting,history:state.history,requests:state.requests})));
  assert.equal(actual.replay.replayed,true);assert.equal(actual.confirmReplay.replayed,true);
  assert.deepEqual(actual.afterReplay,JSON.parse(JSON.stringify(state.history)));
  assert.equal(actual.qtyA,3.5);assert.equal(actual.qtyB,1);assert.equal(actual.continued.state,'confirmed');
  assert.equal(actual.qtyC,1);assert.equal(actual.reviewed.state,'confirmed');
  assert.equal(actual.historyB.filter(r=>r.move_type==='stocktake').length,1);
  assert.ok(actual.historyB.some(r=>r.move_type==='stocktake'&&r.idem_key.includes(state.draft.id)&&r.actor_id===reviewer.id&&r.business.counted_by===actor.id));
 }finally{
  if(!closed)db.default.close();const rel=relative(parent,realpathSync(root));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(root,{recursive:true,force:true});
 }
});
