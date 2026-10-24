// 配合候选容器断网/恢复运行；不停止平台Broker，不修改发件箱状态。
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import * as db from '../apps/api/db.mjs';
import {actorStore} from '../apps/api/context.mjs';
assert.equal(process.env.SPATIAL_BASE_PATH,'/warehouse-standalone');
const phase=process.argv[2],file='/tmp/warehouse-uns-recovery.json';
const loc='WH-1-A-L01-B02';
try {
  if(phase==='offline') {
    assert.equal(db.getPendingOutbox().length,0,'先处理已有待发事件');
    const item=db.getCellItems(loc).find(i=>i.sku==='SUPOS-QA-20260919');
    assert.equal(item?.qty,3);
    const count=db.default.prepare('SELECT count(*) AS n FROM movement').get().n;
    actorStore.run({id:'candidate-uns-recovery',name:'候选UNS断线恢复验收'},()=>{
      db.inbound({name:item.name,sku:item.sku,unit:item.unit,loc_code:loc,qty:0.5,request_id:'uns-offline-in-20260919'});
      db.outbound({loc_code:loc,item_id:item.item_id,qty:0.5,request_id:'uns-offline-out-20260919'});
    });
    const events=db.getPendingOutbox();assert.equal(events.length,2);
    writeFileSync(file,JSON.stringify({events,item:item.item_id,movements:count+2}));
    let rows;
    for(let i=0;i<40;i++) {
      await new Promise(r=>setTimeout(r,500));
      rows=db.default.prepare("SELECT id,status,attempts,last_error FROM outbox_event WHERE status='pending'").all();
      if(rows.length===2 && rows.every(r=>r.attempts>0))break;
    }
    assert.equal(rows.length,2);assert.ok(rows.every(r=>r.attempts>0),'断网期间尚未记录派发失败');
    assert.equal(db.getCellItems(loc).find(i=>i.item_id===item.item_id).qty,3);
    console.log(JSON.stringify({phase,verified:true,events:rows}));
  } else if(phase==='recovered') {
    const saved=JSON.parse(readFileSync(file,'utf8'));
    let states;
    for(let i=0;i<70;i++) {
      states=saved.events.map(e=>db.default.prepare('SELECT status,attempts FROM outbox_event WHERE id=?').get(e.id));
      if(states.every(r=>r.status==='sent'))break;
      await new Promise(r=>setTimeout(r,500));
    }
    assert.ok(states.every(r=>r.status==='sent'),'恢复后未自动补发');
    const response=await fetch('http://backend:8080/open-api/uns/file/current/batchQuery',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(['warehouse3d_candidate_events']),signal:AbortSignal.timeout(10000)});
    const current=(await response.json()).data.warehouse3d_candidate_events;
    const last=saved.events.at(-1);
    assert.equal(current.event_id,last.id);assert.equal(current.payload,last.payload_json);
    assert.equal(db.getCellItems(loc).find(i=>i.item_id===saved.item).qty,3);
    assert.equal(db.default.prepare('SELECT count(*) AS n FROM movement').get().n,saved.movements,'补发不能重复业务流水');
    console.log(JSON.stringify({phase,verified:true,event_id:last.id,states,qty:3,pending:db.getPendingOutbox().length}));
  } else throw Error('参数必须为offline或recovered');
} finally {db.default.close();}
