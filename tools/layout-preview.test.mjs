import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutPreviewSpec,layoutStructureKey} from '../apps/web/prototype/layout-preview.mjs';

test('草稿重建保留原架库存，新增架不继承库存，删除撤销可从原场景恢复',()=>{
  const original={code:'A',items:{'L01-B01':[{qty:5}]},cellMeta:{'L01-B01':{note:'保留'}}};
  const saved={furniture:[original],assets:{A:{url:'old.glb'}}};
  const rack={code:'A',x:1,z:2,rot:0.5,w:3,h:4,d:1,rows:4,cols:2};
  const layout={room:{width:20},furniture:[rack,{...rack,code:'draft-B'}]};
  const preview=layoutPreviewSpec(saved,layout);
  assert.deepEqual(preview.furniture[0].items,original.items);
  assert.deepEqual(preview.furniture[0].cellMeta,original.cellMeta);
  assert.equal(preview.furniture[0].height,4);
  assert.deepEqual(preview.furniture[0].position,[1,0,2]);
  assert.equal(preview.furniture[1].items,undefined);
  assert.deepEqual(preview.assets,{});
  assert.equal(layoutPreviewSpec(saved,{...layout,furniture:[]}).furniture.length,0);
  assert.deepEqual(layoutPreviewSpec(saved,layout).furniture[0].items,original.items);
  assert.equal(saved.furniture.length,1);
});

test('位置变更不触发结构重建，层列、合并和名称变化触发',()=>{
  const rack={code:'A',x:0,z:0,rot:0,w:2,h:3,d:1,rows:3,cols:2};
  const key=layoutStructureKey([rack]);
  assert.equal(layoutStructureKey([{...rack,x:5,z:6,rot:2}]),key);
  for(const change of [{rows:4},{h:4},{merges:{L01:[[1,2]]}},{cellNames:{'L01-B01':'零件'}},{label:'新名称'}])
    assert.notEqual(layoutStructureKey([{...rack,...change}]),key);
});
