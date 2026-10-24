import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';

test('库存操作保持 SKU 独立，非法数量不改库存或流水，正常出入移库守恒',async()=>{
  const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'warehouse-counter-'));
  process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs');
  let closed=false;
  try {
    const rack=db.createRack({name:'库存测试架',rows:1,cols:2}).furn_code;
    const from=rack+'-L01-B01',to=rack+'-L01-B02';
    const add=(sku,qty=5)=>db.inbound({name:'同名物料',sku,qty,loc_code:from});
    const a=add('COUNTER-A',10),b=add('COUNTER-B'),unassigned=add('');
    assert.equal(new Set([a.item_id,b.item_id,unassigned.item_id]).size,3);
    assert.equal(b.sku,'COUNTER-B');
    assert.equal(add(' COUNTER-A ',2).item_id,a.item_id);
    assert.equal(add('',1).item_id,unassigned.item_id);
    const searchA=db.search('COUNTER-A');
    assert.equal(searchA.length,1);assert.equal(searchA[0].sku,'COUNTER-A');
    assert.equal(searchA[0].qty,12);assert.equal(searchA[0].unit,'件');
    assert.equal(db.search('同名物料').length,3);
    const idHit=db.search(unassigned.item_id);
    assert.equal(idHit.length,1);assert.equal(idHit[0].qty,6);
    assert.equal(db.search(unassigned.item_id,[]).length,0);
    const state=()=>JSON.stringify({inventory:db.listInventory(),movements:db.listMovements({limit:1000}),events:db.getPendingOutbox()});
    const before=state();
    for(const qty of [0,'0',-1,'',null,undefined,'abc',Infinity,NaN]) {
      assert.throws(()=>db.outbound({loc_code:from,item_id:a.item_id,qty}),/数量/);
      assert.throws(()=>db.moveItem({from_loc:from,to_loc:to,item_id:a.item_id,qty}),/数量/);
      assert.equal(state(),before);
    }
    assert.throws(()=>db.outbound({loc_code:from,item_id:a.item_id,qty:13}),/库存不足/);
    assert.equal(state(),before);
    assert.equal(db.outbound({loc_code:from,item_id:a.item_id,qty:2}).remain,10);
    const moved=db.moveItem({from_loc:from,to_loc:to,item_id:a.item_id,qty:3});
    assert.equal(moved.from_remain,7);assert.equal(moved.to_total,3);
    assert.equal(db.getCellHistory(to).filter(m=>m.move_type==='move').length,1);
    const requests=[
      [db.inbound,{name:'可重试物料',sku:'RETRY',loc_code:from,qty:4,request_id:'receipt-1'}],
      [db.outbound,{loc_code:from,item_id:a.item_id,qty:1,request_id:'issue-1'}],
      [db.moveItem,{from_loc:from,to_loc:to,item_id:a.item_id,qty:1,request_id:'move-1'}],
      [db.createItem,{name:'普通录入',sku:'CREATE-RETRY',unit:'kg',qty:0.5,loc_code:from,request_id:'create-1'}]
    ];
    for(const [operation,input] of requests){
      operation(input);const committed=state();
      assert.equal(operation(input).replayed,true);assert.equal(state(),committed);
      assert.throws(()=>operation({...input,qty:2}),/请求编号/);assert.equal(state(),committed);
    }
    db.default.exec("CREATE TEMP TRIGGER fail_counter_event BEFORE INSERT ON outbox_event BEGIN SELECT RAISE(ABORT,'模拟事件故障'); END");
    for(const [operation,input] of requests){
      const beforeFailure=state();
      assert.throws(()=>operation({...input,request_id:'fail-'+input.request_id}),/模拟事件故障/);
      assert.equal(state(),beforeFailure);
    }
    db.default.exec('DROP TRIGGER fail_counter_event');
    // 新货品也应回滚，不能只验证已有SKU追加库存。
    const countItems=()=>db.default.prepare('SELECT COUNT(*) n FROM item').get().n;
    const beforeCreate=state(),beforeItems=countItems();
    db.default.exec("CREATE TEMP TRIGGER fail_new_item BEFORE INSERT ON movement BEGIN SELECT RAISE(ABORT,'模拟流水故障'); END");
    assert.throws(()=>db.createItem({name:'失败新货品',sku:'CREATE-FAIL',unit:'箱',qty:2,loc_code:from,request_id:'create-fail'}),/模拟流水故障/);
    assert.equal(countItems(),beforeItems);assert.equal(state(),beforeCreate);
    db.default.exec('DROP TRIGGER fail_new_item');
    assert.equal(db.createItem({name:'失败新货品',sku:'CREATE-FAIL',unit:'箱',qty:2,loc_code:from,request_id:'create-fail'}).reused,false);
    assert.equal(db.inbound({...requests[0][1],request_id:'fail-receipt-1'}).added,4);
    const material={name:'散装物料',sku:'WEIGHT',unit:'kg',loc_code:from,qty:2.5};
    const weight=db.inbound(material);assert.equal(weight.unit,'kg');
    assert.equal(db.inbound({...material,unit:''}).unit,'kg');
    const saved=state();assert.throws(()=>db.inbound({...material,unit:'箱'}),/原单位/);assert.equal(state(),saved);
    assert.equal(db.getCellItems(from).find(i=>i.item_id===weight.item_id).unit,'kg');
    assert.equal(db.listInventory().find(i=>i.item_id===weight.item_id).unit,'kg');
    assert.equal(db.getItemByCode('WEIGHT').unit,'kg');
    assert.equal(db.moveItem({item_id:weight.item_id,from_loc:from,to_loc:to,qty:0.5}).to_total,0.5);
    assert.equal(db.getCellItems(to).find(i=>i.item_id===weight.item_id).unit,'kg');
    assert.equal(db.getCellHistory(to).find(m=>m.item_id===weight.item_id).unit,'kg');
    db.default.prepare("UPDATE item SET unit='箱',name='改名后' WHERE id=?").run(weight.item_id);
    const prior=db.listMovements({limit:1000}).find(m=>m.item_id===weight.item_id);
    assert.equal(prior.unit,'kg');assert.equal(prior.item_name,'散装物料');
    const beforeRestart=JSON.parse(state());
    db.default.close();closed=true;
    const reopened=spawnSync(process.execPath,['--input-type=module','-e',`
      import * as db from ${JSON.stringify(new URL('../apps/api/db.mjs',import.meta.url).href)};
      const replayed=db.createItem(${JSON.stringify(requests[3][1])}).replayed;
      console.log(JSON.stringify({replayed,inventory:db.listInventory(),movements:db.listMovements({limit:1000}),events:db.getPendingOutbox()}));
      db.default.close();
    `],{env:{...process.env,SPATIAL_DATA_DIR:dir},encoding:'utf8',timeout:15000});
    assert.equal(reopened.status,0,reopened.stderr);
    const restored=JSON.parse(reopened.stdout);assert.equal(restored.replayed,true);
    delete restored.replayed;assert.deepEqual(restored,beforeRestart);
  } finally {
    if(!closed)db.default.close();
    const rel=relative(root,realpathSync(dir));
    assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    rmSync(dir,{recursive:true,force:true});
  }
});
