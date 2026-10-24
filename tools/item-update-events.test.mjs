import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';

test('物料更新：单库位移动数量事件、多库位歧义拒绝、逐库位属性快照与事务回滚',async()=>{
 const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'spatial-update-events-'));
 const previous=process.env.SPATIAL_DATA_DIR;process.env.SPATIAL_DATA_DIR=dir;
 const db=await import('../apps/api/db.mjs'),sql=db.default;
 try {
  const row={name:'更新测试',sku:'UPDATE-EVENT',qty:3,loc_code:'WH-1-A-L01-B01'};
  db.importItems([row]);
  const id=sql.prepare('SELECT id FROM item WHERE sku=?').get(row.sku).id;
  const events=()=>db.getPendingOutbox();
  let count=events().length;
  db.updateItem(id,{name:'更新后的名称',qty:8,loc_code:'WH-1-B-L01-B01',erp_code:'ERP-UPDATE'});
  const changed=events().slice(count);
  assert.deepEqual(changed.filter(e=>e.event_type==='inventory.changed').map(e=>{const p=JSON.parse(e.payload_json);return [p.loc_code,p.qty];}),[['WH-1-A-L01-B01',0],['WH-1-B-L01-B01',8]]);
  const master=JSON.parse(changed.at(-1).payload_json);assert.equal(master.name,'更新后的名称');assert.equal(master.erp_code,'ERP-UPDATE');assert.equal(master.qty,8);
  const snapshot=()=>Object.fromEntries(['item','inventory','external_mapping','outbox_event'].map(t=>[t,sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  let before=snapshot();
  sql.exec("CREATE TRIGGER fail_item_update BEFORE INSERT ON outbox_event WHEN NEW.event_type='item.updated' BEGIN SELECT RAISE(ABORT,'update event failed'); END");
  assert.throws(()=>db.updateItem(id,{name:'不应保存',qty:9,erp_code:'WRONG'}),/update event failed/);assert.deepEqual(snapshot(),before);
  sql.exec('DROP TRIGGER fail_item_update');
  assert.throws(()=>db.updateItem(id,{loc_code:'missing',name:'不应保存'}),/目标库位不存在/);assert.deepEqual(snapshot(),before);
  assert.throws(()=>db.updateItem(id,{qty:-1}),/非负有限数字/);assert.deepEqual(snapshot(),before);
  db.importItems([{...row,name:'更新后的名称'}]);before=snapshot();
  assert.throws(()=>db.updateItem(id,{qty:12,name:'不应保存'}),/唯一库存库位/);assert.deepEqual(snapshot(),before);
  assert.throws(()=>db.updateItem(id,{loc_code:'WH-1-C-L01-B01'}),/唯一库存库位/);assert.deepEqual(snapshot(),before);
  count=events().length;db.updateItem(id,{name:'两个库位同步改名'});
  const updated=events().slice(count);assert.equal(updated.length,2);
  for(const e of updated){const p=JSON.parse(e.payload_json);assert.equal(e.event_type,'item.updated');assert.equal(p.name,'两个库位同步改名');assert.equal(p.sku,'UPDATE-EVENT');assert.ok(p.loc_code);}
  for(const e of changed)assert.equal(sql.prepare('SELECT payload_json FROM outbox_event WHERE id=?').get(e.id).payload_json,e.payload_json);
 } finally {
  sql.close();if(previous===undefined)delete process.env.SPATIAL_DATA_DIR;else process.env.SPATIAL_DATA_DIR=previous;
  const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});
 }
});
