import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';

test('货品多码与正式编号：库存历史不变，所有登记入口复用同一货品',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'item-codes-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,codes=db.itemCodes,actor={id:'code-admin',name:'编码管理员'};
  const work=createWarehouseWork(sql,{db}),room=db.createRoomNode({name:'多码验收',w:12,d:8,h:4});
  const rack=db.createRack({roomCode:room.loc_code,rows:2,cols:3}),loc=n=>rack.furn_code+'-L01-B0'+n;
  const first=work.opening(loc(1)),added=work.establish({loc_code:loc(1),baseline:first.baseline,request_id:'open',rows:[{name:'现场轴承',qty:5,unit:'套'}]},actor).rows[0];
  const originalSku=added.sku,id=added.item_id;
  const snapshot=()=>({inventory:sql.prepare('SELECT * FROM inventory ORDER BY id').all(),movements:sql.prepare('SELECT * FROM movement ORDER BY id').all()});
  let request;
  try {
    await t.test('临时转正式并增加供应商条码，库存和所有流水逐字段保持不变',()=>{
      const before=snapshot(),detail=codes.get(id);request={revision:detail.revision,sku:'BRG-6204',codes:[{code:'SUP-6204',kind:'supplier'},{code:'690000620401',kind:'barcode'}],request_id:'rename-1'};
      const saved=codes.save(id,request,actor);assert.equal(saved.temporary,false);assert.equal(saved.sku,'BRG-6204');
      assert.ok(saved.codes.some(row=>row.code===originalSku&&row.kind==='legacy'));assert.deepEqual(snapshot(),before);
      for(const code of [originalSku,'BRG-6204','SUP-6204','690000620401',id])assert.equal(db.getItemByCode(code).item_id,id);
      assert.equal(codes.list('SUP-6204')[0].item_id,id);assert.equal(codes.list('BRG-6204')[0].needs_code,0);
    });
    await t.test('丢回执可重放，换内容不能复用请求编号，旧版本不能覆盖',()=>{
      assert.equal(codes.save(id,request,actor).replayed,true);assert.equal(codes.history(id).length,1);
      assert.throws(()=>codes.save(id,{...request,sku:'OTHER'},actor),error=>error.status===409);
      assert.throws(()=>codes.save(id,{...request,request_id:'stale'},actor),error=>error.status===409);
    });
    await t.test('供应商码和旧SKU用于录入、入库、CSV导入时均不新建货品',()=>{
      const count=sql.prepare('SELECT COUNT(*) n FROM item').get().n;
      assert.equal(db.createItem({name:'供应商轴承',sku:'SUP-6204',loc_code:loc(1),qty:2,unit:'套'}).id,id);
      assert.equal(db.inbound({name:'旧标签',sku:originalSku,loc_code:loc(1),qty:3,unit:'套'}).item_id,id);
      const preview=db.importItems([{name:'旧标签',sku:'SUP-6204',loc_code:loc(1),qty:4,unit:'套'}],{preview:true});assert.equal(preview.errors.length,0);
      const result=db.importItems([{name:'旧标签',sku:'SUP-6204',loc_code:loc(1),qty:4,unit:'套'}]);assert.equal(result.created,0);assert.equal(result.imported,1);
      assert.equal(sql.prepare('SELECT COUNT(*) n FROM item').get().n,count);assert.equal(db.getCellItems(loc(1))[0].qty,14);
    });
    await t.test('建账、查货和货位推荐使用同一条码解析',()=>{
      const next=work.opening(loc(2));
      work.establish({loc_code:loc(2),baseline:next.baseline,request_id:'open-alias',rows:[{name:'轴承',sku:'SUP-6204',qty:2,unit:'套'}]},actor);
      assert.equal(db.getCellItems(loc(2))[0].item_id,id);assert.ok(db.search('SUP-6204').some(row=>row.item_id===id));
      assert.ok(work.recommend({room:room.loc_code,sku:'SUP-6204',qty:1,unit:'套'}).candidates[0].reasons.some(value=>value.includes('相同SKU')));
    });
    await t.test('换正式编号后旧编号继续有效，编辑时不能误删历史编号',()=>{
      const detail=codes.get(id);codes.save(id,{revision:detail.revision,sku:'BRG-6204-V2',codes:[],request_id:'rename-2'},actor);
      assert.equal(db.getItemByCode(originalSku).item_id,id);assert.equal(db.getItemByCode('BRG-6204').item_id,id);
      assert.equal(db.getItemByCode('SUP-6204'),null);assert.equal(codes.history(id)[0].actor_name,'编码管理员');
    });
    let other;
    await t.test('编码冲突、跨货品传码与单位变化均拒绝，失败不留下半条数据',()=>{
      other=db.createItem({name:'另一规格',sku:'OTHER-6205',loc_code:loc(3),qty:1,unit:'件'}).id;
      const before=snapshot(),detail=codes.get(other),body={revision:detail.revision,sku:'OTHER-6205',codes:[{code:'SHOULD-NOT-SAVE',kind:'supplier'},{code:originalSku,kind:'barcode'}],request_id:'collision'};
      assert.throws(()=>codes.save(other,body,actor),error=>error.status===409);
      assert.equal(db.getItemByCode('SHOULD-NOT-SAVE'),null);assert.equal(codes.history(other).length,0);assert.deepEqual(snapshot(),before);
      assert.throws(()=>db.inbound({name:'错配',item_id:other,sku:originalSku,qty:1,loc_code:loc(3)}),/不一致/);
      assert.throws(()=>db.inbound({name:'错单位',sku:originalSku,qty:1,unit:'箱',loc_code:loc(1)}),/单位/);
      assert.throws(()=>sql.prepare('UPDATE item SET sku=? WHERE id=?').run(originalSku,other),/其他货品/);
      assert.throws(()=>sql.prepare('INSERT INTO item(id,tenant_id,name,sku) VALUES(?,?,?,?)').run('duplicate',db.TENANT,'错误新建',originalSku),/其他货品/);
      assert.deepEqual(snapshot(),before);
    });
    await t.test('ERP编码与多条码共用编码空间，不能绑到另一个货品',()=>{
      db.setItemErpCode(id,'ERP-6204');assert.equal(db.getItemByCode('ERP-6204').item_id,id);
      assert.throws(()=>db.setItemErpCode(other,'ERP-6204'),/其他货品/);
      assert.throws(()=>db.setItemErpCode(other,originalSku),/其他货品/);
      const detail=codes.get(other);
      assert.throws(()=>codes.save(other,{revision:detail.revision,sku:'ERP-6204',codes:[],request_id:'erp-collision'},actor),error=>error.status===409);
    });
    await t.test('人工核对同名提示，查询中的百分号和下划线按字面查找',()=>{
      db.createItem({name:'现场轴承',sku:'OTHER-SPEC',loc_code:loc(3),qty:1});
      assert.ok(codes.list('现场轴承').every(row=>row.same_name_count===2));
      assert.equal(codes.list('%').length,0);assert.equal(codes.list('_').length,0);
    });
  } finally {sql.close();rmSync(dir,{recursive:true,force:true});}
});
