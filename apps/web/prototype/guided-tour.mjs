import {mountContextHints} from './context-hints.mjs';
// 引导只观察真实界面状态，不发送业务写入，也不替用户保存或放弃草稿。
export const ROUTES = {
  inventory: [
    {id:'room', title:'选择要查看的库区', target:'#locPickerBtn', action:'使用此库区并继续', body:'点击高亮入口选择仓库和库区。也可以直接使用当前库区。', result:'顶部库区名称与场景一致后，确认使用该库区。'},
    {id:'search', title:'查找一条库存', target:'#topbar .tb-group:has(#searchInput)', body:'输入已有物料名称、SKU、批次或格位编码，再点击放大镜搜索按钮。不确定关键词时，可留空查询。', result:'出现可以点击的库存结果。无结果时调整关键词或筛选；空库区可跳过此步。'},
    {id:'locate', title:'点击结果，定位格位', target:'#searchMsg .inventory-hit, #searchMsg a[data-loc]', body:'点击一条搜索结果。其他库区的结果会先切换库区，再定位。', result:'出现「已定位」提示，右侧显示该格位的库存。'},
    {id:'details', title:'读懂库存详情', target:'#sidebar', action:'已了解', body:'核对数量与单位、批次和状态。再查看来源及更新时间；同步失败或超时意味着当前展示可能不是最新库存。', result:'本应用展示库存，正式出入库仍由 ERP/WMS 办理。完成后可从左侧「引导」重新学习。'}
  ],
  space: [
    {id:'layout', title:'打开布局编辑器', target:'#layoutBtn', body:'点击左侧「布局编辑」。这里维护货架和门窗的空间结构。', result:'看到平面画布、货架列表和属性区。'},
    {id:'rack', title:'确认要调整的货架', target:'#furnSelPanel', action:'确认所选货架', body:'在画布或货架列表中选择一架，核对属性区中的名称与编码。', result:'画布选中标记与右侧货架名称对应；可确认当前已选中的货架。'},
    {id:'draft', title:'修改并查看草稿', target:'#fp_body', body:'例如修改货架宽度，离开输入框后自动更新草稿；也可以在画布中移动货架。', result:'有效修改后显示未保存状态。可以撤销；不想试改时直接跳过。'},
    {id:'close', title:'决定保存还是放弃', target:'#layout_close', body:'查看后点击「关闭」；有未保存改动时，按需要保存或放弃草稿。', result:'编辑器关闭后继续。引导不会自动点击保存，也不会替你处理已有草稿。'},
    {id:'cells', title:'进入格位管理', target:'#spaceManageBtn', body:'点击「格位管理」，按货架、层或关键词筛选，再选择需要维护的格位。', result:'看到格位名称、状态、容量、承重和照片入口。'},
    {id:'finish', title:'区分空间属性与库存', target:'#spaceTitle', action:'已了解', body:'格位属性需点击保存才生效；添加照片按页面说明立即保存。容量、承重与空间标记不等于 ERP 的出入库控制。', result:'空间维护路线完成。本路线不要求提交格位属性或上传照片。'}
  ]
};


