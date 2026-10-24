import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=readFileSync('apps/web/prototype/random-id.js','utf8')+'\n'+readFileSync('apps/web/prototype/counter-write.js','utf8');
function browser(send,storage=new Map(),user='operator',basePath='/warehouse'){
  const window={SPATIAL_RUNTIME:{basePath},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},fetch:(path,init)=>path==='/api/auth/me'?Promise.resolve(new Response(JSON.stringify({user:{id:user}}))):send(path,init)};
  vm.runInNewContext(source,{window,crypto:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)}});return window;
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));

test('异常提示区分待确认原请求与确定拒绝，发送前失败不冒称已提交',async()=>{
  for(const path of ['/api/counter/inbound','/api/counter/outbound','/api/counter/move']){
    const options={method:'POST',body:'{"qty":1}'};
    const uncertain=browser(async()=>new Response('{}',{status:502}));
    await uncertain.fetch(path,options);
    assert.match(await uncertain.CounterWrites.failureMessage(path,'失败'),/结果待确认.*核对原请求/);
    const rejected=browser(async()=>new Response('{}',{status:400}));
    await rejected.fetch(path,options);
    assert.equal(await rejected.CounterWrites.failureMessage(path,'库存不足'),'库存不足');
    const localFailure=browser(async()=>{throw Error('不应发送');});
    localFailure.localStorage.setItem=()=>{throw Error('quota');};
    await assert.rejects(localFailure.fetch(path,options),/本次未发送/);
    assert.equal(await localFailure.CounterWrites.failureMessage(path,'本次未发送库存操作'),'本次未发送库存操作');
  }
});

test('出入库台重复点击共用请求，丢响应原编号重试，成功后新业务使用新编号',async()=>{
  const calls=[];let complete;
  const window=browser((input,init)=>{calls.push(JSON.parse(init.body));return new Promise(resolve=>{complete=resolve;});});
  const path='/api/counter/inbound',options={method:'POST',body:JSON.stringify({qty:3,sku:'A'})};
  const a=window.fetch(path,options),b=window.fetch(path,options);
  await settle();
  assert.equal(calls.length,1);complete(new Response('{}',{status:503}));await a;await b;
  await assert.rejects(window.fetch(path,{...options,body:'{"qty":4}'}),/尚未确认/);
  const retry=window.fetch(path,options);await settle();assert.equal(calls[0].request_id,calls[1].request_id);
  complete(new Response('{}'));await retry;
  const next=window.fetch(path,options);await settle();assert.notEqual(calls[1].request_id,calls[2].request_id);
  complete(new Response('{}'));await next;
});

test('响应丢失后关闭窗口，原账号恢复原请求；不同账号和应用不混用',async()=>{
  const storage=new Map(),calls=[],path='/api/counter/outbound',options={method:'POST',body:JSON.stringify({qty:2,item_id:'item-A',loc_code:'WH-A'})};
  const first=browser(async(path,init)=>{calls.push(JSON.parse(init.body));throw Error('响应丢失');},storage);
  await assert.rejects(first.fetch(path,options),/响应丢失/);
  const second=browser(async(path,init)=>{calls.push(JSON.parse(init.body));return new Response('{"replayed":true}');},storage);
  assert.equal((await second.CounterWrites.list()).length,1);
  assert.equal((await browser(()=>{},storage,'another').CounterWrites.list()).length,0);
  assert.equal((await browser(()=>{},storage,'operator','/another').CounterWrites.list()).length,0);
  const result=await(await second.CounterWrites.retry(path)).json();assert.equal(result.replayed,true);
  assert.deepEqual(calls[0],calls[1]);assert.equal((await second.CounterWrites.list()).length,0);
});

test('存储失败不发送库存写入；权限拒绝保留历史未知请求',async()=>{
  let sent=0;const window=browser(async()=>{sent++;return new Response('{}',{status:403});});
  const path='/api/counter/move',options={method:'POST',body:'{"qty":1}'};
  await window.fetch(path,options);assert.equal((await window.CounterWrites.list()).length,1);
  window.localStorage.setItem=()=>{throw Error('quota');};
  await assert.rejects(window.fetch('/api/counter/inbound',options),/本次未发送/);
  assert.equal(sent,1);
});

test('导入预览不保留业务请求，实际导入丢响应后使用原编号恢复',async()=>{
  const storage=new Map(),calls=[];
  const rows=[{sku:'A',qty:1,loc_code:'WH-A'}];
  const first=browser(async(path,init)=>{
    const body=JSON.parse(init.body);calls.push(body);
    if(body.preview)return new Response('{}');
    throw Error('响应丢失');
  },storage);
  await first.fetch('/api/import',{method:'POST',body:JSON.stringify({rows,preview:true})});
  assert.equal((await first.CounterWrites.list()).length,0);assert.equal(calls[0].request_id,undefined);
  await assert.rejects(first.fetch('/api/import',{method:'POST',body:JSON.stringify({rows})}),/响应丢失/);
  const next=browser(async(path,init)=>{calls.push(JSON.parse(init.body));return new Response('{}');},storage);
  await next.CounterWrites.retry('/api/import');assert.deepEqual(calls[1],calls[2]);
});
