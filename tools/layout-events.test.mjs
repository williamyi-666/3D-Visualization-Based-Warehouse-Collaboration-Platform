import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {SupOSAdapter} from '../packages/integration/adapters/suposUnsAdapter.mjs';
import {dispatchBatch} from '../packages/integration/dispatch.mjs';

test('布局事件：库区ID与编码一致，记录实际货架数，拒绝跨库区写入，空间事件可派发',async()=>{
 const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'spatial-layout-events-'));
 const previous=process.env.SPATIAL_DATA_DIR;process.env.SPATIAL_DATA_DIR=dir;
 const db=await import('../apps/api/db.mjs'),sql=db.default;
 try {
  const first=db.getLayout();
  db.saveLayout({room:{width:16}});
  let event=db.getPendingOutbox().find(e=>e.event_type==='layout.saved');
  assert.deepEqual(JSON.parse(event.payload_json),{roomId:first.roomId,room_code:first.roomCode,furn_count:first.furniture.length});
  db.createSite({code:'EVENTWH',name:'事件测试仓库'});
  const second=db.getLayout('EVENTWH-1');
  db.saveLayout({roomId:'EVENTWH-1',room:{width:18}});
  event=db.getPendingOutbox().filter(e=>e.event_type==='layout.saved').at(-1);
  assert.deepEqual(JSON.parse(event.payload_json),{roomId:second.roomId,room_code:'EVENTWH-1',furn_count:0});
  const snapshot=()=>Object.fromEntries(['space_node','outbox_event','space_operation'].map(t=>[t,sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  const before=snapshot();
  assert.throws(()=>db.saveLayout({roomId:'missing',room:{width:99}}),/目标库区不存在/);
  assert.deepEqual(snapshot(),before);
  assert.throws(()=>db.saveLayout({roomId:second.roomId,room:{width:99},furniture:first.furniture}),/不属于目标库区/);
  assert.deepEqual(snapshot(),before);
  sql.exec("CREATE TRIGGER fail_layout_event BEFORE INSERT ON outbox_event WHEN NEW.event_type='layout.saved' BEGIN SELECT RAISE(ABORT,'layout event failed'); END");
  assert.throws(()=>db.saveLayout({roomId:second.roomId,room:{width:99}}),/layout event failed/);
  assert.deepEqual(snapshot(),before);
  sql.exec('DROP TRIGGER fail_layout_event');
  const adapter=new SupOSAdapter('packages/integration/mapping/supos-uns.yaml'),sent=[];
  adapter.publish=async(topic,body,eventId)=>{sent.push({topic,body,eventId});return {ok:true};};
  assert.equal((await dispatchBatch(db,[adapter])).dispatched,3);
  const site=sent.find(e=>e.body.event_type==='site.created');
  assert.match(site.topic,/node\/EVENTWH\/site$/);assert.equal(site.body.code,'EVENTWH');
  const layout=sent.find(e=>e.body.room_code==='EVENTWH-1');
  assert.match(layout.topic,/node\/EVENTWH-1\/layout$/);assert.equal(layout.body.rack_count,0);
  assert.equal(db.getPendingOutbox().length,0);
 } finally {
  sql.close();if(previous===undefined)delete process.env.SPATIAL_DATA_DIR;else process.env.SPATIAL_DATA_DIR=previous;
  const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
  rmSync(dir,{recursive:true,force:true});
 }
});
