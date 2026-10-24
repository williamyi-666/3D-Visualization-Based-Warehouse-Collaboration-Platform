import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {createStocktakes} from '../apps/api/stocktake.mjs';

test('部署进度区分有库存、核对中和已核对，不把导入库存算作实盘完成',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opening-progress-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,work=createWarehouseWork(sql,{db}),actor={id:'count-worker',name:'盘点员'};
  const counts=createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
  try {
    const room=db.createRoomNode({name:'首次核对',w:12,d:8,h:4}),rack=db.createRack({roomCode:room.loc_code,rows:1,cols:2}),loc=rack.furn_code+'-L01-B01',empty=rack.furn_code+'-L01-B02';
    db.inbound({name:'导入货品',sku:'IMPORTED',qty:5,unit:'套',loc_code:loc});
    let progress=work.progress(room.loc_code);assert.equal(progress.completed,0);assert.equal(progress.unverified,2);
    assert.equal(progress.rows.find(row=>row.loc_code===loc).has_stock,true);assert.equal(progress.rows.find(row=>row.loc_code===loc).status,'unverified');
    let count=counts.create({loc_code:loc},actor);assert.equal(work.progress(room.loc_code).counting,1);
    count=counts.save(count.id,{revision:count.revision,counts:count.baseline.map(row=>({item_id:row.item_id,qty:row.qty}))},actor);
    counts.finish(count.id,{revision:count.revision,action:'confirm'},actor);
    progress=work.progress(room.loc_code);assert.equal(progress.completed,1);assert.equal(progress.counting,0);assert.equal(progress.rows.find(row=>row.loc_code===loc).status,'verified');
    const snapshot=work.opening(empty);assert.ok(snapshot.node_id);
    work.establish({loc_code:empty,baseline:snapshot.baseline,rows:[],request_id:'empty-verified'},actor);assert.equal(work.progress(room.loc_code).completed,2);
    assert.equal(db.getCellItems(loc)[0].qty,5);
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
