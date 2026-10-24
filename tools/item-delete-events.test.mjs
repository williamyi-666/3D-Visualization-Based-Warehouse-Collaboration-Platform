import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {SupOSAdapter} from '../packages/integration/adapters/suposUnsAdapter.mjs';

test('物料删除事件：保留多库位身份与原数量，事件失败回滚，重复删除不伪造事件',async()=>{
 const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'spatial-delete-events-'));
 const previous=process.env.SPATIAL_DATA_DIR;process.env.SPATIAL_DATA_DIR=dir;
 const db=await import('../apps/api/db.mjs'),sql=db.default;
 try {
  db.importItems([
   {name:'待删除测试物料',sku:'DELETE-EVENT',qty:3,loc_code:'WH-1-A-L01-B01'},
   {name:'待删除测试物料',sku:'DELETE-EVENT',qty:7,loc_code:'WH-1-B-L01-B01'},
  ]);
  const id=sql.prepare('SELECT id FROM item WHERE sku=?').get('DELETE-EVENT').id;
  db.setItemErpCode(id,'ERP-DELETE');
  const snapshot=()=>Object.fromEntries(['item','inventory','movement','outbox_event'].map(t=>[t,sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  const before=snapshot();
  // 第二个删除事件失败，验证此前已写入的第一个事件也回滚。
  sql.exec("CREATE TRIGGER fail_delete_event BEFORE INSERT ON outbox_event WHEN NEW.event_type='item.deleted' AND (SELECT COUNT(*) FROM outbox_event WHERE event_type='item.deleted')=1 BEGIN SELECT RAISE(ABORT,'delete event failed'); END");
  assert.throws(()=>db.deleteItem(id),/delete event failed/);assert.deepEqual(snapshot(),before);
  sql.exec('DROP TRIGGER fail_delete_event');
  db.deleteItem(id);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM item WHERE id=?').get(id).n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM inventory WHERE item_id=?').get(id).n,0);
  assert.deepEqual(snapshot().movement,before.movement);
  const events=db.getPendingOutbox().filter(e=>e.event_type==='item.deleted');assert.equal(events.length,2);
  const payloads=events.map(e=>JSON.parse(e.payload_json)).sort((a,b)=>a.loc_code.localeCompare(b.loc_code));
  assert.deepEqual(payloads.map(p=>[p.loc_code,p.previous_qty]),[['WH-1-A-L01-B01',3],['WH-1-B-L01-B01',7]]);
  const adapter=new SupOSAdapter('packages/integration/mapping/supos-uns.yaml');
  const sent=[];adapter.publish=async(topic,body,eventId)=>{sent.push({topic,body,eventId});return {ok:true};};
  for(const e of events)await adapter.send(e.event_type,{...JSON.parse(e.payload_json),_idem:e.id});
  assert.equal(new Set(sent.map(e=>e.topic)).size,2);
  for(const e of sent){assert.equal(e.body.item_id,id);assert.equal(e.body.sku,'DELETE-EVENT');assert.equal(e.body.erp_code,'ERP-DELETE');assert.equal(e.body.name,'待删除测试物料');assert.equal(e.body.unit,'件');}
  const after=snapshot();db.deleteItem(id);assert.deepEqual(snapshot(),after);
 } finally {
  sql.close();if(previous===undefined)delete process.env.SPATIAL_DATA_DIR;else process.env.SPATIAL_DATA_DIR=previous;
  const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});
 }
});
