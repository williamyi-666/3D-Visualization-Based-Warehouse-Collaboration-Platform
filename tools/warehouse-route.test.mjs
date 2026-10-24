import test from 'node:test';
import assert from 'node:assert/strict';
import {createWarehouseRouter,routeLayoutKey} from '../packages/three-kit/warehouse-route.mjs';

const layout=()=>({roomCode:'WH-1',revision:'layout-v1',room:{width:12,depth:8,door:[{side:'back',offset:.5,width:1.2}]},furniture:[
  {code:'WH-1-A',x:-3,z:0,w:2,h:2,d:1,rot:0,rows:4,cols:2},
  {code:'WH-1-B',x:3,z:0,w:2,h:2,d:1,rot:0,rows:4,cols:2},
  {code:'WH-1-C',x:0,z:-1,w:3,h:2,d:1,rot:0,rows:4,cols:2},
]});
const code=(rack,col=1)=>`WH-1-${rack}-L01-B0${col}`;
test('路线绕过实体货架，端点与格位列位置一致，给出就近顺序',()=>{
  const spec=layout(),router=createWarehouseRouter(spec),result=router.plan({locations:[code('B'),code('A'),code('A')]});
  assert.equal(result.stops.length,2);assert.equal(result.unreachable.length,0);assert.equal(result.origin.kind,'entrance');assert.equal(result.layout_revision,'layout-v1');
  assert.deepEqual(router.approach(code('A')), {x:-3.5,z:.8});assert.deepEqual(result.stops.find(v=>v.loc_code===code('B')).point,{x:2.5,z:.8});
  for(let i=1;i<result.points.length;i++)assert.ok(router.segmentClear(result.points[i-1],result.points[i]),JSON.stringify(result.points));
  assert.ok(result.distance>Math.hypot(3.5,4.55));assert.match(result.warnings.join(''),/未计算人员实时位置/);
});
test('旋转及合并格位沿用3D方向，被吞并格位不能生成另一条路线',()=>{
  const spec=layout();spec.furniture[0].rot=Math.PI/2;spec.furniture[0].merges={L01:[[1,2]]};const router=createWarehouseRouter(spec),p=router.approach(code('A'));
  assert.ok(Math.abs(p.x+2.2)<1e-9);assert.ok(Math.abs(p.z)<1e-9);assert.throws(()=>router.approach(code('A',2)),/主格位/);
});
test('入口比例与3D门符号位置相同，选择另一个入口不会沿用旧起点',()=>{
  const spec=layout();spec.room.door=[{side:'left',offset:.75},{side:'front',offset:.25,double:true}];const router=createWarehouseRouter(spec);
  assert.deepEqual(router.origin().point,{x:-5.75,z:2});assert.deepEqual(router.origin({entry:1}).point,{x:-3,z:3.75});
});
test('场景与布局的几何签名一致，库存变化保留路线，位置变更使路线失效',()=>{
  const spec=layout(),scene={...spec,furniture:spec.furniture.map(f=>({code:f.code,position:[f.x,0,f.z],rotation:f.rot,width:f.w,depth:f.d,rows:f.rows,cols:f.cols,items:{}}))};
  assert.equal(routeLayoutKey(spec),routeLayoutKey(scene));scene.furniture[0].items={L01:[{qty:5}]};assert.equal(routeLayoutKey(spec),routeLayoutKey(scene));scene.furniture[0].position[0]++;assert.notEqual(routeLayoutKey(spec),routeLayoutKey(scene));
});
test('通道被完全阻断时报告不可达，不画穿过货架的直线',()=>{
  const spec=layout();spec.furniture=[spec.furniture[0],{code:'WH-1-X',x:0,z:-2,w:12,d:1,h:2,rot:0,rows:1,cols:1}];
  const result=createWarehouseRouter(spec).plan({locations:[code('A')]});assert.deepEqual(result.unreachable,[code('A')]);assert.equal(result.distance,0);assert.equal(result.points.length,1);
});
test('无入口时要求明确起点；允许从用户指定格位附近出发',()=>{
  const spec=layout();spec.room.door=[];const router=createWarehouseRouter(spec);assert.throws(()=>router.plan({locations:[code('B')]}),/设置可用入口/);
  const result=router.plan({locations:[code('B')],start_loc:code('A')});assert.equal(result.origin.loc_code,code('A'));assert.equal(result.stops.length,1);
  assert.throws(()=>router.plan({locations:['WH-2-A-L01-B01'],start_loc:code('A')}),/不属于当前库区/);
});
test('窄入口、遮挡入口和非法尺寸不会给出假路线',()=>{
  const spec=layout();spec.room.door[0].width=.3;assert.throws(()=>createWarehouseRouter(spec).plan({locations:[code('A')]}),/可用入口/);
  spec.room.door[0].width=1.2;spec.furniture.push({code:'WH-1-X',x:0,z:-3.5,w:2,d:1,h:2,rot:0,rows:1,cols:1});assert.throws(()=>createWarehouseRouter(spec).plan({locations:[code('A')]}),/起点附近/);
  spec.furniture[0].w=NaN;assert.throws(()=>createWarehouseRouter(spec),/补全货架尺寸/);
});
