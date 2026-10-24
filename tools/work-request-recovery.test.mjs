import test from 'node:test';
import assert from 'node:assert/strict';
import {setWorkUser,sendWork,retryWork,pendingWork} from '../apps/web/prototype/work-request.mjs';

test('断网后核对原建账请求，不能换内容或换账号重放',async()=>{
  const original={window:globalThis.window,localStorage:globalThis.localStorage,fetch:globalThis.fetch};
  const storage=new Map(),receipts=new Map();let id=0,writes=0,lose=true,user='operator';
  globalThis.window={SPATIAL_RUNTIME:{basePath:''},spatialRandomUUID:()=>`request-${++id}`};
  globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  globalThis.fetch=async(path,init)=>{
    if(path==='/api/auth/me')return new Response(JSON.stringify({user:{id:user}}));
    const body=JSON.parse(init.body);let result=receipts.get(body.request_id);
    if(!result){writes++;result={loc_code:body.loc_code};receipts.set(body.request_id,result);}else result={...result,replayed:true};
    if(lose){lose=false;throw Error('响应丢失');}
    return new Response(JSON.stringify(result));
  };
  try {
    setWorkUser('operator');const input={loc_code:'WH-1-A-L01-B01',baseline:'baseline',rows:[{name:'轴承',qty:10}]};
    await assert.rejects(sendWork('/api/work/opening',input),/无法连接仓库服务/);assert.ok(pendingWork());
    await assert.rejects(sendWork('/api/work/opening',{...input,rows:[]}),/尚未确认/);
    user='another-operator';await assert.rejects(retryWork(),/账号已变化/);assert.equal(writes,1);
    user='operator';const receipt=await retryWork();assert.equal(receipt.replayed,true);assert.equal(writes,1);assert.equal(pendingWork(),null);
  }finally{Object.assign(globalThis,original);setWorkUser('');}
});
