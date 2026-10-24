const output=document.getElementById('result'),frame=document.getElementById('app');
const show=data=>output.textContent=JSON.stringify(data,null,2);
const wait=async(fn,timeout=30000)=>{const start=performance.now();while(!fn()){if(performance.now()-start>timeout)throw Error('等待页面超时');await new Promise(r=>setTimeout(r,100));}};
const doc=()=>frame.contentDocument;
const assert=(value,message)=>{if(!value)throw Error(message);};
async function ready(){await wait(()=>doc()?.getElementById('sidebar')?.textContent.includes('格位') && doc()?.getElementById('userChip')?.textContent.trim());}
async function run(button,fn){button.disabled=true;try{await fn();}catch(e){show({passed:false,error:e.message});}finally{button.disabled=false;}}
document.getElementById('check').onclick=event=>run(event.target,async()=>{
  const identity=await fetch('/api/auth/me').then(r=>r.json());
  const results=[];
  for(const path of ['/api/admin/backup/status','/api/integration/credentials','/api/integration/space-history']) {
    const response=await fetch(path);results.push({path,status:response.status});
  }
  show({user:identity.user?.username,role:identity.user?.role,results,passed:identity.user?.role==='viewer' && results.every(r=>r.status===403)});
});
document.getElementById('flow').onclick=event=>run(event.target,async()=>{
  await ready();const d=doc(),input=d.getElementById('searchInput'),msg=d.getElementById('searchMsg');
  input.value='AUDIT-';d.getElementById('searchBtn').click();
  await wait(()=>msg.textContent.includes('第 1 /'));const first=msg.firstChild.textContent;const ids=[...msg.querySelectorAll('.inventory-hit')].map(x=>x.textContent);
  const all=[...ids];let page=1;
  while(true) {
    const next=[...msg.querySelectorAll('button')].find(b=>b.textContent==='下一页');
    if(!next || next.disabled)break;
    next.click();page++;
    await wait(()=>msg.textContent.includes('第 '+page+' /'));
    const rows=[...msg.querySelectorAll('.inventory-hit')].map(x=>x.textContent);
    assert(rows.length>0 && rows.length<=50 && !rows.some(x=>all.includes(x)),'分页结果重复或数量错误');all.push(...rows);
  }
  const total=Number(first.match(/找到 (\d+) 条/)[1]);assert(all.length===total,'翻页记录有遗漏');
  d.getElementById('clearSearch').click();await wait(()=>input.value==='');
  d.getElementById('helpBtn').click();assert(!d.getElementById('helpModal').classList.contains('hidden'),'帮助未打开');
  const role=d.getElementById('userChip').textContent;const editor=d.querySelector('.editor-help');
  if(role.includes('只读'))assert(frame.contentWindow.getComputedStyle(editor).display==='none','只读用户错误显示编辑帮助');
  d.getElementById('helpClose').click();show({passed:true,first_page:first,first_count:ids.length,total_count:all.length,pages:page,query_clear:true,role_help:true});
});
document.getElementById('capacity').onclick=event=>run(event.target,async()=>{
  const samples=[];
  for(let i=0;i<12;i++) {
    const start=performance.now();frame.src='/apps/web/prototype/index.html?audit='+Date.now();
    await new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));await ready();
    samples.push({elapsed_ms:Math.round(performance.now()-start),heap_bytes:frame.contentWindow.performance.memory?.usedJSHeapSize ?? null});
    show({running:true,completed:i+1,samples});
  }
  const sorted=samples.map(s=>s.elapsed_ms).sort((a,b)=>a-b);
  show({passed:true,user_agent:navigator.userAgent,viewport:{width:frame.clientWidth,height:frame.clientHeight},samples,p95_ms:sorted[Math.ceil(samples.length*.95)-1],memory_note:'Chromium performance.memory估算，非精确进程或GPU内存；页面就绪为场景概览出现'});
});

document.getElementById('refreshes').onclick=event=>run(event.target,async()=>{
  await ready();const samples=[];
  for(let i=0;i<12;i++) {
    const start=performance.now();await frame.contentWindow.SPATIAL_REFRESH_VIEW();
    samples.push({elapsed_ms:Math.round(performance.now()-start),heap_bytes:frame.contentWindow.performance.memory?.usedJSHeapSize ?? null});
    show({running:true,mode:'refresh',completed:i+1,samples});
  }
  const sorted=samples.map(s=>s.elapsed_ms).sort((a,b)=>a-b);
  show({passed:true,mode:'refresh',samples,p95_ms:sorted[Math.ceil(samples.length*.95)-1]});
});

document.getElementById('navigation').onclick=event=>run(event.target,async()=>{
  await ready();const d=doc(),sel=d.getElementById('roomSel'),original=sel.value;
  const target=[...sel.options].find(x=>x.value!==original);assert(target,'至少需要两个库区');
  d.getElementById('locPickerBtn').click();d.querySelector('[data-room="'+target.value+'"]').click();
  await wait(()=>sel.value===target.value && d.getElementById('locBreadcrumb').textContent.includes(target.textContent));
  const other=d.getElementById('sidebar').textContent;
  d.getElementById('locPickerBtn').click();d.querySelector('[data-room="'+original+'"]').click();await wait(()=>sel.value===original);
  frame.style.width='390px';await new Promise(r=>setTimeout(r,300));
  d.getElementById('helpBtn').click();const help=d.querySelector('#helpModal .modal-box').getBoundingClientRect();
  const close=d.getElementById('helpClose').getBoundingClientRect();
  assert(help.left>=0 && help.right<=frame.clientWidth+1,'窄窗口帮助超出视口');
  assert(close.top>=0 && close.bottom<=frame.clientHeight,'关闭按钮不在可见范围');
  const top=d.elementFromPoint(close.left+close.width/2,close.top+close.height/2);
  assert(top===d.getElementById('helpClose') || d.getElementById('helpClose').contains(top),'关闭按钮被遮挡');
  d.getElementById('helpClose').click();show({passed:true,original,target:target.value,other_summary:other,narrow_width:frame.clientWidth,close_visible:true});
});

