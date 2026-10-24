import test from 'node:test';
import assert from 'node:assert/strict';
import { placementError, halfExtents } from '../packages/three-kit/layout-geometry.mjs';
test('旋转货架边界、实体碰撞与地面区域', () => {
  const room={width:6,depth:6};
  const rack={code:'A',x:0,z:0,w:4,d:1,rot:Math.PI/2,type:'rack'};
  assert.ok(Math.abs(halfExtents(rack).z-2)<1e-6);
  assert.match(placementError({...rack,z:2},room),/边界/);
  assert.match(placementError(rack,room,[{...rack,code:'B',x:0.2}]),/重叠/);
  assert.equal(placementError(rack,room,[{...rack,code:'B',x:1}]),'');
  assert.equal(placementError(rack,room,[{...rack,code:'F',type:'floor'}]),'');
});
