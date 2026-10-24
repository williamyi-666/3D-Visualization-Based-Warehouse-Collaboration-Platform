import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryDelivery} from '../packages/integration/inventory-delivery.mjs';
test('断网队列持久化、串行补传、响应丢失原消息重试，凭证不落盘',async()=>{
  const sql=new DatabaseSync(':memory:');let offline=true,time=10000,loseAck=false;const delivered=new Map(),calls=[];
  const config={baseUrl:'http://warehouse/',source:'ERP',token:'secret-test-token',now:()=>time,fetcher:async(_url,init)=>{
    if(offline)throw Error('网络不可用');const body=JSON.parse(init.body);calls.push(body.message_id);delivered.set(body.message_id,body);
    if(loseAck){loseAck=false;throw Error('回执丢失');}return Response.json({applied:true,version:body.version});
  }};
  const payload=n=>({mode:'delta',source:'ERP',message_id:'m'+n,version:n+1,base_version:n,changes:[]});
  try{
    let queue=createInventoryDelivery(sql,config);const first=queue.enqueue('order1',payload(1));queue.enqueue('order2',payload(2));await queue.flush();assert.equal(queue.status()[0].state,'pending');assert.equal(calls.length,0);
    queue=createInventoryDelivery(sql,config);assert.equal(queue.enqueue('order1',payload(1)),first);assert.throws(()=>queue.enqueue('order1',payload(2)),/冲突/);
    assert.equal(queue.enqueue('order1',{...payload(1),optional:undefined}),first);
    offline=false;loseAck=true;time+=2000;await Promise.all([queue.flush(),queue.flush()]);assert.deepEqual(calls,['m1']);assert.equal(queue.status()[1].attempts,0);
    time+=4000;await queue.flush();assert.deepEqual(calls,['m1','m1','m2']);assert.equal(delivered.size,2);assert.ok(queue.status().every(r=>r.state==='sent'));
    assert.ok(!JSON.stringify(sql.prepare('SELECT * FROM inventory_delivery').all()).includes(config.token));
    assert.throws(()=>createInventoryDelivery(sql,{...config,baseUrl:'http://other/'}),/其他平台/);
  }finally{sql.close();}
});
test('映射或权限错误保留原消息并阻止越过，修复后可明确重试',async()=>{
  const sql=new DatabaseSync(':memory:');let fixed=false,calls=0;
  const queue=createInventoryDelivery(sql,{baseUrl:'http://warehouse',source:'ERP',token:'token',fetcher:async()=>{calls++;return fixed?Response.json({applied:true}):Response.json({error:'未配置库位映射'},{status:400});}});
  try{
    const payload={source:'ERP',version:1,rows:[]},id=queue.enqueue('first',payload);queue.enqueue('second',{...payload,version:2});
    await queue.flush();assert.equal(queue.status()[0].state,'blocked');assert.equal(queue.status()[1].attempts,0);await queue.flush();assert.equal(calls,1);
    fixed=true;queue.retry(id);await queue.flush();assert.ok(queue.status().every(r=>r.state==='sent'));
  }finally{sql.close();}
});
