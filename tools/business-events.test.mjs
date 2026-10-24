import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInventoryView} from '../apps/api/inventory-view.mjs';

test('外部事件持久化、重放、冲突整批回滚、分页与库存隔离',()=>{
 const sql=new DatabaseSync(':memory:');
 try {
  sql.exec("CREATE TABLE space_node(id TEXT,loc_code TEXT,node_type TEXT);INSERT INTO space_node VALUES('1','A','cell')");
  const view=createInventoryView(sql),event={event_id:'1',type:'inbound',loc_code:'A',sku:'A',name:'轴承',qty:2,occurred_at:'2026-09-16T08:00:00+08:00'};
  const send=events=>view.receive({mode:'events',source:'ERP',events},'test');
  assert.equal(send([event]).count,1);assert.equal(send([event]).skipped,1);
  assert.deepEqual(view.list(),[]);assert.equal(view.status().length,0);
  assert.throws(()=>send([{...event,event_id:'2'},{...event,qty:3}]),{status:409});
  assert.equal(view.businessEvents.page({loc_code:'A'}).total,1);
  assert.throws(()=>send([{...event,event_id:'3',loc_code:'missing'}]),/库位/);
  assert.throws(()=>send([{...event,occurred_at:'2026-09-16 08:00:00'}]),/时区/);
  assert.throws(()=>send([{...event,qty:-1}]),/qty/);
  assert.equal(send([{...event,event_id:'adjust',type:'adjustment',qty:-1}]).count,1);
  send(Array.from({length:23},(_,i)=>({...event,event_id:'page'+i})));
  const reopened=createInventoryView(sql).businessEvents;
  assert.equal(reopened.page({loc_code:'A'}).rows.length,20);
  assert.equal(reopened.page({loc_code:'A',page:2}).rows.length,5);
  assert.equal(reopened.page({loc_code:'B'}).total,0);
  assert.throws(()=>reopened.page({loc_code:'A',page:0}),/页码/);
 }finally{sql.close();}
});
