import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostBridge } from '../apps/web/prototype/host-bridge.mjs';

test('嵌入通信：限定父窗口和来源，握手后定位，串行执行并返回结果',async()=>{
  const sent=[],calls=[],connections=[];let listener;
  const parent={postMessage:(data,origin)=>sent.push({data,origin})};
  const win={parent,addEventListener:(_,fn)=>listener=fn,removeEventListener:()=>{listener=null;}};
  const bridge=createHostBridge({window:win,allowedOrigins:['http://host'],onConnectionChange:value=>connections.push(value),locate:async p=>{calls.push(p);if(p.loc==='bad') throw new Error('未找到');return p;}});
  const event=(type,payload={},extra={})=>listener({source:parent,origin:'http://host',data:{channel:'spatial-inventory',version:1,type,payload,requestId:'r'},...extra});
  event('hello',{}, {origin:'http://evil'});event('hello',{}, {source:{}});
  event('locate',{sku:'A'});assert.equal(bridge.connected(),false);assert.equal(sent.length,0);
  assert.deepEqual(connections,[]);
  event('hello');assert.deepEqual(connections,[true]);assert.equal(sent[0].data.type,'ready');
  event('locate',{sku:'A'});event('locate',{loc:'bad'});event('locate',{loc:9});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[{sku:'A'},{loc:'bad'}]);
  assert.ok(sent.some(x=>x.data.type==='located' && x.data.requestId==='r'));
  assert.equal(sent.filter(x=>x.data.type==='error').length,2);
  bridge.send('open-business',{sku:'A'});assert.equal(sent.at(-1).data.type,'open-business');
  assert.ok(sent.every(x=>x.origin==='http://host'));bridge.destroy();assert.equal(listener,null);assert.equal(bridge.connected(),false);assert.deepEqual(connections,[true,false]);
});
