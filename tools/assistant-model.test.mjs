import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalAssistantModel} from '../apps/api/assistant-model.mjs';
async function waitFor(check){const deadline=Date.now()+1500;while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(check(),'等待自动连接状态超时');}

test('多人模型请求按顺序排队，失败或取消后仍能继续处理其他人请求',async t=>{
  let loaded=true,finish,active=0,maximum=0;const received=[],states=[];
  const model=createLocalAssistantModel({url:'http://model/',model:'installed',fetchImpl:async(url,options)=>{
    if(url.pathname==='/api/tags')return Response.json({models:[{name:'installed'}]});
    if(url.pathname==='/api/ps')return Response.json({models:loaded?[{name:'installed'}]:[]});
    const message=JSON.parse(options.body).messages[0].content;received.push(message);maximum=Math.max(maximum,++active);
    try{if(message==='first')await new Promise(resolve=>{finish=resolve;});if(message==='fail')return Response.json({error:'模型失败'},{status:500});return Response.json({message:{content:message}});}finally{active--;}
  }});
  t.after(()=>model.close());await model.status();
  const first=model.plan([{role:'user',content:'first'}]);
  const second=model.plan([{role:'user',content:'second'}],{onState:value=>states.push(value)});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal((await model.status()).queued,1);assert.ok(states.some(s=>s.state==='queued'&&s.ahead===1));
  finish();assert.equal((await first).content,'first');assert.equal((await second).content,'second');assert.equal(maximum,1);
  await assert.rejects(model.plan([{role:'user',content:'fail'}]));
  const abort=new AbortController();abort.abort(Error('取消'));
  await assert.rejects(model.plan([{role:'user',content:'cancelled'}],{signal:abort.signal}));
  assert.equal((await model.plan([{role:'user',content:'after'}])).content,'after');assert.ok(!received.includes('cancelled'));
});

test('首次加载期间保留普通作业，助手准备完成后才受理查询',async t=>{
  let loaded=false,finishWarm,chatCalls=0,warmCalls=0;
  const model=createLocalAssistantModel({url:'http://model/',model:'installed',fetchImpl:async(url,options)=>{
    const path=url.pathname;
    if(path==='/api/tags')return Response.json({models:[{name:'installed'}]});
    if(path==='/api/ps')return Response.json({models:loaded?[{name:'installed'}]:[]});
    if(path==='/api/generate'){
      warmCalls++;
      assert.equal(JSON.parse(options.body).prompt,'');
      await new Promise(resolve=>{finishWarm=resolve;});loaded=true;return Response.json({done:true});
    }
    if(path==='/api/chat'){chatCalls++;return Response.json({message:{tool_calls:[{function:{name:'find_stock',arguments:{query:'6204'}}}]}});}
    throw Error('未知模型接口');
  }});
  t.after(()=>model.close());assert.equal(warmCalls,0);
  const first=await model.status();assert.equal(first.available,false);assert.equal(first.warming,true);
  await assert.rejects(model.plan([{role:'user',content:'6204在哪里'}]),error=>error.status===503);
  assert.equal(chatCalls,0);assert.equal(warmCalls,1);
  finishWarm();await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal((await model.status()).warming,false);
  assert.equal((await model.plan([{role:'user',content:'6204在哪里'}])).tool_calls[0].function.name,'find_stock');
  assert.equal(chatCalls,1);
});

test('预热失败后可自动恢复，无需手动重连或重启仓储后台',async t=>{
  let loaded=false,warmCalls=0;
  const model=createLocalAssistantModel({url:'http://model/',model:'installed',retryMs:30,fetchImpl:async url=>{
    if(url.pathname==='/api/tags')return Response.json({models:[{name:'installed'}]});
    if(url.pathname==='/api/ps')return Response.json({models:loaded?[{name:'installed'}]:[]});
    if(url.pathname==='/api/generate'){
      if(++warmCalls===1)return Response.json({error:'暂时内存不足'},{status:503});
      loaded=true;return Response.json({done:true});
    }
    if(url.pathname==='/api/chat')return Response.json({message:{tool_calls:[{function:{name:'find_stock',arguments:{query:'6204'}}}]}});
    throw Error('未知模型接口');
  }});
  t.after(()=>model.close());await model.status();await new Promise(resolve=>setTimeout(resolve,0));
  const failed=model.snapshot();assert.equal(failed.available,false);assert.match(failed.error,/自动重试/);
  await waitFor(()=>model.snapshot().state==='ready');
  assert.equal((await model.status()).available,true);assert.equal(warmCalls,2);
  assert.equal((await model.plan([])).tool_calls[0].function.name,'find_stock');
});

test('按需检测、共享探测、断线恢复和停用不会继续调用模型',async t=>{
  let online=false,calls=0;
  const model=createLocalAssistantModel({url:'http://model/',model:'installed',retryMs:25,fetchImpl:async url=>{
    calls++;if(!online)throw Error('断线');
    await new Promise(resolve=>setTimeout(resolve,5));
    if(url.pathname==='/api/chat')return Response.json({message:{content:'正常'}});
    return Response.json({models:[{name:'installed'}]});
  }});t.after(()=>model.close());
  assert.equal(calls,0);assert.equal((await model.status({activate:false})).state,'idle');
  await Promise.all([model.status(),model.status(),model.status()]);assert.equal(calls,1);assert.equal(model.snapshot().state,'unavailable');
  online=true;await waitFor(()=>model.snapshot().state==='ready');
  online=false;await waitFor(()=>model.snapshot().state==='unavailable');
  online=true;await waitFor(()=>model.snapshot().state==='ready');
  model.configure({enabled:false,url:'http://model/',model:'installed'});const stopped=calls;
  assert.equal((await model.status()).state,'disabled');await assert.rejects(model.plan([]),e=>e.status===503);
  await new Promise(resolve=>setTimeout(resolve,60));assert.equal(calls,stopped);
});

test('切换设置取消旧预热，处理请求期间不能切换目标模型',async t=>{
  let finishWarm,finishChat;
  const model=createLocalAssistantModel({url:'http://old/',model:'installed',fetchImpl:async(url,options)=>{
    if(url.pathname==='/api/tags')return Response.json({models:[{name:'installed'}]});
    if(url.pathname==='/api/ps')return Response.json({models:url.hostname==='old'?[]:[{name:'installed'}]});
    if(url.pathname==='/api/generate'){await new Promise(resolve=>finishWarm=resolve);return Response.json({done:true});}
    if(url.pathname==='/api/chat'){await new Promise(resolve=>finishChat=resolve);return Response.json({message:{content:'正常'}});}
  }});t.after(()=>model.close());
  await model.status();assert.equal(model.snapshot().state,'warming');
  model.configure({enabled:false,url:'http://old/',model:'installed'});finishWarm();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(model.snapshot().state,'disabled');
  model.configure({enabled:true,url:'http://new/',model:'installed'});await model.status();
  const pending=model.plan([]);await new Promise(resolve=>setTimeout(resolve,0));
  assert.throws(()=>model.configure({enabled:false,url:'',model:''}),e=>e.status===409);
  finishChat();await pending;assert.equal(model.snapshot().state,'ready');
});
