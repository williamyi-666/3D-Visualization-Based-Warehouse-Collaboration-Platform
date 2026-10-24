import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeCapacityPlan,mergeCapacityPreview} from '../apps/web/prototype/merge-capacity.mjs';
import {layoutPreviewSpec,layoutStructureKey} from '../apps/web/prototype/layout-preview.mjs';
import {cellDimensions,updateCapacityRules} from '../packages/three-kit/sku-capacity.mjs';

const k=c=>'L01-B'+String(c).padStart(2,'0');
const product={sku:'TEST-CAP',unit:'箱'};
const source=(capacities,merges={})=>{
 const spec={rows:1,cols:capacities.length,width:capacities.length,height:2,depth:1,merges};
 return {...spec,items:Object.fromEntries(capacities.map((_,i)=>[k(i+1),[{...product,qty:1}]])),cellMeta:Object.fromEntries(capacities.map((capacity,i)=>[k(i+1),{capacity,capacity_rules:updateCapacityRules({},product,capacity,cellDimensions(spec,k(i+1)))}]))};
};

test('同SKU核定容量参考合计；未设置、零容量和混合单位分别处理',()=>{
  const plan=s=>mergeCapacityPlan(s,1,2,{L01:[[1,2]]})[0];
  assert.equal(plan(source([100,100])).capacity,200);
  assert.equal(plan(source([100,null])).capacity,null);
  assert.equal(plan(source([0,0])).capacity,0);
  assert.equal(plan({...source([100,100]),items:{[k(1)]:[{...product,qty:1,unit:'箱'}],[k(2)]:[{...product,qty:1,unit:'件'}]}}).capacity,null);
});
test('再次合并已合并格位只累计主格容量，原范围保持和拆分不推断分配',()=>{
  const s=source([250,100,100],{L01:[[1,2]]});
  assert.equal(mergeCapacityPlan(s,1,3,{L01:[[1,3]]})[0].capacity,350);
  assert.equal(mergeCapacityPlan(s,1,3,s.merges)[0].capacity,250);
  const split=mergeCapacityPlan(s,1,3,{});
  assert.equal(split[0].capacity,null);assert.equal(split[1].capacity,100,'原尺寸下已有此SKU标准时可以复用，不推断新分配');
  assert.match(split[0].hint,/拆分/);assert.equal(split[2].capacity,100);
});
test('容量与库存随布局草稿预览，撤销恢复原状态，原始数据不被改写',()=>{
  const original={...source([100,100]),code:'A',items:{[k(1)]:[{...product,id:'one',qty:30}],[k(2)]:[{...product,id:'one',qty:40}]}};
  const saved={furniture:[original]},snapshot=JSON.stringify(saved);
  const draft={code:'A',rows:1,cols:2,w:2,h:2,d:1,merges:{L01:[[1,2]]},mergeCapacities:{[k(1)]:{product,capacity:200}}};
  const result=layoutPreviewSpec(saved,{furniture:[draft]}).furniture[0];
  assert.equal(result.items[k(1)].reduce((n,i)=>n+i.qty,0),70);
  assert.equal(result.items[k(2)],undefined);assert.equal(result.cellMeta[k(1)].capacity,200);
  assert.equal(JSON.stringify(saved),snapshot);
  assert.equal(layoutPreviewSpec(saved,{furniture:[{...draft,merges:{},mergeCapacities:undefined}]}).furniture[0].cellMeta[k(1)].capacity,100);
  assert.notEqual(layoutStructureKey([draft]),layoutStructureKey([{...draft,mergeCapacities:{[k(1)]:250}}]));
  const next={...original,...mergeCapacityPreview(original,draft),merges:draft.merges};
  assert.equal(mergeCapacityPlan(next,1,2,draft.merges)[0].capacity,200);
});

