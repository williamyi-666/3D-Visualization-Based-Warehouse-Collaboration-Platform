import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rackTemplates,planQuickBuild} from '../packages/three-kit/quick-build.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {createStocktakes} from '../apps/api/stocktake.mjs';
import {actorStore} from '../apps/api/context.mjs';

test('批量建仓、首次建账和作业规则',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'warehouse-work-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,actor={id:'test-operator',name:'测试操作员'};
  createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
  const work=createWarehouseWork(sql,{db});
  try {await actorStore.run(actor,async()=>{
    const room=db.createRoomNode({name:'快速落地测试',w:12,d:8,h:4}),roomCode=room.loc_code;
    const input={roomCode,template:'shelf',count:4,perRow:2,aisle:1.2,gap:0.3,...rackTemplates[0]};
    let preview=planQuickBuild(db.getLayout(roomCode),input);
    await t.test('整批生成稳定格位码，重复提交不重复生成',()=>{
      assert.equal(preview.problems.length,0);assert.equal(preview.cellCount,48);
      const body={...input,revision:preview.revision,request_id:'quick-build-1'};
      const result=db.quickBuildRacks(body,planQuickBuild),retry=db.quickBuildRacks(body,planQuickBuild);
      assert.equal(result.created.length,4);assert.equal(retry.replayed,true);
      assert.equal(work.progress(roomCode).total,48);
      assert.equal(sql.prepare("SELECT COUNT(*) n FROM space_operation WHERE action='quickBuild'").get().n,1);
    });
    await t.test('重叠、越界、旧布局均拒绝，现有货架不变',()=>{
      const before=db.getLayout(roomCode);assert.throws(()=>db.quickBuildRacks({...input,revision:preview.revision,request_id:'quick-build-2'},planQuickBuild),/已变化/);
      const collision=planQuickBuild(before,input);assert.ok(collision.problems.length);
      assert.throws(()=>db.quickBuildRacks({...input,revision:before.revision,request_id:'quick-build-3'},planQuickBuild),/重叠/);
      assert.equal(db.getLayout(roomCode).furniture.length,4);
    });
    const cells=work.progress(roomCode).rows.map(c=>c.loc_code),first=cells[0];let item;
    await t.test('期初实盘生成临时SKU，可复用，重试只有一条流水',()=>{
      const snapshot=work.opening(first),body={loc_code:first,baseline:snapshot.baseline,request_id:'opening-1',rows:[{name:'标准螺母',qty:24,unit:'盒'}]};
      const result=work.establish(body,actor);item=result.rows[0];assert.match(item.sku,/^TMP-/);
      assert.equal(work.establish(body,actor).replayed,true);
      assert.equal(db.getCellItems(first)[0].qty,24);
      assert.equal(sql.prepare("SELECT COUNT(*) n FROM movement WHERE move_type='opening' AND to_node_id=(SELECT id FROM space_node WHERE loc_code=?)").get(first).n,1);
      assert.throws(()=>work.establish({...body,request_id:'opening-again'},actor),/已建立/);
      const second=work.opening(cells[1]);work.establish({loc_code:second.loc_code,baseline:second.baseline,request_id:'opening-2',rows:[{item_id:item.item_id,name:item.name,sku:item.sku,qty:5,unit:'盒'}]},actor);
      assert.equal(db.getCellItems(cells[1])[0].item_id,item.item_id);
    });
    await t.test('并发入库阻止陈旧建账，失败整批回滚',()=>{
      const snapshot=work.opening(cells[2]);db.inbound({loc_code:cells[2],name:'已入库',sku:'EXISTING',qty:3});
      assert.throws(()=>work.establish({loc_code:cells[2],baseline:snapshot.baseline,request_id:'stale',rows:[{name:'覆盖',qty:1}]},actor),/已变化/);
      assert.equal(db.getCellItems(cells[2])[0].qty,3);
      const next=work.opening(cells[3]);assert.throws(()=>work.establish({loc_code:cells[3],baseline:next.baseline,request_id:'invalid',rows:[{name:'应回滚',qty:8},{name:'无效',qty:-1}]},actor),/实盘数量/);
      assert.equal(db.getCellItems(cells[3]).length,0);assert.equal(sql.prepare("SELECT COUNT(*) n FROM item WHERE name='应回滚'").get().n,0);
      work.establish({loc_code:cells[3],baseline:next.baseline,request_id:'empty',rows:[]},actor);assert.equal(work.opening(cells[3]).completed.empty,true);
    });
    await t.test('推荐避开锁定、超容量和超承重，不夸大未配置条件',()=>{
      sql.prepare("UPDATE space_node SET status='locked' WHERE loc_code=?").run(cells[4]);
      db.setCellMeta(cells[5],{capacity_rule:{product:{...item,unit:'盒'},capacity:1}});
      sql.prepare('UPDATE space_node SET max_load=1 WHERE loc_code=?').run(cells[6]);
      const r=work.recommend({room:roomCode,item_id:item.item_id,qty:2,unit:'盒',unit_weight:1});
      assert.equal(r.candidates[0].loc_code,first);assert.ok(r.candidates[0].reasons.some(s=>s.includes('相同SKU')));
      for(const code of [cells[4],cells[5],cells[6]])assert.ok(!r.candidates.some(c=>c.loc_code===code));
      assert.ok(r.candidates[0].warnings.some(s=>s.includes('未设置')));
      sql.prepare('UPDATE space_node SET max_load=25 WHERE loc_code=?').run(first);
      const loaded=work.recommend({room:roomCode,item_id:item.item_id,qty:2,unit:'盒',unit_weight:1});
      assert.ok(!loaded.candidates.some(c=>c.loc_code===first));
      sql.prepare('UPDATE space_node SET max_load=NULL WHERE loc_code=?').run(first);
    });
    await t.test('待办由规则和实际库存派生，可恢复我的盘点草稿',()=>{
      work.savePolicy(roomCode,{count_days:30,thresholds:[{item_id:item.item_id,minimum:40}]});
      const stocktakes=createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
      const draft=stocktakes.create({loc_code:first},actor);
      const tasks=work.tasks(roomCode,null,actor);
      assert.ok(tasks.rows.some(row=>row.kind==='draft'&&row.id===draft.id));
      assert.ok(tasks.rows.some(row=>row.kind==='low'&&row.title.includes('螺母')));
      db.inbound({loc_code:first,sku:item.sku,name:item.name,qty:20,unit:'盒'});
      assert.ok(!work.tasks(roomCode,null,actor).rows.some(row=>row.kind==='low'));
    });
    await t.test('跨仓权限不能通过新工作台接口绕过',()=>{
      const deny=()=>false;for(const fn of [()=>work.opening(first,deny),()=>work.progress(roomCode,deny),()=>work.recommend({room:roomCode,qty:1},deny),()=>work.tasks(roomCode,deny,actor)])assert.throws(fn,error=>error.status===403);
    });
    await t.test('无差异盘点也重置到期提醒，耗尽的货品仍可复用',()=>{
      sql.prepare("UPDATE opening_stock SET created_at=datetime('now','-40 days') WHERE loc_code=?").run(cells[1]);
      assert.ok(work.tasks(roomCode,null,actor).rows.some(row=>row.kind==='count'&&row.loc_code===cells[1]));
      const stocktakes=createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
      let record=stocktakes.create({loc_code:cells[1]},actor);
      record=stocktakes.save(record.id,{revision:record.revision,counts:record.baseline.map(i=>({item_id:i.item_id,qty:i.qty}))},actor);
      stocktakes.finish(record.id,{revision:record.revision,action:'confirm'},actor);
      assert.ok(!work.tasks(roomCode,null,actor).rows.some(row=>row.kind==='count'&&row.loc_code===cells[1]));
      db.outbound({loc_code:cells[1],item_id:item.item_id,qty:5});
      assert.ok(work.catalogue(roomCode,null,actor).some(i=>i.item_id===item.item_id));
    });
    await t.test('旧版建账和规则迁移保留回执、库存及原请求',()=>{
      const receipts=sql.prepare('SELECT * FROM opening_stock ORDER BY node_id').all();
      const before=db.listInventory(),savedPolicy=work.policy(roomCode);
      sql.exec(`ALTER TABLE opening_stock RENAME TO opening_stock_new;
        CREATE TABLE opening_stock (loc_code TEXT PRIMARY KEY,node_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
        INSERT INTO opening_stock SELECT * FROM opening_stock_new; DROP TABLE opening_stock_new;
        ALTER TABLE warehouse_work_policy DROP COLUMN room_id;`);
      const restored=createWarehouseWork(sql,{db});
      assert.deepEqual(sql.prepare('SELECT * FROM opening_stock ORDER BY node_id').all(),receipts);
      assert.deepEqual(db.listInventory(),before);
      assert.deepEqual(restored.policy(roomCode),savedPolicy);
      assert.equal(restored.opening(first).completed.rows[0].item_id,item.item_id);
      assert.equal(sql.prepare('PRAGMA table_info(opening_stock)').all().find(c=>c.name==='node_id').pk,1);
    });
    await t.test('货架和库区重建不继承旧底账、旧草稿和旧规则',()=>{
      const r=db.createRoomNode({name:'重建试点',w:12,d:8,h:4});
      const make=()=>db.createRack({roomCode:r.loc_code,rows:1,cols:1});
      const rack=make(),code=rack.furn_code+'-L01-B01',old=work.opening(code);
      const oldBody={loc_code:code,baseline:old.baseline,request_id:'lifecycle-old',rows:[]};
      work.establish(oldBody,actor);
      const stocktakes=createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
      const draft=stocktakes.create({loc_code:code},actor);
      work.savePolicy(r.loc_code,{count_days:30,thresholds:[]});
      db.deleteRack(rack.furn_code);assert.equal(make().furn_code,rack.furn_code);
      assert.equal(work.opening(code).completed,null);assert.equal(work.progress(r.loc_code).completed,0);
      assert.ok(!work.tasks(r.loc_code,null,actor).rows.some(t=>t.id===draft.id));
      const fresh=work.opening(code);
      work.establish({loc_code:code,baseline:fresh.baseline,request_id:'lifecycle-new',rows:[{name:'重建底账',qty:2,unit:'箱'}]},actor);
      assert.equal(work.establish(oldBody,actor).replayed,true);assert.equal(db.getCellItems(code)[0].qty,2);
      assert.equal(sql.prepare('SELECT COUNT(*) n FROM opening_stock WHERE loc_code=?').get(code).n,2);
      db.deleteRoom(r.id);const rebuilt=db.createRoomNode({name:'重建库区',w:12,d:8,h:4});
      assert.equal(rebuilt.loc_code,r.loc_code);assert.notEqual(rebuilt.id,r.id);
      assert.equal(work.policy(rebuilt.loc_code).count_days,0);
      work.savePolicy(rebuilt.loc_code,{count_days:7,thresholds:[]});assert.equal(work.policy(rebuilt.loc_code).count_days,7);
    });
  });}finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
