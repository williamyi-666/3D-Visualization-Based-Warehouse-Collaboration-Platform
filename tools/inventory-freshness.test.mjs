import test from 'node:test';
import assert from 'node:assert/strict';
import {freshness} from '../apps/web/prototype/inventory-freshness.mjs';

test('库存业务状态独立于来源健康，状态恢复不掩盖页面旧快照',()=>{
  const item={source:'ERP-A',received_at:'2026-09-17T00:00:00Z',status:'可用'};
  const state=value=>[{source:'ERP-A',received_at:item.received_at,state:value}];
  for(const name of ['failed','stale','waiting','unconfigured'])assert.equal(freshness(item,state(name)).level,'warning');
  assert.match(freshness(item,state('failed')).text,/同步失败/);
  assert.equal(freshness(item,state('ok')).level,'ok');
  assert.match(freshness(item,[{...state('ok')[0],received_at:'2026-09-17T01:00:00Z'}]).text,/已有更新/);
  assert.equal(freshness(item,[{...state('ok')[0],received_at:'2026-09-17T01:00:00Z'}]).level,'warning');
  assert.match(freshness(item,null).text,/未知/);
  assert.match(freshness({...item,source:'ERP-B'},state('ok')).text,/未知/);
  assert.equal(item.status,'可用');
});
