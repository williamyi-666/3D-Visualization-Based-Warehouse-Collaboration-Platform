// 独立联调：代理只影响本脚本连接，不停止平台Broker、不派发业务发件箱。
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {dispatchBatch} from '../packages/integration/dispatch.mjs';
import net from 'node:net';import {once} from 'node:events';import {randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
import mqtt from 'mqtt';import {SupOSAdapter} from '../packages/integration/adapters/suposUnsAdapter.mjs';
const address=new URL(process.argv[2] || 'mqtt://127.0.0.1:21883');
if(address.protocol!=='mqtt:')throw new Error('联调代理仅支持mqtt TCP');
const sockets=new Set();
const proxy=net.createServer(socket=>{
 const remote=net.connect(Number(address.port || 1883),address.hostname);sockets.add(socket);sockets.add(remote);
 socket.pipe(remote);remote.pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
 for(const s of [socket,remote])s.on('close',()=>sockets.delete(s));
});
const topic='spatial-validation/'+randomUUID();let sub,adapter,db;
const data=mkdtempSync(join(tmpdir(),'spatial-mqtt-smoke-'));
const oldData=process.env.SPATIAL_DATA_DIR;
process.env.SPATIAL_DATA_DIR=data;
const timeout=()=>AbortSignal.timeout(15000);
try {
 db=await import('../apps/api/db.mjs');
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const port=proxy.address().port;
 sub=mqtt.connect(address.href,{reconnectPeriod:0});await once(sub,'connect',{signal:timeout()});
 await sub.subscribeAsync(topic,{qos:1});
 const received=[];sub.on('message',(_,payload)=>received.push(JSON.parse(payload.toString())));
 adapter=new SupOSAdapter('packages/integration/mapping/supos-uns.yaml');adapter.brokerUrl='mqtt://127.0.0.1:'+port;
 adapter.mapping.topic.inventory.changed=topic; // 仅替换主题，不改变实际字段映射和发送实现。
 const enqueue=qty=>{db.emit('inventory.changed',{loc_code:'WH-1-A-L01-B01',item_id:'SMOKE-ITEM',qty});return db.getPendingOutbox().at(-1).id;};
 const eventState=id=>db.default.prepare('SELECT status,attempts FROM outbox_event WHERE id=?').get(id);
 assert.ok(await adapter.ensureClient());assert.ok(adapter.connected);
 const first=enqueue(7);
 assert.equal((await dispatchBatch(db,[adapter])).dispatched,1);
 assert.equal(eventState(first).status,'sent');
 const closed=once(adapter._client,'close',{signal:timeout()});
 for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));await closed;
 assert.equal(adapter.connected,false);
 const second=enqueue(9);
 assert.equal((await dispatchBatch(db,[adapter])).failed,1);
 assert.equal(eventState(second).status,'pending');assert.equal(eventState(second).attempts,1);
 const connected=once(adapter._client,'connect',{signal:timeout()});
 proxy.listen(port,'127.0.0.1');await connected;
 const delivered=once(sub,'message',{signal:timeout()});
 assert.equal((await dispatchBatch(db,[adapter])).dispatched,1);await delivered;
 assert.equal(eventState(second).status,'sent');assert.equal(eventState(second).attempts,1);
 assert.ok(received.some(r=>r.event_id===first && r.quantity===7 && r.event_type==='inventory.changed'));
 assert.ok(received.some(r=>r.event_id===second && r.quantity===9 && r.item_id==='SMOKE-ITEM'));
 assert.ok(received.filter(r=>r.event_type==='inventory.changed').every(r=>!('sku' in r)), '内部物料ID不得冒充SKU');
 // 真实导入函数产生事件，经同一适配器到Broker；仍只写临时SQLite与随机测试主题。
 adapter.mapping.topic.item.created=topic;
 db.importItems([
  {name:'MQTT导入联调',sku:'MQTT-IMPORT',qty:3,loc_code:'WH-1-A-L01-B01'},
  {name:'MQTT导入联调',sku:'MQTT-IMPORT',qty:4,loc_code:'WH-1-A-L01-B01'},
  {name:'MQTT导入联调',sku:'MQTT-IMPORT',qty:2,loc_code:'WH-1-B-L01-B01'},
 ]);
 const imported=db.getPendingOutbox();
 assert.equal(imported.length,4);
 assert.equal((await dispatchBatch(db,[adapter])).dispatched,4);
 const deadline=Date.now()+5000;
 while(!imported.every(e=>received.some(r=>r.event_id===e.id)) && Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
 for(const e of imported){
  assert.equal(eventState(e.id).status,'sent');
  const actual=received.find(r=>r.event_id===e.id);assert.ok(actual);
  const expected=JSON.parse(e.payload_json);
  assert.equal(actual.loc_code,expected.loc_code);
  if(e.event_type==='inventory.changed')assert.equal(actual.quantity,expected.qty);
 }
 assert.deepEqual(imported.filter(e=>e.event_type==='inventory.changed').map(e=>JSON.parse(e.payload_json).qty),[3,7,2]);
 // 空间事件使用真实主题模板，隔离租户名，避免触及已注册的业务UNS路径。
 adapter.tenant='spatial-validation-'+randomUUID();
 db.createSite({code:'MQTTWH',name:'MQTT空间联调'});
 db.saveLayout({roomId:'MQTTWH-1',room:{width:15}});
 const spatial=db.getPendingOutbox();assert.equal(spatial.length,2);
 for(const e of spatial)await sub.subscribeAsync(adapter.topicFor(e.event_type,JSON.parse(e.payload_json)),{qos:1});
 assert.equal((await dispatchBatch(db,[adapter])).dispatched,2);
 const spatialDeadline=Date.now()+5000;
 while(!spatial.every(e=>received.some(r=>r.event_id===e.id)) && Date.now()<spatialDeadline)await new Promise(r=>setTimeout(r,50));
 for(const e of spatial){
  const actual=received.find(r=>r.event_id===e.id);assert.ok(actual);
  assert.equal(actual.event_type,e.event_type);assert.equal(eventState(e.id).status,'sent');
  assert.equal(actual.code,e.event_type==='site.created'?'MQTTWH':'MQTTWH-1');
  if(e.event_type==='layout.saved')assert.equal(actual.rack_count,0);
 }
 const importedItem=db.default.prepare('SELECT id FROM item WHERE sku=?').get('MQTT-IMPORT').id;
 db.deleteItem(importedItem);
 const deleted=db.getPendingOutbox();assert.equal(deleted.length,2);
 for(const e of deleted)await sub.subscribeAsync(adapter.topicFor(e.event_type,JSON.parse(e.payload_json)),{qos:1});
 assert.equal((await dispatchBatch(db,[adapter])).dispatched,2);
 const deleteDeadline=Date.now()+5000;
 while(!deleted.every(e=>received.some(r=>r.event_id===e.id)) && Date.now()<deleteDeadline)await new Promise(r=>setTimeout(r,50));
 for(const e of deleted){
  const actual=received.find(r=>r.event_id===e.id),expected=JSON.parse(e.payload_json);assert.ok(actual);
  assert.equal(actual.event_type,'item.deleted');assert.equal(actual.item_id,importedItem);
  assert.equal(actual.sku,'MQTT-IMPORT');assert.equal(actual.loc_code,expected.loc_code);
  assert.equal(actual.previous_qty,expected.previous_qty);assert.equal(eventState(e.id).status,'sent');
 }
 db.emit('inventory.changed',{item_id:'NO-LOCATION',qty:1});
 assert.equal((await dispatchBatch(db,[adapter])).failed,1);
 assert.equal(db.getPendingOutbox().length,1);
 console.log('真实MQTT发件箱联调通过：字段映射、确认后sent、断线保持pending并记重试、恢复后同一事件ID发送、批量导入逐库位累计数量、仓库与布局主题映射、删除后原库位物料快照、缺少库位仍待发；均为独立非保留测试消息');
} finally {
 await adapter?._client?.endAsync(true);await sub?.endAsync(true);
 for(const socket of sockets)socket.destroy();if(proxy.listening)await new Promise(resolve=>proxy.close(resolve));
 db?.default.close();rmSync(data,{recursive:true,force:true}); // 只清理本脚本创建的临时数据库。
 if(oldData===undefined)delete process.env.SPATIAL_DATA_DIR;else process.env.SPATIAL_DATA_DIR=oldData;
}
