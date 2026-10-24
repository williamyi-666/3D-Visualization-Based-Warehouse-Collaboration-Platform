import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync('apps/web/prototype/app.js','utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('平台返回与本地退出文案区分，取消不离开，有草稿时提示丢失',async()=>{
  const start=source.indexOf("document.getElementById('userChip').onclick =");
  const code=source.slice(start,source.indexOf('// ---- 系统管理面板',start));
  for(const IS_SUPOS of [true,false]){
    const chip={};let confirmation,accepted=false,leaves=0;
    const context={IS_SUPOS,layoutDirty:true,document:{getElementById:()=>chip},
      appConfirm:async(msg,options)=>{confirmation={msg,...options};return accepted;},doLogout:()=>leaves++};
    vm.runInNewContext(code,context);
    await chip.onclick();assert.equal(leaves,0);
    assert.match(confirmation.msg,/未保存/);
    assert.equal(confirmation.title,IS_SUPOS?'返回平台':'退出登录');
    if(IS_SUPOS)assert.match(confirmation.msg,/账号会保持登录/);
    accepted=true;await chip.onclick();assert.equal(leaves,1);
  }
});

test('同步示例使用当前实例根路径，独立入口不指向固定网关',()=>{
  const sync=readFileSync('apps/web/prototype/sync.js','utf8');
  const start=sync.indexOf("  const endpoint=");
  assert.ok(start>=0,'同步页面需计算当前入口');
  const snippet=sync.slice(start,sync.indexOf('  await refresh();',start));
  for(const basePath of ['', '/warehouse','/warehouse-rc/']){
    const els={endpoint:{},example:{}};
    vm.runInNewContext(snippet,{$:id=>els[id],window:{SPATIAL_RUNTIME:{basePath}},location:{origin:'http://localhost:39026'},JSON});
    const expected='http://localhost:39026'+basePath.replace(/\/$/,'')+'/api/integration/snapshot';
    assert.equal(els.endpoint.textContent,expected);
    assert.ok(els.example.textContent.startsWith('POST '+expected+'\n'));
  }
});

test('移库更换目标立即禁用提交，更换源清除选品，晚到结果不覆盖新源',async()=>{
  const html=readFileSync('apps/web/prototype/counter.html','utf8');
  const els=new Map(),requests=[];
  const $=id=>{if(!els.has(id))els.set(id,{value:'',max:'',events:{},addEventListener(n,fn){this.events[n]=fn;},querySelectorAll(){return [];}});return els.get(id);};
  const ctx=vm.createContext({$,cells:new Set(['A','B','C']),escapeText:String,fetch(){const d=deferred();requests.push(d);return d.promise;}});
  vm.runInContext(html.slice(html.indexOf("let moveFromCode="),html.indexOf("$('moveSubmit').onclick")),ctx);
  vm.runInContext("moveFromCode='A'; moveToCode='B'; moveSelItem='sku';",ctx);
  $('moveQty').value='1';$('moveQty').max='2';ctx.updateMoveReady();assert.equal($('moveSubmit').disabled,false);
  $('moveTo').value='outside';$('moveTo').events.input();assert.equal($('moveSubmit').disabled,true);
  ctx.validateMoveLoc('moveTo');assert.match($('moveToState').textContent,/无效/);
  $('moveTo').value='B';ctx.validateMoveLoc('moveTo');assert.equal($('moveSubmit').disabled,false);
  $('moveTo').value='A';ctx.validateMoveLoc('moveTo');assert.equal($('moveSubmit').disabled,true);
  $('moveFrom').events.input();assert.equal($('moveQty').disabled,true);assert.equal($('moveQty').value,'');
  vm.runInContext("moveFromCode='A'",ctx);const old=ctx.loadMoveItems('A');
  vm.runInContext("moveFromCode='C'",ctx);const fresh=ctx.loadMoveItems('C');
  requests[1].resolve({ok:true,json:async()=>[{item_id:'new',name:'新源货品',qty:2}]});await fresh;
  const expected=$('moveItems').innerHTML;
  requests[0].resolve({ok:true,json:async()=>[{item_id:'old',name:'旧源货品',qty:9}]});await old;
  assert.equal($('moveItems').innerHTML,expected);assert.match(expected,/新源货品/);
});

