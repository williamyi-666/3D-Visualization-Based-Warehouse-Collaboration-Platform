import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import mqtt from 'mqtt';
import {readWarehouseSnapshot,buildWarehouseModel} from '../packages/integration/warehouse-model.mjs';
import {warehouseUnsRequest,publishWarehouseModel} from '../packages/integration/warehouse-publish.mjs';
assert.equal(process.env.SPATIAL_BASE_PATH,'/warehouse-standalone','仅允许隔离候选');
assert.ok(process.argv.includes('--publish'),'需显式 --publish');
const db=new DatabaseSync(join(process.env.SPATIAL_DATA_DIR,'spatial.db'),{readOnly:true});
let plan;
try {plan=buildWarehouseModel(readWarehouseSnapshot(db,'WH'));} finally {db.close();}
const request=warehouseUnsRequest(process.env.SUPOS_INTERNAL_API||'http://backend:8080');
const client=await mqtt.connectAsync(process.env.SUPOS_MQTT_URL||'mqtt://emqx:1883',{reconnectPeriod:0,connectTimeout:8000});
try {
  const result=await publishWarehouseModel(plan,{request,register:process.argv.includes('--register'),
    publish:(path,value)=>client.publishAsync(path,JSON.stringify(value),{qos:1,retain:false}),progress:r=>console.log(JSON.stringify(r))});
  console.log(JSON.stringify({...result,occupied:plan.values.filter(v=>v.occupied).length,scope:'候选仓库完整快照已发布并读回；尚非持续空间同步'}));
} finally {await client.endAsync(true);}
