import test from 'node:test';
import assert from 'node:assert/strict';
import {createSceneNavigation} from '../apps/web/prototype/scene-navigation.mjs';

function setup() {
  const scenes=[],rooms=[],commits=[];
  let state={siteCode:'WH',roomCode:'WH-1'};
  const deferred=(queue,key)=>new Promise((resolve,reject)=>queue.push({key,resolve,reject}));
  const navigation=createSceneNavigation({current:()=>state,
    readScene:key=>deferred(scenes,key),readRooms:key=>deferred(rooms,key),
    commit(data){commits.push(data);state={siteCode:data.siteCode,roomCode:data.spec.roomCode};}});
  return {navigation,scenes,rooms,commits,state:()=>state};
}
const spec=roomCode=>({roomCode,furniture:[]});

test('连续切换库区：旧成功和旧失败均不能覆盖最新选择',async()=>{
  const h=setup();
  const a=h.navigation.loadRoom('WH-2'), b=h.navigation.loadRoom('WH-3');
  h.scenes[1].resolve(spec('WH-3'));assert.equal(await b,true);
  h.scenes[0].resolve(spec('WH-2'));assert.equal(await a,false);
  assert.equal(h.state().roomCode,'WH-3');assert.equal(h.commits.length,1);
  const c=h.navigation.loadRoom('WH-4'),d=h.navigation.loadRoom('WH-5');
  h.scenes[3].resolve(spec('WH-5'));await d;
  h.scenes[2].reject(Error('旧请求断网'));assert.equal(await c,false);
  assert.equal(h.state().roomCode,'WH-5');
});

test('最新加载失败不提交半成品，旧成功也不能复活',async()=>{
  const h=setup();
  const a=h.navigation.loadRoom('WH-2'),b=h.navigation.loadRoom('WH-3');
  h.scenes[1].reject(Error('断网'));await assert.rejects(b,/断网/);
  h.scenes[0].resolve(spec('WH-2'));assert.equal(await a,false);
  assert.deepEqual(h.state(),{siteCode:'WH',roomCode:'WH-1'});
  assert.equal(h.commits.length,0);
});

test('跨仓库列表乱序时只继续最后一次导航，并原子提交库区列表与场景',async()=>{
  const h=setup();
  const a=h.navigation.loadSite('A'),b=h.navigation.loadSite('B');
  h.rooms[1].resolve([{loc_code:'B-1',name:'B库区'}]);await Promise.resolve();
  h.rooms[0].resolve([{loc_code:'A-1',name:'A库区'}]);assert.equal(await a,false);
  assert.deepEqual(h.scenes.map(x=>x.key),['B-1']);
  assert.equal(h.commits.length,0);
  h.scenes[0].resolve(spec('B-1'));assert.equal(await b,true);
  assert.deepEqual(h.state(),{siteCode:'B',roomCode:'B-1'});
  assert.equal(h.commits[0].rooms[0].loc_code,'B-1');
});

test('跨仓库场景失败、空仓库不丢失原选择，直接库位导航更新所属仓库',async()=>{
  const h=setup();
  const a=h.navigation.loadSite('A');h.rooms[0].resolve([{loc_code:'A-1'}]);await Promise.resolve();
  h.scenes[0].reject(Error('场景失败'));await assert.rejects(a,/场景失败/);
  assert.equal(h.state().siteCode,'WH');
  const empty=h.navigation.loadSite('E');h.rooms[1].resolve([]);await assert.rejects(empty,/没有库区/);
  const direct=h.navigation.loadRoom('B-2');h.rooms[2].resolve([{loc_code:'B-2',name:'二号'}]);await Promise.resolve();
  h.scenes[1].resolve(spec('B-2'));await direct;
  assert.deepEqual(h.state(),{siteCode:'B',roomCode:'B-2'});
});

test('重新选择当前库区可以取消先前等待中的仓库切换',async()=>{
  const h=setup();
  const pending=h.navigation.loadSite('B'),back=h.navigation.loadRoom('WH-1');
  h.scenes[0].resolve(spec('WH-1'));await back;
  h.rooms[0].resolve([{loc_code:'B-1'}]);assert.equal(await pending,false);
  assert.deepEqual(h.state(),{siteCode:'WH',roomCode:'WH-1'});
});
