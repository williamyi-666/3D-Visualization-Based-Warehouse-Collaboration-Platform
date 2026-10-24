import test from 'node:test';
import assert from 'node:assert/strict';
import {createWarehouseSync} from '../packages/integration/warehouse-sync.mjs';
const cell=qty=>({alias:'cell',path:'root/cell',occupied:qty?1:0,snapshot:JSON.stringify({inventory:[{sku:'A',qty,unit:'kg'}]})});
test('失败后即使库存回到旧基线也必须实际读回，不能以未变化宣告恢复',async()=>{
  let qty=3,fail=false,readFail=false,saved;
  const platform=new Map();let calls=0;
  const run=createWarehouseSync({now:()=>0,readPlan:()=>{
    if(readFail)throw Error('数据库暂不可用');
    return {models:[],values:[cell(qty)]};
  },save:p=>saved=p,publish:async plan=>{
    calls++;
    for(const value of plan.values)platform.set(value.alias,value.snapshot);
    if(fail)throw Error('发布后读回失败');
    return {verified:plan.values.length};
  }});
  await run();qty=4;fail=true;
  await assert.rejects(run,/发布后读回失败/);
  assert.equal(JSON.parse(saved.values[0].snapshot).inventory[0].qty,3);
  qty=3;
  await assert.rejects(run,/发布后读回失败/);
  fail=false;
  assert.equal((await run()).verified,1);
  assert.equal(JSON.parse(platform.get('cell')).inventory[0].qty,3);
  assert.equal(calls,4);
  readFail=true;await assert.rejects(run,/数据库暂不可用/);
  readFail=false;assert.equal((await run()).verified,1);
  assert.equal(calls,5);
  assert.equal((await run()).unchanged,true);
});
test('仓库缺失使旧值失效，失败可重试，恢复后重新发布真实库存',async()=>{
  let missing=false,fail=false,saved,published,calls=0;
  const options={load:()=>saved,save:p=>saved=p,readPlan:()=>{
    if(missing)throw Object.assign(Error('仓库不存在：WH'),{code:'WAREHOUSE_NOT_FOUND',siteCode:'WH'});
    return {models:[],values:[cell(3)]};
  },publish:async p=>{calls++;if(fail)throw Error('暂时断网');published=p;return {verified:p.values.length};}};
  let run=createWarehouseSync(options);await run();missing=true;fail=true;
  await assert.rejects(run,/暂时断网/);assert.equal(JSON.parse(saved.values[0].snapshot).inventory[0].qty,3);
  fail=false;const result=await run();assert.equal(result.status,'warehouse_missing');assert.equal(result.site,'WH');
  const value=published.values[0],snapshot=JSON.parse(value.snapshot);
  assert.equal(value.occupied,0);assert.equal(snapshot.unavailable,true);assert.equal(snapshot.unavailable_reason,'warehouse_missing');
  assert.deepEqual(snapshot.inventory,[]);assert.equal(snapshot.deleted,undefined);
  const before=calls;assert.equal((await run()).unchanged,true);assert.equal(calls,before);
  run=createWarehouseSync(options);await run();assert.equal(published.values.length,1);
  missing=false;await run();const restored=JSON.parse(published.values[0].snapshot);
  assert.equal(restored.unavailable,undefined);assert.equal(restored.inventory[0].qty,3);
  let publishedOnError=false;
  await assert.rejects(createWarehouseSync({load:()=>saved,readPlan:()=>{throw Error('数据库忙');},publish:()=>{publishedOnError=true;}}),/数据库忙/);
  assert.equal(publishedOnError,false);
});
test('仅发布变化；失败不推进基线，删除清空快照，重启仍记住删除',async()=>{
  let current={models:[],values:[cell(3)]},saved,fail=false;const calls=[];
  const options={readPlan:()=>current,load:()=>saved,save:p=>saved=p,publish:async p=>{calls.push(p);if(fail)throw Error('断网');return {verified:p.values.length};}};
  const run=createWarehouseSync(options);
  await run();assert.equal((await run()).unchanged,true);assert.equal(calls.length,1);
  current={models:[],values:[cell(4)]};fail=true;await assert.rejects(run,/断网/);
  assert.equal(JSON.parse(saved.values[0].snapshot).inventory[0].qty,3);
  fail=false;await run();assert.equal(JSON.parse(saved.values[0].snapshot).inventory[0].qty,4);
  current={models:[],values:[]};await run();
  assert.equal(saved.values[0].occupied,0);assert.equal(JSON.parse(saved.values[0].snapshot).deleted,true);
  assert.deepEqual(JSON.parse(saved.values[0].snapshot).inventory,[]);
  await createWarehouseSync(options)();assert.equal(calls.at(-1).values.length,1);
  current={models:[],values:[cell(2)]};await run();assert.equal(JSON.parse(saved.values[0].snapshot).inventory[0].qty,2);
});
test('新父节点优先于移动的格位，已删除子节点路径跟随父空间',async()=>{
  const root={alias:'root',name:'Root'};
  const old={models:[root,{alias:'rack',name:'Rack',parentAlias:'root',path:'Root/Rack'},
    {alias:'cell',name:'Cell',parentAlias:'rack',path:'Root/Rack/Cell'}],values:[{...cell(0),path:'Root/Rack/Cell'}]};
  let sent;
  const run=createWarehouseSync({load:()=>old,readPlan:()=>({models:[root,
    {alias:'room',name:'Room',parentAlias:'root',path:'Root/Room'},
    {alias:'rack',name:'Rack',parentAlias:'room',path:'Root/Room/Rack'}],values:[]}),publish:async p=>{sent=p;return {};}});
  await run();assert.deepEqual(sent.models.map(m=>m.alias),['root','room','rack','cell']);
  assert.equal(sent.values[0].path,'Root/Room/Rack/Cell');assert.equal(JSON.parse(sent.values[0].snapshot).deleted,true);
});

test('平台丢失当前值后定期全量恢复，失败及持续增量不推迟恢复',async()=>{
  let time=0,current={models:[],values:[cell(3),{...cell(4),alias:'other',path:'root/other'}]};
  const platform=new Map();let failed=false;const calls=[];
  const run=createWarehouseSync({now:()=>time,refreshMs:100,readPlan:()=>current,publish:async plan=>{
    calls.push(plan);if(failed)throw Error('平台不可用');
    for(const value of plan.values)platform.set(value.alias,value.snapshot);
    return {verified:plan.values.length};
  }});
  await run();assert.equal(platform.size,2);platform.clear();
  time=50;assert.equal((await run()).unchanged,true);assert.equal(platform.size,0);
  current={...current,values:[cell(5),current.values[1]]};time=90;
  await run();assert.equal(calls.at(-1).values.length,1);assert.equal(platform.size,1);
  time=100;failed=true;await assert.rejects(run,/平台不可用/);
  assert.equal(calls.at(-1).values.length,2);
  time=101;failed=false;await run();assert.equal(platform.size,2);
  assert.equal(JSON.parse(platform.get('cell')).inventory[0].qty,5);
  time=200;assert.equal((await run()).unchanged,true);
  time=201;await run();assert.equal(calls.at(-1).values.length,2);
});
