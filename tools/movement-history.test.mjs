import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,relative,isAbsolute } from 'node:path';
import { actorStore } from '../apps/api/context.mjs';
import { installMovementHistory } from '../apps/api/movement-history.mjs';
import { DatabaseSync } from 'node:sqlite';

test('旧库升级补全现存关联信息，重复迁移不改写历史；已丢失的数据保持未知',()=>{
  const sql=new DatabaseSync(':memory:');
  try {
    sql.exec(`CREATE TABLE movement(id INTEGER PRIMARY KEY,item_id TEXT,from_node_id TEXT,to_node_id TEXT);
      CREATE TABLE item(id TEXT,name TEXT,sku TEXT);CREATE TABLE space_node(id TEXT,loc_code TEXT);
      CREATE TABLE external_mapping(external_system TEXT,local_type TEXT,local_id TEXT,external_id TEXT);
      INSERT INTO item VALUES('i','旧名称','OLD-SKU');INSERT INTO space_node VALUES('n','OLD-LOC');
      INSERT INTO movement VALUES(1,'i',NULL,'n'),(2,'deleted',NULL,'deleted');`);
    installMovementHistory(sql);
    assert.equal(JSON.parse(sql.prepare('SELECT history_json FROM movement WHERE id=1').get().history_json).item_name,'旧名称');
    sql.exec("UPDATE item SET name='新名称'; DELETE FROM space_node");installMovementHistory(sql);
    const history=JSON.parse(sql.prepare('SELECT history_json FROM movement WHERE id=1').get().history_json);
    assert.equal(history.item_name,'旧名称');assert.equal(history.to_loc,'OLD-LOC');
    assert.equal(JSON.parse(sql.prepare('SELECT history_json FROM movement WHERE id=2').get().history_json).item_name,null);
  } finally {sql.close();}
});

test('历史流水：重命名、删除物品/货架/库区后仍可查询，格位扩缩不重建保留节点',async()=>{
  const root=realpathSync(tmpdir()),dir=mkdtempSync(join(root,'spatial-history-'));
  process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default;
  try {
    const rack=db.createRack({name:'历史测试架',rows:2,cols:2}).furn_code;
    const loc=rack+'-L01-B01';
    actorStore.run({id:'operator-history',name:'历史操作员'},()=>db.createItem({name:'原始物料名称',sku:'HISTORY-PART',erp_code:'ERP-PART',qty:7,loc_code:loc}));
    const original=db.getCellHistory(loc)[0],node=sql.prepare('SELECT * FROM space_node WHERE loc_code=?').get(loc);
    assert.equal(original.item_name,'原始物料名称');
    const movement=()=>db.listMovements({limit:2000}).find(m=>m.id===original.id);
    assert.equal(movement().erp_code,'ERP-PART');assert.equal(movement().actor_name,'历史操作员');
    sql.prepare("UPDATE space_node SET photo_urls='[\"sample-photo\"]' WHERE id=?").run(node.id);
    const count=sql.prepare('SELECT count(*) n FROM movement').get().n;
    db.updateRack(rack,{rows:3,cols:3});db.updateRack(rack,{rows:1,cols:1});
    const retained=sql.prepare('SELECT * FROM space_node WHERE loc_code=?').get(loc);
    assert.equal(retained.id,node.id);assert.equal(retained.photo_urls,'["sample-photo"]');
    assert.equal(sql.prepare('SELECT count(*) n FROM movement').get().n,count);
    sql.prepare('UPDATE item SET name=? WHERE id=?').run('改名后的物料',original.item_id);
    db.setItemErpCode(original.item_id,'ERP-RENAMED');
    assert.equal(movement().item_name,'原始物料名称');assert.equal(movement().erp_code,'ERP-PART');
    db.deleteItem(original.item_id);db.deleteRack(rack);
    assert.equal(movement().to_loc_code,loc);assert.equal(movement().item_name,'原始物料名称');
    assert.equal(db.getCellHistory(loc)[0].id,original.id);
    assert.equal(db.listAuditMovements({actor:'历史操作员'})[0].item_name,'原始物料名称');
    const room=db.createRoomNode({name:'删除测试区'});
    const roomRack=db.createRack({roomCode:room.loc_code,name:'区内测试架',rows:1,cols:1}).furn_code;
    const roomLoc=roomRack+'-L01-B01';db.createItem({name:'库区历史物料',qty:2,loc_code:roomLoc});
    const roomHistory=db.getCellHistory(roomLoc)[0];db.deleteRoom(room.loc_code);
    assert.equal(db.getCellHistory(roomLoc)[0].id,roomHistory.id);
    // 遗留流水补全幂等；重启不以当前名称覆盖已捕获的上下文。
    installMovementHistory(sql);assert.equal(movement().item_name,'原始物料名称');
    const emptyRack=db.createRack({rows:2,cols:2}).furn_code;
    const occupied=emptyRack+'-L02-B02';db.createItem({name:'不可裁掉库存',qty:4,loc_code:occupied});
    assert.throws(()=>db.updateRack(emptyRack,{rows:1,cols:1,name:'不应写入'}),/仍有库存/);
    assert.equal(sql.prepare('SELECT qty FROM inventory WHERE node_id=(SELECT id FROM space_node WHERE loc_code=?)').get(occupied).qty,4);
    const visible=emptyRack+'-L01-B01',hidden=emptyRack+'-L01-B02';
    const item=db.inbound({name:'分页过滤物料',sku:'HISTORY-SCOPE',qty:1,loc_code:visible});
    const visibleBefore=db.getCellHistory(visible,[visible]).map(row=>row.id);
    for(let i=0;i<65;i++){
      db.moveItem({item_id:item.item_id,from_loc:visible,to_loc:hidden,qty:1});
      db.moveItem({item_id:item.item_id,from_loc:hidden,to_loc:visible,qty:1});
    }
    assert.equal(db.getCellHistory(visible).length,120);
    assert.deepEqual(db.getCellHistory(visible,[visible]).map(row=>row.id),visibleBefore);
  } finally {
    sql.close();const rel=relative(root,realpathSync(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));rmSync(dir,{recursive:true,force:true});
  }
});
