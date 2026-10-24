import test from 'node:test';
import assert from 'node:assert/strict';
import {watchWorkStatus} from '../apps/web/prototype/work-status.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));

test('浏览器显示离线但局域网仓库可达时，仍同步待办并在临时失败后恢复',async()=>{
  const doc=new EventTarget();doc.hidden=false;const win=new EventTarget();win.navigator={onLine:false};let calls=0,updates=0,errors=0;
  const monitor=watchWorkStatus({getRoom:()=> 'WH-2',intervalMs:20,doc,win,onUpdate:()=>updates++,onError:error=>{if(error)errors++;},fetcher:async()=>{calls++;if(calls===1)throw Error('暂时不可达');return Response.json({revision:'local',room:'WH-2'});}});
  try{await new Promise(resolve=>setTimeout(resolve,90));assert.ok(calls>=2);assert.equal(errors,1);assert.ok(updates>0);}
  finally{monitor.stop();}
});

test('状态检查暂停隐藏页面，恢复立即补查，失败重试且停止后不再回调',async()=>{
  const doc=new EventTarget();doc.hidden=false;const win=new EventTarget();let calls=0,updates=0,last;
  const monitor=watchWorkStatus({getRoom:()=> 'WH-2',intervalMs:20,doc,win,onUpdate:value=>{updates++;last=value;},fetcher:async()=>{calls++;return Response.json({revision:'same',room:'WH-2'});}});
  try{
    await tick();assert.ok(updates>0);doc.hidden=true;doc.dispatchEvent(new Event('visibilitychange'));const hiddenCalls=calls;await tick();assert.equal(calls,hiddenCalls);
    doc.hidden=false;doc.dispatchEvent(new Event('visibilitychange'));await tick();assert.ok(calls>hiddenCalls);assert.equal(last.room,'WH-2');
    monitor.stop();const stopped=updates;await tick();assert.equal(updates,stopped);
  }finally{monitor.stop();}
});

test('权限失效不发布旧数据，切库期间旧响应不串入新库区',async()=>{
  const doc=new EventTarget();doc.hidden=false;const win=new EventTarget();let room='A',resolve,updates=[],lost=0;
  const monitor=watchWorkStatus({getRoom:()=>room,intervalMs:20,doc,win,onUpdate:value=>updates.push(value.room),onError:error=>{if(error?.accessLost)lost++;},fetcher:async()=>new Promise(done=>resolve=done)});
  try{await tick();room='B';resolve(Response.json({room:'A',revision:'old'}));await tick();assert.deepEqual(updates,[]);resolve(new Response('{}',{status:403}));await tick();assert.equal(lost,1);assert.deepEqual(updates,[]);}
  finally{monitor.stop();}
});
