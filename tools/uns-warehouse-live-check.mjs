// 隔离候选真实业务变更验收；由运行中的服务同步，本脚本不发布MQTT。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as db from '../apps/api/db.mjs';
import {actorStore} from '../apps/api/context.mjs';
import {warehouseUnsRequest} from '../packages/integration/warehouse-publish.mjs';
assert.equal(process.env.SPATIAL_BASE_PATH,'/warehouse-standalone');
const request=warehouseUnsRequest(process.env.SUPOS_INTERNAL_API||'http://backend:8080');
const actor={id:'candidate-structure-check',name:'候选结构持续同步验收'};
const write=fn=>actorStore.run(actor,fn);
let room,alias;
async function expect(label,predicate,target=alias) {
  let lastError;
  for(let i=0;i<45;i++) {
    try {
      const current=(await request('file/current/batchQuery',[target]))?.[target];
      if(current?.snapshot&&predicate(JSON.parse(current.snapshot),current)){
        console.log(JSON.stringify({verified:true,stage:label,alias:target}));return;
      }
    } catch(error) {lastError=error;}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw Error(label+' 未同步'+(lastError?'：'+lastError.message:''));
}
try {
  room=write(()=>db.createRoomNode({siteCode:'WH',name:'UNS临时验收库区'}));
  const rack=write(()=>db.createRack({roomCode:room.loc_code,name:'UNS临时验收货架',rows:1,cols:2}));
  const loc=rack.furn_code+'-L01-B01';
  const node=db.default.prepare('SELECT id FROM space_node WHERE loc_code=?').get(loc);
  alias='warehouse3d_candidate_structure_n_'+createHash('sha256').update(node.id).digest('hex').slice(0,20);
  await expect('新建空格位',(s,c)=>s.cell.code===loc&&s.inventory.length===0&&c.occupied===0);
  write(()=>db.inbound({name:'UNS临时验收物料',sku:'UNS-TEMP-'+node.id,qty:2,unit:'kg',loc_code:loc}));
  await expect('库存变化',(s,c)=>s.inventory.length===1&&s.inventory[0].qty===2&&s.inventory[0].unit==='kg'&&c.occupied===1);
  write(()=>db.updateRack(rack.furn_code,{w:1.6}));
  await expect('货架尺寸变化',s=>s.ancestors.find(a=>a.type==='rack')?.geometry.w===1.6);
  const second=rack.furn_code+'-L01-B02';
  const secondNode=db.default.prepare('SELECT id FROM space_node WHERE loc_code=?').get(second);
  const secondAlias='warehouse3d_candidate_structure_n_'+createHash('sha256').update(secondNode.id).digest('hex').slice(0,20);
  write(()=>db.inbound({name:'UNS临时验收物料',sku:'UNS-TEMP-'+node.id,qty:1,unit:'kg',loc_code:second}));
  await expect('合并前子格库存',s=>s.inventory[0]?.qty===1,secondAlias);
  write(()=>db.setRackMerges(rack.furn_code,{L01:[[1,2]]}));
  assert.equal(db.getCells().filter(c=>c.loc_code.startsWith(rack.furn_code+'-')).length,1);
  await expect('合并主格库存守恒',s=>s.inventory.length===1&&s.inventory[0].qty===3);
  await expect('合并子格失效',(s,c)=>s.deleted===true&&s.inventory.length===0&&c.occupied===0,secondAlias);
  write(()=>db.setRackMerges(rack.furn_code,{}));
  assert.equal(db.getCells().filter(c=>c.loc_code.startsWith(rack.furn_code+'-')).length,2);
  await expect('拆分子格恢复原模型',(s,c)=>!s.deleted&&s.inventory.length===0&&c.occupied===0,secondAlias);
  await expect('拆分主格保留库存',s=>s.inventory.length===1&&s.inventory[0].qty===3);
  write(()=>db.deleteRoom(room.id));room=null;
  await expect('删除格位',(s,c)=>s.deleted===true&&s.inventory.length===0&&c.occupied===0);
  await expect('删除子格',(s,c)=>s.deleted===true&&s.inventory.length===0&&c.occupied===0,secondAlias);
} finally {
  if(room&&db.default.prepare('SELECT id FROM space_node WHERE id=?').get(room.id))write(()=>db.deleteRoom(room.id));
  db.default.close();
}