test('合并容量与库存、名称同事务，重复保存不叠加，冲突和非法输入全部回滚',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'merge-capacity-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default;
  const state=()=>JSON.stringify(['space_node','inventory','movement','outbox_event','space_operation'].map(t=>sql.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));
  try {
    const room=db.createRoomNode({name:'容量合并验收'});
    const code=db.createRack({name:'容量架',roomCode:room.loc_code,rows:1,cols:3,geom:{w:3,h:2,d:1,x:0,z:0,rot:0}}).furn_code;
    const loc=c=>code+'-'+k(c),scene=()=>db.getScene(room.loc_code).furniture.find(f=>f.code===code);
    for(let c=1;c<=3;c++)db.setCellMeta(loc(c),{capacity:100,max_load:80});
    db.createItem({name:'测试箱',sku:'CAP-BOX',unit:'箱',qty:30,loc_code:loc(1)});
    db.createItem({name:'测试箱',sku:'CAP-BOX',unit:'箱',qty:40,loc_code:loc(2)});
    const input={merges:{L01:[[1,2]]},names:{[k(1)]:'大格'},capacities:{[k(1)]:200},capacityRevision:scene().capacityRevision};
    const initial=state();
    assert.throws(()=>db.setRackCells(code,{...input,capacities:{[k(1)]:-1}}),/格式错误/);
    assert.equal(state(),initial);
    assert.throws(()=>db.setRackCells(code,{...input,capacities:{[k(2)]:100}}),/有效主格位/);
    assert.equal(state(),initial);
    sql.exec("CREATE TRIGGER fail_capacity BEFORE UPDATE OF capacity ON space_node BEGIN SELECT RAISE(ABORT,'capacity failed'); END");
    assert.throws(()=>db.setRackCells(code,input),/capacity failed/);assert.equal(state(),initial);
    sql.exec('DROP TRIGGER fail_capacity');
    db.setRackCells(code,input);
    let rack=scene();assert.equal(rack.cellMeta[k(1)].capacity,200);assert.equal(rack.cellMeta[k(1)].max_load,80);
    assert.equal(rack.items[k(1)][0].qty,70);assert.deepEqual(rack.items[k(2)],[]);
    const merged=state();assert.throws(()=>db.setRackCells(code,input),e=>e.status===409);assert.equal(state(),merged);
    db.setRackCells(code,{...input,capacityRevision:rack.capacityRevision});assert.equal(scene().cellMeta[k(1)].capacity,200);
    rack=scene();db.setRackCells(code,{merges:{L01:[[1,3]]},names:{},capacities:{[k(1)]:350},capacityRevision:rack.capacityRevision});
    assert.equal(scene().cellMeta[k(1)].capacity,350);
    const layout=db.getLayout(room.loc_code),f=layout.furniture[0];
    f.merges={};f.mergeCapacities={[k(1)]:null,[k(2)]:null,[k(3)]:0};f.mergeCapacityRevision=scene().capacityRevision;
    const pre=state();const stale=structuredClone(layout);
    stale.furniture[0].mergeCapacityRevision='stale';assert.throws(()=>db.saveLayout(stale),e=>e.status===409);assert.equal(state(),pre);
    db.saveLayout(layout);rack=scene();assert.equal(rack.cellMeta[k(1)].capacity,null);assert.equal(rack.cellMeta[k(2)].capacity,null);assert.equal(rack.cellMeta[k(3)].capacity,0);
    assert.equal(rack.items[k(1)][0].qty,70);assert.equal(rack.cellMeta[k(1)].max_load,80);
    const fresh=db.getLayout(room.loc_code);fresh.furniture.push({code:'draft-new-cap',label:'新架',rows:1,cols:2,w:2,h:2,d:1,x:0,z:2,merges:{L01:[[1,2]]},mergeCapacities:{[k(1)]:60},mergeCapacityRevision:'new'});
    db.saveLayout(fresh);assert.equal(db.getScene(room.loc_code).furniture.find(f=>f.label==='新架').cellMeta[k(1)].capacity,60);
    assert.ok(db.getSpaceOperation(db.listSpaceOperations().find(a=>a.action==='setRackCells').id).after.some(c=>c.capacity===350));
  } finally {sql.close();rmSync(dir,{recursive:true,force:true});}
});
