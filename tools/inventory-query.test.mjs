import test from 'node:test';import assert from 'node:assert/strict';import {searchInventory} from '../apps/api/inventory-query.mjs';
test('库存组合查询：同SKU多来源/状态分离，单位和批次精确匹配',()=>{
 const base={sku:'A',name:'轴承',loc_code:'WH-1-A-L01-B01',source:'ERP甲',unit:'套',batch_no:'B01',status:'可用'};
 const rows=[base,{...base,status:'待检',loc_code:'WH-1-B-L01-B01'},{...base,source:'ERP乙',unit:'件',batch_no:'B010'}];
 assert.deepEqual(searchInventory(rows,{q:'A',source:'ERP甲',status:'待检'}),[rows[1]]);
 assert.equal(searchInventory(rows,{unit:'套',batch_no:'B01'}).length,2);
 assert.equal(searchInventory(rows,{q:'待检'}).length,1);
 assert.equal(searchInventory(rows,{q:'不存在',status:'可用'}).length,0);
 assert.deepEqual(searchInventory(rows,{source:'ERP乙',batch_no:'B01'}),[]);
});

test('型号与货名顺序不影响查询，限定词和完整SKU不被丢弃',()=>{
 const target={name:'深沟球轴承6204',sku:'BRG-6204',loc_code:'WH-1-A-L01-B01',unit:'套'};
 const rows=[target,{name:'备用轴承',sku:'BRG-6205',loc_code:'WH-1-B-L01-B01',unit:'套'}];
 for(const q of ['6204轴承','轴承6204','6204 轴承','深沟球轴承BRG-6204'])assert.deepEqual(searchInventory(rows,{q}),[target]);
 assert.deepEqual(searchInventory(rows,{q:'不锈钢轴承6204'}),[]);
 assert.deepEqual(searchInventory(rows,{q:'BRG-6205'}),[rows[1]]);
});