test('主页面写入403保留表单，401和读取403仍触发身份保护',async()=>{
  let status=403,logins=0;
  const context=vm.createContext({Headers,Request,apiGetToken:()=>'',showLogin:()=>logins++,notifyFetchTrouble(){},window:{fetch:async()=>({status})}});
  vm.runInContext(source.slice(source.indexOf('const _rawFetch ='),source.indexOf('function showLogin(')),context);
  for(const method of ['POST','PUT','PATCH','DELETE']){const r=await context.window.fetch('/api/import',{method});assert.equal(r.status,403);}
  assert.equal(logins,0);
  await context.window.fetch('/api/scene');assert.equal(logins,1);
  await context.window.fetch(new Request('http://localhost/api/items',{method:'POST'}));assert.equal(logins,1);
  status=401;await context.window.fetch('/api/import',{method:'POST'});assert.equal(logins,2);
});

test('出入库台写入403保留待确认界面，身份或读取权限失效仍通知父页',async()=>{
  const html=readFileSync('apps/web/prototype/counter.html','utf8');let status=403,notifications=0;
  const context=vm.createContext({Headers,Request,location:{hash:'',origin:'http://localhost'},window:{SPATIAL_RUNTIME:{provider:'supos'},fetch:async()=>({status}),parent:{postMessage(){notifications++;}}}});
  const start=html.indexOf('(function(){',html.indexOf('// 企业级 P0'));
  vm.runInContext(html.slice(start,html.indexOf('const $ =',start)),context);
  await context.window.fetch('/api/counter/move',{method:'POST'});assert.equal(notifications,0);
  await context.window.fetch('/api/cells');assert.equal(notifications,1);
  status=401;await context.window.fetch('/api/counter/move',{method:'POST'});assert.equal(notifications,2);
});

test('3D编辑捕获层放行退出确认按钮和键盘，仍拦截其他工具',()=>{
  const events={};let blocked=0,cancelled=0;
  const context=vm.createContext({drag3dMode:true,positionStarting:false,positionExitPending:true,
    positionBar:{contains:()=>false},renderer:{domElement:{}},toast(){},
    cancelPositionEdit(){cancelled++;},document:{addEventListener:(name,fn)=>events[name]=fn}});
  const start=source.indexOf('// 编辑期间保持库区和场景不变');
  vm.runInContext(source.slice(start,source.indexOf('const floorPlane',start)),context);
  const event=(inConfirm,key)=>({key,target:{closest:selector=>inConfirm&&selector==='#confirmModal'},
    preventDefault(){blocked++;},stopImmediatePropagation(){}});
  events.click(event(true));assert.equal(blocked,0);
  events.keydown(event(true,'Escape'));events.keydown(event(true,'Enter'));
  assert.equal(blocked,0);assert.equal(cancelled,0);
  events.click(event(false));assert.equal(blocked,1);
  context.positionExitPending=false;events.keydown(event(false,'Escape'));
  assert.equal(cancelled,1);
});

test('格位关闭等待页面确认，取消保留草稿，重复点击不替换待确认请求',async()=>{
  const text=readFileSync('apps/web/prototype/space-management.js','utf8');
  let hidden=false,calls=0;
  const request=deferred();
  const context=vm.createContext({dirty:true,bindingDirty:false,saving:false,returnFocus:null,
    modal:{inert:false,classList:{add(){hidden=true;}}},document:{activeElement:{focus(){}}},
    confirm(){calls++;return request.promise;}});
  vm.runInContext(text.slice(text.indexOf('  let confirming=false;'),text.indexOf("  q('#spaceClose').onclick")),context);
  const pending=context.close();await Promise.resolve();
  assert.equal(context.modal.inert,true);assert.equal(hidden,false);
  await context.close();assert.equal(calls,1);
  request.resolve(false);await pending;
  assert.equal(context.dirty,true);assert.equal(hidden,false);assert.equal(context.modal.inert,false);
  context.confirm=async()=>true;await context.close();
  assert.equal(hidden,true);assert.equal(context.dirty,false);
});

test('3D退出等待确认，取消不退出，重复点击不重复确认',async()=>{
  const button={};let calls=0,exits=0;const request=deferred();
  const context=vm.createContext({positionSaving:false,positionStarting:false,drag3dMode:true,layoutDirty:true,
    document:{getElementById:()=>button},appConfirm(){calls++;return request.promise;},
    cancelPositionEdit(){exits++;},beginPositionEdit(){}});
  vm.runInContext(source.slice(source.indexOf('let positionExitPending=false;'),source.indexOf('// 根据 3D 拖拽模式')),context);
  const pending=button.onclick();await button.onclick();assert.equal(calls,1);assert.equal(exits,0);
  request.resolve(false);await pending;assert.equal(exits,0);
  context.appConfirm=async()=>true;await button.onclick();assert.equal(exits,1);
});

