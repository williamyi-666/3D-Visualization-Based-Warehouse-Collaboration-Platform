import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWarehouseModel,readWarehouseSnapshot} from '../packages/integration/warehouse-model.mjs';
import {DatabaseSync} from 'node:sqlite';
test('读取缺失仓库返回明确类型并回滚读取事务',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec('CREATE TABLE space_node(id TEXT,parent_id TEXT,loc_code TEXT,node_type TEXT)');
    assert.throws(()=>readWarehouseSnapshot(sql,'MISSING'),error=>error.code==='WAREHOUSE_NOT_FOUND'&&error.siteCode==='MISSING');
    sql.exec('BEGIN; ROLLBACK');
    sql.exec('DROP TABLE space_node');
    assert.throws(()=>readWarehouseSnapshot(sql,'MISSING'),error=>error.code!=='WAREHOUSE_NOT_FOUND');
  } finally {sql.close();}
});
const nodes=[
  {id:'s',node_type:'site',loc_code:'WH',name:'仓库'},
  {id:'r',parent_id:'s',node_type:'room',loc_code:'WH-1',name:'库区',geom:'{"w":12,"d":8}'},
  {id:'rack',parent_id:'r',node_type:'rack',loc_code:'WH-1-A',name:'货架'},
  {id:'c',parent_id:'rack',node_type:'cell',loc_code:'WH-1-A-L01-B01',name:'格位'},
  {id:'empty',parent_id:'rack',node_type:'cell',loc_code:'WH-1-A-L01-B02',name:'空格'}];
test('仓储模型保持层级、几何、空格及同格多SKU独立单位',()=>{
  const inventory=[{node_id:'c',item_id:'i1',name:'物料一',sku:'A',qty:3,unit:'kg',batch_no:'B1'},
    {node_id:'c',item_id:'i2',name:'物料二',sku:'B',qty:2,unit:'箱',batch_no:'B2'}];
  const result=buildWarehouseModel({nodes:[...nodes].reverse(),inventory});
  assert.equal(result.models.length,6);assert.equal(result.values.length,2);
  const cell=result.values.find(v=>v.loc_code.endsWith('B01'));
  const data=JSON.parse(cell.snapshot);
  assert.deepEqual(data.ancestors.map(a=>a.type),['site','room','rack']);
  assert.equal(data.ancestors[1].geometry.w,12);
  assert.deepEqual(data.inventory.map(i=>[i.sku,i.qty,i.unit]),[['A',3,'kg'],['B',2,'箱']]);
  assert.equal(cell.occupied,1);assert.equal(result.values.find(v=>v.loc_code.endsWith('B02')).occupied,0);
  const renamed=buildWarehouseModel({nodes:nodes.map(n=>({...n,name:'新名称',loc_code:n.loc_code+'new'})),inventory});
  assert.deepEqual(result.models.map(m=>m.alias).sort(),renamed.models.map(m=>m.alias).sort());
});
test('无效层级或超长快照在注册前拒绝',()=>{
  assert.throws(()=>buildWarehouseModel({nodes:nodes.slice(1),inventory:[]}),/缺少父空间/);
  assert.throws(()=>buildWarehouseModel({nodes,inventory:[{node_id:'c',name:'货'.repeat(17000)}]}),/超过UNS字段长度/);
});

test('合并子格不发布为有效格位，拆分恢复原别名与快照',async()=>{
  const {createWarehouseSync}=await import('../packages/integration/warehouse-sync.mjs');
  const original=buildWarehouseModel({nodes,inventory:[]});
  const merged=buildWarehouseModel({nodes:nodes.map(n=>n.id==='rack'?{...n,template:JSON.stringify({merges:{L01:[[1,2]]}})}:n),inventory:[]});
  assert.equal(merged.values.length,1);assert.equal(merged.values[0].loc_code,'WH-1-A-L01-B01');
  let current=merged,sent;
  const run=createWarehouseSync({load:()=>original,readPlan:()=>current,publish:async plan=>{sent=plan;return {};}});
  await run();
  const hidden=sent.values.find(v=>v.loc_code.endsWith('B02'));
  assert.equal(hidden.occupied,0);assert.equal(JSON.parse(hidden.snapshot).deleted,true);
  assert.deepEqual(JSON.parse(hidden.snapshot).inventory,[]);
  current=original;await run();
  const restored=sent.values.find(v=>v.alias===hidden.alias);
  assert.ok(restored);assert.equal(JSON.parse(restored.snapshot).deleted,undefined);
});
