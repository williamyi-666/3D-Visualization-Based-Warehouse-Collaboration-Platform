import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryView} from '../apps/api/inventory-view.mjs';
import {reconcileRows} from '../apps/web/prototype/reconcile-view.mjs';

test('对账结果可持久回看，超100项明确截断，不修改库存',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT);INSERT INTO space_node VALUES('1','A','cell')");
    let view=createInventoryView(sql);
    const row={sku:'A',name:'轴承',loc_code:'A',qty:10};
    view.receive({source:'ERP',version:1,rows:[row]},'tester');
    const result=view.receive({mode:'reconcile',source:'ERP',version:1,rows:[{...row,qty:11},...Array.from({length:110},(_,i)=>({...row,sku:'EXTRA'+i}))]},'tester');
    assert.equal(result.difference_count,111);assert.equal(result.truncated,true);assert.equal(result.differences.length,100);
    const id=view.history()[0].id;
    view=createInventoryView(sql);
    assert.deepEqual(view.historyDetail(id).details,result);
    assert.equal(view.list().length,1);assert.equal(view.list()[0].qty,10);
    assert.match(view.history()[0].message,/111/);
    assert.equal(view.historyDetail(-1),null);
    assert.equal(view.historyDetail(id-1).details,null);
  } finally {sql.close();}
});

test('对账表格说明差异方向并保留未知字段及特殊字符',()=>{
  const base={sku:'<A>',loc_code:'L',batch_no:'B',status:'待检',qty:2,unit:'件'};
  const rows=reconcileRows({differences:[{kind:'changed',expected:{...base,qty:3,extra:'新'},actual:{...base,extra:'旧'}},{kind:'missing',expected:base,actual:null},{kind:'unexpected',expected:null,actual:base}]});
  const qty=rows.find(x=>x.kind==='内容不一致' && x.field==='数量');
  assert.equal(qty.expected,'3');assert.equal(qty.actual,'2');assert.equal(qty.sku,'<A>');
  assert.ok(rows.some(x=>x.field==='extra' && x.expected==='新'));
  assert.ok(rows.some(x=>x.kind==='展示库存缺失' && x.actual==='—'));
  assert.ok(rows.some(x=>x.kind==='展示库存多余' && x.expected==='—'));
});
