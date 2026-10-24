import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {SupOSAdapter} from '../packages/integration/adapters/suposUnsAdapter.mjs';

test('批量导入事件：逐库位冻结累计数量，发件箱失败时库存和流水一起回滚',async()=>{
  const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'spatial-import-events-'));
  const previous=process.env.SPATIAL_DATA_DIR;
  process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default;
  try {
    const rows=[
      {name:'导入事件测试',sku:'IMPORT-EVENT-TEST',qty:3,loc_code:'WH-1-A-L01-B01'},
      {name:'导入事件测试',sku:'IMPORT-EVENT-TEST',qty:4,loc_code:'WH-1-A-L01-B01'},
      {name:'导入事件测试',sku:'IMPORT-EVENT-TEST',qty:2,loc_code:'WH-1-B-L01-B01'},
    ];
    assert.equal(db.importItems(rows).imported,3);
    const events=db.getPendingOutbox().filter(e=>e.event_type==='inventory.changed');
    const bodies=events.map(e=>JSON.parse(e.payload_json));
    assert.deepEqual(bodies.map(b=>[b.loc_code,b.qty]),[
      ['WH-1-A-L01-B01',3],['WH-1-A-L01-B01',7],['WH-1-B-L01-B01',2],
    ]);
    assert.equal(new Set(bodies.map(b=>b.item_id)).size,1);
    const adapter=new SupOSAdapter('packages/integration/mapping/supos-uns.yaml');
    const sent=[];
    adapter.publish=async(topic,body,eventId)=>{sent.push({topic,body,eventId});return {ok:true};};
    for(const e of events) assert.equal((await adapter.send(e.event_type,{...JSON.parse(e.payload_json),_idem:e.id})).ok,true);
    assert.deepEqual(sent.map(e=>e.body.quantity),[3,7,2]);
    assert.deepEqual(sent.map(e=>e.eventId),events.map(e=>e.id));
    assert.match(sent[2].topic,/rack\/B\/layer\/L01\/bin\/B01\/quantity$/);
    const snapshot=()=>Object.fromEntries(['item','inventory','movement','outbox_event'].map(table=>[
      table,sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
    const before=snapshot();
    sql.exec("CREATE TRIGGER fail_import_event BEFORE INSERT ON outbox_event WHEN NEW.event_type='inventory.changed' BEGIN SELECT RAISE(ABORT,'injected event failure'); END");
    assert.throws(()=>db.importItems([rows[0]]),/injected event failure/);
    assert.deepEqual(snapshot(),before);
    sql.exec('DROP TRIGGER fail_import_event');
    db.importItems([rows[0]]);
    assert.deepEqual(events.map(e=>JSON.parse(sql.prepare('SELECT payload_json FROM outbox_event WHERE id=?').get(e.id).payload_json).qty),[3,7,2]);
    assert.equal(JSON.parse(db.getPendingOutbox().at(-1).payload_json).qty,10);
    const unitRows=[
      {name:'同名导入货品',sku:'UNIT-A',qty:0.5,unit:'kg',loc_code:rows[0].loc_code},
      {name:'同名导入货品',sku:'UNIT-B',qty:2,unit:'箱',loc_code:rows[0].loc_code},
      {name:'同名导入货品',sku:'UNIT-A',qty:1,unit:'',loc_code:rows[0].loc_code},
    ];
    const beforePreview=snapshot(),preview=db.importItems(unitRows,{preview:true});
    assert.equal(preview.imported,0);assert.deepEqual(snapshot(),beforePreview);
    assert.deepEqual(preview.rows.map(row=>[row.unit,row.before,row.after]),[['kg',0,0.5],['箱',0,2],['kg',0.5,1.5]]);
    const imported=db.importItems(unitRows,{request_id:'unit-import'});assert.equal(imported.created,2);
    const afterImport=snapshot();assert.equal(db.importItems(unitRows,{request_id:'unit-import'}).replayed,true);
    assert.deepEqual(snapshot(),afterImport);
    assert.throws(()=>db.importItems([{...unitRows[0],qty:8}],{request_id:'unit-import'}),/请求编号/);
    assert.throws(()=>db.importItems([{...unitRows[0],sku:'NEW-ROLLBACK'}, {...unitRows[2],unit:'箱'}]),/第 3 行.*单位/);
    assert.deepEqual(snapshot(),afterImport);
    assert.equal(db.importItems([{...unitRows[0],qty:1}],{preview:true}).rows[0].before,1.5);
  } finally {
    sql.close();
    if(previous===undefined)delete process.env.SPATIAL_DATA_DIR;else process.env.SPATIAL_DATA_DIR=previous;
    const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    rmSync(dir,{recursive:true,force:true});
  }
});
