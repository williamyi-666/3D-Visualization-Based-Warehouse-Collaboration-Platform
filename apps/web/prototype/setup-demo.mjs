import * as THREE from 'three';
import {createRoom,createFurniture} from '../../../packages/three-kit/spaceGenerator.js';
import {SETUP_SAMPLE as sample,SETUP_CHAPTERS,SETUP_DEMO_DURATION,setupDemoState,smoothDemo} from './setup-demo-timeline.mjs';

// 仅创建页面内的三维样板和只读表单，不导入任何库存、建仓或登录请求模块。
const $=id=>document.getElementById(id),host=$('scene'),main=document.querySelector('main');
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));host.append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color('#dfe7ef');scene.add(new THREE.HemisphereLight(0xffffff,0x64748b,2));
const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(4,9,6);scene.add(light);
const room=createRoom({width:sample.width,depth:sample.depth,height:sample.height,walls:false});scene.add(room);
const cells=[],rack=createFurniture({code:'DEMO-A',label:sample.rack,type:'rack',open:1,position:[0,0,0],rotationY:0,width:sample.rackWidth,height:sample.rackHeight,depth:sample.rackDepth,rows:sample.rows,cols:sample.cols},cells);scene.add(rack);
const cell=cells.find(cell=>cell.locCode===sample.loc);if(!cell)throw Error('样板格位未生成');
const vertices=[];for(let x=-6;x<=6;x+=0.5)vertices.push(x,0.005,-4,x,0.005,4);for(let z=-4;z<=4;z+=0.5)vertices.push(-6,0.005,z,6,0.005,z);
const gridGeometry=new THREE.BufferGeometry();gridGeometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
const grid=new THREE.LineSegments(gridGeometry,new THREE.LineBasicMaterial({color:'#6484a5',transparent:true,opacity:.4}));scene.add(grid);
const outline=new THREE.Group(),edgeGeometry=new THREE.EdgesGeometry(cell.mesh.geometry),points=edgeGeometry.attributes.position;
const edgeMaterial=new THREE.MeshBasicMaterial({color:'#fbbf24',depthTest:false,depthWrite:false});
for(let i=0;i<points.count;i+=2){const a=new THREE.Vector3().fromBufferAttribute(points,i),b=new THREE.Vector3().fromBufferAttribute(points,i+1),delta=b.clone().sub(a);const edge=new THREE.Mesh(new THREE.CylinderGeometry(.012,.012,delta.length(),8),edgeMaterial);edge.position.copy(a).add(b).multiplyScalar(.5);edge.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());edge.renderOrder=30;outline.add(edge);}edgeGeometry.dispose();
// 描边挂在格位实体上，摆放过程中始终与格位一致。
cell.mesh.add(outline);
const camera=new THREE.PerspectiveCamera(42,1,.1,160),worldCell=new THREE.Vector3(),look=new THREE.Vector3();
const otherMaterials=new Map();rack.traverse(object=>{if(object===cell.mesh||object.parent===outline)return;for(const material of [object.material].flat().filter(Boolean))if(!otherMaterials.has(material))otherMaterials.set(material,{opacity:material.opacity,transparent:material.transparent,depthWrite:material.depthWrite});});
let seconds=0,playing=!matchMedia('(prefers-reduced-motion: reduce)').matches,last=performance.now(),frame,chapter=-1,selected=false,cursorPosition=null;
const params=new URLSearchParams(location.search);$('build').hidden=params.get('build')!=='1';
const send=action=>parent.postMessage({type:'warehouse-setup-demo-action',action},location.origin);
$('build').onclick=()=>send('setup');$('browse').onclick=()=>send('browse');
SETUP_CHAPTERS.forEach((chapter,index)=>{const button=document.createElement('button');button.type='button';button.textContent=chapter.title;button.onclick=()=>{seconds=chapter.preview;playing=false;draw(true);cancelAnimationFrame(frame);};button.dataset.chapter=index;$('chapters').append(button);});