test('非整米库区的网格保持0.25米间距和1米粗线，尺寸提示不随缩放变化',()=>{
  const legend={},lines=[];
  const context=vm.createContext({cadGrid:true,LPAD:20,SVGNS:'svg',document:{getElementById:()=>legend,createElementNS:()=>({setAttribute(key,value){this[key]=value;}})},w2s:(x,z,w,d,scale)=>[20+(x+w/2)*scale,20+(z+d/2)*scale]});
  vm.runInContext(source.slice(source.indexOf('function drawGrid('),source.indexOf('// ---- 房间尺寸标注')),context);
  for(const scale of [20,80]){
    lines.length=0;context.drawGrid({appendChild:line=>lines.push(line)},9.7,6.3,scale);
    const vertical=lines.filter(line=>line.x1===line.x2);
    assert.ok(vertical.every(line=>line.x1>=20&&line.x1<=20+9.7*scale));
    for(let i=1;i<vertical.length;i++)assert.ok(Math.abs((vertical[i].x1-vertical[i-1].x1)/scale-0.25)<1e-9);
    const major=vertical.filter(line=>line.stroke==='rgba(148,163,184,0.18)');
    assert.ok(major.length>1);
    for(let i=1;i<major.length;i++)assert.ok(Math.abs((major[i].x1-major[i-1].x1)/scale-1)<1e-9);
    assert.equal(legend.textContent,'小格 0.25 m ／ 大格 1 m');
  }
  context.cadGrid=false;lines.length=0;context.drawGrid({appendChild:line=>lines.push(line)},9.7,6.3,20);
  assert.equal(lines.length,0);assert.match(legend.textContent,/网格已隐藏/);
});

test('刷新库存保留库区、镜头和库位，编辑期间拒绝刷新',async()=>{
  const vector=value=>({value,clone(){return vector(this.value);},copy(other){this.value=other.value;}});
  let loaded=null,picked=null,searched=null;
  const context=vm.createContext({inventoryFilterUI:null,window:{},layoutDirty:false,layoutSaving:false,layoutModal:{classList:{contains:()=>true}},selected:{locCode:'WH-2-F1-L01-B01'},currentRoomCode:'WH-2',camera:{position:vector(7)},controls:{target:vector(3),update(){}},cellRegistry:[],document:{getElementById:()=>({value:'FLOOR'}),querySelectorAll:()=>[]},async loadScene(room,strict){loaded=[room,strict];context.camera.position.value=0;context.controls.target.value=0;context.cellRegistry=[{locCode:'WH-2-F1-L01-B01'}];},selectCell:entry=>picked=entry.locCode,doSearch:async q=>searched=q});
  vm.runInContext(source.slice(source.indexOf('window.SPATIAL_REFRESH_VIEW = async'),source.indexOf('\nasync function refreshLiveInventory()')),context);
  await context.window.SPATIAL_REFRESH_VIEW();
  assert.deepEqual(loaded,['WH-2',true]);assert.equal(picked,'WH-2-F1-L01-B01');assert.equal(searched,'FLOOR');
  assert.equal(context.camera.position.value,7);assert.equal(context.controls.target.value,3);
  context.layoutDirty=true;loaded=null;
  await assert.rejects(context.window.SPATIAL_REFRESH_VIEW(),/保存或关闭/);assert.equal(loaded,null);
});

test('库存查询晚到的结果或错误不覆盖新查询',async()=>{
  const requests=[];
  const msg={textContent:'',prepend(button){this.dismiss=button;},replaceChildren(){this.textContent='';},append(text){this.textContent+=typeof text==='string'?text:text.textContent;}};
  const context=vm.createContext({mountFreshness(){},URLSearchParams,currentRoomCode:'WH-1',locateByLoc(){},fetch(){const d=deferred();requests.push(d);return d.promise;},document:{getElementById(id){return id==='searchMsg'?msg:{value:''};},createElement(){return {};}}});
  vm.runInContext(source.slice(source.indexOf('let inventorySearchVersion'),source.indexOf('\nif(IS_INTEGRATION)',source.indexOf('let inventorySearchVersion'))),context);
  const first=context.searchExternalInventory('旧');
  const second=context.searchExternalInventory('新');
  requests[1].resolve({ok:true,json:async()=>({total:1,page:1,pages:1,rows:[{name:'新库存',qty:5,unit:'件',status:'可用',loc_code:'WH-1-A'}]})});await second;
  const current=msg.textContent;
  requests[0].resolve({ok:true,json:async()=>({total:0,page:1,pages:1,rows:[]})});await first;assert.equal(msg.textContent,current);
  const third=context.searchExternalInventory('将失败');
  const fourth=context.searchExternalInventory('最新');
  requests[3].resolve({ok:true,json:async()=>({total:0,page:1,pages:1,rows:[]})});await fourth;
  const empty=msg.textContent;requests[2].reject(Error('旧网络错误'));await third;
  assert.equal(msg.textContent,empty);
});

