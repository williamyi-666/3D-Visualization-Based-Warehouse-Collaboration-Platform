import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createRoom,createFurniture} from '../../../packages/three-kit/spaceGenerator.js';
import {createRouteLayer} from './route-layer.mjs';

// 与电脑端共用场景数据和格位生成器，手机只提供浏览、选择和定位。
export function createMobileScene(host,onSelect){
 const marker=document.createElement('span');marker.className='scene-selection hidden';host.append(marker);
 const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));host.append(renderer.domElement);
 renderer.domElement.setAttribute('aria-label','三维仓库，可旋转和缩放');
 const scene=new THREE.Scene();scene.background=new THREE.Color('#dfe7ef');
 scene.add(new THREE.HemisphereLight(0xffffff,0x64748b,2));
 const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(5,10,6);scene.add(light);
 const camera=new THREE.PerspectiveCamera(45,1,.05,1000),controls=new OrbitControls(camera,renderer.domElement);
 controls.maxPolarAngle=Math.PI*.49;controls.minDistance=.5;controls.touches.ONE=THREE.TOUCH.ROTATE;controls.touches.TWO=THREE.TOUCH.DOLLY_PAN;
 let content=new THREE.Group(),cells=[],selection='',box=null,roomSpec=null,savedSpec,roomObject,racks=new Map(),models=[],build=0,realistic=false;
 const loader=new GLTFLoader(),cache=new Map();
 scene.add(content);
 const draw=()=>{if(host.clientWidth&&host.clientHeight&&!document.hidden)renderer.render(scene,camera);};
 const routeLayer=createRouteLayer({scene,host,onRender:draw});
 controls.addEventListener('change',draw);
 const resize=()=>{const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();draw();};
 const observer=new ResizeObserver(resize);observer.observe(host);
 function reset(){if(!roomSpec)return;const span=Math.max(roomSpec.width||12,roomSpec.depth||8);controls.target.set(0,1,0);camera.position.set(span*.8,span*.9,span*1.1);controls.update();draw();}
 function select(code,focus=false){
  selection=code;const cell=cells.find(c=>c.locCode===code);
  marker.textContent=cell?'已选中 '+code:'';marker.classList.toggle('hidden',!cell);
  if(box){scene.remove(box);box.geometry.dispose();box.material.dispose();box=null;}
  if(!cell){draw();return false;}
  scene.updateMatrixWorld(true);box=new THREE.BoxHelper(cell.mesh,0xffb000);box.material.depthTest=false;box.renderOrder=30;scene.add(box);
  if(focus){const bounds=new THREE.Box3().setFromObject(cell.mesh),center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());const direction=camera.position.clone().sub(controls.target).normalize();camera.position.copy(center).addScaledVector(direction,Math.max(2.2,size.length()*2.5));controls.target.copy(center);controls.update();}
  draw();return true;
 }
 function load(spec,fit=false){
  routeLayer.setLayout(spec);
  build++;savedSpec=spec;models=[];racks=new Map();realistic=false;
  const old=content;scene.remove(old);old.traverse(o=>{o.geometry?.dispose();for(const m of [o.material].flat().filter(Boolean))m.dispose();});
  content=new THREE.Group();scene.add(content);cells=[];roomSpec=spec.room;
  roomObject=createRoom({...spec.room,walls:false});content.add(roomObject);
  for(const furniture of spec.furniture||[]){const rack=createFurniture({...furniture,lazyCellLabels:true,inventoryVisualLimit:3,batchInventory:true},cells);racks.set(furniture.code,rack);content.add(rack);}
  scene.updateMatrixWorld(true);if(fit)reset();select(selection);resize();
 }
 async function setRealistic(enabled){
  const version=++build;
  if(!enabled){realistic=false;for(const model of models)model.visible=false;roomObject.visible=true;for(const rack of racks.values())rack.visible=true;draw();return;}
  const assets=savedSpec.assets||{},entries=Object.entries(assets).filter(([code])=>code===savedSpec.roomCode||racks.has(code));
  if(!entries.length)throw Error('当前库区尚未绑定写实模型');
  const roots=[];
  // 全部加载成功再切换外观，失败时继续显示完整示意图。
  for(const [code,asset] of entries){
   let template=cache.get(asset.url);
   if(!template){const response=await fetch(asset.url);if(!response.ok)throw Error('写实模型读取失败，请稍后重试');const data=await response.arrayBuffer();template=(await loader.parseAsync(data,'')).scene;cache.set(asset.url,template);}
   if(version!==build)return;
   const root=template.clone(true),f=savedSpec.furniture.find(f=>f.code===code),t=asset.transform||{},p=f?.position||[0,0,0];
   root.position.set(p[0]+(t.x||0),p[1]+(t.y||0),p[2]+(t.z||0));root.rotation.y=(f?.rotationY??f?.rotation??0)+(t.rotY||0);root.scale.setScalar(t.scale||1);roots.push({code,root});
  }
  for(const model of models)content.remove(model);models=[];
  for(const {code,root} of roots){content.add(root);models.push(root);if(code===savedSpec.roomCode){roomObject.visible=false;for(const rack of racks.values())rack.visible=false;}else racks.get(code).visible=false;}
  realistic=true;draw();
 }
 const ray=new THREE.Raycaster();let down=null,multi=false;
 renderer.domElement.addEventListener('pointerdown',e=>{if(down){multi=true;return;}multi=false;down={x:e.clientX,y:e.clientY};});
 renderer.domElement.addEventListener('pointercancel',()=>{down=null;multi=false;});
 renderer.domElement.addEventListener('pointerup',e=>{
  const start=down;down=null;if(!start||multi||Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)return;
  const r=renderer.domElement.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1),camera);
  const hit=ray.intersectObjects(cells.map(c=>c.mesh),false)[0],cell=hit&&cells.find(c=>c.mesh===hit.object);if(cell){select(cell.locCode);onSelect(cell.locCode);}
 });
 document.addEventListener('visibilitychange',draw);
 return {load,select,reset,resize,setRealistic,capacity:code=>cells.find(c=>c.locCode===code)?.capacityState,showRoute:routeLayer.show,clearRoute:routeLayer.clear};
}
