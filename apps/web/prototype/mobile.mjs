import {mountLiveInventory,inventorySyncMessage} from './live-inventory.mjs';
import {createStocktakeUI} from './stocktake-ui.mjs';
import {createWarehouseWorkUI} from './warehouse-work-ui.mjs';
import {createTeamTasksUI} from './team-tasks-ui.mjs';
import {openItemStorage} from './item-storage-ui.mjs';
import {createMobileOperations} from './mobile-operations-ui.mjs';
import {createAssistantUI} from './assistant-ui.mjs';
import {createAssistantGuide} from './assistant-guide.mjs';
import {createErpStocktakeUI} from './erp-stocktake-ui.mjs';
import {formatBusinessTime} from './business-time.mjs';
import {createMobileOffline} from './mobile-offline.mjs';
import {mountMobilePwa} from './mobile-pwa.mjs';
import {openMobileCountDraft} from './mobile-count-draft.mjs';
import {capacitySummary} from '../../../packages/three-kit/sku-capacity.mjs';
const $=id=>document.getElementById(id);
const rawFetch=window.fetch.bind(window);
window.fetch=(url,init={})=>{
  const headers=new Headers(init.headers);
  if(window.SPATIAL_RUNTIME?.provider!=='supos'){
    const token=localStorage.getItem('spatial_token');if(token)headers.set('Authorization','Bearer '+token);
  }
  return rawFetch(url,{...init,headers});
};
let selected='',access={canOperate:false},mode='',queryVersion=0,detailVersion=0,pickerCells=[],pickAction;
let currentUserId='',stopLive, suspended=[],initialTargetApplied=false;
let mobileScene,sceneVersion=0,activeView='work',realisticView=false;
let sourceStates=[];
let lastSync='正在连接仓库服务…';
const offline=createMobileOffline({storage:localStorage,scope:location.origin+(window.SPATIAL_RUNTIME?.basePath||''),credential:()=>localStorage.getItem('spatial_token')||'',fetcher:(...args)=>fetch(...args),onAccessLost:()=>showLogin(),onState:({stale,warning})=>{
  $('offlineStatus').classList.toggle('hidden',!stale.length&&!warning);
  $('offlineStatusText').textContent=stale.length?`正在查看本机最近记录（${formatBusinessTime(new Date(Math.min(...stale.map(row=>row.at))).toISOString())}），仅供参考。未提交草稿不会更新库存，请联网核对后提交。`:warning;
  showSyncStatus(lastSync);
}});
mountMobilePwa({button:$('installMobile'),status:$('installHint')});
function showSyncStatus(text){
  lastSync=text;const label=offline.historical?'当前为本机最近记录，库存尚未重新同步':inventorySyncMessage(text,sourceStates),host=$('liveStatus');host.textContent=label;
  host.classList.toggle('sync-warning',/ERP同步失败|ERP更新超时|网络已断开|连接中断|同步暂未完成/.test(label));
}
function setView(view){activeView=view;document.body.dataset.view=view;for(const name of ['warehouse','work','records'])$(name+'View').classList.toggle('hidden',name!==view);document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));mobileScene?.resize();}
setView(activeView);
function updateDesktopLink(){ $('desktopViewSwitch').href=window.SpatialInterface.url('desktop',{room:$('room').value,loc:selected});const url=new URL(location.href);if($('room').value)url.searchParams.set('room',$('room').value);if(selected)url.searchParams.set('loc',selected);else url.searchParams.delete('loc');window.history.replaceState(null,'',url); }
$('desktopViewSwitch').href=window.SpatialInterface.url('desktop');
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
async function refreshScene(fit=false,requireFresh=false){
  const version=++sceneVersion,room=$('room').value;if(!room)return;
  if(fit){$('mobileScene').dataset.unavailable='true';$('sceneMessage').classList.remove('hidden');$('sceneMessage').textContent='正在加载当前库区…';}
  try{
    const scenePath='/api/scene?room='+encodeURIComponent(room),data=await api(scenePath);
    if(fit&&mode!=='integration'&&!offline.isStale(scenePath))void Promise.allSettled([api('/api/work/progress?room='+encodeURIComponent(room)),api('/api/work/catalogue?room='+encodeURIComponent(room))]);
    if(requireFresh&&offline.isStale(scenePath))throw Error('尚未连接仓库服务，当前显示最近记录');
    if(version!==sceneVersion)return;
    if(!mobileScene){const {createMobileScene}=await import('./mobile-scene.mjs');if(version!==sceneVersion)return;mobileScene=createMobileScene($('mobileScene'),code=>run(async()=>{await showDetail(code);$('mobileScene').scrollIntoView({block:'start'});}));}
    mobileScene.load(data,fit);if(fit){realisticView=false;$('modelScene').textContent='写实模型';$('modelScene').setAttribute('aria-pressed','false');}if(realisticView)await mobileScene.setRealistic(true);
    if(version!==sceneVersion)return;
    delete $('mobileScene').dataset.unavailable;$('sceneMessage').classList.add('hidden');
    sourceStates=data.sync||[];
  }catch(error){
    if(version!==sceneVersion)return;
    $('mobileScene').dataset.unavailable='true';$('sceneMessage').classList.remove('hidden');$('sceneMessage').textContent='三维场景暂不可用，可到“作业”继续查询：'+error.message;
    // 同步器必须收到失败，才能保留待更新状态并自动重试。
    if(requireFresh)throw error;
  }
}
$('resetScene').onclick=()=>mobileScene?.reset();
$('modelScene').onclick=()=>run(async()=>{
 if(!mobileScene)return;$('modelScene').disabled=true;
 try{await mobileScene.setRealistic(!realisticView);realisticView=!realisticView;$('modelScene').textContent=realisticView?'返回示意图':'写实模型';$('modelScene').setAttribute('aria-pressed',String(realisticView));}
 finally{$('modelScene').disabled=false;}
});
$('locateScene').onclick=()=>{setView('warehouse');mobileScene?.select(selected,true);$('mobileScene').scrollIntoView({block:'center'});};
$('closeDetail').onclick=()=>{selected='';detailVersion++;$('detail').classList.add('hidden');mobileScene?.select('');updateDesktopLink();};
function showLogin(){
  offline.forget(); // 实时同步发现撤权时，也清除最近记录；本机未提交草稿仍保留。
  stopLive?.();stopLive=null;
  window.dispatchEvent(new Event('spatial-auth-required'));
  $('identity').textContent='尚未登录';
  $('workspace').classList.add('hidden');sceneVersion++;
  // 登录失效时取消待确认动作；重新登录后只恢复原表单。
  if($('confirmModal').open)$('confirmModal').close();
  const open=[...document.querySelectorAll('dialog[open]:not(.assistant-window),.modal:not(.hidden)')];
  if(open.length)suspended=open;
  open.forEach(panel=>panel.tagName==='DIALOG'?panel.close():panel.classList.add('hidden'));
  if(window.SPATIAL_RUNTIME?.provider!=='supos')$('loginPanel').classList.remove('hidden');
}
$('loginForm').onsubmit=async event=>{
  event.preventDefault();$('loginSubmit').disabled=true;$('loginError').textContent='';
  try{
    const r=await rawFetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('loginUser').value.trim(),password:$('loginPassword').value})});
    const data=await r.json();if(!r.ok)throw Error(data.error||'登录失败');
    localStorage.setItem('spatial_token',data.token);localStorage.setItem('spatial_user',JSON.stringify(data.user));$('loginPassword').value='';
    if(currentUserId&&currentUserId===data.user.id){await initialize();await $('counterFrame').contentWindow.resumeCounterAccess?.();for(const panel of suspended)panel.tagName==='DIALOG'?panel.showModal():panel.classList.remove('hidden');suspended=[];$('message').textContent='已重新登录，原填写内容已保留。';}
    else location.reload();
  }catch(error){$('loginError').textContent=error.message;}finally{$('loginSubmit').disabled=false;}
};
async function api(url){
  return offline.read(url);
}
const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el;};
async function showDetail(code){
  const version=++detailVersion;
  const items=await api('/api/cells/'+encodeURIComponent(code)+'/items');
  if(mode!=='integration'&&!offline.historical)void api('/api/work/opening?loc_code='+encodeURIComponent(code)).catch(()=>{});
  if(version!==detailVersion)return;
  selected=code;$('loc').textContent=code;$('items').replaceChildren();updateDesktopLink();
  const capacity=mobileScene?.capacity(code);
  if(capacity){const summary=node('p',capacitySummary(capacity));summary.className='hint';$('items').append(summary);}
  for(const item of items){const row=node('div',`${item.name} · ${item.qty} ${item.unit||'件'}`);row.append(node('small','SKU：'+(item.sku||'未设置')));if(item.reserved_qty)row.append(node('small',`任务预占 ${item.reserved_qty} · 可用 ${item.available_qty} ${item.unit||'件'}`));if(mode!=='integration'){const storage=node('button','存放资料 / 推荐');storage.type='button';storage.onclick=()=>run(()=>openItemStorage({itemId:item.item_id,room:$('room').value,onChanged:()=>refreshScene(false),locate:async loc=>{await showDetail(loc);setView('warehouse');mobileScene?.select(loc,true);},openCounter:openMobileCounter}));row.append(storage);}$('items').append(row);}
  if(!items.length)$('items').append(node('p','此格位暂无库存，可以办理入库。'));
  $('detail').classList.remove('hidden');
  mobileScene?.select(code);
  document.querySelectorAll('#results button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.loc===code)));
}
async function search(){
  const q=$('query').value.trim(),version=++queryVersion,room=$('room').value;
  if(!q){$('message').textContent='请输入货品名称、SKU或格位码。';return;}
  const hits=await api('/api/search?q='+encodeURIComponent(q));
  if(version!==queryVersion)return;
  const groups=new Map();
  for(const hit of hits){if(!hit.loc_code?.startsWith(room+'-'))continue;const group=groups.get(hit.loc_code)||[];group.push(hit);groups.set(hit.loc_code,group);}
  // 空格位没有货品，也应能按完整格位码进入办理入库。
  if(!groups.size){const cells=await api('/api/cells');if(version!==queryVersion)return;for(const c of cells)if(c.loc_code===q&&q.startsWith(room+'-'))groups.set(q,[]);}
  $('results').replaceChildren();$('message').textContent=groups.size?`找到 ${groups.size} 个格位，点击查看库存。`:'当前库区没有匹配结果，请检查关键词或切换库区。';
  for(const [code,rows] of groups){const b=node('button',code);b.dataset.loc=code;b.setAttribute('aria-pressed',String(code===selected));b.append(node('small',rows.map(r=>r.name).filter(Boolean).join('、')||'空格位'));b.onclick=()=>run(async()=>{await showDetail(code);mobileScene?.select(code,true);$('results').replaceChildren();(activeView==='warehouse'?$('mobileScene'):$('detail')).scrollIntoView({block:'start'});});$('results').append(b);}
}
async function run(fn){try{$('message').textContent='';await fn();}catch(error){$('message').textContent=error.message;}}
$('searchForm').onsubmit=e=>{e.preventDefault();run(search);};
$('room').onchange=()=>{queryVersion++;detailVersion++;selected='';$('detail').classList.add('hidden');$('results').replaceChildren();updateDesktopLink();refreshScene(true);if($('query').value.trim())run(search);};
for(const button of document.querySelectorAll('[data-mode]'))button.onclick=()=>{
  if(!access.canOperate)return;
  run(()=>openMobileCounter(button.closest('#actions')?selected:'',button.dataset.mode));
};
function closeCounter(){
  if($('counterFrame').contentWindow.confirmCounterClose?.()===false)return;
  $('counter').close();$('counterFrame').src='about:blank';if(selected)run(()=>showDetail(selected));
}
$('closeCounter').onclick=closeCounter;
$('counter').addEventListener('cancel',event=>{event.preventDefault();closeCounter();});
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==$('counterFrame').contentWindow)return;
  if(event.data?.type==='counter-close-request')closeCounter();
  if(event.data?.type==='counter-auth-required'){
    showLogin();$('message').textContent='登录已变化，重新登录同一账号后可继续填写。';
  }
});
function confirmMobile(text){
  const dialog=$('confirmModal');$('mobileConfirmText').textContent=text;
  dialog.classList.remove('hidden');dialog.showModal();
  return new Promise(resolve=>{
    let accepted=false;
    $('mobileConfirmCancel').onclick=()=>dialog.close();
    $('mobileConfirmAccept').onclick=()=>{accepted=true;dialog.close();};
    dialog.addEventListener('close',()=>{dialog.classList.add('hidden');resolve(accepted);},{once:true});
  });
}
const stocktake=createStocktakeUI({confirm:confirmMobile,onChanged:async()=>{await refreshScene(false);if(selected)await showDetail(selected);}});
const erpStocktake=createErpStocktakeUI();
const openCount=(code,options)=>mode==='integration'?erpStocktake.open(code,{canOperate:access.canCount,canAdmin:access.canAdmin},options):stocktake.open(code,access,options);
const mobileOperations=createMobileOperations({getRoom:()=>$('room').value,confirm:confirmMobile,openCount,read:api,isHistorical:()=>offline.historical,onChanged:async()=>{await refreshScene(false);if(selected)await showDetail(selected);}});
const teamTasksUI=createTeamTasksUI({getRoom:()=>$('room').value,confirm:confirmMobile,onChanged:async()=>{await refreshScene(false);if(selected)await showDetail(selected);},locate:async code=>{await showDetail(code);setView('warehouse');mobileScene?.select(code,true);},
  showRoute:async route=>{await refreshScene(false,true);setView('warehouse');mobileScene.showRoute(route);mobileScene.reset();$('mobileScene').scrollIntoView({block:'center'});}});
