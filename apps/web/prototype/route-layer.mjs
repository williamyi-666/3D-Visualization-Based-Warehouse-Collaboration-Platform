import * as THREE from 'three';
import {routeLayoutKey} from '../../../packages/three-kit/warehouse-route.mjs';

// 路线独立于货架外观。库区/布局改变或权限失效时清除，库存刷新不改变起点。
export function createRouteLayer({scene,host,onRender=()=>{}}){
  const group=new THREE.Group();group.name='warehouse-picking-route';scene.add(group);
  const badge=document.createElement('div');badge.className='warehouse-route-badge';badge.hidden=true;
  const text=document.createElement('span'),close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','清除取货路线');badge.append(text,close);host.append(badge);
  let currentKey='',active;
  function clear(message=''){
    for(const object of [...group.children]){group.remove(object);object.traverse(child=>{child.geometry?.dispose();for(const material of [child.material].flat().filter(Boolean)){material.map?.dispose();material.dispose();}});}
    active=null;badge.hidden=!message;text.textContent=message;onRender();
  }
  close.onclick=()=>clear();
  function setLayout(spec){const key=routeLayoutKey(spec);if(active&&key!==currentKey)clear('布局已变化，请重新规划路线');currentKey=key;}
  function show(route){
    if(!currentKey||route.layout_key!==currentKey)throw Error('场景已变化，请刷新并重新规划路线');clear();active=route;
    const material=new THREE.MeshBasicMaterial({color:0x22b8f0,depthTest:false});
    for(let i=1;i<route.points.length;i++){
      const from=route.points[i-1],to=route.points[i],length=Math.hypot(to.x-from.x,to.z-from.z);if(length<1e-6)continue;
      const mesh=new THREE.Mesh(new THREE.CylinderGeometry(.025,.025,length,8),material.clone());mesh.position.set((from.x+to.x)/2,.09,(from.z+to.z)/2);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(to.x-from.x,0,to.z-from.z).normalize());mesh.renderOrder=45;group.add(mesh);
    }
    material.dispose();
    for(const stop of route.stops){
      const canvas=document.createElement('canvas');canvas.width=canvas.height=96;const ctx=canvas.getContext('2d');ctx.fillStyle='#1379cb';ctx.beginPath();ctx.arc(48,48,43,0,Math.PI*2);ctx.fill();ctx.lineWidth=5;ctx.strokeStyle='#fff';ctx.stroke();ctx.font='bold 50px sans-serif';ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(stop.index),48,51);
      const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(canvas),depthTest:false}));sprite.position.set(stop.point.x,.4,stop.point.z);sprite.scale.set(.5,.5,.5);sprite.renderOrder=46;sprite.userData={type:'routeStop',loc_code:stop.loc_code};group.add(sprite);
    }
    text.textContent=`取货路线 · ${route.stops.length}处 · 约${route.distance.toFixed(1)}米${route.unreachable.length?' · 部分不可达':''}`;badge.hidden=false;onRender();
  }
  window.addEventListener('spatial-auth-required',()=>clear());
  return {show,clear,setLayout};
}