// 首次使用先部署空间，查询单独通过样板演示和日常路线学习。
ROUTES.setup = [
  {id:'setupWarehouse',title:'设置仓库与库区',target:'#locPickerBtn',action:'使用当前仓库与尺寸',open:'#locPickerBtn',openLabel:'设置仓库',body:'选择或新建仓库、库区，在「库区设置」填写长宽。',result:'场景显示库区范围，面积按长 × 宽计算。'},
  {id:'setupLayout',title:'打开布局编辑',target:'#layoutBtn',body:'点击高亮的「布局编辑」，开始摆放第一个货架。',walk:true,auto:true},
  {id:'setupAdd',title:'添加一个存放位置',target:'#layoutAddMenu',body:'打开「＋ 添加」，选择「货架」或「地面存放区」。门和窗也从这里添加。',walk:true,auto:true},
  {id:'setupType',title:'选择放什么',target:'#furn_type',body:'在「类型」中选择货架；货物堆在地上时，选择最下方的「地面区」。',walk:true,form:true},
  {id:'setupSize',title:'填写名称与实际尺寸',target:'#furn_name, #lbl_w, #lbl_h, #lbl_d',body:'给它起个名称，再填写宽、高、深，单位是米。地面区只需宽和深。',walk:true,form:true},
  {id:'setupGrid',title:'划分存放格位',target:'#lbl_rows, #furn_cols',body:'填写层数和每层的列数，例如 3 层 × 4 列就是 12 个格位；地面区按行 × 列划分。',walk:true,form:true},
  {id:'setupGenerate',title:'生成到画布',target:'#furn_save',body:'点击「生成」，将刚填写的货架或地面区加入草稿。',walk:true,form:true,auto:true},
  {id:'setupPlace',title:'拖到实际摆放位置',target:'#layoutSvg',body:'按住画布中选中的货架或存放区拖动，松开后点「位置已确认」。参考左下角比例尺判断距离，给通道留出空间。',walk:true},
  {id:'setupSave',title:'保存你的布局',target:'#layout_save',body:'位置确认后点击「保存布局」。保存成功才会生成正式格位。',walk:true,auto:true},
  {id:'setupStock',title:'添加库存',target:'#integrationAdminLink',open:'#integrationAdminLink',openLabel:'查看接入配置',body:'由管理员在数据接入中连接 ERP/WMS，并配置库位映射。',result:'同步成功后，格位显示对应货品和数量。',detail:'当前使用外部库存模式，数量由 ERP/WMS 维护。没有接口时可以稍后继续，或联系管理员启用独立库存部署。填写格位 SKU 仅建立归位关系，不会增加库存。'},
];

export function recommendedRoute(state, canEdit, canOperate=false) {
  // 样板中已有货架不代表首次用户已经理解建仓能力。
  if(canEdit)return 'setup';
  return 'inventory';
}

// 按库存模式生成说明；确认仅表示已阅读，不冒充库存操作成功。
export function routesFor({standalone=false, canOperate=false}={}) {
  const routes=Object.fromEntries(Object.entries(ROUTES).map(([name,steps])=>[name,steps.map(step=>({...step}))]));
  if(!standalone)return routes;
  for(const steps of Object.values(routes))for(const step of steps){
    if(step.id==='search'){step.body='输入已有货品名称、SKU或格位编码，再点击放大镜搜索按钮。请至少填写一个关键词。';step.result='结果逐项显示货品、SKU、数量和单位；点击即可定位。没有库存时可跳过此步。';}
    if(step.id==='details'){step.body='核对当前格位的货品、SKU、数量与单位。数量变化可在右侧「库存流水」查看。';step.result='独立库存由本应用记录；有库存操作权限时，可在右侧入库、出库、移库或盘点。';}
    if(step.id==='finish')step.body='格位属性需点击保存才生效；照片按页面说明立即保存。填写SKU只设置对应关系，不会增加库存数量。';
    if(step.id==='cellsDone')step.result=canOperate?'接下来了解如何录入第一笔库存，再学习查询。':'库存由有操作权限的同事录入；你可继续学习查询，空库可跳过。';
  }
  const stock=routes.setup.find(s=>s.id==='setupStock');
  Object.assign(stock,canOperate ? {
    target:'#addBtn',open:'#addBtn',openLabel:'录入第一件货品',
    body:'点击「入库」，填写货品名称、SKU、数量和格位，核对后保存。',
    result:'保存成功后，格位显示货品和数量。已有库存可直接继续。',
    detail:'当前使用独立库存模式，无需 ERP。以后对接 ERP/WMS 时由管理员配置接入，避免两边同时维护数量。仅填写格位 SKU 不会生成库存。'
  } : {target:'#sidebar',open:null,action:'已了解，完成空间配置',body:'空间已交给仓管人员使用，由有库存操作权限的同事录入货品。',result:'你可以继续维护空间或学习查库存。'});
  return routes;
}

