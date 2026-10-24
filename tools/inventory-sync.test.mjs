import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createInventoryView } from '../apps/api/inventory-view.mjs';

test('增量重放、版本保护、对账、补发与事务回滚',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT);INSERT INTO space_node VALUES('1','A','cell')");
    let view=createInventoryView(sql);
    const row={sku:'轴承',name:'轴承',loc_code:'A',qty:10};
    view.receive({source:'ERP',version:1,rows:[row]},'admin');
    const delta={mode:'delta',source:'ERP',message_id:'1',base_version:1,version:2,changes:[{...row,op:'upsert',qty:7}]};
    assert.equal(view.receive(delta,'machine').applied,true);
    view=createInventoryView(sql); // 重建模块实例后仍使用持久化消息记录。
    assert.equal(view.receive(delta,'machine').replayed,true);
    assert.equal(view.list()[0].qty,7);
    assert.throws(()=>view.receive({...delta,changes:[{...row,op:'upsert',qty:99}]},'machine'),{status:409});
    assert.throws(()=>view.receive({...delta,message_id:'2'},'machine'),{status:409});
    assert.equal(view.receive({mode:'reconcile',source:'ERP',version:2,rows:[{...row,qty:7}]},'machine').matched,true);
    const difference=view.receive({mode:'reconcile',source:'ERP',version:2,rows:[row,{...row,sku:'螺栓'}]},'machine');
    assert.equal(difference.difference_count,2);
    assert.equal(view.list()[0].qty,7);
    const bad={mode:'delta',source:'ERP',message_id:'3',base_version:2,version:3,changes:[{op:'upsert',sku:'新物料',name:'新物料',external_loc_code:'EXT',qty:3}]};
    assert.throws(()=>view.receive(bad,'machine'),/未配置库位映射/);
    const failed=view.history()[0];assert.equal(failed.retryable,1);assert.equal('request_json' in failed,false);
    view.saveMapping({source:'ERP',external_loc_code:'EXT',loc_code:'A'});
    assert.equal(view.retry(failed.id,'admin').applied,true);
    assert.equal(view.history()[0].retry_of,failed.id);
    assert.equal(view.retry(failed.id,'admin').replayed,true);
    const next={mode:'delta',source:'ERP',message_id:'4',base_version:3,version:4,changes:[{op:'delete',sku:'轴承',loc_code:'A'}]};
    const before=JSON.stringify(view.list());
    sql.exec("CREATE TRIGGER fail_sync BEFORE INSERT ON external_inventory_sync_log WHEN NEW.result='applied' BEGIN SELECT RAISE(ABORT,'注入日志失败');END;");
    assert.throws(()=>view.receive(next,'machine'),/注入日志失败/);
    assert.equal(JSON.stringify(view.list()),before);assert.equal(view.status()[0].version,3);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM external_inventory_message WHERE message_id='4'").get().n,0);
    sql.exec('DROP TRIGGER fail_sync');
    assert.equal(view.receive(next,'machine').applied,true);
    assert.equal(view.list().length,1);
    assert.equal(view.receive(delta,'machine').replayed,true);assert.equal(view.status()[0].version,4);
    assert.throws(()=>view.receive({mode:{bad:true}},'machine'),/未知同步模式/);
  } finally {sql.close();}
});

test('库存单位重量校验、增量保留和对账差异',()=>{
 const sql=new DatabaseSync(':memory:');
 try {
  sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT);INSERT INTO space_node VALUES('1','A','cell')");
  const view=createInventoryView(sql),row={sku:'A',name:'轴承',loc_code:'A',qty:10,unit_weight_kg:2};
  view.receive({source:'ERP',version:1,rows:[row]},'admin');
  assert.equal(view.list()[0].unit_weight_kg,2);
  for(const value of [-1,'2',Infinity]) assert.throws(()=>view.receive({source:'ERP',version:2,rows:[{...row,unit_weight_kg:value}]},'admin'),/unit_weight_kg/);
  view.receive({mode:'delta',source:'ERP',message_id:'weight',base_version:1,version:2,changes:[{op:'upsert',...row,sku:'B',unit_weight_kg:0}]},'admin');
  assert.equal(view.list().find(r=>r.sku==='A').unit_weight_kg,2);
  assert.equal(view.list().find(r=>r.sku==='B').unit_weight_kg,0);
  const check=view.receive({mode:'reconcile',source:'ERP',version:2,rows:[{...row,unit_weight_kg:3},{...row,sku:'B',unit_weight_kg:0}]},'admin');
  assert.equal(check.difference_count,1);
 }finally{sql.close();}
});
