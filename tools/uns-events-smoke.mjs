// 在平台网络内运行；--register显式创建缺失模型，不覆盖已有模型。
// 只使用临时数据库和专用联调模型，不读取或派发业务发件箱。
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import mqtt from 'mqtt';
import {SupOSEventAdapter} from '../packages/integration/adapters/suposEventAdapter.mjs';
import {dispatchBatch} from '../packages/integration/dispatch.mjs';
const base=process.env.SUPOS_INTERNAL_API || 'http://backend:8080';
const alias='warehouse3d_lab_events',path='Warehouse3D_Lab/business_events';
const description='仓储应用事件模型联调；仅模拟数据，不代表ERP业务处理成功';
async function request(route,body){
 const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
 const result=await r.json();if(!r.ok||![0,200].includes(result.code)){const e=Error(result.msg||'UNS请求失败');e.code=result.code;throw e;}
 return result.data;
}
let model;
try {model=await request('/open-api/uns/file/'+alias);}
catch(error){
 if(!process.argv.includes('--register')||error.code!==400||!/找不到|not found/i.test(error.message))throw error;
 const folder=await request('/open-api/uns/folder/warehouse3d_lab');
 assert.equal(folder.path,'Warehouse3D_Lab');
 assert.equal(folder.description,'仓储应用模型联调，仅展示应用状态，不是ERP库存业务写入');
 await request('/open-api/uns/file',{name:'business_events',alias,displayName:'模拟仓储业务事件',parentAlias:'warehouse3d_lab',
  dataType:1,description,persistence:false,dashBoard:false,addFlow:false,
  definition:['event_id','event_type','payload'].map(name=>({name,type:'STRING',maxLen:name==='payload'?8192:512}))});
 model=await request('/open-api/uns/file/'+alias);
}
assert.equal(model.path,path);assert.equal(model.description,description);assert.equal(model.dataType,1);
assert.equal(model.persistence,false,'联调模型不启用业务持久化');
const fields=model.definition.filter(f=>!f.systemField);
assert.equal(fields.length,3);
for(const name of ['event_id','event_type','payload']){
 const f=fields.find(f=>f.name===name);assert.equal(f?.type,'STRING');
 assert.ok(f.maxLen >= (name==='payload'?8192:512),'模型字段长度不足');
}
const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'warehouse-uns-events-'));
const previous=process.env.SPATIAL_DATA_DIR;process.env.SPATIAL_DATA_DIR=dir;
let db,client,adapter;
try {
 db=await import('../apps/api/db.mjs');
 const site=db.createSite({code:'UNSTEST',name:'UNS模拟仓库'});
 const room=db.createRoomNode({siteCode:site.loc_code,name:'UNS模拟库区'});
 const rack=db.createRack({roomCode:room.loc_code,name:'UNS模拟货架',rows:1,cols:2}).furn_code;
 const loc=rack+'-L01-B01';
 db.importItems([{name:'UNS模拟物料',sku:'UNS-SMOKE',qty:3,loc_code:loc}]);
 const id=db.default.prepare('SELECT id FROM item WHERE sku=?').get('UNS-SMOKE').id;
 db.updateItem(id,{name:'UNS模拟物料已更新',qty:5});
 db.updateRack(rack,{name:'UNS模拟货架已更新'});
 db.saveLayout({roomId:room.loc_code,room:{width:15}});
 db.deleteItem(id);db.deleteRack(rack);db.deleteRoom(room.loc_code);
 const events=db.getPendingOutbox();
 const expected=['site.created','room.created','rack.created','item.created','inventory.changed','item.updated','rack.updated','layout.saved','item.deleted','rack.deleted','room.deleted'].sort();
 assert.deepEqual([...new Set(events.map(e=>e.event_type))].sort(),expected);
 if(process.argv.includes('--outbox')){
  process.env.SUPOS_UNS_EVENT_ALIAS=alias;process.env.SUPOS_UNS_EVENT_PATH=path;
  adapter=new SupOSEventAdapter('packages/integration/mapping/supos-uns.yaml');
  adapter.apiBase=base;adapter.brokerUrl=process.env.SUPOS_STATUS_MQTT_URL || 'mqtt://emqx:1883';
  const result=await dispatchBatch(db,[adapter]);
  assert.equal(result.dispatched,events.length);assert.equal(result.failed,0);assert.equal(db.getPendingOutbox().length,0);
  assert.equal(adapter.lastVerifiedEvent,events.at(-1).id);
 } else {
 client=await mqtt.connectAsync(process.env.SUPOS_STATUS_MQTT_URL || 'mqtt://emqx:1883',{reconnectPeriod:0,connectTimeout:8000});
 let sequence=Date.now();
 for(const event of events){
  const timeStamp=++sequence;
  assert.ok(Buffer.byteLength(event.payload_json,'utf8')<=8192,'事件超过模型字段长度');
  const message={event_id:event.id,event_type:event.event_type,payload:event.payload_json,timeStamp,quality:192};
  await client.publishAsync(model.path,JSON.stringify(message),{qos:1,retain:false});
  let actual;
  for(let i=0;i<20;i++){
   actual=(await request('/open-api/uns/file/current/batchQuery',[alias]))?.[alias];
   if(actual?.event_id===event.id && Number(actual.timeStamp)===timeStamp)break;
   await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(actual?.event_id,event.id,'Broker已确认，但UNS未读回当前事件');
  assert.equal(Number(actual.timeStamp),timeStamp);assert.equal(actual.event_type,event.event_type);
  assert.equal(actual.payload,event.payload_json,'UNS事件内容与发件箱不一致');
 }
 }
 console.log(JSON.stringify({verified:true,mode:process.argv.includes('--outbox')?'outbox-adapter':'direct',topic:model.path,events:events.length,eventTypes:expected,
  scope:'临时数据库生成的业务事件逐条读回；不代表真实ERP处理、平台持久化或运行时发件箱已切换'}));
} finally {
 await client?.endAsync(true);await adapter?._client?.endAsync(true);db?.default.close();
 if(previous===undefined)delete process.env.SPATIAL_DATA_DIR;else process.env.SPATIAL_DATA_DIR=previous;
 const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
 rmSync(dir,{recursive:true,force:true});
}