test('布局取消关闭保留草稿，保存锁阻止重复提交和关闭，失败可重试',async()=>{
  const els=new Map();const events={};let hidden=false,cleared=0,calls=0,accept=false,refreshed=0;
  const pending=deferred();
  const modal={inert:false,classList:{add(){hidden=true;}},setAttribute(){},removeAttribute(){}};
  const context=vm.createContext({clearTimeout,openingPersistTimer:null,layoutSaving:false,layoutClosePending:false,layoutDirty:true,layoutState:{room:{},furniture:[]},layoutReplacePending:false,currentRoomCode:'WH-1',layoutModal:modal,appConfirm:async()=>accept,clearDirty(){cleared++;},rebuildRoom(){},layoutMsg(){},loadScene:async()=>{},fetch(){calls++;return pending.promise;},window:{SPATIAL_REFRESH_VIEW:async()=>refreshed++,addEventListener:(n,fn)=>events[n]=fn},document:{getElementById(id){if(!els.has(id))els.set(id,{dataset:{}});return els.get(id);}}});
  vm.runInContext(source.slice(source.indexOf('async function closeLayout()'),source.indexOf("document.getElementById('layout_add_rack')")),context);
  vm.runInContext(source.slice(source.indexOf("document.getElementById('layout_save').onclick = async"),source.indexOf('function currentLayoutData()')),context);
  await context.closeLayout();assert.equal(hidden,false);assert.equal(cleared,0);
  const saving=els.get('layout_save').onclick();assert.equal(modal.inert,true);
  await els.get('layout_save').onclick();await context.closeLayout();assert.equal(calls,1);assert.equal(hidden,false);
  pending.reject(Error('网络中断'));await saving;assert.equal(modal.inert,false);assert.equal(context.layoutSaving,false);assert.equal(cleared,0);
  accept=true;await context.closeLayout();assert.equal(hidden,true);assert.equal(cleared,1);assert.equal(refreshed,1);
});

test('库存翻页沿用查询条件与版本，409提示重新查询，重新查询重置到第一页',async()=>{
  const requests=[],buttons=[];
  const fields={searchInput:{value:'轴承'},searchScope:{value:'room'},filter_source:{value:'ERP'}};
  const msg={textContent:'',prepend(button){this.dismiss=button;},replaceChildren(){this.textContent='';buttons.length=0;},append(value){if(typeof value==='object')buttons.push(value);else this.textContent+=value;}};
  const context=vm.createContext({URLSearchParams,currentRoomCode:'WH-1',locateByLoc(){},fetch(url){const d=deferred();requests.push({url,...d});return d.promise;},document:{getElementById(id){return id==='searchMsg'?msg:fields[id] || {value:''};},createElement(){return {};}}});
  vm.runInContext(source.slice(source.indexOf('let inventorySearchVersion'),source.indexOf('\nif(IS_INTEGRATION)',source.indexOf('let inventorySearchVersion'))),context);
  const first=context.searchExternalInventory('轴承');
  requests[0].resolve({ok:true,json:async()=>({total:51,page:1,pages:2,revision:'v1',rows:[]})});await first;
  assert.equal(buttons[0].disabled,true);
  const next=buttons[1].onclick();
  const params=new URL(requests[1].url,'http://test').searchParams;
  assert.equal(params.get('room'),'WH-1');assert.equal(params.get('source'),'ERP');assert.equal(params.get('revision'),'v1');assert.equal(params.get('page'),'2');
  requests[1].resolve({ok:false,status:409});await next;
  assert.match(msg.textContent,/库存已更新/);
  const retry=buttons.at(-1).onclick();
  const retryParams=new URL(requests[2].url,'http://test').searchParams;
  assert.equal(retryParams.get('page'),'1');assert.equal(retryParams.has('revision'),false);
  requests[2].resolve({ok:true,json:async()=>({total:0,page:1,pages:1,rows:[]})});await retry;
});


