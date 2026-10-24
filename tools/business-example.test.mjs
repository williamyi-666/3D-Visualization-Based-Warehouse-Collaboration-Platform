import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBusinessInventory} from '../apps/web/prototype/business-example.mjs';

test('模拟宿主详情按完整业务标识读取当前库存，拒绝过期和跨来源匹配',async()=>{
  const row={source:'模拟ERP',sku:'BEARING-6204',loc_code:'WH-1-F1-L02-B01',batch_no:'B1',status:'待检',qty:20,unit:'套',snapshot_version:2};
  const payload={source:row.source,sku:row.sku,loc:row.loc_code,batch_no:'B1',status:'待检',qty:999};
  let requested;
  const fetcher=async url=>{requested=url;return {ok:true,json:async()=>[
    {...row,source:'另一ERP'}, {...row,sku:row.sku+'0'}, {...row,batch_no:'B2'}, {...row,status:'可用'}, {...row,loc_code:'WH-1-A-L01-B01'},row
  ]};};
  const current=await resolveBusinessInventory(payload,{fetcher,basePath:'/warehouse'});
  assert.equal(current.qty,20);assert.equal(current.snapshot_version,2);
  assert.ok(requested.startsWith('/warehouse/api/search?'));
  assert.equal(new URL(requested,'http://localhost').searchParams.get('source'),'模拟ERP');
  await assert.rejects(()=>resolveBusinessInventory({...payload,batch_no:'OLD'},{fetcher}),/变化或移除/);
  await assert.rejects(()=>resolveBusinessInventory({...payload,source:''},{fetcher}),/缺少业务/);
  await assert.rejects(()=>resolveBusinessInventory(payload,{fetcher:async()=>({ok:false,status:401})}),/会话已过期/);
  await assert.rejects(()=>resolveBusinessInventory(payload,{fetcher:async()=>({ok:false,status:500})}),/无法读取/);
  await assert.rejects(()=>resolveBusinessInventory(payload,{fetcher:async()=>({ok:true,json:async()=>[row,row]})}),/多条库存/);
});
