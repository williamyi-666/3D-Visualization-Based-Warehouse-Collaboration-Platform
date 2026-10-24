import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';

test('场景批量读取按库区隔离同SKU库存，并保留空格、属性、照片与ERP映射',async()=>{
  const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'scene-read-'));
  process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs');const sql=db.default;
  try{
    const rooms=[db.createRoomNode({name:'批量场景A'}),db.createRoomNode({name:'批量场景B'})];
    const racks=rooms.map(room=>db.createRack({name:'架',roomCode:room.loc_code,rows:1,cols:2,geom:{w:2,h:2,d:1,x:0,z:0,rot:0}}).furn_code);
    const codes=racks.map(code=>code+'-L01-B01');
    db.createItem({name:'轴承',sku:'SAME-SKU',qty:5,loc_code:codes[0],erp_code:'ERP-001',note:'属性保留',photo:'data:image/png;base64,AA=='});
    db.createItem({name:'轴承',sku:'SAME-SKU',qty:7,loc_code:codes[1]});
    db.setCellMeta(codes[0],{name:'备件位',capacity:20,max_load:100,status:'stocktaking',tags:['备件'],note:'格位备注'});
    db.addCellPhoto(codes[0],'data:image/png;base64,BB==');
    const scenes=rooms.map(room=>db.getScene(room.loc_code));
    for(let i=0;i<2;i++){
      assert.equal(scenes[i].furniture.length,1);
      const rack=scenes[i].furniture[0];assert.equal(rack.code,racks[i]);
      assert.equal(rack.capacityPerCell,null);
      assert.equal(rack.cellMeta['L01-B01'].capacity,i===0?20:null);
      assert.equal(rack.items['L01-B01'].length,1);
      assert.equal(rack.items['L01-B01'][0].qty,[5,7][i]);
      assert.equal(rack.items['L01-B01'][0].sku,'SAME-SKU');
      assert.equal(rack.items['L01-B01'][0].erp_code,'ERP-001');
      assert.deepEqual(rack.items['L01-B02'],[]);
    }
    const rack=scenes[0].furniture[0];
    assert.equal(rack.items['L01-B01'][0].note,'属性保留');
    assert.deepEqual(rack.cellPhotos['L01-B01'],['data:image/png;base64,BB==']);
    assert.equal(rack.cellMeta['L01-B01'].status,'stocktaking');
    assert.deepEqual(rack.cellMeta['L01-B01'].tags,['备件']);
    assert.equal(rack.cellNames['L01-B01'],'备件位');
    sql.prepare('UPDATE inventory SET qty=0 WHERE node_id=(SELECT id FROM space_node WHERE loc_code=?)').run(codes[0]);
    assert.deepEqual(db.getScene(rooms[0].loc_code).furniture[0].items['L01-B01'],[]);
    assert.equal(db.getScene(rooms[1].loc_code).furniture[0].items['L01-B01'][0].qty,7);
  }finally{
    sql.close();const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});
  }
});
