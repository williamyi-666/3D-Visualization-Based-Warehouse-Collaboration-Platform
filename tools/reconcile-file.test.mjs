import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReconcile,reconcileCSV} from '../apps/web/prototype/reconcile-file.mjs';
test('对账导入校验行号、数量及编码，允许空快照和BOM文件',()=>{
  const row={sku:'A',name:'轴承',qty:2,loc_code:'L'};
  const input={source:'ERP',version:1,rows:[row]};
  assert.deepEqual(parseReconcile('\uFEFF'+JSON.stringify(input)),input);
  assert.deepEqual(parseReconcile(JSON.stringify({...input,rows:[]})).rows,[]);
  assert.throws(()=>parseReconcile('{'),/JSON/);
  assert.throws(()=>parseReconcile(JSON.stringify({...input,version:'1'})),/version/);
  assert.throws(()=>parseReconcile(JSON.stringify({...input,rows:[row,{...row,qty:-1}]})),/第 2 条.*qty/);
  assert.throws(()=>parseReconcile(JSON.stringify({...input,rows:[{...row,external_loc_code:'E'}]})),/只能提供一个/);
  assert.throws(()=>parseReconcile(JSON.stringify({...input,rows:[null]})),/第 1 条/);
});
test('差异导出包含范围说明，转义逗号引号并阻止公式执行',()=>{
  const result={difference_count:101,truncated:true,differences:[{kind:'changed',expected:{sku:'=1+1',name:'轴承,"A"',qty:2},actual:{sku:'=1+1',name:'旧',qty:1}}]};
  const csv=reconcileCSV(result,'ERP · 版本 1');
  assert.ok(csv.startsWith('\uFEFF'));assert.match(csv,/非完整结果/);assert.match(csv,/101/);
  assert.ok(csv.includes(String.fromCharCode(39)+'=1+1'));assert.ok(csv.includes('"轴承,""A"""'));
});

test('对账导入接受SKU归位，拒绝缺仓库和混合定位方式',()=>{
  const row={sku:'A',name:'轴承',qty:2,placement:'sku',warehouse_code:'WH'};
  const input={source:'ERP',version:1,rows:[row]};
  assert.deepEqual(parseReconcile(JSON.stringify(input)),input);
  for(const warehouse_code of [undefined,'',12])
    assert.throws(()=>parseReconcile(JSON.stringify({...input,rows:[{...row,warehouse_code}]})),/warehouse_code/);
  for(const field of ['loc_code','external_loc_code'])
    assert.throws(()=>parseReconcile(JSON.stringify({...input,rows:[{...row,[field]:'A-01'}]})),/不要同时提供库位/);
});
