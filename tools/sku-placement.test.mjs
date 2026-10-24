import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryView} from '../apps/api/inventory-view.mjs';
import {createSpacePolicy,isSpaceWrite} from '../apps/api/space-policy.mjs';
import {parseReconcile} from '../apps/web/prototype/reconcile-file.mjs';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec(`CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT,parent_id TEXT);
 INSERT INTO space_node VALUES('S','WH','site',NULL),('R','WH-1','room','S'),('K','WH-1-A','rack','R'),
 ('K-A','K-A','cell','K'),('K-B','K-B','cell','K'),('K-C','K-C','cell','K'),('K-D','K-D','cell','K'),
 ('T','OTHER','site',NULL),('K-E','K-E','cell','T');`);
 const usable=new Set(['K-A','K-B','K-C','K-D','K-E']);
 const view=createInventoryView(sql,{getUsableCells:()=>usable});return {sql,view,usable};
}
const item=(extra={})=>({sku:'SKU-1',name:'轴承',loc_code:'K-A',qty:10,unit:'件',...extra});
const bind=(view,code,extra={})=>view.skuPlacement.save(code,{mode:'sku',source:'ERP',sku:'SKU-1',revision:view.skuPlacement.get(code).revision,...extra});
test('已有 ERP 库存绑定后立即归位，隔离来源仓库，解除回到原位',()=>{
 const {sql,view,usable}=fixture();try{
 view.apply({source:'ERP',version:1,rows:[item(),item({loc_code:'K-E',qty:8})]});
 view.apply({source:'ERP2',version:1,rows:[item({qty:2})]});
 const before=sql.prepare('SELECT payload FROM external_inventory_snapshot WHERE source=?').get('ERP').payload;
 bind(view,'K-B');
 assert.deepEqual(view.list().map(r=>r.loc_code),['K-B','K-E','K-A']);
 assert.equal(sql.prepare('SELECT payload FROM external_inventory_snapshot WHERE source=?').get('ERP').payload,before);
 assert.throws(()=>bind(view,'K-C'),/已绑定格位 K-B/);
 const restored=createInventoryView(sql,{getUsableCells:()=>usable});assert.equal(restored.list()[0].loc_code,'K-B');
 const page=view.inventoryPage();bind(view,'K-B',{mode:'location'});
 assert.throws(()=>view.inventoryPage({revision:page.revision}),/库存已更新/);
 assert.equal(view.list()[0].loc_code,'K-A');
 }finally{sql.close();}
});
test('SKU-only 快照、增量、对账和归零保留绑定；未绑定进入待分配，绑定与解绑即时生效',()=>{
 const {sql,view}=fixture();try{
 bind(view,'K-B');const row={sku:'SKU-1',name:'轴承',qty:6,unit:'件',placement:'sku',warehouse_code:'WH'};
 assert.throws(()=>view.apply({source:'ERP',version:1,rows:[row,item()]}),/重复上报/);
 view.receive({source:'ERP',version:1,rows:[row]},'test');assert.equal(view.list()[0].loc_code,'K-B');
 assert.equal(view.scene({furniture:[{code:'K',items:{B:[]}}]}).furniture[0].items.B.length,1);
 bind(view,'K-B',{mode:'location'});
 assert.equal(view.list()[0].assignment,'unassigned');
 assert.equal(view.list()[0].loc_code,null);
 assert.equal(view.scene({furniture:[{code:'K',items:{B:[]}}]}).furniture[0].items.B.length,0);
 bind(view,'K-B');
 view.receive({source:'ERP',mode:'delta',message_id:'d1',base_version:1,version:2,changes:[{...row,op:'upsert',qty:4}]},'test');
 assert.equal(view.list()[0].qty,4);
 const uiInput=parseReconcile(JSON.stringify({source:'ERP',version:2,rows:[{...row,qty:4}]}));
 assert.equal(view.receive({...uiInput,mode:'reconcile'},'test').matched,true);
 const difference=view.receive({...parseReconcile(JSON.stringify({...uiInput,rows:[{...row,qty:5}]})),mode:'reconcile'},'test');
 assert.equal(difference.matched,false);
 assert.equal(view.list()[0].qty,4); // 页面输入经过真实对账模块后仍不改库存。
 view.apply({source:'ERP',version:3,rows:[{...row,qty:0}]});
 assert.equal(view.skuPlacement.get('K-B').mode,'sku');
 const scene=view.scene({furniture:[{code:'K',items:{B:[]}}]});assert.equal(scene.furniture[0].items.B.length,0);
 view.apply({source:'ERP',version:4,rows:[row,{...row,sku:'NOT-BOUND'}]});
 assert.equal(view.list()[0].loc_code,'K-B');
 assert.equal(view.list()[1].assignment,'unassigned');
 assert.equal(view.inventoryPage({assignment:'unassigned',warehouse:'WH'},code=>code==='WH').total,1);
 assert.equal(view.inventoryPage({assignment:'unassigned'},code=>code==='OTHER').total,0);
 assert.equal(view.inventoryPage({room:'WH-1'}).total,0);
 bind(view,'K-C',{sku:'NOT-BOUND'});
 assert.equal(view.inventoryPage({assignment:'unassigned'}).total,0);
 }finally{sql.close();}
});
test('绑定冲突回滚、并发版本、空间引用保护',()=>{
 const {sql,view}=fixture();try{
 view.apply({source:'ERP',version:1,rows:[item({loc_code:'K-B',sku:'OTHER'})]});
 assert.throws(()=>bind(view,'K-B'),/冲突/);assert.equal(view.skuPlacement.get('K-B').revision,0);
 bind(view,'K-C');assert.throws(()=>view.skuPlacement.save('K-C',{mode:'location',revision:0}),/已更新/);
 assert.throws(()=>createSpacePolicy(sql,view)('DELETE','/api/rack/WH-1-A'),/引用/);
 assert.equal(isSpaceWrite('PUT','/api/cell/C/sku-binding'),true);
 assert.throws(()=>view.apply({source:'ERP',version:2,rows:[item({loc_code:'K-C',sku:'OTHER'})]}),/冲突/);
 assert.equal(view.list()[0].loc_code,'K-B');
 }finally{sql.close();}
});

