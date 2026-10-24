import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryView} from '../apps/api/inventory-view.mjs';
test('库存分页无遗漏重复，服务端库区和组合筛选准确，版本变化拒绝旧翻页',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT); INSERT INTO space_node VALUES('1','WH-1-A-C1','cell'),('2','WH-10-A-C1','cell')");
    const view=createInventoryView(sql);
    const rows=Array.from({length:137},(_,i)=>({sku:'SKU-'+i,name:'库存'+i,qty:1,loc_code:i%2?'WH-1-A-C1':'WH-10-A-C1',status:i%3?'可用':'待检'}));
    view.apply({source:'ERP',version:1,rows});
    const first=view.inventoryPage();assert.equal(first.rows.length,50);assert.equal(first.pages,3);
    const ids=[];
    for(let page=1;page<=first.pages;page++)ids.push(...view.inventoryPage({page,revision:first.revision}).rows.map(r=>r.id));
    assert.equal(ids.length,137);assert.equal(new Set(ids).size,137);
    assert.deepEqual(new Set(ids),new Set(view.list().map(r=>r.id)));
    const room=view.inventoryPage({room:'WH-1',status:'待检',page_size:200});
    assert.equal(room.total,rows.filter(r=>r.loc_code.startsWith('WH-1-') && r.status==='待检').length);
    assert.ok(room.rows.every(r=>r.loc_code==='WH-1-A-C1'));
    assert.equal(view.inventoryPage({source:'不存在'}).total,0);
    for(const query of [{page:0},{page_size:201},{page:'oops'}])assert.throws(()=>view.inventoryPage(query),/分页/);
    view.apply({source:'ERP',version:2,rows:rows.slice(1)});
    assert.throws(()=>view.inventoryPage({page:2,revision:first.revision}),e=>e.status===409);
    assert.equal(view.inventoryPage().total,136);
  }finally{sql.close();}
});