export function stepReady(id, state, entry, signals) {
  switch(id) {
    case 'setupWarehouse': return !!(signals.confirmed && state.site && state.room && state.sceneLoaded && state.roomWidth>0 && state.roomDepth>0 && !state.roomSettingsOpen);
    case 'setupLayout': return !!state.layoutOpen;
    case 'setupAdd': return !!state.furnOpen;
    case 'setupType': return !!(state.furnOpen && state.furnType);
    case 'setupSize': return !!(state.furnOpen && state.furnName && state.furnWidth>0 && state.furnDepth>0 && (state.furnType==='floor'||state.furnHeight>0));
    case 'setupGrid': return !!(state.furnOpen && Number.isInteger(state.furnRows) && state.furnRows>=1 && state.furnRows<=100 && Number.isInteger(state.furnCols) && state.furnCols>=1 && state.furnCols<=100);
    case 'setupGenerate': return !!(!state.furnOpen && state.layoutOpen && state.draftCount>entry.draftCount);
    case 'setupPlace': return !!(state.layoutOpen && state.rack);
    case 'setupSave': return !!(signals.saved && !state.layoutOpen && !state.layoutDirty);
    case 'setupStock': return state.canOperate===false ? !!signals.confirmed : !!(state.itemCount>0);
    case 'setupFind': return !!(state.selected && state.located);
    case 'warehouse': return !!(state.site && signals.confirmed);
    case 'dimensions': return !!(state.sceneLoaded && state.room && state.roomWidth>0 && state.roomDepth>0 && !state.roomSettingsOpen && signals.confirmed);
    case 'cellsDone': return !state.cellsOpen;
    case 'room': return !!(state.sceneLoaded && signals.confirmed);
    case 'search': return !!(signals.searched && (state.searchReady || (state.selected && state.located)) && (state.searchVersion > entry.searchVersion || !state.integration));
    // 用户可能在上一教学步骤中已点击结果；以定位成功状态为准。
    case 'locate': return !!(state.selected && state.located);
    case 'details': case 'finish': return !!(signals.confirmed);
    case 'layout': return !!(state.layoutOpen);
    case 'rack': return !!(state.layoutOpen && !!state.rack && signals.confirmed);
    case 'draft': return !!(state.layoutOpen && state.layoutDirty && signals.edited);
    case 'close': return !!(!state.layoutOpen && !state.layoutDirty);
    case 'cells': return !!(state.cellsOpen);
    default: return !!(false);
  }
}

export function stepFeedback(step,state,entry,signals,ready) {
  if(!ready)return step.action?'完成操作后，请点击确认':'完成后即可继续，也可以稍后再做';
  if(step.id==='setupLayout' && entry.rackCount>0)return '✓ 已有保存的货架布局，可以继续';
  if(step.id==='setupStock' && entry.itemCount>0)return '✓ 当前库区已有库存，可以继续';
  if(['details','finish'].includes(step.id))return '✓ 已了解本步说明，可以继续';
  return '✓ 本步已完成，可以继续';
}

export function tipPosition(target, width, height, viewport) {
  const gap=12, maxX=Math.max(gap,viewport.width-width-gap), maxY=Math.max(gap,viewport.height-height-gap);
  const clamp=(x,a,b)=>Math.max(a,Math.min(x,b));
  if(!target)return {left:maxX,top:maxY};
  const points=[
    {left:target.right+gap,top:target.top}, {left:target.left-width-gap,top:target.top},
    {left:target.left,top:target.bottom+gap}, {left:target.left,top:target.top-height-gap}
  ].map(p=>({left:clamp(p.left,gap,maxX),top:clamp(p.top,gap,maxY)}));
  const overlap=p=>Math.max(0,Math.min(p.left+width,target.right)-Math.max(p.left,target.left))*Math.max(0,Math.min(p.top+height,target.bottom)-Math.max(p.top,target.top));
  return points.sort((a,b)=>overlap(a)-overlap(b))[0];
}

