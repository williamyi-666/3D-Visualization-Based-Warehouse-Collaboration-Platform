import test from 'node:test';
import assert from 'node:assert/strict';
import {createMobileOffline,canRemember} from '../apps/web/prototype/mobile-offline.mjs';
import {validateMobileStock} from '../apps/web/prototype/mobile-revalidate.mjs';
const memory=()=>{const rows=new Map();return {getItem:key=>rows.get(key)||null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};};
test('断网只读最近记录；账号切换、拒绝访问和过期记录不能兜底',async()=>{
  const storage=memory();let token='account-a',online=true,clock=1000,status=200,value={user:{id:'a',role:'operator'},mode:'standalone'},last;
  const options={storage,scope:'warehouse-a',credential:()=>token,now:()=>clock,onState:s=>last=s,fetcher:async()=>{if(!online)throw Error('offline');return new Response(JSON.stringify(value),{status});}};
  let cache=createMobileOffline(options);await cache.read('/api/auth/me');value=[{id:'room-a',loc_code:'WH-1'}];await cache.read('/api/rooms');
  value=[{item_id:'sku-a',qty:5}];await cache.read('/api/cells/WH-1-A-L01-B01/items');online=false;
  cache=createMobileOffline(options);assert.equal((await cache.read('/api/auth/me')).user.id,'a');assert.equal((await cache.read('/api/cells/WH-1-A-L01-B01/items'))[0].qty,5);assert.equal(last.stale.length,2);
  token='account-b';await assert.rejects(cache.read('/api/rooms'),/没有这项最近记录/);
  token='account-a';online=true;status=403;await assert.rejects(cache.read('/api/rooms'),error=>error.status===403);online=false;await assert.rejects(cache.read('/api/rooms'),/没有这项最近记录/);
  online=true;status=200;value={user:{id:'a'}};await cache.read('/api/auth/me');value=[];await cache.read('/api/rooms');online=false;clock+=8*86400000;await assert.rejects(cache.read('/api/rooms'),/没有这项最近记录/);
});
test('库区重建清除旧位置缓存；其他部署不能读取；不缓存写入和管理接口',async()=>{
  const storage=memory();let online=true,value={user:{id:'a'}};
  const options={storage,scope:'a',credential:()=> 'token',fetcher:async()=>{if(!online)throw Error('offline');return new Response(JSON.stringify(value));}};
  const cache=createMobileOffline(options);await cache.read('/api/auth/me');value=[{id:'old',loc_code:'WH-1'}];await cache.read('/api/rooms');value={furniture:[]};await cache.read('/api/scene?room=WH-1');value=[{id:'new',loc_code:'WH-1'}];await cache.read('/api/rooms');online=false;
  await assert.rejects(cache.read('/api/scene?room=WH-1'),/没有这项最近记录/);await assert.rejects(createMobileOffline({...options,scope:'b'}).read('/api/rooms'),/没有这项最近记录/);
  for(const path of ['/api/admin/users','/api/counter/outbound','/api/assistant/jobs','/api/rooms/secret'])assert.equal(canRemember(path),false);
});
test('草稿提交前按新库存、预占、单位和格位身份核对',()=>{
  const value={mode:'out',amount:4,item:{item_id:'a',unit:'件'},source:{node_id:'old',items:[{item_id:'a',qty:10,available_qty:3}]},originalNode:'old',unit:'件'};
  assert.throws(()=>validateMobileStock(value),/最新可用库存不足/);
  assert.throws(()=>validateMobileStock({...value,amount:2,source:{...value.source,node_id:'rebuilt'}}),/重建/);
  assert.throws(()=>validateMobileStock({...value,amount:2,unit:'箱'}),/单位已变化/);
  assert.throws(()=>validateMobileStock({...value,amount:2,target:{node_id:'new'},targetNode:'old'}),/目标格位已重建/);
  assert.doesNotThrow(()=>validateMobileStock({...value,amount:2}));
});