test('布局复制及删除仅修改草稿，取消删除保留状态，新增不改源规格',async()=>{
  const original={code:'A',label:'货架',x:0,z:0,rot:0,w:1,h:2,d:0.5,rows:2,cols:2,merges:{L01:[[1,2]]},cellNames:{'L01-B01':'轴承'}};
  let confirmed=false,dirty=0,selectionEvents=0;
  const context=vm.createContext({structuredClone,Event,window:{dispatchEvent(event){assert.equal(event.type,'layout-object-selected');selectionEvents++;}},spatialRandomUUID:()=> 'test',layoutState:{room:{width:12,depth:8},furniture:[structuredClone(original)]},layoutSel:'A',layoutReplacePending:false,
    computeClonePositions:()=>[{x:2,z:1}],markDirty(){dirty++;},renderLayout(){},renderList(){},layoutMsg(){},appConfirm:async()=>confirmed});
  vm.runInContext(source.slice(source.indexOf('function appendDraftRack('),source.indexOf('// 加载当前房间布局到 layoutState')),context);
  context.layoutState.furniture[0].svg={onclick(){}}; // 实际渲染节点不能被 structuredClone
  context.appendDraftRack(context.layoutState.furniture[0]);
  assert.equal(context.layoutState.furniture.length,2);
  const copy=context.layoutState.furniture[1];
  assert.equal(copy.code,'draft-test');assert.equal(copy.x,2);
  copy.cellNames['L01-B01']='改副本';assert.equal(context.layoutState.furniture[0].cellNames['L01-B01'],'轴承');
  assert.equal(dirty,1);
  assert.equal(selectionEvents,1,'复制后需通知属性面板切换到新货架');
  await context.removeDraftRack('A');assert.equal(context.layoutState.furniture.length,2);
  confirmed=true;await context.removeDraftRack('A');
  assert.equal(context.layoutState.furniture.length,1);assert.equal(context.layoutReplacePending,true);assert.equal(dirty,2);
});


test('3D位置草稿：失败可重试，提交保留门窗方向，取消无需网络并恢复初始坐标',async()=>{
  const layout={room:{width:12,depth:8,door:[{side:'back',offset:0.5,flip:true}]},furniture:[{code:'A',x:0,z:0,rot:0,w:1,d:1}]};
  let accepted=false,calls=0,loaded=0,payload;
  const message={textContent:''},buttons=[{},{}];
  const context=vm.createContext({structuredClone,positionSaving:false,positionStarting:false,positionOriginal:structuredClone(layout),openingOriginal:[],drag3dMode:true,drag3d:null,currentRoomCode:'WH-1',layoutState:structuredClone(layout),sceneFurniture:[{code:'A',x:2,z:1,rot:0}],
    positionBar:{querySelector:()=>message,querySelectorAll:()=>buttons},roomGroup:{userData:{width:12,depth:8,openings:[{type:'door',side:'left',offset:0.3,flip:true}]}},
    placementError:()=>'',fetch:async(url,options)=>{calls++;payload=JSON.parse(options.body);return {ok:accepted,json:async()=>({error:'模拟失败'})};},
    setDrag3dMode:on=>{context.drag3dMode=on;},clearDirty(){},applyTransform(){},placeOpening(){},loadScene:async()=>{loaded++;},toast(){}});
  vm.runInContext(source.slice(source.indexOf('function positionMessage('),source.indexOf("positionBar.querySelector('#positionSave').onclick")),context);
  context.layoutState.furniture[0].x=2;
  const firstSave=context.savePositionEdit();await context.savePositionEdit();await firstSave;assert.equal(calls,1);assert.match(message.textContent,/草稿已保留/);assert.equal(context.drag3dMode,true);assert.equal(loaded,0);assert.equal(buttons[0].disabled,false);
  accepted=true;await context.savePositionEdit();assert.equal(calls,2);assert.equal(payload.furniture[0].x,2);assert.equal(payload.room.door[0].flip,true);assert.equal(loaded,1);assert.equal(context.drag3dMode,false);
  context.drag3dMode=true;context.positionOriginal=structuredClone(layout);context.layoutState=structuredClone(layout);
  context.cancelPositionEdit();assert.equal(calls,2);assert.equal(context.sceneFurniture[0].x,0);assert.equal(context.sceneFurniture[0].z,0);assert.equal(context.drag3dMode,false);
});


