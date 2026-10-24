import test from 'node:test';
import assert from 'node:assert/strict';
import {startDispatchLoop} from '../packages/integration/scheduler.mjs';

test('派发完成后再调度，失败仍继续，停止后不再重试',async()=>{
  const timers=[],reports=[],errors=[];let resolve,calls=0;
  const stop=startDispatchLoop({intervalMs:5000,dispatch:()=>{
    calls++;if(calls===1)return new Promise(r=>resolve=r);throw Error('网络中断');
  },report:r=>reports.push(r),onError:e=>errors.push(e.message),schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{}});
  assert.equal(calls,1);assert.equal(timers.length,0);
  resolve({dispatched:1});await new Promise(r=>setImmediate(r));
  assert.equal(reports.length,1);assert.equal(timers[0].ms,5000);
  await timers[0].fn();assert.deepEqual(errors,['网络中断']);assert.equal(timers.length,2);
  stop();await timers[1].fn();assert.equal(timers.length,2);assert.equal(calls,2);
});

test('未配置间隔保留仅启动派发一次的行为',async()=>{
  let calls=0;
  startDispatchLoop({dispatch:async()=>{calls++;},schedule:()=>assert.fail('不应定时')});
  await new Promise(r=>setImmediate(r));assert.equal(calls,1);
});