$('teamTasks').onclick=()=>run(()=>teamTasksUI.open());
const warehouseWork=createWarehouseWorkUI({getRoom:()=>$('room').value,confirm:confirmMobile,
  openJob:id=>warehouseAssistant.showJob(id),
  openTeam:id=>teamTasksUI.open(id),
  onChanged:async()=>{await refreshScene(false);if(selected)await showDetail(selected);},
  openCount:(code,options)=>stocktake.open(code,access,options),
  openCounter:openMobileCounter,
  locate:async code=>{setView('warehouse');await showDetail(code);mobileScene?.select(code,true);},
});
$('openingStock').onclick=()=>run(()=>warehouseWork.opening());$('workTasks').onclick=()=>run(()=>warehouseWork.tasks());
$('itemCodes').onclick=()=>run(()=>openItemCodes({onChanged:()=>refreshScene(false)}));
function openMobileCounter(code,mode,options={}) {return mobileOperations.open(code,mode,options);}
const assistantGuide=createAssistantGuide({mobile:true,getRoom:()=>$('room').value,prepare:async topic=>{
  setView('work');
  if(topic==='quickBuild')await warehouseWork.quickBuild();
  if(topic==='opening')await warehouseWork.opening();
  if(topic==='labels'){const url=new URL('../labels/index.html',import.meta.url);url.searchParams.set('room',$('room').value);window.open(url,'_blank');}
}});
const warehouseAssistant=createAssistantUI({getRoom:()=>$('room').value,getContext:()=>({loc_code:selected,view:activeView}),openGuide:topic=>assistantGuide.open(topic),
  locate:async code=>{const rooms=[...$('room').options],target=rooms.find(r=>code.startsWith(r.value+'-'));if(target&&target.value!==$('room').value){$('room').value=target.value;await refreshScene(true);}setView('warehouse');await showDetail(code);mobileScene?.select(code,true);},
  openCounter:openMobileCounter,openTeam:id=>teamTasksUI.open(id),openCount:(code,options)=>mode==='integration'?erpStocktake.open(code,{canOperate:access.canCount,canAdmin:access.canAdmin},options):stocktake.open(code,access,options),
  openQuickBuild:options=>warehouseWork.quickBuild(options),openOpening:(loc,options)=>warehouseWork.opening(loc.split('-').slice(0,-3).join('-'),loc,options),openTasks:()=>warehouseWork.tasks(),onAuthRequired:showLogin,onError:error=>$('message').textContent=error.message});