test('首次同步无需先绑定；零数量不列入待分配，重启和导出保留货品',()=>{
 const {sql,view,usable}=fixture();try {
 const row={sku:'NEW',name:'新货品',qty:5,unit:'件',placement:'sku',warehouse_code:'WH'};
 view.receive({source:'ERP',version:1,rows:[row,{...row,sku:'ZERO',qty:0}]},'test');
 assert.equal(view.inventoryPage({assignment:'unassigned'}).total,1);
 const restored=createInventoryView(sql,{getUsableCells:()=>usable});
 assert.equal(restored.list().find(r=>r.sku==='NEW').qty,5);
 bind(restored,'K-B',{sku:'NEW'});
 assert.equal(restored.list().find(r=>r.sku==='NEW').loc_code,'K-B');
 }finally {sql.close();}
});

test('只填 SKU 自动匹配当前仓库来源，多个来源必须选择',()=>{
 const {sql,view}=fixture();try {
 view.apply({source:'ERP',version:1,rows:[item()]});
 view.apply({source:'OTHER-WAREHOUSE',version:1,rows:[item({loc_code:'K-E'})]});
 const saved=view.skuPlacement.save('K-B',{sku:'SKU-1',revision:0});
 assert.equal(saved.mode,'sku');assert.equal(saved.source,'ERP');
 assert.equal(view.list()[0].loc_code,'K-B');
 view.skuPlacement.save('K-B',{sku:'',revision:saved.revision});
 view.apply({source:'ERP2',version:1,rows:[item()]});
 assert.throws(()=>view.skuPlacement.save('K-B',{sku:'SKU-1',revision:2}),e=>e.sources?.join(',')==='ERP,ERP2');
 assert.equal(view.skuPlacement.get('K-B').mode,'location');
 view.skuPlacement.save('K-B',{sku:'SKU-1',source:'ERP',revision:2});
 assert.equal(view.list().find(r=>r.source==='ERP').loc_code,'K-B');
 }finally {sql.close();}
});
test('无库存先绑定 SKU，后续自动归入；多来源不会擅自合并',()=>{
 const {sql,view}=fixture();try {
 const binding=view.skuPlacement.save('K-B',{sku:'NEW',revision:0});
 assert.equal(binding.source,'');
 assert.throws(()=>view.skuPlacement.save('K-C',{sku:'NEW',source:'ERP',revision:0}),/已绑定/);
 const row={placement:'sku',warehouse_code:'WH',sku:'NEW',name:'新货品',qty:3,unit:'件'};
 view.apply({source:'ERP',version:1,rows:[row]});
 assert.equal(view.list()[0].loc_code,'K-B');
 view.apply({source:'ERP2',version:1,rows:[row]});
 assert.equal(view.inventoryPage({assignment:'unassigned'}).total,2);
 view.skuPlacement.save('K-B',{sku:'NEW',source:'ERP',revision:binding.revision});
 assert.equal(view.list().find(r=>r.source==='ERP').loc_code,'K-B');
 assert.equal(view.list().find(r=>r.source==='ERP2').loc_code,null);
 }finally {sql.close();}
});