export function mountGuidedTour({readState, canEdit, openHelp,standalone=false, canOperate=()=>false}) {
  let routes=routesFor({standalone,canOperate:canOperate()});
  const allowed=name=>name==='inventory'||(['setup','space'].includes(name)&&canEdit());
  mountContextHints({account:()=>readState().account});
  const choice=document.createElement('dialog');choice.id='guideChoice';
  choice.setAttribute('aria-labelledby','guideWelcomeTitle');
  choice.innerHTML=`<span class="guide-eyebrow">三维仓储协同平台</span><h3 id="guideWelcomeTitle">把仓库变成可视化空间</h3><p id="guideWelcomeText">按现场尺寸搭建库区、摆放货架，再把货品、数量与格位对应起来。</p>
    <ol class="guide-journey"><li>设置空间</li><li>布置存放位置</li><li>关联货品</li></ol>
    <button id="guideStart"><strong>▶ 先看一遍如何建仓</strong><span>50秒自动模拟填写、摆放和查货，无需输入。</span></button>
    <button id="guideUse"><strong>开始配置仓库</strong><span>选择实际库区，按需设置尺寸和货架；操作提示可随时收起。</span></button>
    <p id="guideReadOnly" hidden>空间由管理员搭建。你可以先看演示，了解货品如何查询。</p>
    <details><summary>帮助与操作提示</summary>
      <button id="guideDemo"><strong>▶ 观看查询演示</strong><span>30 秒 · 双排货架样板 · 字幕讲解</span></button>
      <button id="guideResume" hidden><strong>继续上次引导</strong><span id="guideResumeText"></span></button>
      <button data-route="setup"><strong>搭建我的仓库</strong><span>已了解流程，开始配置真实库区和货架</span></button>
      <button data-route="inventory"><strong>查找库存 · 4 步</strong><span>选择库区、搜索、定位、详情</span></button>
      <button data-route="space"><strong>维护空间</strong><span>布局草稿与格位属性</span></button>
    </details>
    <div class="guide-choice-actions"><button id="guideReference">查看帮助</button><button id="guideLater">先浏览平台</button></div>`;
  document.body.append(choice);
  const demo=document.createElement('dialog');demo.id='guideDemoDialog';demo.setAttribute('aria-label','样板查询动画演示');
  demo.innerHTML='<header><strong>如何查询货品 · 样板演示</strong><button type="button">关闭演示</button></header><iframe title="双排货架查询演示"></iframe>';
  document.body.append(demo);
  demo.querySelector('button').onclick=()=>demo.close();
  demo.addEventListener('close',()=>{demo.querySelector('iframe').removeAttribute('src');choose();choice.querySelector('#guideDemo').focus();});
  window.addEventListener('message',e=>{if(e.origin===location.origin&&e.source===demo.querySelector('iframe').contentWindow&&e.data?.type==='warehouse-demo-close')demo.close();});
  choice.querySelector('#guideDemo').onclick=()=>{choice.close();demo.querySelector('iframe').src='./query-demo.html';demo.showModal();};
  const setupDemo=document.createElement('dialog');setupDemo.id='setupDemoDialog';setupDemo.setAttribute('aria-label','仓库搭建模拟演示');
  setupDemo.innerHTML='<header><strong>50秒了解建仓与查货</strong><button type="button">关闭演示</button></header><iframe title="自动建仓与查货演示"></iframe>';
  document.body.append(setupDemo);let returnAfterDemo=true;
  function showSetupDemo(){
    stop();choice.close();returnAfterDemo=true;
    setupDemo.querySelector('iframe').src='./setup-demo.html?'+new URLSearchParams({build:canEdit()?'1':'0'});
    setupDemo.showModal();
  }
  setupDemo.querySelector('button').onclick=()=>setupDemo.close();
  setupDemo.addEventListener('close',()=>{setupDemo.querySelector('iframe').removeAttribute('src');if(returnAfterDemo)choose();});
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==setupDemo.querySelector('iframe').contentWindow||event.data?.type!=='warehouse-setup-demo-action')return;
    const action=event.data.action;
    if(action==='close'){setupDemo.close();return;}
    if(action==='browse'){returnAfterDemo=false;setupDemo.close();return;}
    if(!['setup','inventory'].includes(action)||!allowed(action))return;
    returnAfterDemo=false;setupDemo.close();start(action);
  });
  const tip=document.createElement('section');tip.id='guideCoach';tip.hidden=true;tip.setAttribute('aria-label','新手操作引导');tip.tabIndex=-1;
  tip.innerHTML=`<header><span id="guideProgress"></span><button id="guideExit" type="button" aria-label="退出引导">退出引导</button></header>
    <h3 id="guideHeading"></h3><p id="guideInstruction"></p>
    <b class="guide-label">完成后</b><p id="guideExpected"></p><details id="guideMore" hidden><summary>了解更多</summary><p id="guideMoreText"></p></details><div id="guideStatus" role="status"></div><button id="guideOpen" hidden></button>
    <button id="guideConfirm" class="guide-confirm" hidden></button><footer><button id="guidePrev">上一步</button><button id="guideSkip">跳过此步</button><button id="guidePause">稍后继续</button><button id="guideNext">下一步</button></footer>`;
  document.body.append(tip);
  const outline=document.createElement('div');outline.id='guideOutline';outline.hidden=true;outline.setAttribute('aria-hidden','true');document.body.append(outline);
  const connector=document.createElement('div');connector.id='guideConnector';connector.hidden=true;connector.setAttribute('aria-hidden','true');
  connector.innerHTML='<svg width="100%" height="100%"><defs><marker id="guideArrowHead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#60a5fa"/></marker></defs><path fill="none" stroke="#60a5fa" stroke-width="3" marker-end="url(#guideArrowHead)"/></svg>';document.body.append(connector);
  const prompt=document.createElement('div');prompt.id='guideInvitation';prompt.hidden=true;
  prompt.innerHTML='<span>第一次使用？从建仓库到找到货品，一步一步完成。</span><button id="guideBegin">开始学习</button><button id="guideDismiss" aria-label="关闭新手提示">×</button>';document.body.append(prompt);
  const formHint=document.createElement('div');formHint.id='guideFormHint';formHint.hidden=true;
  formHint.innerHTML='<span>先填名称、数量、单位和格位，核对后保存。取消不会录入库存。</span><button type="button">退出引导</button>';
  document.querySelector('#modal .modal-box h3')?.after(formHint);
  const q=id=>tip.querySelector('#'+id);
  let route=null,index=0,entry={},signals={},timer=null,ready=false,returnFocus=null,lastTarget=null,highlighted=null;
  const storageKey=()=> 'spatial_guide_v5:'+location.pathname+':'+(readState().account||'local');
  function savedProgress(){try{return JSON.parse(localStorage.getItem(storageKey())||'null');}catch{return null;}}
  function remember(done=false){if(!route)return;try{localStorage.setItem(storageKey(),JSON.stringify({route,step:routes[route][index].id,done}));}catch{}}
  const visible=el=>el && el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
  function targetFor(step) {
    if(step.id==='setupWarehouse'){
      if(visible(document.querySelector('#roomModal')))return document.querySelector('#room_name');
      if(visible(document.querySelector('#locPickerModal')))return document.querySelector('#locPickerModal .lp-grid');
    }
    if(step.id==='locate' && stepReady('locate',readState(),entry,signals))return document.querySelector('#sidebar');
    let target=[...document.querySelectorAll(step.target)].find(visible);
    if(!target)target=document.querySelector(step.id==='locate'?'#searchBtn':step.id==='finish'?'#spaceManageBtn':'#layoutBtn');
    return visible(target)?target:null;
  }
  function position() {
    if(!route)return;
    const step=routes[route][index],target=targetFor(step);
    const form=target?.closest('#furnModal .modal-box,#roomModal .modal-box,#locPickerModal .modal-box');
    if(form){if(tip.parentNode!==form)form.querySelector('h3').after(tip);}else if(tip.parentNode!==document.body)document.body.append(tip);
    tip.classList.toggle('guide-inline',!!form);
    if(highlighted!==target){highlighted?.classList.remove('guide-form-target');highlighted=target;}
    target?.classList.toggle('guide-form-target',!!form);
    if(target&&target!==lastTarget){lastTarget=target;target.scrollIntoView({block:'nearest',inline:'nearest'});}
    if(step.id==='setupWarehouse')q('guideInstruction').textContent=readState().roomSettingsOpen?'填写库区名称和宽、深、高，单位为米；核对后点「应用」，回到主界面再继续。':visible(document.querySelector('#locPickerModal'))?'先选仓库和库区；需要修改现场尺寸时点「库区设置」，完成后关闭选择器。':step.body;
    q('guideOpen').disabled=!target||!!target.disabled;
    if(form){outline.hidden=true;connector.hidden=true;return;}
    let r=target?.getBoundingClientRect();
    if(step.form){const rects=[...document.querySelectorAll(step.target)].filter(visible).map(el=>el.getBoundingClientRect());if(rects.length){const left=Math.min(...rects.map(r=>r.left)),top=Math.min(...rects.map(r=>r.top)),right=Math.max(...rects.map(r=>r.right)),bottom=Math.max(...rects.map(r=>r.bottom));r={left,top,right,bottom,width:right-left,height:bottom-top};}}
    const p=tipPosition(r,tip.offsetWidth,tip.offsetHeight,{width:innerWidth,height:innerHeight});
    tip.style.left=p.left+'px';tip.style.top=p.top+'px';
    outline.hidden=!r;
    if(r)Object.assign(outline.style,{left:Math.max(0,r.left-3)+'px',top:Math.max(0,r.top-3)+'px',width:r.width+6+'px',height:r.height+6+'px'});
    connector.hidden=!r;
    if(r){
      const box=tip.getBoundingClientRect(),dx=(r.left+r.right-box.left-box.right)/2,dy=(r.top+r.bottom-box.top-box.bottom)/2,horizontal=Math.abs(dx)>Math.abs(dy);
      const sx=horizontal?(dx>0?box.right:box.left):(box.left+box.right)/2,sy=horizontal?(box.top+box.bottom)/2:(dy>0?box.bottom:box.top);
      let ex=horizontal?(dx>0?r.left-5:r.right+5):(r.left+r.right)/2,ey=horizontal?(r.top+r.bottom)/2:(dy>0?r.top-5:r.bottom+5);
      // 窄屏中卡片与按钮可能仅隔几像素，改指按钮上下边，避免箭头藏进卡片边框。
      if(horizontal&&Math.abs(ex-sx)<24){ex=(r.left+r.right)/2;ey=dy>0?r.top-5:r.bottom+5;}
      connector.querySelector('svg > path').setAttribute('d',`M ${sx} ${sy} L ${ex} ${ey}`);
    }
  }
  function tick() {
    if(!route)return;
    if(!allowed(route)){stop();return;}
    const step=routes[route][index],state=readState();
    // 取消子窗口回到添加入口；关闭编辑器回到打开步骤，绝不把放弃草稿算作保存。
    if(step.walk && step.id!=='setupLayout' && !state.layoutOpen && !(step.id==='setupSave'&&signals.saved)){index=routes[route].findIndex(s=>s.id==='setupLayout');show();return;}
    if(step.form && !state.furnOpen && !(step.id==='setupGenerate'&&state.draftCount>entry.draftCount)){index=routes[route].findIndex(s=>s.id==='setupAdd');show();return;}
    ready=stepReady(step.id,state,entry,signals);
    q('guideNext').disabled=!ready;q('guideNext').hidden=!!step.action||(!!step.auto&&!signals.review);
    const message=stepFeedback(step,state,entry,signals,ready);
    if(q('guideStatus').textContent!==message)q('guideStatus').textContent=message;
    const confirm=q('guideConfirm');
    confirm.disabled=(step.id==='setupWarehouse'&&(!state.sceneLoaded||!state.site||!state.room||state.roomWidth<=0||state.roomDepth<=0||state.roomSettingsOpen||visible(document.querySelector('#locPickerModal'))))||(step.id==='warehouse'&&!state.site)||(step.id==='dimensions'&&(!state.sceneLoaded||!state.room||state.roomWidth<=0||state.roomDepth<=0||state.roomSettingsOpen))||(step.id==='room'&&!state.sceneLoaded)||(step.id==='rack'&&(!state.layoutOpen||!state.rack));
    // 业务确认框优先显示，引导不遮挡保存/放弃选择。
    // 教学目标所在的布局/设置表单保留提示，只有确认框和其它业务窗口暂停引导。
    const confirming=[...document.querySelectorAll('#confirmModal,#inputModal,#modal')].some(visible)||!!document.querySelector('dialog.work-dialog[open]:not(.assistant-window),.modal [role="dialog"][aria-label="出入库台"]');
    formHint.hidden=!(step.id==='setupStock' && visible(document.querySelector('#modal')));
    tip.hidden=confirming;outline.hidden=confirming;connector.hidden=confirming;
    if(!confirming)position();
    if(step.auto && ready && !confirming && !signals.review)move();
  }
  function show(review=false) {
    const step=routes[route][index];entry=readState();signals={review};ready=false;lastTarget=null;remember();
    tip.classList.toggle('guide-walk',!!step.walk);
    q('guideProgress').textContent=route==='setup'?(step.id==='setupWarehouse'?'设置空间 · 阶段 1 / 3':step.id==='setupStock'?'关联货品 · 阶段 3 / 3':`布置存放位置 · ${index} / 8`):(route==='inventory'?'查找库存':'维护空间')+` · 第 ${index+1} / ${routes[route].length} 步`;
    q('guideHeading').textContent=step.title;q('guideInstruction').textContent=step.body;q('guideExpected').textContent=step.result||'';
    q('guideConfirm').hidden=!step.action;q('guideConfirm').textContent=step.action||'';
    q('guideMore').hidden=!step.detail;q('guideMore').open=false;q('guideMoreText').textContent=step.detail||'';
    q('guideOpen').hidden=!step.open;q('guideOpen').textContent=step.openLabel||'打开';
    q('guidePrev').disabled=index===0;q('guideNext').textContent=index===routes[route].length-1?'完成':'下一步';
    if(step.walk)q('guideNext').textContent=step.id==='setupPlace'?'位置已确认':'填好了，继续';
    q('guideSkip').hidden=!!step.walk && !(step.id==='setupLayout'&&entry.rackCount>0&&!entry.layoutOpen);
    q('guideSkip').textContent=step.walk?'已有布局，跳过摆放':'跳过此步';
    // 引导目标所在菜单组可能已收起，先展开再定位高亮。
    const menuTarget=document.querySelector(step.target);
    if(menuTarget?.closest('#leftToolbar') && !document.getElementById('leftToolbar').classList.contains('lt-open'))document.getElementById('ltToggle').click();
    const initialization=menuTarget?.closest('.lt-initialization');if(initialization)initialization.open=true;
    const menuGroup=menuTarget?.closest('.lt-group.is-collapsed');
    menuGroup?.querySelector('.lt-group-toggle')?.click();
    targetFor(step)?.scrollIntoView({block:'nearest',inline:'nearest'});tip.hidden=false;tick();
  }
  function start(name,stepId=null) {
    if(name==='setup'){
      if(!canEdit())return;
      stop();choice.close();document.getElementById('locPickerBtn')?.click();return;
    }
    if(!routes[name]||!allowed(name))return;
    choice.close();route=name;index=Math.max(0,routes[name].findIndex(s=>s.id===stepId));clearInterval(timer);show();timer=setInterval(tick,250);tip.focus({preventScroll:true});
  }
  function stop() {formHint.hidden=true;remember();route=null;clearInterval(timer);timer=null;tip.hidden=true;outline.hidden=true;connector.hidden=true;highlighted?.classList.remove('guide-form-target');highlighted=null;if(visible(returnFocus))returnFocus.focus({preventScroll:true});}
  function move(skip=false) {
    if(!route||(!skip&&!ready))return;
    if(index===routes[route].length-1){const completed=route;remember(true);route=null;stop();prompt.hidden=true;if(completed==='setup')choose();return;}index++;show();
  }
  function choose() {
    stop();returnFocus=document.activeElement;prompt.hidden=true;
    routes=routesFor({standalone,canOperate:canOperate()});
    choice.querySelector('[data-route="space"]').hidden=!canEdit();
    choice.querySelector('[data-route="setup"]').hidden=!canEdit();
    choice.querySelector('#guideReadOnly').hidden=canEdit()||canOperate();
    choice.querySelector('#guideReadOnly').textContent='空间由管理员维护，你可以直接查找货品和查看库存。';
    const startButton=choice.querySelector('#guideStart');
    choice.querySelector('#guideWelcomeTitle').textContent='把仓库变成可视化空间';
    choice.querySelectorAll('.guide-journey li').forEach((li,i)=>li.textContent=['设置空间','摆放货架','关联货品'][i]);
    startButton.onclick=showSetupDemo;
    const use=choice.querySelector('#guideUse');use.hidden=!canEdit();use.onclick=()=>start('setup');
    const saved=savedProgress(),resume=choice.querySelector('#guideResume');
    resume.hidden=!(saved&&!saved.done&&saved.route!=='setup'&&routes[saved.route]?.some(s=>s.id===saved.step)&&allowed(saved.route));
    if(!resume.hidden){choice.querySelector('#guideResumeText').textContent=routes[saved.route].find(s=>s.id===saved.step).title;resume.onclick=()=>start(saved.route,saved.step);}
    if(!choice.open)choice.showModal();
  }
  choice.querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>start(b.dataset.route));
  choice.querySelector('#guideLater').onclick=()=>choice.close();
  choice.querySelector('#guideReference').onclick=()=>{choice.close();openHelp();};
  formHint.querySelector('button').onclick=stop;
  q('guidePause').onclick=stop;
  q('guideOpen').onclick=()=>{remember();const selector=routes[route][index].open;const button=selector&&document.querySelector(selector);if(visible(button))button.click();};
  q('guideExit').onclick=stop;q('guideNext').onclick=()=>move();q('guideSkip').onclick=()=>{if(route==='setup'&&routes[route][index].id==='setupLayout'){index=routes.setup.findIndex(s=>s.id==='setupStock');show();}else move(true);};
  window.addEventListener('spatial-layout-saved',()=>{if(route==='setup'&&routes[route][index].id==='setupSave'){signals.saved=true;tick();}});
  q('guidePrev').onclick=()=>{if(index>0){index--;show(true);}};
  q('guideConfirm').onclick=()=>{signals.confirmed=true;tick();if(route && ready)move();};
  document.addEventListener('click',e=>{
    if(!route||tip.contains(e.target))return;
    const step=routes[route][index];
    if(e.target.closest('#searchBtn'))signals.searched=true;
    if(e.target.closest('#fp_saveBtn,#layoutSvg,#layoutList'))signals.edited=true;
  },true);
  document.addEventListener('keydown',e=>{
    if(!route)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();stop();return;}
    if(e.key==='Enter'&&e.target.id==='searchInput')signals.searched=true;
    if(e.target.closest('#layoutSvg,#layoutList'))signals.edited=true;
  });
  document.addEventListener('pointerdown',e=>{if(route&&e.target.closest('#layoutSvg'))signals.edited=true;},true);
  document.addEventListener('change',e=>{if(route&&e.target.closest('#fp_body'))signals.edited=true;},true);
  window.addEventListener('pagehide',stop);
  prompt.querySelector('#guideBegin').onclick=choose;prompt.querySelector('#guideDismiss').onclick=()=>{prompt.hidden=true;};
  return {choose,stop,offer(){
    if(!readState().sceneLoaded||route||choice.open)return;
    try {if(localStorage.getItem(storageKey()+':overview-seen'))return;localStorage.setItem(storageKey()+':overview-seen','1');}catch{}
    choose();
  }};
}