$('count').onclick=()=>run(()=>mode==='integration'?openCount(selected):openMobileCountDraft({code:selected,read:api,openCount,isHistorical:()=>offline.historical}));
function renderChoices(){
  const term=$('cellFilter').value.trim().toUpperCase();$('cellChoices').replaceChildren();
  const matches=pickerCells.filter(c=>c.loc_code.toUpperCase().includes(term));
  for(const cell of matches){const b=node('button',cell.loc_code);b.onclick=()=>{$('cellPicker').close();run(()=>pickAction(cell.loc_code));};$('cellChoices').append(b);}
  if(!matches.length)$('cellChoices').append(node('p','没有匹配的格位。'));
}
async function pickCell(title,action){
  pickerCells=(await api('/api/cells')).filter(c=>c.loc_code.startsWith($('room').value+'-'));pickAction=action;
  $('pickerTitle').textContent=title;$('cellFilter').value='';renderChoices();$('cellPicker').showModal();
}
async function history(code){
  $('historyTitle').textContent='库存流水 · '+code;$('historyRows').replaceChildren(node('p','正在读取…'));$('history').showModal();
  try{
    const rows=await api('/api/cell/'+encodeURIComponent(code)+'/history');$('historyRows').replaceChildren();
    const names={opening:'期初建账',inbound:'入库',outbound:'出库',move:'移库',stocktake:'盘点调账',merge:'合并',relocate:'重定位',erp_sync:'ERP同步'};
    for(const row of rows){const card=node('article','');card.className='card';card.append(node('strong',`${names[row.move_type]||row.move_type} · ${row.item_name||'货品'} · ${row.qty} ${row.unit||'件'}`),node('p',`${row.from_loc||'外部'} → ${row.to_loc||'外部'}`),node('small',`${formatBusinessTime(row.occurred_at)} · ${row.actor_name||'操作人未记录'}`));if(row.business)card.append(node('small',window.SpatialBusiness.describe(row.business)));if(mode!=='integration'&&row.move_type==='stocktake'){const id=row.business?.stocktake_id||/^stocktake:([0-9a-f-]{36}):/i.exec(row.idem_key||'')?.[1];if(id){const view=node('button','查看盘点单');view.onclick=()=>{$('history').close();stocktake.open(code,access,{recordId:id});};card.append(view);}}$('historyRows').append(card);}
    if(!rows.length)$('historyRows').append(node('p','该格位暂无库存流水。'));
  }catch(error){$('historyRows').replaceChildren(node('p',error.message));}
}
$('quickCount').onclick=()=>run(()=>mode==='integration'?pickCell('选择盘点格位',async code=>{await showDetail(code);await openCount(code);}):mobileOperations.open('','count'));
$('quickHistory').onclick=()=>run(()=>pickCell('选择流水查询格位',history));
$('recordLookup').onclick=()=>run(()=>pickCell('选择流水查询格位',history));
$('browseCells').onclick=()=>run(()=>pickCell('选择要查看的格位',showDetail));
$('cellHistory').onclick=()=>history(selected);
$('cellFilter').oninput=renderChoices;
$('closePicker').onclick=()=>$('cellPicker').close();$('closeHistory').onclick=()=>$('history').close();
async function initialize(){
  stopLive?.();
  const identity=await api('/api/auth/me');mode=identity.mode;
  currentUserId=identity.user.id;
  access.canOperate=['admin','operator'].includes(identity.user?.role)&&mode!=='integration';
  access.canCount=['admin','operator'].includes(identity.user?.role);access.canAdmin=identity.user?.role==='admin';
  $('openingStock').disabled=!access.canOperate;$('workTasks').disabled=mode==='integration';
  $('teamTasks').disabled=!access.canOperate;$('teamTasks').hidden=mode==='integration';
  $('itemCodes').hidden=!access.canAdmin||mode==='integration';
  $('identity').textContent=identity.user?.name||identity.user?.username||'已登录';
  document.querySelectorAll('#actions button').forEach(b=>b.disabled=!access.canOperate);
  document.querySelectorAll('#quickActions [data-mode],#quickCount').forEach(b=>b.disabled=!access.canOperate);
  for(const id of ['quickHistory','browseCells','cellHistory'])$(id).disabled=false;
  $('count').disabled=!access.canCount;$('quickCount').disabled=!access.canCount;
  $('modeHint').textContent=mode==='integration'?(access.canCount?'可查询库存、登记实盘差异；审核后提交 ERP，回传核对后完成调账。':'当前账号可查询 ERP 库存。'):access.canOperate?'操作成功后，其他在线设备会自动更新。':'当前账号可查询库存，不能办理库存操作。';
  const rooms=await api('/api/rooms'),previousRoom=$('room').value,params=new URLSearchParams(location.search);
  const initialLoc=!initialTargetApplied?params.get('loc'):'',initialRoom=!initialTargetApplied?rooms.find(r=>initialLoc?initialLoc.startsWith(r.loc_code+'-'):r.loc_code===params.get('room')):null;
  $('room').replaceChildren();for(const room of rooms){const option=node('option',room.name||room.loc_code);option.value=room.loc_code;$('room').append(option);}
  if(initialRoom)$('room').value=initialRoom.loc_code;else if(rooms.some(r=>r.loc_code===previousRoom))$('room').value=previousRoom;
  if(!rooms.length)throw Error('暂无可访问库区，请联系管理员配置仓库权限。');
  $('loginPanel').classList.add('hidden');$('workspace').classList.remove('hidden');await refreshScene(true);
  window.dispatchEvent(new Event('spatial-auth-ready'));
  if(initialLoc&&initialRoom)await showDetail(initialLoc);
  initialTargetApplied=true;updateDesktopLink();
  stopLive=mountLiveInventory({getRoom:()=>$('room').value,isBusy:()=>!!document.querySelector('dialog[open]:not(.assistant-window),.modal:not(.hidden)'),
    onAccessLost:()=>{access.canOperate=false;document.querySelectorAll('[data-mode],#count,#quickCount').forEach(b=>b.disabled=true);showLogin();$('message').textContent='登录或权限已变化，请重新登录。';},
    refresh:async()=>{await refreshScene(false,true);if(selected)await showDetail(selected);if($('query').value.trim())await search();},status:showSyncStatus});
}
$('retryOffline').onclick=()=>run(async()=>{await initialize();if($('query').value.trim())await search();});
// 恢复连接只提示核对，绝不自动提交本机草稿。
window.addEventListener('online',()=>{if(offline.historical)$('message').textContent='连接可能已恢复，请点“重新连接”核对最新库存后再提交草稿。';});
await run(initialize);
import {openItemCodes} from './item-codes-ui.mjs';
