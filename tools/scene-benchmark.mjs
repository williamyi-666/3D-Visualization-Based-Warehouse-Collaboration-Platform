// 运行 node tools/scene-benchmark.mjs，浏览器打开输出地址；只生成内存场景，不连接业务数据库。
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const files=new Map([
  ['/three.js','apps/web/prototype/vendor/three.module.js'],
  ['/spaceGenerator.js','packages/three-kit/spaceGenerator.js'],
  ['/sku-capacity.mjs','packages/three-kit/sku-capacity.mjs'],
]);
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>格位规模隔离验收</title>
<style>body{font:14px system-ui;margin:20px;background:#edf2f7}button{padding:10px;margin:4px}pre{white-space:pre-wrap}canvas{max-width:100%}</style>
<h1>格位规模隔离验收</h1><p>使用应用实际空间生成器。每货架100格，默认无库存；远景隐藏编号并只保留空格轮廓。URL加?full=1可对照完整表面，stock=8启用每格8条库存，unbatched=1关闭库存合批，unbatchedSurfaces=1关闭远景表面合批。耗时受机器和浏览器影响。</p>
<button data-count="1000">1000格</button><button data-count="5000">5000格</button><button data-count="10000">10000格</button>
<p id="status" role="status">准备就绪</p><pre id="results"></pre><div id="view"></div>
<script type="importmap">{"imports":{"three":"/three.js"}}</script><script type="module">
import * as THREE from 'three';
import {createFurniture,updateCellSurface} from '/spaceGenerator.js';
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(960,540);renderer.setPixelRatio(1);
document.getElementById('view').append(renderer.domElement);
const scene=new THREE.Scene();scene.background=new THREE.Color(0xdfe7ef);scene.add(new THREE.AmbientLight(0xffffff,2));
const camera=new THREE.PerspectiveCamera(50,960/540,0.1,1000);
const query=new URLSearchParams(location.search),stock=Math.max(0,Math.min(8,Number(query.get('stock'))||0)),batchInventory=!query.has('unbatched');
let groups=[],cells=[];
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const q95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];
async function run(count){
 const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 const status=document.getElementById('status');status.textContent='运行 '+count+' 格…';await frame();await frame();
 try{
  const removed={geometries:new Set(),materials:new Set(),textures:new Set()};
  for(const g of groups){scene.remove(g);g.traverse(o=>{if(o.isInstancedMesh)o.dispose();if(o.geometry)removed.geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:[o.material])if(m){removed.materials.add(m);for(const v of Object.values(m))if(v?.isTexture)removed.textures.add(v);}});}
  for(const set of Object.values(removed))for(const resource of set)resource.dispose();
  groups=[];cells=[];renderer.render(scene,camera);
  const afterDispose={...renderer.info.memory},start=performance.now();
  const inventory={};for(let r=1;r<=10;r++)for(let c=1;c<=10;c++)inventory['L'+String(r).padStart(2,'0')+'-B'+String(c).padStart(2,'0')]=Array.from({length:stock},(_,j)=>({name:'样例'+j,qty:1,unit:'件'}));
  for(let i=0;i<count/100;i++){
   const g=createFurniture({code:'BENCH-'+i,label:'架'+i,type:'rack',width:5,height:4,depth:1,rows:10,cols:10,position:[(i%10)*6,0,Math.floor(i/10)*3],inventoryVisualLimit:8,lazyCellLabels:true,batchInventory,batchCellSurfaces:!query.has('unbatchedSurfaces'),items:inventory},cells);
   groups.push(g);scene.add(g);
  }
  for(const c of cells)c.label.visible=false;
  const buildMs=performance.now()-start;
  camera.position.set(27,60,60);camera.lookAt(27,0,Math.floor(count/1000)*1.5);
  const surfaceMode=new URLSearchParams(location.search).has('full')?'完整表面':'远景空格轮廓';
  if(surfaceMode!=='完整表面')for(const cell of cells)updateCellSurface(cell,camera.position);
  const first=performance.now();renderer.render(scene,camera);const firstRenderMs=performance.now()-first;
  const frameTimes=[],renderTimes=[];let prev=await frame();
  for(let i=0;i<60;i++){const now=await frame();frameTimes.push(now-prev);prev=now;const s=performance.now();renderer.render(scene,camera);renderTimes.push(performance.now()-s);}
  const result={surfaceMode,stockPerCell:stock,batchInventory,batchCellSurfaces:!query.has('unbatchedSurfaces'),cells:cells.length,buildMs:Math.round(buildMs),firstRenderMs:Math.round(firstRenderMs),frameP95Ms:Math.round(q95(frameTimes)*10)/10,renderP95Ms:Math.round(q95(renderTimes)*10)/10,drawCalls:renderer.info.render.calls,memory:{...renderer.info.memory},afterDispose};
  document.getElementById('results').textContent+=JSON.stringify(result)+'\\n';status.textContent='完成 '+count+' 格';
 }catch(e){status.textContent='失败：'+e.message;}finally{buttons.forEach(b=>b.disabled=false);}
}
document.querySelectorAll('button').forEach(b=>b.onclick=()=>run(Number(b.dataset.count)));
</script></html>`;
createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);}
  const file=files.get(path);if(!file){res.statusCode=404;return res.end();}
  try{res.setHeader('Content-Type','text/javascript');res.end(await readFile(fileURLToPath(new URL(file,root))));}
  catch{res.statusCode=500;res.end('资源读取失败');}
}).listen(39098,'127.0.0.1',()=>console.log('隔离格位验收：http://127.0.0.1:39098'));