document.getElementById('race').onclick=event=>run(event.target,async()=>{
  await ready();const d=doc(),w=frame.contentWindow,original=w.fetch;let delayed=false;
  frame.style.width='100%';
  const choose=code=>{if(d.getElementById('locPickerModal').classList.contains('hidden'))d.getElementById('locPickerBtn').click();d.querySelector('[data-site="'+code+'"]').click();};
  try {
    w.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/api/rooms?site=QA')){delayed=true;await new Promise(r=>setTimeout(r,1500));}return response;};
    choose('QA');await wait(()=>delayed);choose('WH');await new Promise(r=>setTimeout(r,2000));
    assert(d.getElementById('siteSel').value==='WH' && d.getElementById('roomSel').value.startsWith('WH-'),'旧仓库响应覆盖最新选择');
  }finally{w.fetch=original;}
  choose('QA');await wait(()=>d.getElementById('siteSel').value==='QA');
  const text=d.getElementById('locBreadcrumb').textContent;
  assert(text.includes('<b>仓库</b>') && text.includes('<b>库区</b>'),'特殊名称没有按原文显示');
  assert(!d.querySelector('#locBreadcrumb b,#lpSiteList b,#lpRoomList b'),'名称被解析成HTML');
  choose('WH');await wait(()=>d.getElementById('siteSel').value==='WH');
  show({passed:true,old_response_ignored:true,special_name_literal:text,html_elements_created:false,method:'真实接口响应在隔离页fetch包装中延迟1500ms，非系统级网络限速'});
});

document.getElementById('adminFlow').onclick=event=>run(event.target,async()=>{
  await ready();let d=doc();assert(d.getElementById('userChip').textContent.includes('管理员'),'本流程需要管理员会话');
  const room=d.getElementById('roomSel').value;
  const layout=()=>fetch('/api/layout?room='+encodeURIComponent(room)).then(r=>r.json());
  const prior=await layout(),beforeAudit=await fetch('/api/integration/space-history').then(r=>r.json());
  const open=async()=>{d.getElementById('layoutBtn').click();await wait(()=>!d.getElementById('layoutModal').classList.contains('hidden') && [...d.querySelectorAll('#layoutModal button')].some(b=>b.textContent==='↻15'));};
  show({running:true,stage:'打开布局'});await open();show({running:true,stage:'旋转草稿'});[...d.querySelectorAll('#layoutModal button')].find(b=>b.textContent==='↻15').click();
  show({running:true,stage:'关闭确认'});d.getElementById('layout_close').click();await wait(()=>!d.getElementById('confirmModal').classList.contains('hidden'));
  d.getElementById('confirmCancel').click();await new Promise(r=>setTimeout(r,100));assert(!d.getElementById('layoutModal').classList.contains('hidden'),'取消确认错误关闭草稿');
  show({running:true,stage:'关闭确认'});d.getElementById('layout_close').click();await wait(()=>!d.getElementById('confirmModal').classList.contains('hidden'));d.getElementById('confirmOk').click();
  await wait(()=>d.getElementById('layoutModal').classList.contains('hidden'));
  assert(JSON.stringify(await layout())===JSON.stringify(prior),'放弃草稿却修改已发布布局');
  show({running:true,stage:'重新打开并保存'});await open();d.getElementById('layout_save').click();await wait(()=>d.getElementById('layoutModal').classList.contains('hidden'));
  const afterAudit=await fetch('/api/integration/space-history').then(r=>r.json());assert(afterAudit[0].id!==beforeAudit[0]?.id && afterAudit[0].action==='saveLayout','未生成保存审计');
  show({running:true,stage:'同步管理'});frame.src='/apps/web/prototype/sync.html';await new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));d=doc();
  await wait(()=>d.getElementById('message').textContent==='平台管理员 · 同步管理');
  assert(d.getElementById('sourceStates').textContent.includes('最近同步失败'),'未显示失败来源');
  const status=await fetch('/api/integration/status').then(r=>r.json());const source=status.sources.find(s=>s.received_at && s.state==='unconfigured');assert(source,'需要未配置周期的旧库存来源');
  const form=d.getElementById('sourcePolicyForm');form.elements.namedItem('source').value=source.source;form.elements.namedItem('expected_interval_minutes').value='1';form.querySelector('button').click();
  await wait(()=>d.getElementById('sourceStates').textContent.includes('更新超时'));
  await wait(()=>!form.querySelector('button').disabled);
  form.elements.namedItem('expected_interval_minutes').value=String(source.expected_interval_minutes);form.querySelector('button').click();await wait(()=>!form.querySelector('button').disabled);
  show({passed:true,cancel_keeps_draft:true,discard_keeps_published_layout:true,save_audit:afterAudit[0].id,failed_source_visible:true,stale_source_visible:true,period_restored:true});
});
