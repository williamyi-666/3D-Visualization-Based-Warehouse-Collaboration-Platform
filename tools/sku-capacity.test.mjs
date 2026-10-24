import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {skuCapacity,estimateCapacity,updateCapacityRules,cellDimensions} from '../packages/three-kit/sku-capacity.mjs';
import {mergeCapacityPlan,mergeCapacityPreview} from '../apps/web/prototype/merge-capacity.mjs';

const dimensions={width:1,height:1,depth:1},product={sku:'SMALL',name:'小轴承',unit:'箱'};
const profile={width:.2,height:.25,depth:.5,horizontal_rotation:false};
const meta=(p=product,n=100,d=dimensions)=>({capacity_rules:updateCapacityRules({},p,n,d)});
test('同SKU批次合计数量；同单位不同SKU、不同来源或不同单位均不计算混放满载率',()=>{
  const a={...product,qty:30},b={...product,qty:20,batch_no:'第二批'};
  const state=skuCapacity({items:[a,b],meta:meta(),dimensions});assert.equal(state.ratio,.5);assert.equal(state.capacity,100);
  for(const other of [{...b,sku:'LARGE'},{...b,unit:'件'},{...b,source:'ERP2'}])assert.equal(skuCapacity({items:[a,other],meta:meta(),dimensions}).kind,'mixed');
  const legacy=skuCapacity({items:[a],meta:{capacity:100},dimensions});assert.equal(legacy.capacity,null);assert.equal(legacy.ratio,null);
});
test('容量标准按SKU与格位尺寸复用，换货品、合并及拆分不误用旧容量',()=>{
  const a={...product,qty:60},b={sku:'LARGE',unit:'箱',qty:10};let m=meta();
  m.capacity_rules=updateCapacityRules(m,b,20,dimensions);
  assert.equal(skuCapacity({items:[a],meta:m,dimensions}).ratio,.6);
  assert.equal(skuCapacity({items:[b],meta:m,dimensions}).ratio,.5);
  assert.equal(skuCapacity({items:[a],meta:m,dimensions:{...dimensions,width:2}}).capacity,null);
  assert.equal(skuCapacity({items:[a],meta:m,dimensions}).capacity,100);
  assert.equal(skuCapacity({items:[a],meta:meta(product,0),dimensions}).over,true);
});
test('尺寸估算为保持朝上的规整排列，未登记叠放仅估算单层，明确允许才转向',()=>{
  assert.equal(estimateCapacity(dimensions,profile).capacity,10);
  assert.equal(estimateCapacity(dimensions,{...profile,max_stack_layers:3}).capacity,30);
  assert.equal(estimateCapacity({...dimensions,height:.6},{...profile,max_stack_layers:9}).capacity,20);
  const space={width:.7,height:.5,depth:.4},p={width:.4,height:.2,depth:.3,max_stack_layers:2};
  assert.equal(estimateCapacity(space,p).capacity,2);assert.equal(estimateCapacity(space,{...p,horizontal_rotation:true}).capacity,4);
  assert.equal(estimateCapacity({...dimensions,height:null},profile),null);assert.equal(estimateCapacity(dimensions,{width:.2}),null);
  const state=skuCapacity({items:[{...product,qty:50,storage_profile:profile}],meta:{max_load:12},dimensions});
  assert.equal(state.basis,'estimated');assert.equal(state.capacity,10);assert.equal(state.over,false,'估算不能冒充已核定超容量');
  const load=skuCapacity({items:[{...product,qty:1,storage_profile:{...profile,weight_kg:3,max_stack_layers:4}}],meta:{max_load:12},dimensions});assert.equal(load.capacity,4);
});
test('单SKU合并按新尺寸估算；同单位不同SKU合并不做数量合计',()=>{
  const source={rows:1,cols:2,width:2,height:1,depth:1,items:{'L01-B01':[{...product,qty:2,storage_profile:profile}],'L01-B02':[{...product,qty:3,storage_profile:profile}]},cellMeta:{'L01-B01':meta(),'L01-B02':meta()}};
  const plan=mergeCapacityPlan(source,1,2,{L01:[[1,2]]})[0];assert.equal(plan.state.capacity,20);assert.equal(plan.capacity,null,'估算不直接保存为人工核定值');
  const mixed=structuredClone(source);mixed.items['L01-B02'][0].sku='LARGE';
  assert.equal(mergeCapacityPlan(mixed,1,2,{L01:[[1,2]]})[0].product,null);
  const draft={rows:1,cols:2,w:2,h:1,d:1,merges:{L01:[[1,2]]},mergeCapacities:{'L01-B01':{product,capacity:25}}};
  const preview=mergeCapacityPreview(source,draft);assert.equal(skuCapacity({items:preview.items['L01-B01'],meta:preview.cellMeta['L01-B01'],dimensions:{...dimensions,width:2}}).capacity,25);
  assert.equal(source.cellMeta['L01-B01'].capacity_rules[0].capacity,100);
});
test('SKU容量持久化、版本冲突、同事务合并及布局草稿均不改变库存数量',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sku-capacity-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default;
  try {
    const room=db.createRoomNode({name:'SKU容量验收'}),code=db.createRack({roomCode:room.loc_code,name:'架',rows:1,cols:2,geom:{w:2,h:1,d:1,x:0,z:0}}).furn_code;
    const loc=code+'-L01-B01',scene=()=>db.getScene(room.loc_code).furniture[0];
    db.createItem({loc_code:loc,name:product.name,sku:product.sku,unit:product.unit,qty:60});
    const original=JSON.stringify(db.listInventory()),snapshot=scene();
    db.setCellMeta(loc,{capacity_rule:{product,capacity:100}},snapshot.cellMeta['L01-B01'].revision);
    let rack=scene();assert.equal(skuCapacity({items:rack.items['L01-B01'],meta:rack.cellMeta['L01-B01'],dimensions}).ratio,.6);
    assert.throws(()=>db.setCellMeta(loc,{capacity_rule:{product,capacity:10}},snapshot.cellMeta['L01-B01'].revision),e=>e.status===409);
    const pre=sql.prepare('SELECT capacity_rules FROM space_node WHERE loc_code=?').get(loc).capacity_rules;
    assert.throws(()=>db.setRackCells(code,{merges:{L01:[[1,2]]},names:{},capacities:{'L01-B01':{product,capacity:-1}},capacityRevision:rack.capacityRevision}),/非负|格式错误/);
    assert.equal(sql.prepare('SELECT capacity_rules FROM space_node WHERE loc_code=?').get(loc).capacity_rules,pre);
    db.setRackCells(code,{merges:{L01:[[1,2]]},names:{},capacities:{'L01-B01':{product,capacity:200}},capacityRevision:rack.capacityRevision});
    rack=scene();assert.equal(skuCapacity({items:rack.items['L01-B01'],meta:rack.cellMeta['L01-B01'],dimensions:cellDimensions(rack,'L01-B01')}).ratio,.3);
    const layout=db.getLayout(room.loc_code);layout.furniture[0].merges={};db.saveLayout(layout);
    rack=scene();assert.equal(skuCapacity({items:rack.items['L01-B01'],meta:rack.cellMeta['L01-B01'],dimensions}).capacity,100,'拆回原尺寸可复用原SKU标准');
    db.setCellMeta(loc,{capacity_rule:{product,capacity:null}});assert.equal(skuCapacity({items:scene().items['L01-B01'],meta:scene().cellMeta['L01-B01'],dimensions}).capacity,null);
    assert.equal(JSON.stringify(db.listInventory()),original);
    assert.ok(db.getSpaceOperation(db.listSpaceOperations()[0].id).after.some(n=>n.capacity_rules));
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
