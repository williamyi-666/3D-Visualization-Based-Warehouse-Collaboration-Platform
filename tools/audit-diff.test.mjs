import test from 'node:test';
import assert from 'node:assert/strict';
import {auditChanges} from '../apps/web/prototype/audit-diff.mjs';
test('审计按节点身份对比，展开几何字段并保留新增删除与未知字段',()=>{
  const a={id:'a',loc_code:'A',geom:'{"x":0,"rot":0}',template:'{"rows":3}'};
  const b={id:'b',loc_code:'B',name:'旧节点'};
  const result=auditChanges([a,b],[{id:'c',loc_code:'C',name:'新节点'},{...a,geom:'{"x":2,"rot":0}',custom:'扩展'}]);
  assert.deepEqual(result.filter(r=>r.node==='A').map(r=>[r.field,r.before,r.after]),[['空间 · X 坐标（米）','0','2'],['custom','未设置','扩展']]);
  assert.ok(result.some(r=>r.node==='B' && r.action==='删除'));
  assert.ok(result.some(r=>r.node==='C' && r.action==='新增'));
  assert.deepEqual(auditChanges([a],[{...a,geom:'{"rot":0,"x":0}'}]),[]);
  assert.equal(auditChanges([{id:'d',geom:'旧格式'}],[{id:'d',geom:null}])[0].before,'旧格式');
});
