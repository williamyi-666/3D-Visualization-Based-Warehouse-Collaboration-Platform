import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../apps/web/prototype/vendor/three.module.js';

test('复位取景在宽屏和窄画布中均包含货架全部角点',()=>{
  const source=readFileSync('apps/web/prototype/app.js','utf8');
  // 与createFurniture一致：仅shell参与取景，屏幕标牌不影响距离。
  const shell=new THREE.Mesh(new THREE.BoxGeometry(6,2,1),new THREE.MeshBasicMaterial());
  const rack=new THREE.Group();rack.add(shell);rack.userData.shell=shell;
  const label=new THREE.Mesh(new THREE.BoxGeometry(20,20,1),new THREE.MeshBasicMaterial());
  label.position.set(50,50,0);rack.add(label);
  rack.position.set(3,1,-2);rack.updateMatrixWorld(true);
  try {
    for(const [width,height] of [[1200,680],[464,1180],[280,700]]) {
      const camera=new THREE.PerspectiveCamera(50,width/height,.1,500);
      const context=vm.createContext({THREE,rackGroups:[rack],assetGroups:[],roomGroup:null,camera,container:{clientWidth:width,clientHeight:height}});
      vm.runInContext(source.slice(source.indexOf('function frameBounds('),source.indexOf('// 根据当前场景包围盒自动放置相机')),context);
      const fit=context.computeCameraFit();camera.position.copy(fit.position);camera.lookAt(fit.target);camera.updateMatrixWorld(true);
      const box=new THREE.Box3().setFromObject(shell);
      for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]) {
        const projected=new THREE.Vector3(x,y,z).project(camera);
        assert.ok(Math.abs(projected.x)<1 && Math.abs(projected.y)<1 && projected.z>-1 && projected.z<1,`${width}×${height}角点被裁切`);
      }
    }
  } finally {for(const mesh of [shell,label]){mesh.geometry.dispose();mesh.material.dispose();}}
});
