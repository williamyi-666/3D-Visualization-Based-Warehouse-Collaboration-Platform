import test from 'node:test';
import assert from 'node:assert/strict';
import {arrangeRacks} from '../packages/three-kit/layout-arrange.mjs';
test('批量排列按旋转外边界留距，越界或撞未选货架时不改原草稿',()=>{
 const racks=[{code:'A',x:-4,z:0,w:2,d:1,rot:0},{code:'B',x:0,z:2,w:4,d:1,rot:Math.PI/2}];
 const before=structuredClone(racks),room={width:20,depth:20};
 const result=arrangeRacks(racks,['B','A'],room,'x',1);
 assert.equal(result[0].x,-4);assert.ok(Math.abs(result[1].x+1.5)<1e-9);assert.equal(result[1].z,0);
 assert.deepEqual(racks,before);
 assert.throws(()=>arrangeRacks(racks,['A','B'],room,'x',30),/边界/);
 const blocker={code:'C',x:-1.5,z:0,w:1,d:1};
 assert.throws(()=>arrangeRacks([...racks,blocker],['A','B'],room,'x',1),/重叠/);
 assert.throws(()=>arrangeRacks(racks,['A'],room,'x',1),/至少/);
 assert.throws(()=>arrangeRacks(racks,['A','B'],room,'x',-1),/非负/);
 const vertical=arrangeRacks(racks,['A','B'],room,'z',0.5);assert.equal(vertical[1].x,-4);assert.equal(vertical[1].z,3);
 assert.deepEqual(racks,before);
});
