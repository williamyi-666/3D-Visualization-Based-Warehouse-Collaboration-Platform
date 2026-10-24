// 在隔离候选容器中运行：只读现有测试库存事件，发布到专用联调模型。
// 不修改库存、不标记业务发件箱已发送；运行时自动派发需另行验收。
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {SupOSEventAdapter} from '../packages/integration/adapters/suposEventAdapter.mjs';

assert.equal(process.env.SPATIAL_BASE_PATH,'/warehouse-standalone','仅允许隔离候选');
assert.ok(process.argv.includes('--publish'),'显式传入 --publish 才发布候选测试事件');
const alias='warehouse3d_candidate_events', path='Warehouse3D_Lab/candidate_events';
const description='独立库存候选验收事件；不代表ERP业务数据';
process.env.SUPOS_UNS_EVENT_ALIAS=alias;
process.env.SUPOS_UNS_EVENT_PATH=path;
const db=new DatabaseSync(join(process.env.SPATIAL_DATA_DIR,'spatial.db'),{readOnly:true});
let event,payload;
try {
  const item=db.prepare('SELECT id FROM item WHERE sku=?').get('SUPOS-QA-20260919');
  assert.ok(item,'缺少指定候选测试货品');
  event=db.prepare("SELECT id,event_type,payload_json FROM outbox_event WHERE event_type='inventory.changed' AND json_extract(payload_json,'$.item_id')=? ORDER BY rowid DESC LIMIT 1").get(item.id);
  assert.ok(event,'没有真实操作事件');
  payload=JSON.parse(event.payload_json);
  const inventory=db.prepare('SELECT qty FROM inventory WHERE item_id=? AND node_id=?').get(item.id,payload.node_id);
  assert.equal(inventory?.qty,payload.qty,'最新事件与当前库存不一致，先检查业务状态');
} finally {db.close();}
const adapter=new SupOSEventAdapter('packages/integration/mapping/supos-uns.yaml');
adapter.brokerUrl=process.env.SUPOS_MQTT_URL || 'mqtt://emqx:1883';
try {
  let model;
  try {model=await adapter.request('/open-api/uns/file/'+alias);}
  catch(error) {
    if(!process.argv.includes('--register')||!/找不到|not found/i.test(error.message))throw error;
    const folder=await adapter.request('/open-api/uns/folder/warehouse3d_lab');
    assert.equal(folder.path,'Warehouse3D_Lab');
    await adapter.request('/open-api/uns/file',{name:'candidate_events',alias,displayName:'候选库存事件',parentAlias:'warehouse3d_lab',description,
      dataType:1,persistence:false,dashBoard:false,addFlow:false,
      definition:['event_id','event_type','payload'].map(name=>({name,type:'STRING',maxLen:name==='payload'?8192:512}))});
    model=await adapter.request('/open-api/uns/file/'+alias);
  }
  assert.equal(model.description,description);
  assert.equal(model.persistence,false);
  const result=await adapter.send(event.event_type,{...payload,_idem:event.id});
  assert.equal(result.ok,true);
  assert.equal(adapter.lastVerifiedEvent,event.id);
  console.log(JSON.stringify({verified:true,event_id:event.id,loc_code:payload.loc_code,qty:payload.qty,path,
    scope:'候选真实事件与UNS当前值完整读回；未修改发件箱状态，非自动派发验收'}));
} finally {await adapter._client?.endAsync(true);}
