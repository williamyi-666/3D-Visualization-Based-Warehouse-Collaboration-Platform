// 需在已接入平台网络的应用容器内运行；仅发送指定模拟来源的状态，不排空outbox。
import {DatabaseSync} from 'node:sqlite';import mqtt from 'mqtt';import {join} from 'node:path';
import {createUnsClient} from '../packages/integration/supos-status.mjs';
if(process.env.SPATIAL_MODE!=='integration')throw new Error('仅供独立集成实例联调');
const source='模拟ERP（联调）';
const db=new DatabaseSync(join(process.env.SPATIAL_DATA_DIR || '/data','spatial.db'),{readOnly:true});
let snapshot;try{snapshot=db.prepare('SELECT version,payload FROM external_inventory_snapshot WHERE source=?').get(source);}finally{db.close();}
if(!snapshot)throw new Error('没有指定的模拟快照，拒绝生成虚假状态');
const api=createUnsClient(process.env.SUPOS_INTERNAL_API || 'http://backend:8080');
const model=await api.model(process.argv.includes('--register'));
const rowCount=JSON.parse(snapshot.payload).length;
const timeStamp=Date.now();
const client=await mqtt.connectAsync(process.env.SUPOS_STATUS_MQTT_URL || 'mqtt://emqx:1883',{reconnectPeriod:0,connectTimeout:8000});
try{await client.publishAsync(model.path,JSON.stringify({value:rowCount,timeStamp,quality:192}),{qos:1,retain:false});}finally{await client.endAsync();}
let actual;
for(let i=0;i<10;i++){
 actual=await api.current();
 if(actual?.value===rowCount && Number(actual.timeStamp)===timeStamp)break;
 await new Promise(resolve=>setTimeout(resolve,300));
}
if(actual?.value!==rowCount || Number(actual.timeStamp)!==timeStamp)throw new Error('Broker已确认，但UNS尚未读回本次状态');
console.log(JSON.stringify({source,snapshot_version:snapshot.version,topic:model.path,value:rowCount,timeStamp,verified:true}));