test('多 SKU 共用格位，批次独立、单项解绑、分页版本及重启保持',()=>{
 const {sql,view,usable}=fixture();try {
 const row={placement:'sku',warehouse_code:'WH',sku:'A',name:'甲',qty:3,unit:'件'};
 view.apply({source:'ERP',version:1,rows:[row,{...row,batch_no:'B2',qty:2},{...row,sku:'B',name:'乙',qty:4}]});
 const saved=view.skuPlacement.save('K-B',{items:[{sku:'A'},{sku:'B'}],revision:0});
 assert.equal(saved.items.length,2);assert.equal(saved.items[1].source,'ERP');
 assert.equal(view.list().filter(r=>r.loc_code==='K-B').length,3);
 assert.equal(view.scene({furniture:[{code:'K',items:{B:[]}}]}).furniture[0].items.B.length,3);
 assert.throws(()=>bind(view,'K-C',{sku:'B'}),/已绑定格位/);
 assert.throws(()=>view.skuPlacement.save('K-B',{sku:'A',revision:saved.revision}),/多个 SKU/);
 const restored=createInventoryView(sql,{getUsableCells:()=>usable});assert.equal(restored.skuPlacement.get('K-B').items.length,2);
 const page=view.inventoryPage();
 view.skuPlacement.save('K-B',{items:[{sku:'B'}],revision:saved.revision});
 assert.throws(()=>view.inventoryPage({revision:page.revision}),/库存已更新/);
 assert.equal(view.inventoryPage({assignment:'unassigned'}).total,2);
 assert.equal(view.list().find(r=>r.sku==='B').loc_code,'K-B');
 }finally {sql.close();}
});
test('多 SKU 校验失败整体保留，旧绑定可平滑扩展',()=>{
 const {sql,view}=fixture();try {
 sql.prepare('INSERT INTO cell_sku_binding(loc_code,mode,source,warehouse_code,sku,revision) VALUES(?,?,?,?,?,?)').run('K-B','sku','ERP','WH','OLD',2);
 assert.deepEqual(view.skuPlacement.get('K-B').items,[{source:'ERP',sku:'OLD'}]);
 const saved=view.skuPlacement.save('K-B',{items:[{source:'ERP',sku:'OLD'},{source:'ERP',sku:'NEW'}],revision:2});
 assert.equal(saved.items.length,2);
 assert.throws(()=>view.skuPlacement.save('K-B',{items:[{sku:'DUP'},{sku:'DUP'}],revision:3}),/重复/);
 assert.equal(view.skuPlacement.get('K-B').revision,3);
 view.apply({source:'ERP',version:1,rows:[item({sku:'MULTI'})]});
 view.apply({source:'ERP2',version:1,rows:[item({sku:'MULTI'})]});
 assert.throws(()=>view.skuPlacement.save('K-B',{items:[{sku:'OTHER'},{sku:'MULTI'}],revision:3}),e=>e.bindingIndex===1 && e.sources.length===2);
 assert.equal(view.skuPlacement.get('K-B').items[1].sku,'NEW');
 }finally {sql.close();}
});