function renderForm(state){
  const current=SETUP_CHAPTERS[state.chapter];$('formTitle').textContent=current.title;$('formHelp').textContent=current.help;$('fields').replaceChildren();
  for(const [id,label] of current.fields){const box=document.createElement('label'),input=document.createElement('input');box.textContent=label;box.dataset.field=id;input.id='demo-'+id;input.readOnly=true;input.tabIndex=-1;input.setAttribute('aria-label','模拟填写 · '+label);box.htmlFor=input.id;box.append(input);if(['roomName','rackName','stockLoc','stockName','stockSku','query'].includes(id))box.className='wide';$('fields').append(box);}
  if(state.chapter===4){const result=document.createElement('div');result.id='queryResult';result.innerHTML='<strong>深沟球轴承6204 · 24 套</strong><br><small>DEMO-A-L02-B02 · 点击定位</small>';$('fields').append(result);}
  $('simAction').textContent=current.action;$('caption').textContent=current.caption;
  for(const button of $('chapters').children){if(Number(button.dataset.chapter)===state.chapter)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');}
}
function draw(snapCursor=false){
  const state=setupDemoState(seconds);if(chapter!==state.chapter){chapter=state.chapter;renderForm(state);}
  for(const [id,value] of Object.entries(state.values)){const input=$('demo-'+id);if(input.value!==value)input.value=value;input.parentNode.classList.toggle('active',state.active===id);}
  $('simAction').classList.toggle('active',state.actionActive);
  $('formResult').textContent=chapter===0&&state.roomVisible?'已建立 12 × 8 米库区，面积96平方米。':chapter===1&&state.rackVisible?'3层 × 4列 = 12个格位，自动分配格位码。':chapter===2&&state.layoutSaved?'样板布局已保存 · 12个格位可用。':chapter===3&&state.stocked?'已登记示例库存：24套，关联到第2层第2格。':chapter===4&&state.selected?'已定位示例格位，库存24套。':'';
  const result=$('queryResult');if(result)result.hidden=!state.results;
  $('sceneStatus').textContent=state.selected?'深沟球轴承6204 · 24 套 · '+sample.loc:state.stocked?'货品已与格位关联':state.layoutSaved?'布局已保存 · A货架 · 12个格位':state.rackVisible?'A货架 · 宽1.2 / 高2 / 深0.5米 · 3层×4列':state.roomVisible?'样板库区 · 12 × 8米 · 96平方米':'填写尺寸，同步建立空间';
  $('waiting').hidden=state.roomVisible;room.visible=state.roomVisible;rack.visible=state.rackVisible;grid.visible=chapter===2;
  rack.position.set(state.x,0,state.z);scene.updateMatrixWorld(true);cell.mesh.getWorldPosition(worldCell);
  cell.mesh.material.color.set(state.stocked?'#0ea5e9':'#d9d9d9');cell.mesh.material.opacity=state.stocked ? .88 : .08;cell.mesh.material.emissive.set(state.selected?'#0ea5e9':'#000000');cell.mesh.material.emissiveIntensity=state.selected ? .6 : 0;
  outline.visible=state.selected;
  if(selected!==state.selected){selected=state.selected;for(const [material,original] of otherMaterials){material.opacity=selected?original.opacity*.3:original.opacity;material.transparent=selected||original.transparent;material.depthWrite=selected?false:original.depthWrite;material.needsUpdate=true;}}
  const aspect=camera.aspect;
  // 设置时看清完整库区，摆放时看清货架及周边通道，避免小窗中货架过小。
  const overview=new THREE.Vector3(10,10,12).normalize().multiplyScalar(21/Math.min(1,aspect));
  const placement=new THREE.Vector3(8,9,10).normalize().multiplyScalar(12/Math.min(1,aspect)).add(new THREE.Vector3(state.x,0,state.z));
  const wide=seconds>=23?placement:overview,wideLook=seconds>=23?new THREE.Vector3(state.x,.5,state.z):new THREE.Vector3(0,.5,0);
  const rackLook=new THREE.Vector3(state.x,1,state.z),rackView=rackLook.clone().add(new THREE.Vector3(2.6,1.8,4.3).multiplyScalar(Math.max(1,.8/aspect)));
  let closeBlend=seconds<23?smoothDemo(seconds,18,22):seconds<32?1-smoothDemo(seconds,23,25):1;
  if(seconds>=32)closeBlend=smoothDemo(seconds,32,35);
  camera.position.copy(wide).lerp(rackView,closeBlend);look.copy(wideLook).lerp(rackLook,closeBlend);
  const locate=smoothDemo(seconds,45,48),cellView=worldCell.clone().add(new THREE.Vector3(1.6,.9,2.8).multiplyScalar(Math.max(1,.75/aspect)));
  camera.position.lerp(cellView,locate);look.lerp(worldCell,locate);camera.lookAt(look);renderer.render(scene,camera);
  $('located').hidden=!state.selected;
  if(state.selected){const point=worldCell.clone().add(new THREE.Vector3(0,.35,0)).project(camera);$('located').style.left=Math.max(120,Math.min(host.clientWidth-120,(point.x+1)*host.clientWidth/2))+'px';$('located').style.top=Math.max(90,Math.min(host.clientHeight-24,(1-point.y)*host.clientHeight/2-20))+'px';}
  positionCursor(state,snapCursor);
  $('finished').hidden=!state.done;$('cursor').hidden=state.done;
  $('clock').textContent=`${String(Math.floor(seconds)).padStart(2,'0')} / 50 秒`;$('progress').value=seconds;
  $('play').textContent=playing?'暂停':state.done?'重新播放':'播放';
  $('play').hidden=state.done;
}
function positionCursor(state,snap){
  let x,y;
  const bounds=main.getBoundingClientRect(),target=state.active?$('demo-'+state.active):state.results?$('queryResult'):$('simAction');
  if(state.dragging){const point=rack.position.clone().add(new THREE.Vector3(0,1,0)).project(camera),sceneBounds=host.getBoundingClientRect();x=sceneBounds.left-bounds.left+(point.x+1)*sceneBounds.width/2;y=sceneBounds.top-bounds.top+(1-point.y)*sceneBounds.height/2;}
  else{const rect=target.getBoundingClientRect();x=rect.left-bounds.left+rect.width*.75;y=rect.top-bounds.top+rect.height*.6;}
  if(!cursorPosition||snap)cursorPosition={x,y};else{cursorPosition.x+=(x-cursorPosition.x)*.2;cursorPosition.y+=(y-cursorPosition.y)*.2;}
  $('cursor').style.transform=`translate(${cursorPosition.x}px,${cursorPosition.y}px)`;
}
function animate(now){if(playing&&!document.hidden)seconds=Math.min(SETUP_DEMO_DURATION,seconds+(now-last)/1000);last=now;if(seconds>=SETUP_DEMO_DURATION)playing=false;draw();if(playing)frame=requestAnimationFrame(animate);}
function play(){if(seconds>=SETUP_DEMO_DURATION)seconds=0;playing=!playing;last=performance.now();cancelAnimationFrame(frame);draw(true);if(playing)frame=requestAnimationFrame(animate);}
$('play').onclick=play;$('replay').onclick=()=>{seconds=0;playing=false;play();};
$('progress').oninput=()=>{seconds=Number($('progress').value);playing=false;cancelAnimationFrame(frame);draw(true);};
function resize(){const {width,height}=host.getBoundingClientRect();if(!width||!height)return;renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();draw(true);}
const observer=new ResizeObserver(resize);observer.observe(host);resize();if(playing)frame=requestAnimationFrame(animate);
document.addEventListener('visibilitychange',()=>{last=performance.now();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();send('close');}});
window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);observer.disconnect();scene.traverse(object=>{object.geometry?.dispose();for(const material of [object.material].flat().filter(Boolean)){material.map?.dispose();material.dispose();}});renderer.dispose();});
