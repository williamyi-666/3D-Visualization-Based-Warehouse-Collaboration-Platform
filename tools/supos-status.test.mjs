import test from 'node:test';import assert from 'node:assert/strict';
import {createUnsClient,statusFolder,statusFile} from '../packages/integration/supos-status.mjs';
test('UNS状态契约：显式注册、结构冲突拒绝、当前值按别名读取',async()=>{
 const entries=new Map();const writes=[];
 const api=createUnsClient('http://backend',async(url,opts)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/batchQuery'))return {ok:true,json:async()=>({code:200,data:{[statusFile.alias]:{value:3}}})};
  if(opts.method==='POST'){const m=JSON.parse(opts.body);writes.push(m);entries.set(m.alias,{...m,path:'Warehouse3D_Lab/inventory_rows'});return {ok:true,json:async()=>({code:200})};}
  const m=entries.get(path.split('/').at(-1));return {ok:true,json:async()=>m?{code:200,data:m}:{code:400,msg:'找不到文件'}};
 });
 await assert.rejects(()=>api.model(),/找不到/);assert.equal(writes.length,0);
 await api.model(true);assert.equal(writes.length,2);
 await api.model(true);assert.equal(writes.length,2);assert.equal((await api.current()).value,3);
 entries.set(statusFile.alias,{...entries.get(statusFile.alias),dataType:2});await assert.rejects(()=>api.model(true),/结构/);
 entries.set(statusFolder.alias,{...statusFolder,description:'其他应用'});await assert.rejects(()=>api.model(true),/占用/);
});
