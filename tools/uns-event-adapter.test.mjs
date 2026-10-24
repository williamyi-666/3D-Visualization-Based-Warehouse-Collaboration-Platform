import test from 'node:test';
import assert from 'node:assert/strict';
import {SupOSEventAdapter} from '../packages/integration/adapters/suposEventAdapter.mjs';
import {dispatchBatch} from '../packages/integration/dispatch.mjs';

test('UNS事件确认：字段与路径校验、完整读回后sent，过期/篡改/超长时不误报',async()=>{
 const names=['SUPOS_UNS_EVENT_ALIAS','SUPOS_UNS_EVENT_PATH','SUPOS_DRYRUN'];
 const previous=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 process.env.SUPOS_UNS_EVENT_ALIAS='events';process.env.SUPOS_UNS_EVENT_PATH='Warehouse/events';delete process.env.SUPOS_DRYRUN;
 try {
  let published,mode='ok',publishes=0;
  const model={alias:'events',path:'Warehouse/events',dataType:1,definition:['event_id','event_type','payload'].map(name=>({name,type:'STRING',maxLen:8192}))};
  const adapter=new SupOSEventAdapter('packages/integration/mapping/supos-uns.yaml',{sleep:async()=>{},fetcher:async(url)=>({ok:true,json:async()=>({code:200,data:url.endsWith('/batchQuery')?
   {events:mode==='stale'?{...published,event_id:'older'}:mode==='corrupt'?{...published,payload:'{}'}:published}:model})})});
  adapter.publish=async(topic,body)=>{assert.equal(topic,'Warehouse/events');published=body;publishes++;return {ok:true};};
  const event={id:'event-1',event_type:'item.updated',payload_json:JSON.stringify({item_id:'i1',name:'物料属性更新'})};
  const sent=[],failed=[];
  const db={getPendingOutbox:()=>[event],markOutboxSent:id=>sent.push(id),markOutboxRetry:(id,e)=>failed.push([id,e.message])};
  assert.equal((await dispatchBatch(db,[adapter])).dispatched,1);assert.deepEqual(sent,['event-1']);
  assert.equal(published.payload,event.payload_json);assert.equal(adapter.lastVerifiedEvent,'event-1');
  for(const failure of ['stale','corrupt']){
   mode=failure;assert.equal((await dispatchBatch(db,[adapter])).failed,1);
  }
  assert.deepEqual(sent,['event-1']);assert.equal(failed.length,2);
  mode='ok';model.path='Other/events';const before=publishes;
  await assert.rejects(()=>adapter.send('item.updated',{_idem:'e2'}),/标识/);assert.equal(publishes,before);
  model.path='Warehouse/events';model.definition[2].maxLen=2;
  await assert.rejects(()=>adapter.send('item.updated',{_idem:'e2',name:'超长'}),/长度/);assert.equal(publishes,before);
  model.definition[2].maxLen=8192;model.definition[2].type='LONG';
  await assert.rejects(()=>adapter.send('item.updated',{_idem:'e2'}),/字段/);assert.equal(publishes,before);
  await assert.rejects(()=>adapter.send('item.updated',{}),/事件ID/);
  process.env.SUPOS_DRYRUN='1';assert.deepEqual(await adapter.send('item.updated',{_idem:'e2'}),{ok:false,dry:true});
  assert.equal(publishes,before);
 } finally {for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}
});
