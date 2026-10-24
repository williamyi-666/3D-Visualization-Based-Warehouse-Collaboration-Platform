import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {updateCapacityRules} from '../packages/three-kit/sku-capacity.mjs';

test('地面区库存位于所属格位，旋转定位一致，合并与货架布局保持有效', async () => {
  // 使用页面同版Three.js生成真实几何；仅替代标签画布，不模拟几何计算或GPU渲染。
  const vendor = pathToFileURL(resolve('apps/web/prototype/vendor/three.module.js')).href;
  const source = readFileSync('packages/three-kit/spaceGenerator.js', 'utf8').replace("from 'three'", 'from ' + JSON.stringify(vendor)).replace("from './sku-capacity.mjs'",'from '+JSON.stringify(pathToFileURL(resolve('packages/three-kit/sku-capacity.mjs')).href));
  const { createFurniture, makeCellLabelSprite, ensureCellLabelTexture, setCellLabelText, updateCellSurface } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const previous = globalThis.document;
  const noop = () => {};
  globalThis.document = { createElement: () => ({ getContext: () => ({
    clearRect: noop, beginPath: noop, arc: noop, fill: noop, stroke: noop,
    fillText: noop, strokeText: noop, measureText: text => ({ width: text.length * 8 })
  }) }) };
  try {
    const THREE=await import(vendor);
    for(const type of ['rack','floor']){
      const entries=[];
      const group=createFurniture({code:'SURFACE',type,width:3,height:2,depth:2,rows:2,cols:3,
        position:[2,0,3],rotationY:0.7,batchCellSurfaces:true,lazyCellLabels:true,
        merges:{L01:[[1,2]]},items:{'L01-B01':[{qty:2}]},cellMeta:{'L02-B01':{status:'locked'}}},entries);
      group.updateMatrixWorld(true);
      for(const entry of entries){
        const surface=entry.surfaceBatch;
        const center=new THREE.Vector3().setFromMatrixPosition(surface.matrix).applyMatrix4(surface.batch.matrixWorld);
        assert.ok(center.distanceTo(entry.center)<1e-6,'旋转/合并/地面表面位置不变');
        assert.equal(surface.batch.material.color.getHex(),entry.mesh.material.color.getHex());
        assert.equal(surface.batch.material.opacity,entry.mesh.material.opacity);
        const far=entry.center.clone().add(new THREE.Vector3(0,0,100));
        updateCellSurface(entry,far);
        assert.equal(surface.shown,entry.items.length>0||entry.status!=='normal');
        updateCellSurface(entry,far,true);
        assert.equal(surface.shown,false);assert.equal(entry.mesh.material.visible,true);
        const matrix=new THREE.Matrix4();surface.batch.getMatrixAt(surface.index,matrix);
        assert.equal(matrix.elements[0],0,'高亮时移除批次中的重复表面');
        updateCellSurface(entry,entry.center);assert.equal(entry.mesh.material.visible,true);
        surface.batch.visible=false;updateCellSurface(entry,far,true);
        assert.equal(entry.mesh.material.visible,true,'写实外壳隐藏批次时仍可显示高亮');
        surface.batch.visible=true;
      }
    }

    const detail={mesh:new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial()),items:[],status:'normal',center:new THREE.Vector3()};
    updateCellSurface(detail,new THREE.Vector3(0,0,20));assert.equal(detail.mesh.material.visible,false);
    detail.mesh.updateMatrixWorld(true);
    assert.equal(new THREE.Raycaster(new THREE.Vector3(0,0,20),new THREE.Vector3(0,0,-1)).intersectObject(detail.mesh).length>0,true,'远景仍可拾取');
    updateCellSurface(detail,new THREE.Vector3(0,0,20),true);assert.equal(detail.mesh.material.visible,true);
    updateCellSurface(detail,new THREE.Vector3(0,0,2));assert.equal(detail.mesh.material.visible,true);
    for(const state of [{items:[{qty:1}]},{status:'locked'},{status:'stocktaking'},{over:true}]){
      Object.assign(detail,{items:[],status:'normal',over:false},state);updateCellSurface(detail,new THREE.Vector3(0,0,20));assert.equal(detail.mesh.material.visible,true);
    }
    detail.mesh.geometry.dispose();detail.mesh.material.dispose();
    const lazyLabel=makeCellLabelSprite('原名称',1,true);
    assert.equal(lazyLabel.material.map,null);
    setCellLabelText(lazyLabel,'延迟创建前改名');
    ensureCellLabelTexture(lazyLabel);
    const labelTexture=lazyLabel.material.map;
    assert.equal(lazyLabel.userData.text,'延迟创建前改名');
    ensureCellLabelTexture(lazyLabel);
    assert.equal(lazyLabel.material.map,labelTexture,'反复显示复用同一编号纹理');
    const batchedCells=[];
    const batched=createFurniture({code:'BATCH',type:'rack',position:[0,0,0],rows:2,cols:3,width:3,height:2,depth:1,lazyCellLabels:true,batchInventory:true,
      cellMeta:{'L01-B01':{status:'locked'},'L01-B02':{status:'stocktaking'},'L01-B03':{capacity_rules:updateCapacityRules({},{sku:'TEST',unit:'件'},1,{width:1,height:1,depth:1})}},items:{'L01-B03':[{sku:'TEST',unit:'件',qty:2}]}},batchedCells);
    batched.updateMatrixWorld(true);
    const edges=[];batched.traverse(o=>{if(o.userData.type==='cellEdges')edges.push(o);});
    assert.equal(edges.reduce((n,e)=>n+e.geometry.attributes.position.count,0),6*24,'每格12条边仍完整');
    assert.deepEqual(edges.map(e=>e.material.color.getHex()).sort(),[0xf87171,0xfbbf24,0xe2574c,0x94a3b8].sort());
    assert.equal(batchedCells[0].mesh.geometry,batchedCells[1].mesh.geometry);
    assert.notEqual(batchedCells[0].mesh.material,batchedCells[1].mesh.material);
    for(const cell of batchedCells){
      const ray=new THREE.Raycaster(cell.center.clone().add(new THREE.Vector3(0,0,10)),new THREE.Vector3(0,0,-1));
      assert.equal(ray.intersectObjects(batchedCells.map(c=>c.mesh),false)[0].object.userData.locCode,cell.locCode,'格位仍可独立拾取');
    }
    const quantityRegistry=[];
    createFurniture({code:'WH-1-Q',type:'rack',position:[0,0,0],rotationY:0,rows:1,cols:1,width:1,height:2,depth:1,
      cellMeta:{'L01-B01':{capacity_rules:updateCapacityRules({},{sku:'TEST',unit:'件'},100,{width:1,height:2,depth:1})}},items:{'L01-B01':[{sku:'TEST',unit:'件',qty:120}]}},quantityRegistry);
    assert.equal(quantityRegistry[0].ratio,1.2);
    assert.equal(quantityRegistry[0].over,true);
    for (const [items,limit,weight,complete,over] of [
      [[{qty:10,unit:'箱',unit_weight_kg:12},{qty:20,unit:'件',unit_weight_kg:1}],100,140,true,true],
      [[{qty:2,unit_weight_kg:10},{qty:5}],100,20,false,false],
      [[{qty:2,unit_weight_kg:10},{qty:5}],10,20,false,true],
      [[],0,0,true,false], [[{qty:2,unit_weight_kg:0}],0,0,true,false]
    ]) {
      const cells=[];
      createFurniture({code:'W',type:'rack',position:[0,0,0],rows:1,cols:1,width:1,height:2,depth:1,
        cellMeta:{'L01-B01':{max_load:limit}},items:{'L01-B01':items}},cells);
      assert.equal(cells[0].weightKg,weight);assert.equal(cells[0].weightComplete,complete);
      assert.equal(cells[0].overWeight,over);assert.equal(cells[0].mesh.userData.overWeight,over);
    }
    for (const type of ['floor', 'rack']) {
      const registry = [];
      const group = createFurniture({ code: 'WH-1-F1', type, open: 1, width: 6, height: type === 'floor' ? 0.05 : 3,
        depth: 4, rows: 4, cols: 3, position: [3, 0, 5], rotationY: Math.PI / 2,
        merges: { L01: [[1, 2]] }, items: {
          'L01-B01': [{ name: '轴承' }], 'L04-B03': [{ name: '螺栓' }]
        } }, registry);
      group.updateMatrixWorld(true);
      assert.equal(registry.length, 11);
      assert.equal(registry.some(x => x.locCode.endsWith('L01-B02')), false);
      const items = [];
      group.traverse(x => { if (x.userData.type === 'item') items.push(x); });
      assert.equal(items.length, 2);
      for (const item of items) {
        const cell = registry.find(x => x.locCode === item.userData.locCode);
        assert.equal(item.position.x, cell.mesh.position.x);
        assert.equal(item.position.z, cell.mesh.position.z);
        assert.ok(item.geometry.parameters.depth < cell.mesh.geometry.parameters.depth);
        assert.ok(item.geometry.parameters.width < cell.mesh.geometry.parameters.width);
        const world = cell.mesh.getWorldPosition(cell.center.clone());
        assert.ok(world.distanceTo(cell.center) < 1e-9, '定位坐标与旋转后的实际格位一致');
      }
      if (type === 'floor') assert.notEqual(items[0].position.z, items[1].position.z);
      const denseRegistry=[];
      const dense=createFurniture({code:'WH-1-D',type,width:3,height:3,depth:3,rows:1,cols:1,position:[0,0,0],inventoryVisualLimit:8,items:{'L01-B01':Array.from({length:500},(_,i)=>({name:'库存'+i}))}},denseRegistry);
      let blocks=0;dense.traverse(x=>{if(x.userData.type==='item')blocks++;});
      assert.equal(blocks,8);assert.equal(denseRegistry[0].items.length,500);
      const batchedRegistry=[];
      const batched=createFurniture({code:'WH-1-D',type,width:3,height:3,depth:3,rows:1,cols:1,position:[0,0,0],inventoryVisualLimit:8,batchInventory:true,items:{'L01-B01':Array.from({length:500},(_,i)=>({name:'库存'+i}))}},batchedRegistry);
      let batch;batched.traverse(o=>{if(o.isInstancedMesh)batch=o;});
      assert.equal(batch.count,8);assert.equal(batchedRegistry[0].items.length,500);
      const originalBlocks=[];dense.traverse(o=>{if(o.userData.type==='item')originalBlocks.push(o);});
      for(let i=0;i<8;i++){
        const matrix=new THREE.Matrix4(),position=new THREE.Vector3(),scale=new THREE.Vector3();batch.getMatrixAt(i,matrix);matrix.decompose(position,new THREE.Quaternion(),scale);
        const original=originalBlocks[i];assert.ok(position.distanceTo(original.position)<1e-6);
        assert.ok(Math.abs(scale.x-original.geometry.parameters.width)<1e-6);assert.ok(Math.abs(scale.y-original.geometry.parameters.height)<1e-6);assert.ok(Math.abs(scale.z-original.geometry.parameters.depth)<1e-6);
        assert.equal(batch.userData.items[i].locCode,original.userData.locCode);
      }

    }
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
