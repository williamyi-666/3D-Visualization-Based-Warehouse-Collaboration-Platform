// 候选专用：创建自有UNS模型，删除后验证全量同步能重建；不读写业务数据库。
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import {randomUUID} from 'node:crypto';
import {buildWarehouseModel} from '../packages/integration/warehouse-model.mjs';
import {createWarehouseSync} from '../packages/integration/warehouse-sync.mjs';
import {warehouseUnsRequest,publishWarehouseModel} from '../packages/integration/warehouse-publish.mjs';

assert.equal(process.env.SPATIAL_BASE_PATH,'/warehouse-standalone');
const alias='rebuildqa_'+randomUUID().replaceAll('-','').slice(0,16);
const plan=buildWarehouseModel({nodes:[
  {id:'rebuild-site',node_type:'site',loc_code:'REBUILD-QA',name:'模型重建测试仓'},
  {id:'rebuild-cell',parent_id:'rebuild-site',node_type:'cell',loc_code:'REBUILD-QA-CELL',name:'模型重建测试格'}
],inventory:[{node_id:'rebuild-cell',item_id:'rebuild-item',sku:'REBUILD-QA',name:'模拟物料',unit:'kg',qty:3}]},{alias,name:'RebuildQA'+alias.slice(-12)});
const request=warehouseUnsRequest(process.env.SUPOS_INTERNAL_API||'http://backend:8080');
const client=await mqtt.connectAsync(process.env.SUPOS_MQTT_URL,{reconnectPeriod:0,connectTimeout:8000});
const cell=plan.models.find(m=>m.kind==='file');
let state,clock=1000;
const options={readPlan:()=>plan,load:()=>state,save:value=>state=value,now:()=>clock,
  publish:p=>publishWarehouseModel(p,{request,register:true,update:true,publish:(path,value)=>client.publishAsync(path,JSON.stringify(value),{qos:1,retain:false})})};
const run=createWarehouseSync(options);
async function absent(model){
  await assert.rejects(request(model.kind+'/'+model.alias),e=>e.code===400&&/找不到|not found/i.test(e.message));
}
async function check(stage,result){
  const v=(await request('file/current/batchQuery',[cell.alias]))[cell.alias];
  assert.equal(v.occupied,1);assert.equal(JSON.parse(v.snapshot).inventory[0].qty,3);
  console.log(JSON.stringify({stage,...result,passed:true,alias}));
}
try {
  await absent(plan.models[0]);
  await check('建立独立测试模型',await run());
  assert.equal((await run()).unchanged,true);
  await request('batch/alias',{aliasList:[cell.alias]},'DELETE');await absent(cell);
  // 前进同步器时钟触发正式的五分钟刷新分支，不用睡眠阻塞五分钟。
  clock+=300001;
  const rebuilt=await run();assert.equal(rebuilt.created,1);
  await check('格位模型删除后全量刷新重建',rebuilt);
  await request('batch/alias',{aliasList:[plan.models[0].alias]},'DELETE');
  for(const model of plan.models)await absent(model);
  clock+=300001;
  const tree=await run();assert.equal(tree.created,plan.models.length);
  await check('整棵测试树删除后按父子顺序重建',tree);
} finally {
  try {
    await request('batch/alias',{aliasList:[plan.models[0].alias]},'DELETE');
    for(const model of plan.models)await absent(model);
    console.log(JSON.stringify({stage:'仅清理本次自有模型',verified:true,alias}));
  } finally {await client.endAsync(true);}
}
