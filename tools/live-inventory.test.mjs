import test from 'node:test';
import assert from 'node:assert/strict';
import express from '../apps/api/node_modules/express/index.js';
import {mountLiveScene,sceneRevision} from '../apps/api/live-scene.mjs';
import {inventoryDelta,mountLiveInventory,inventorySyncMessage} from '../apps/web/prototype/live-inventory.mjs';

test('权限失效停止刷新并通知页面限制操作',async()=>{
 const doc=new EventTarget();doc.hidden=false;const win=new EventTarget();let lost=0,refreshes=0,message='';
 const stop=mountLiveInventory({getRoom:()=> 'A',refresh:async()=>refreshes++,isBusy:()=>false,status:s=>message=s,onAccessLost:()=>lost++,doc,win,
 fetcher:async()=>new Response('{}',{status:403})});
 try{await new Promise(r=>setTimeout(r,30));assert.equal(lost,1);assert.equal(refreshes,0);assert.match(message,/重新登录/);}
 finally{stop();}
});

test('断网期间不刷新，恢复网络后补查且保留断网提示',async()=>{
 const doc=new EventTarget();doc.hidden=false;const win=new EventTarget();let refreshes=0,message='',stream;
 const stop=mountLiveInventory({getRoom:()=> 'A',refresh:async()=>refreshes++,isBusy:()=>false,status:s=>message=s,doc,win,
 fetcher:async(_url,{signal})=>new Response(new ReadableStream({start(c){stream=c;signal.addEventListener('abort',()=>c.close());c.enqueue(new TextEncoder().encode('data: {"revision":"1"}\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}})});
 try{await new Promise(r=>setTimeout(r,30));assert.equal(refreshes,1);win.dispatchEvent(new Event('offline'));assert.match(message,/网络已断开/);
 await new Promise(r=>setTimeout(r,550));assert.equal(refreshes,1);win.dispatchEvent(new Event('online'));await new Promise(r=>setTimeout(r,30));assert.equal(refreshes,2);}
 finally{stop();}
});

test('库存变化仅重建受影响货架，布局变化单独识别',()=>{
 const before={roomCode:'A',furniture:[{code:'R',items:{a:[{qty:1}]}},{code:'S',items:{}}]};
 const after=structuredClone(before);after.furniture[0].items.a[0].qty=2;
 assert.deepEqual(inventoryDelta(before,after),{rebuild:false,changed:['R']});
 after.furniture[0].width=2;assert.equal(inventoryDelta(before,after).rebuild,true);
 assert.notEqual(sceneRevision(before),sceneRevision(after));
});

test('ERP失败或超时即使数量未变也通知页面，库存旧值提示不覆盖断网或编辑提示',()=>{
  const scene={roomCode:'A',furniture:[],sync:[{source:'ERP',state:'ok',version:1}]},failed=structuredClone(scene);failed.sync[0].state='failed';
  assert.notEqual(sceneRevision(scene),sceneRevision(failed));assert.deepEqual(inventoryDelta(scene,failed),{rebuild:false,changed:[]});
  assert.match(inventorySyncMessage('库存已同步',failed.sync),/ERP同步失败.*上次成功/);
  assert.match(inventorySyncMessage('库存自动同步已连接',[{state:'stale'}]),/ERP更新超时/);
  assert.equal(inventorySyncMessage('网络已断开，当前为上次库存',failed.sync),'网络已断开，当前为上次库存');
  assert.equal(inventorySyncMessage('库存有更新，结束当前操作后同步',failed.sync),'库存有更新，结束当前操作后同步');
});

test('两个订阅者收到同一已提交变化，跨仓变动不通知，撤权后关闭连接',async()=>{
 const app=express();let authorized=true;
 const scenes={A:{roomCode:'A',furniture:[{items:{qty:1}}]},B:{roomCode:'B',furniture:[]}};
 mountLiveScene(app,{readScene:req=>scenes[req.query.room],authorize:()=>authorized,intervalMs:30});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const controllers=[];
 async function open(room){const c=new AbortController();controllers.push(c);const response=await fetch(`http://127.0.0.1:${server.address().port}/api/scene/events?room=${room}`,{signal:c.signal});return response.body.getReader();}
 try{
  const a=await open('A'),b=await open('A');
  const first=new TextDecoder().decode((await a.read()).value);await b.read();
  scenes.B.furniture.push({items:{qty:8}});
  scenes.A.furniture[0].items.qty=2;
  const changed=await Promise.all([a.read(),b.read()]);
  assert.ok(changed.every(r=>new TextDecoder().decode(r.value)!==first));
  assert.equal(new TextDecoder().decode(changed[0].value),new TextDecoder().decode(changed[1].value));
  const revision=sceneRevision(scenes.A);scenes.B.furniture.push({items:{qty:9}});assert.equal(sceneRevision(scenes.A),revision);
  authorized=false;scenes.A.furniture[0].items.qty=3;
  assert.match(new TextDecoder().decode((await a.read()).value),/access-expired/);
 }finally{controllers.forEach(c=>c.abort());server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('打开表单时暂缓同步，关闭后合并刷新且释放连接',async()=>{
 let busy=true,calls=0,stream;
 const doc=new EventTarget();doc.hidden=false;const win=new EventTarget();
 const stop=mountLiveInventory({getRoom:()=> 'A',isBusy:()=>busy,refresh:async()=>{calls++;},status:()=>{},doc,win,
 fetcher:async()=>new Response(new ReadableStream({start(c){stream=c;c.enqueue(new TextEncoder().encode('data: {"revision":"1"}\n\n'));}}),{headers:{'Content-Type':'text/event-stream'}})});
 try{await new Promise(r=>setTimeout(r,40));assert.equal(calls,0);busy=false;
 await new Promise(r=>setTimeout(r,550));assert.equal(calls,1);
 stream.enqueue(new TextEncoder().encode('data: {"revision":"1"}\n\n'));await new Promise(r=>setTimeout(r,40));assert.equal(calls,1);
 }finally{stop();stream.close();}
});
