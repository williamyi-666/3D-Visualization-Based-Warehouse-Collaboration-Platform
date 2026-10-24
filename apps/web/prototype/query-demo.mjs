import * as THREE from 'three';
import {createRoom,createFurniture} from '../../../packages/three-kit/spaceGenerator.js';

// 使用随应用发布的样板快照，不读取或写入用户库存。
const layout=await fetch('./query-demo-layout.json').then(r=>{if(!r.ok)throw Error('样板加载失败');return r.json();});
const $=id=>document.getElementById(id),host=$('scene');
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));host.append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#dfe7ef');
scene.add(new THREE.HemisphereLight(0xffffff,0x64748b,2));
const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(5,10,6);scene.add(light);
scene.add(createRoom({...layout.room,walls:false}));
const cells=[],racks=[];
for(const f of layout.furniture){const rack=createFurniture({code:f.code,label:f.label,type:f.type,open:f.open,position:[f.x,0,f.z],rotationY:f.rot,width:f.w,height:f.h,depth:f.d,rows:f.rows,cols:f.cols},cells);racks.push(rack);scene.add(rack);}
const cell=cells.find(c=>c.locCode==='WH-2-A-L02-B02');
if(!cell)throw Error('样板目标格位不存在');
cell.mesh.material.color.set('#38bdf8');cell.mesh.material.opacity=.65;
const originalTarget={opacity:cell.mesh.material.opacity,emissive:cell.mesh.material.emissive.clone(),intensity:cell.mesh.material.emissiveIntensity};
const surroundings=new Map();
for(const rack of racks)rack.traverse(object=>{if(object===cell.mesh)return;for(const material of [object.material].flat().filter(Boolean)){if(!surroundings.has(material))surroundings.set(material,{opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite});}});
// 货架刚加入场景时父级世界矩阵尚未更新；先同步，再计算格位的世界包围盒。
scene.updateMatrixWorld(true);
// 用实体边线代替原生一像素线框，移动端也有清晰粗细；沿真实格位边缘描边。
const box=new THREE.Group(),edges=new THREE.EdgesGeometry(cell.mesh.geometry);
const vertices=edges.attributes.position,edgeMaterial=new THREE.MeshBasicMaterial({color:0xfbbf24,depthTest:false,depthWrite:false});
for(let i=0;i<vertices.count;i+=2){
  const a=new THREE.Vector3().fromBufferAttribute(vertices,i),b=new THREE.Vector3().fromBufferAttribute(vertices,i+1),direction=b.clone().sub(a);
  const edge=new THREE.Mesh(new THREE.CylinderGeometry(.018,.018,direction.length(),8),edgeMaterial);
  edge.position.copy(a).add(b).multiplyScalar(.5);edge.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());edge.renderOrder=20;box.add(edge);
}
edges.dispose();box.matrixAutoUpdate=false;box.matrix.copy(cell.mesh.matrixWorld);scene.add(box);box.visible=false;
const marker=document.createElement('div');marker.className='demo-located';marker.textContent='已定位 · A排 / 2层 / 2列';marker.hidden=true;host.append(marker);
const markerAnchor=cell.center.clone();markerAnchor.y=new THREE.Box3().setFromObject(cell.mesh).max.y;
let selected=false;
function selectTarget(value){
  if(value===selected)return;selected=value;box.visible=value;marker.hidden=!value;
  cell.mesh.material.opacity=value ? .88 : originalTarget.opacity;
  cell.mesh.material.emissive.copy(value?new THREE.Color('#0ea5e9'):originalTarget.emissive);
  cell.mesh.material.emissiveIntensity=value ? .7 : originalTarget.intensity;
  for(const [material,original] of surroundings){material.opacity=value?original.opacity*.35:original.opacity;material.transparent=value||original.transparent;material.depthWrite=value?false:original.depthWrite;material.needsUpdate=true;}
}
const camera=new THREE.PerspectiveCamera(42,1,.1,100);
const wide=new THREE.Vector3(10,9,12),near=cell.center.clone().add(new THREE.Vector3(3,2.2,5.5));
const target=new THREE.Vector3(0,1,0);
let seconds=0,playing=!matchMedia('(prefers-reduced-motion: reduce)').matches,last=performance.now(),frame,chapter=-1;
const captions=['① 看清空间：货架和存放区对应实际仓库。','② 搜索货品：输入名称或 SKU，点击放大镜。','③ 定位格位：点击结果，查看高亮的存放位置。','④ 查看库存：右侧核对货品、数量和库位。'];
function resize(){const {width,height}=host.getBoundingClientRect();renderer.setSize(width,height);camera.aspect=width/Math.max(1,height);camera.updateProjectionMatrix();}
const observer=new ResizeObserver(resize);observer.observe(host);resize();
function draw(){
  const stage=seconds<7?0:seconds<14?1:seconds<22?2:3;
  if(stage!==chapter){chapter=stage;$('caption').textContent=captions[stage];}
  $('keyword').textContent=seconds<8?'名称 / SKU / 库位': 'BRG-6204'.slice(0,Math.min(8,Math.floor((seconds-8)*4)));
  $('result').hidden=seconds<11||seconds>=17;$('detail').hidden=seconds<22;
  selectTarget(seconds>=15);
  const blend=THREE.MathUtils.smoothstep(seconds,15,21);
  // 前七秒轻缓旋转；后续先停稳搜索，再平滑靠近目标。
  const angle=Math.min(seconds,7)*.035;
  const start=wide.clone().applyAxisAngle(new THREE.Vector3(0,1,0),angle);
  camera.position.copy(start).lerp(near,blend);camera.lookAt(target.clone().lerp(cell.center,blend));
  renderer.render(scene,camera);
  if(selected){const p=markerAnchor.clone().project(camera);const width=host.clientWidth,height=host.clientHeight;marker.style.left=Math.max(marker.offsetWidth/2+8,Math.min(width-marker.offsetWidth/2-8,(p.x+1)*width/2))+'px';marker.style.top=Math.max(64,Math.min(height-40,(1-p.y)*height/2-38))+'px';}
  $('progress').value=seconds;$('clock').textContent=`${String(Math.floor(seconds)).padStart(2,'0')} / 30 秒`;
  $('play').textContent=playing?'暂停':seconds>=30?'重新播放':'播放';
}
function animate(now){if(playing&&!document.hidden)seconds=Math.min(30,seconds+(now-last)/1000);last=now;if(seconds>=30)playing=false;draw();frame=requestAnimationFrame(animate);}
$('play').onclick=()=>{if(seconds>=30)seconds=0;playing=!playing;last=performance.now();};
$('replay').onclick=()=>{seconds=0;playing=true;last=performance.now();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();parent.postMessage({type:'warehouse-demo-close'},location.origin);}});
window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);observer.disconnect();scene.traverse(o=>{o.geometry?.dispose();for(const m of [o.material].flat().filter(Boolean)){m.map?.dispose();m.dispose();}});renderer.dispose();});
frame=requestAnimationFrame(animate);