test('静止场景停止绘制，变化和阻尼恢复渲染，飞行动画最后一帧不丢失',()=>{
  let draws=0,labels=0,moving=false;
  const context=vm.createContext({sceneRenderDirty:true,tween:null,scene:{},camera:{position:{lerpVectors(){}}},
    controls:{target:{lerpVectors(){}},update:()=>moving},easeInOut:x=>x,
    document:{hidden:false,addEventListener(){}},requestSceneRender(){context.sceneRenderDirty=true;},
    requestAnimationFrame(){},THREE:{Clock:class{getDelta(){return 0.1;}}},
    renderer:{render(){draws++;}},updateCellLabels(){labels++;}});
  vm.runInContext(source.slice(source.indexOf('const clock = new THREE.Clock();'),source.indexOf('// ---- 登录交互绑定 ----')),context);
  assert.equal(draws,1);
  for(let i=0;i<120;i++)context.animate();
  assert.equal(draws,1);assert.equal(labels,1);
  context.sceneRenderDirty=true;context.animate();assert.equal(draws,2);
  moving=true;context.animate();context.animate();assert.equal(draws,4);
  moving=false;context.animate();assert.equal(draws,4);
  context.tween={t:0,dur:0.2};context.animate();context.animate();
  assert.equal(context.tween,null);assert.equal(draws,6);
  context.animate();assert.equal(draws,6);
  context.document.hidden=true;context.sceneRenderDirty=true;context.animate();assert.equal(draws,6);
  context.document.hidden=false;context.animate();assert.equal(draws,7);assert.equal(labels,7);
});

test('切换库区清除旧定位提示，并丢弃旧库区晚到的查询结果和错误',async()=>{
  const requests=[];
  const msg={textContent:'已定位：WH-2-F1-L04-B03',prepend(button){this.dismiss=button;},replaceChildren(){this.textContent='';}};
  const context=vm.createContext({URLSearchParams,currentRoomCode:'WH-2',fetch(){const d=deferred();requests.push(d);return d.promise;},document:{createElement(){return {};},getElementById(id){return id==='searchMsg'?msg:{value:''};}}});
  vm.runInContext(source.slice(source.indexOf('let inventorySearchVersion'),source.indexOf('\nif(IS_INTEGRATION)',source.indexOf('let inventorySearchVersion'))),context);
  context.clearSearchFeedback();assert.equal(msg.textContent,'');
  const old=context.searchExternalInventory('旧库区');
  context.clearSearchFeedback();
  requests[0].resolve({ok:true,json:async()=>({total:0,page:1,pages:1,rows:[]})});await old;
  assert.equal(msg.textContent,'');
  const failed=context.searchExternalInventory('旧错误');
  context.clearSearchFeedback();msg.textContent='已定位：WH-1-A-L01-B01';
  requests[1].reject(Error('迟到的错误'));await failed;
  assert.equal(msg.textContent,'已定位：WH-1-A-L01-B01');
});


test('出入库通知按同源实例隔离，刷新中再有操作不丢最终刷新，失败不报成功',async()=>{
  const events={},messages=[];let timer,calls=0;
  const pending=deferred();
  const context=vm.createContext({URL,clearTimeout(){},setTimeout(fn){timer=fn;return 1;},toast:m=>messages.push(m),window:{location:{href:'http://localhost:28088/warehouse-standalone/apps/web/prototype/index.html',origin:'http://localhost:28088'},addEventListener:(type,fn)=>events[type]=fn,SPATIAL_REFRESH_VIEW:async()=>{calls++;if(calls===1)await pending.promise;}}});
  vm.runInContext(source.slice(source.indexOf('const counterAppPath ='),source.indexOf('function openOverview()')),context);
  const data={type:'counter-updated',appPath:'/warehouse-standalone/apps/web/prototype/'};
  events.message({origin:'http://unrelated.test',data});assert.equal(timer,undefined);
  events.message({origin:'http://localhost:28088',data:{...data,appPath:'/warehouse/apps/web/prototype/'}});assert.equal(timer,undefined);
  events.storage({key:'spatial_counter_dirty:/warehouse/apps/web/prototype/'});assert.equal(timer,undefined);
  events.message({origin:'http://localhost:28088',data});
  const first=timer();assert.equal(calls,1);
  events.storage({key:'spatial_counter_dirty:'+data.appPath});await timer();assert.equal(calls,1);
  pending.resolve();await first;assert.equal(calls,2);
  context.window.SPATIAL_REFRESH_VIEW=async()=>{throw Error('请先保存或关闭布局');};
  messages.length=0;context.refreshAfterCounter();await timer();assert.equal(messages.length,1);assert.match(messages[0],/尚未刷新.*布局/);
});
