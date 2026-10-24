import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantSessions} from '../apps/api/assistant-session.mjs';

test('不同账号、不同浏览器会话隔离，切换库区和超时清除旧作业上下文',()=>{
  let now=100;const store=createAssistantSessions({now:()=>now,ttl:50});
  const request=(user,session='browser-1',room='WH-2')=>({user:{id:user},body:{session_id:session,room}});
  const first=store.get(request('a'));store.remember(first,'prepare_operation',{}, {kind:'draft',input:{operation:'move',qty:3,item_id:'item-1'}},'移3套');
  assert.equal(store.get(request('a')).pending.input.qty,3);
  assert.equal(store.get(request('b')).pending,null);
  assert.equal(store.get(request('a','browser-2')).pending,null);
  first.state='running';assert.throws(()=>store.get(request('a','browser-1','WH-3')),error=>error.status===409);first.state='idle';
  assert.equal(store.get(request('a','browser-1','WH-3')).pending,null);
  store.remember(first,'prepare_operation',{}, {kind:'draft',input:{qty:5}},'改5套');now+=51;
  assert.equal(store.get(request('a','browser-1','WH-3')).pending,null);
});
