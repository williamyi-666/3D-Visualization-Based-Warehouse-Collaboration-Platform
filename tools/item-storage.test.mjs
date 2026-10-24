import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createItemStorage,normalizeStorageProfile} from '../apps/api/item-storage.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {makeBackup,restoreBackup} from './backup-data.mjs';

test('存放资料和上架推荐：尺寸、标签、承重、距离与资料追溯',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'item-storage-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,actor={id:'storage-worker',name:'存放资料维护员',role:'operator'},viewer={id:'storage-viewer',role:'viewer'};
  let failEmit=false;const storage=createItemStorage(sql,{tenant:db.TENANT,emit:(...args)=>{if(failEmit)throw Error('模拟事件写入失败');db.emit(...args);}}),work=createWarehouseWork(sql,{db});
  const room=db.createRoomNode({name:'存放条件验收',w:12,d:8,h:4,door:[{side:'back',offset:.5}]}),a=db.createRack({roomCode:room.loc_code,rows:2,cols:4,x:-2,z:0}),b=db.createRack({roomCode:room.loc_code,rows:2,cols:4,x:2,z:0});
  const from=a.furn_code+'-L01-B01',near=b.furn_code+'-L01-B01',item=db.inbound({loc_code:from,name:'包装轴承',sku:'STORAGE-6204',unit:'套',qty:10,note:'保留原备注'});
  const blank={width:null,height:null,depth:null,weight_kg:null,required_tags:[],horizontal_rotation:false};let request=0;
  const save=profile=>storage.save(item.item_id,{revision:storage.get(item.item_id,actor).revision,profile,request_id:'storage-'+(++request)},actor);
  const recommend=extra=>work.recommend({room:room.loc_code,item_id:item.item_id,qty:2,unit:'套',...extra});
  try{
    await t.test('保存、重放和旧版本校验不改变库存、条码或备注',()=>{
      const before=JSON.stringify(db.listInventory()),initial=storage.get(item.item_id,actor),input={revision:initial.revision,profile:{...blank,width:.25,height:.3,depth:.2,weight_kg:.5},request_id:'first-profile'};
      const saved=storage.save(item.item_id,input,actor);assert.equal(saved.profile.configured,true);assert.equal(saved.profile.width,.25);assert.equal(storage.save(item.item_id,input,actor).replayed,true);
      assert.equal(storage.history(item.item_id,actor).length,1);assert.equal(JSON.stringify(db.listInventory()),before);assert.equal(db.getItemByCode('STORAGE-6204').item_id,item.item_id);assert.equal(JSON.parse(sql.prepare('SELECT attributes FROM item WHERE id=?').get(item.item_id).attributes).note,'保留原备注');
      assert.throws(()=>storage.save(item.item_id,{...input,request_id:'stale',profile:blank},actor),e=>e.status===409);
      assert.throws(()=>storage.save(item.item_id,{...input,profile:blank},actor),e=>e.status===409);
    });
    await t.test('尺寸不完整拒绝保存；水平转向须明确允许，高度始终保持朝上',()=>{
      assert.throws(()=>normalizeStorageProfile({width:.2}),/全部填写/);assert.throws(()=>normalizeStorageProfile({...blank,weight_kg:0}),/大于零/);
      save({...blank,width:.35,height:.3,depth:.2});assert.equal(recommend().candidates.length,0);
      save({...blank,width:.35,height:.3,depth:.2,horizontal_rotation:true});assert.ok(recommend().candidates.every(c=>c.rotated));
      save({...blank,width:.2,height:2,depth:.2,horizontal_rotation:true});assert.equal(recommend().candidates.length,0);
    });
    await t.test('合并格位使用实际跨度；必需条件标签全部匹配才入选',()=>{
      db.setRackMerges(a.furn_code,{L01:[[1,2]]});save({...blank,width:.5,height:.3,depth:.2,required_tags:['干燥','避光']});
      db.setCellMeta(from,{tags:['干燥']});assert.equal(recommend().candidates.length,0);
      db.setCellMeta(from,{tags:['干燥','避光']});const result=recommend();assert.deepEqual(result.candidates.map(c=>c.loc_code),[from]);assert.equal(result.candidates[0].dimensions.width,.6);assert.ok(result.candidates[0].warnings.some(s=>s.includes('整批堆放')));
      assert.ok(!result.candidates.some(c=>c.loc_code===a.furn_code+'-L01-B02'));
    });
    await t.test('使用已登记重量，库存单位不一致拒绝，不拿未知重量当零',()=>{
      save({...blank,weight_kg:.5});db.setCellMeta(from,{max_load:5.5});assert.ok(!recommend().candidates.some(c=>c.loc_code===from));
      db.setCellMeta(from,{max_load:6.1});assert.ok(recommend().candidates.some(c=>c.loc_code===from));
      assert.throws(()=>recommend({unit:'箱'}),/库存单位/);save(blank);const result=recommend();assert.ok(result.candidates.find(c=>c.loc_code===from).warnings.some(s=>s.includes('重量不足')));db.setCellMeta(from,{max_load:null});
    });
    await t.test('同类候选沿通道距离排序，未配置入口时明确标注距离未计算',()=>{
      const result=recommend({start_loc:near});assert.equal(result.candidates[0].loc_code,from);const empty=result.candidates.filter(c=>c.score===2);assert.equal(empty[0].loc_code,near);assert.equal(empty[0].distance,0);assert.ok(result.route.available);
      db.setRoom({id:room.id,width:12,depth:8,height:4,door:null});const noDoor=recommend();assert.equal(noDoor.route.available,false);assert.ok(noDoor.candidates.every(c=>c.distance===null&&c.warnings.some(s=>s.includes('距离未计算'))));
      db.setRoom({id:room.id,width:12,depth:8,height:4,door:[{side:'back',offset:.5}]});
    });
    await t.test('尺寸和标签合格但正面无法接近的格位不进入推荐',()=>{
      const blocker=db.createRack({roomCode:room.loc_code,rows:1,cols:1,x:-2,z:.7,geom:{w:1.8,h:1,d:.4}});
      const result=recommend();assert.ok(!result.candidates.some(c=>c.loc_code===from));assert.ok(result.excluded.unreachable>0);assert.ok(result.candidates.length);
      db.deleteRack(blocker.furn_code);
    });
    await t.test('只读、跨仓和共享资料修改限制不能绕过',()=>{
      const allow=code=>code.startsWith('WH-');assert.equal(storage.get(item.item_id,viewer,allow).can_edit,false);assert.throws(()=>storage.get(item.item_id,actor,()=>false),e=>e.status===404);
      const site=db.createSite({code:'EXT',name:'另一仓库'}),rack=db.createRack({roomCode:site.loc_code+'-1',rows:1,cols:1,x:0,z:0});db.inbound({loc_code:rack.furn_code+'-L01-B01',item_id:item.item_id,name:'包装轴承',unit:'套',qty:1});
      const shared=storage.get(item.item_id,actor,allow);assert.equal(shared.can_edit,false);assert.throws(()=>storage.save(item.item_id,{revision:shared.revision,profile:blank,request_id:'shared'},actor,allow),e=>e.status===403);
      assert.throws(()=>work.recommend({room:room.loc_code,item_id:item.item_id,qty:1,start_loc:rack.furn_code+'-L01-B01'},allow),e=>e.status===403);
    });
    await t.test('审计或事件故障时资料与历史一起回滚',()=>{
      const before=storage.get(item.item_id,actor),history=storage.history(item.item_id,actor).length;failEmit=true;
      assert.throws(()=>storage.save(item.item_id,{revision:before.revision,profile:{...blank,weight_kg:2},request_id:'rollback'},actor),/事件写入失败/);failEmit=false;
      assert.deepEqual(storage.get(item.item_id,actor),before);assert.equal(storage.history(item.item_id,actor).length,history);
    });
    await t.test('成套备份恢复保留存放资料、修改记录和库存',()=>{
      save({...blank,width:.2,height:.3,depth:.2,weight_kg:.5,required_tags:['干燥']});const uploads=join(dir,'uploads'),bundle=join(dir,'bundle'),data=join(dir,'restored-data'),assets=join(dir,'restored-assets');mkdirSync(uploads);makeBackup(dir,uploads,bundle);restoreBackup(bundle,data,assets);
      const restored=new DatabaseSync(join(data,'spatial.db'));try{const service=createItemStorage(restored,{tenant:db.TENANT});assert.deepEqual(service.get(item.item_id,actor).profile,storage.get(item.item_id,actor).profile);assert.equal(service.history(item.item_id,actor).length,storage.history(item.item_id,actor).length);assert.equal(restored.prepare('SELECT SUM(qty) n FROM inventory WHERE item_id=?').get(item.item_id).n,11);}finally{restored.close();}
    });
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
