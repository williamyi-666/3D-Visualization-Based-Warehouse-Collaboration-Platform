import {workApi,pendingWork,sendWork,retryWork,setWorkUser} from './work-request.mjs';
import {renderWorkTasks} from './work-tasks-ui.mjs';
import {createFieldDrafts} from './field-drafts.mjs';

const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(text,action,primary=false)=>{const b=el('button',text,primary?'primary':'');b.type='button';b.onclick=action;return b;};
const uid=()=>window.spatialRandomUUID();
function field(parent,label,value,type='text') {
  const box=el('div'),id='work-'+uid(),input=el('input');input.id=id;input.type=type;input.value=value??'';
  const title=el('label',label);title.htmlFor=id;box.append(title,input);parent.append(box);return input;
}
function select(parent,label,choices) {
  const box=el('div'),id='work-'+uid(),input=el('select');input.id=id;
  for(const [value,name] of choices){const option=el('option',name);option.value=value;input.append(option);}
  const title=el('label',label);title.htmlFor=id;box.append(title,input);parent.append(box);return input;
}
export function ensureWorkStyles() {
  if(!document.querySelector('link[data-warehouse-work]')){const link=el('link');link.rel='stylesheet';link.href=new URL('./warehouse-work.css',import.meta.url);link.dataset.warehouseWork='';document.head.append(link);}
}
function dialog(title,{floating=false,onRestore,launcher:externalLauncher,onMinimize}={}) {
  ensureWorkStyles();
  const root=el('dialog',undefined,'work-dialog'),head=el('div',undefined,'work-head'),body=el('div',undefined,'work-body'),message=el('p','','work-message');
  root.setAttribute('aria-label',title);
  const controls=el('div',undefined,'work-window-controls');
  head.append(el('h2',title),controls);controls.append(button('关闭',()=>root.close()));body.append(message);root.append(head,body);document.body.append(root);
  let launcher,drag,keepInView=()=>{};
  const restore=()=>{root.hidden=false;if(launcher)launcher.hidden=true;keepInView();root.querySelector('textarea')?.focus();};
  const minimize=()=>{root.hidden=true;launcher.hidden=false;onMinimize?.();launcher.focus();};
  if(floating){
    root.classList.add('assistant-window');
    const small=button('−',minimize);small.title='最小化智能助手';small.setAttribute('aria-label',small.title);controls.prepend(small);
    const close=controls.lastElementChild;close.textContent='×';close.title='关闭智能助手';close.setAttribute('aria-label',close.title);
    launcher=externalLauncher||button('✦ 智能助手',()=>onRestore?onRestore():restore());launcher.className='assistant-launcher';launcher.hidden=true;
    if(!externalLauncher){launcher.setAttribute('aria-label','恢复智能助手');document.body.append(launcher);}
    // 非模态窗口保留场景操作；手机用底部面板，不拦截手指滚动。
    root.show();
    const smallScreen=window.matchMedia('(max-width:600px)');
    keepInView=()=>{
      if(smallScreen.matches){root.style.left='';root.style.top='';root.style.right='';root.style.bottom='';return;}
      if(!root.style.left||root.hidden)return;
      const box=root.getBoundingClientRect();root.style.left=Math.max(8,Math.min(box.left,innerWidth-box.width-8))+'px';root.style.top=Math.max(8,Math.min(box.top,innerHeight-box.height-8))+'px';
    };
    head.addEventListener('pointerdown',event=>{
      if(smallScreen.matches||event.button!==0||event.target.closest('button'))return;
      const box=root.getBoundingClientRect();drag={x:event.clientX,y:event.clientY,left:box.left,top:box.top};head.setPointerCapture(event.pointerId);head.classList.add('dragging');event.preventDefault();
    });
    head.addEventListener('pointermove',event=>{
      if(!drag)return;
      const box=root.getBoundingClientRect();root.style.left=Math.max(8,Math.min(drag.left+event.clientX-drag.x,innerWidth-box.width-8))+'px';root.style.top=Math.max(8,Math.min(drag.top+event.clientY-drag.y,innerHeight-box.height-8))+'px';root.style.right='auto';root.style.bottom='auto';
    });
    const endDrag=()=>{drag=null;head.classList.remove('dragging');};
    head.addEventListener('pointerup',endDrag);head.addEventListener('pointercancel',endDrag);
    root.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();minimize();}});
    window.addEventListener('resize',keepInView);
    root.addEventListener('close',()=>{if(!externalLauncher)launcher.remove();window.removeEventListener('resize',keepInView);},{once:true});
  }else root.showModal();
  root.addEventListener('close',()=>root.remove(),{once:true});
  const run=async fn=>{message.textContent='';try{await fn();}catch(error){message.textContent=error.message;}};
  return {root,body,message,run,restore,minimize};
}
export {dialog as createWorkDialog};
export {drawPlan as drawQuickBuildPreview};
async function recovery(panel,onChanged) {
  const pending=pendingWork();if(!pending)return;
  const banner=el('div',undefined,'work-recovery');banner.append(el('p','上次操作结果尚未确认：'+(pending.path.includes('opening')?'首次建账':'快速建仓')));
  banner.append(button('核对上次操作',()=>panel.run(async()=>{await retryWork();banner.replaceChildren(el('p','已确认结果，不会重复记账。请关闭后重新打开。'));await onChanged();})));panel.body.append(banner);
}
function drawPlan(svg,plan) {
  svg.replaceChildren();const ns='http://www.w3.org/2000/svg',w=plan.room.width,d=plan.room.depth;
  svg.setAttribute('viewBox',`${-w/2-0.4} ${-d/2-0.4} ${w+0.8} ${d+0.8}`);
  const rect=(f,fill,stroke)=>{const r=document.createElementNS(ns,'rect');for(const [key,val] of Object.entries({x:f.x-f.w/2,y:f.z-f.d/2,width:f.w,height:f.d,fill,stroke,'stroke-width':0.04}))r.setAttribute(key,String(val));if(f.rot)r.setAttribute('transform',`rotate(${-f.rot*180/Math.PI} ${f.x} ${f.z})`);svg.append(r);};
  rect({x:0,z:0,w,d},'#0d192b','#6883a5');for(const f of plan.existing)rect(f,'#344257','#8495ac');for(const f of plan.furniture)rect(f,plan.problems.length?'#92522c':'#2257a4',plan.problems.length?'#fbbf24':'#79b4ff');
}
export function createWarehouseWorkUI({getRoom,onChanged=async()=>{},openLayout,openLabels,openCount,openCounter,openJob,locate,openTeam,confirm:confirmOpening}) {
  async function identity(){const data=await workApi('/api/auth/me');setWorkUser(data.user.id);return data;}
  async function quickBuild(initial={}) {
    const who=await identity();if(!['admin','spaceAdmin'].includes(who.user.role))throw Error('快速建仓需要空间管理员权限');
    const panel=dialog('快速建仓'),{body,run}=panel;await recovery(panel,onChanged);
    body.append(el('p','选择模板、预览摆放，一次生成货架和格位。生成后可以调整位置。','work-hint'));
    const grid=el('div',undefined,'work-grid');body.append(grid);
    const rooms=await workApi('/api/rooms'),room=select(grid,'目标库区',rooms.map(r=>[r.loc_code,r.name+' · '+r.loc_code]));room.value=initial.roomCode||getRoom()||room.value;
    const templates=await workApi('/api/setup/templates'),template=select(grid,'存放模板',templates.map(t=>[t.id,t.name]));
    const name=field(grid,'货架名称前缀','轻型货架'),count=field(grid,'数量',4,'number'),perRow=field(grid,'每排数量',2,'number');
    const width=field(grid,'宽（米）',1.2,'number'),height=field(grid,'高（米）',1.8,'number'),depth=field(grid,'深（米）',0.5,'number'),rows=field(grid,'层数',4,'number'),cols=field(grid,'每层格位数',3,'number'),aisle=field(grid,'排间通道（米）',1.2,'number'),gap=field(grid,'相邻间距（米）',0.3,'number');
    const extras=el('details'),extraGrid=el('div',undefined,'work-grid');extras.append(el('summary','调整起始位置 / 新建空库区'),extraGrid);body.append(extras);
    const startX=field(extraGrid,'起始 X（留空自动居中）','','number'),startZ=field(extraGrid,'起始 Z（留空自动居中）','','number');
    const newName=field(extraGrid,'新库区名称','新库区'),roomWidth=field(extraGrid,'库区宽（米）',12,'number'),roomDepth=field(extraGrid,'库区深（米）',8,'number');
    extraGrid.append(button('新建空库区',()=>run(async()=>{
      const site=room.value.split('-').slice(0,-1).join('-'),w=Number(roomWidth.value),d=Number(roomDepth.value);if(!(w>0&&d>0))throw Error('请填写正数库区尺寸');
      const result=await workApi('/api/rooms',{name:newName.value,siteCode:site,w,d,h:4},'POST');
      const option=el('option',result.name+' · '+result.loc_code);option.value=result.loc_code;room.append(option);room.value=result.loc_code;invalidate();
    })));
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('work-preview');svg.setAttribute('aria-label','摆放预览，蓝色为新增，灰色为已有');body.append(svg);
    const summary=el('p','先预览摆放方案。','work-hint'),actions=el('div',undefined,'work-actions');body.append(summary,actions);
    let preview;
    const input=()=>({roomCode:room.value,template:template.value,name:name.value,count:Number(count.value),perRow:Number(perRow.value),w:Number(width.value),h:Number(height.value),d:Number(depth.value),rows:Number(rows.value),cols:Number(cols.value),aisle:Number(aisle.value),gap:Number(gap.value),...(startX.value!==''?{startX:Number(startX.value)}:{}),...(startZ.value!==''?{startZ:Number(startZ.value)}:{})});
    const save=button('确认生成',()=>run(async()=>{
      if(!preview)return;save.disabled=true;
      try {
        const result=await sendWork('/api/setup/racks',{...input(),revision:preview.revision});
        summary.textContent=`已生成 ${result.created.length} 个货架 / ${result.cellCount} 个格位`;svg.remove();grid.hidden=true;extras.hidden=true;actions.replaceChildren();
        if(openLayout)actions.append(button('调整摆放',()=>{panel.root.close();openLayout();}));
        if(openLabels)actions.append(button('打印格位标签',()=>{panel.root.close();openLabels();}));
        if(who.mode!=='integration')actions.append(button('开始建立底账',()=>{panel.root.close();opening(result.roomCode);},true));
        await onChanged(result.roomCode);
      }finally{save.disabled=false;}
    }),true);save.disabled=true;
    const invalidate=()=>{preview=null;save.disabled=true;summary.textContent='参数已修改，请重新预览。';svg.replaceChildren();};
    for(const f of [...grid.querySelectorAll('input,select'),startX,startZ])f.addEventListener('input',invalidate);
    template.onchange=()=>{const t=templates.find(t=>t.id===template.value);name.value=t.name;for(const [f,k] of [[width,'w'],[height,'h'],[depth,'d'],[rows,'rows'],[cols,'cols']])f.value=t[k];height.disabled=t.type==='floor';invalidate();};
    const previewPlan=async()=>{const values=input(),params=new URLSearchParams(values);params.set('room',values.roomCode);const result=await workApi('/api/setup/preview?'+params);if(JSON.stringify(values)!==JSON.stringify(input()))return;preview=result;drawPlan(svg,preview);summary.textContent=preview.problems.length?preview.problems.join('；'):`${preview.count} 个货架，${preview.cellCount} 个格位 · 蓝色新增 / 灰色已有 · 确认后写入`;save.disabled=!!preview.problems.length;};
    actions.append(button('预览摆放',()=>run(previewPlan)),save);
    if(initial.template){
      template.value=initial.template;template.onchange();
      for(const [f,key] of [[name,'name'],[count,'count'],[perRow,'perRow'],[width,'w'],[height,'h'],[depth,'d'],[rows,'rows'],[cols,'cols'],[aisle,'aisle'],[gap,'gap'],[startX,'startX'],[startZ,'startZ']])if(initial[key]!=null)f.value=initial[key];
      body.prepend(el('p','助手已带入预览参数，请按实际尺寸和通道核对后确认。','work-hint'));await run(previewPlan);
    }
  }
  async function opening(roomCode=getRoom(),preferred='',initial={}) {
    const who=await identity();if(who.mode==='integration'||!['admin','operator'].includes(who.user.role))throw Error('首次建账需要独立库存操作权限');
    const panel=dialog('首次建账 · 按格位登记'),{body,run}=panel;await recovery(panel,onChanged);
    body.append(el('p','填写现场实盘数量。没有SKU会生成临时编号；空格位直接确认空位。','work-hint'));
    let progress=await workApi('/api/work/progress?room='+encodeURIComponent(roomCode)),catalogue=await workApi('/api/work/catalogue?room='+encodeURIComponent(roomCode)),snapshot;
    const roomIdentity=(await workApi('/api/rooms')).find(room=>room.loc_code===roomCode);
    if(!roomIdentity)throw Error('当前库区已不存在，请重新选择');
    const drafts=createFieldDrafts({userId:who.user.id,roomId:roomIdentity.id,kind:'opening'});
    let loading=false,staleDraft=false;
    let initialRow=initial.row;if(initialRow?.item_id&&!catalogue.some(i=>i.item_id===initialRow.item_id))catalogue.push(initialRow);
    const progressText=el('p',undefined,'work-hint'),chooser=el('div',undefined,'work-grid');body.append(progressText,chooser);
    const stateName={counting:'核对中',reviewing:'待管理员复核',verified:'已核对',unverified:'未核对'};
    const location=select(chooser,'当前格位',progress.rows.map(c=>[c.loc_code,c.loc_code+' · '+stateName[c.status]]));if(preferred&&progress.rows.some(c=>c.loc_code===preferred))location.value=preferred;else location.value=drafts.list().find(d=>progress.rows.some(c=>c.loc_code===d.id&&c.node_id===d.node_id&&!c.completed&&c.status!=='reviewing'))?.id||progress.rows.find(c=>!c.completed&&c.status!=='reviewing')?.loc_code||location.value;
    const manual=field(chooser,'扫描枪 / 手动输入格位','');manual.placeholder='输入完整格位码后回车';
    const list=el('div'),info=el('p','','work-message'),actions=el('div',undefined,'work-actions');body.append(info,list,actions);
    const add=button('＋ 登记货品',()=>{addRow();persist();}),confirm=button('核对并建立底账',()=>run(async()=>{
      const rows=readRows();if(!rows.length)throw Error('请登记货品，或点击“确认空位”');await finish(rows);
    }),true),empty=button('确认空位',()=>run(async()=>{if(readRows().length)throw Error('已填写货品，请清空后再确认空位');await finish([]);}));
    const photoInput=el('input');photoInput.type='file';photoInput.accept='image/jpeg,image/png,image/webp';photoInput.setAttribute('capture','environment');photoInput.hidden=true;photoInput.setAttribute('aria-label','拍摄或选择货品标签');
    const photo=button('拍标签辅助填写',()=>photoInput.click());actions.append(add,photo,empty,confirm,photoInput);
    photoInput.onchange=()=>run(async()=>{
      const file=photoInput.files[0];photoInput.value='';if(!file)return;if(file.size>5*1024*1024)throw Error('请拍摄或选择5MB以内的标签照片');
      photo.disabled=true;
      try{
        const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('照片读取失败'));reader.readAsDataURL(file);});
        const result=await workApi('/api/assistant/media/recognize',{kind:'photo',data,room:roomCode},'POST');if(!panel.root.isConnected)return;
        const review=el('div',undefined,'work-recovery'),fields=result.fields||{};
        review.append(el('strong','请核对标签识别结果'),el('p',result.text),el('small','识别内容仅辅助填写；实盘数量请按现场核对。'));
        review.append(button('填入一行，再核对数量',()=>{addRow({name:fields.name||'',sku:fields.sku||'',unit:fields.unit||'件',qty:fields.qty??''});persist();review.remove();}));info.append(review);
      }finally{photo.disabled=!!snapshot?.completed||!!snapshot?.items.length;}
    });
    function addRow(value={}) {
      const box=el('div',undefined,'work-row'),choices=el('div'),fields=el('div',undefined,'work-grid');box.append(choices,fields);list.append(box);
      const existing=select(choices,'选择已有货品（或下方填新货品）',[['','新货品'],...catalogue.map(i=>[i.item_id,`${i.name} · ${i.sku||'未编号'}`])]);
      const name=field(fields,'货品名称','','text'),qty=field(fields,'实盘数量','','number'),unit=field(fields,'单位','件'),sku=field(fields,'SKU（无编号可留空）','');qty.min='0';qty.step='any';
      existing.onchange=()=>{const item=catalogue.find(i=>i.item_id===existing.value);if(item){name.value=item.name;unit.value=item.unit||'件';sku.value=item.sku||'';}name.readOnly=unit.readOnly=sku.readOnly=!!item;};
      for(const [f,key] of [[name,'name'],[qty,'qty'],[unit,'unit'],[sku,'sku']])if(value[key]!=null)f.value=value[key];
      if(value.item_id){existing.value=value.item_id;existing.onchange();}
      box.read=()=>({item_id:existing.value||undefined,name:name.value.trim(),qty:Number(qty.value),unit:unit.value.trim(),sku:sku.value.trim()});
      const lookup=button('识别所填条码',()=>run(async()=>{
        if(!sku.value.trim())throw Error('请先扫描或填写货品条码');
        const item=await workApi('/api/items/by-code?code='+encodeURIComponent(sku.value.trim()));
        if(!catalogue.some(row=>row.item_id===item.item_id))catalogue.push(item);
        if(![...existing.options].some(option=>option.value===item.item_id)){const option=el('option',`${item.name} · ${item.sku||'未编号'}`);option.value=item.item_id;existing.append(option);}
        existing.value=item.item_id;existing.onchange();persist();
      }));
      sku.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();lookup.click();}};
      box.append(lookup,button('移除此行',()=>{box.remove();persist();}));name.focus();
    }
    const readRows=()=>[...list.children].map(r=>r.read()).filter(r=>r.name||r.sku||r.qty);
    function persist(){if(loading||!snapshot||snapshot.completed||snapshot.items.length)return;try{const rows=readRows();if(rows.length)drafts.save(snapshot.loc_code,{node_id:snapshot.node_id,baseline:staleDraft?drafts.get(snapshot.loc_code)?.baseline:snapshot.baseline,rows});else drafts.remove(snapshot.loc_code);}catch(error){panel.message.textContent=error.message;}}
    list.addEventListener('input',persist);list.addEventListener('change',persist);
    function updateProgress(){progressText.textContent=`已核对 ${progress.completed} / ${progress.total} 个格位 · ${progress.counting||0} 个核对中 · ${progress.rows.filter(cell=>cell.status==='reviewing').length} 个待复核 · 填写自动留草稿，确认后进入下一格`;}updateProgress();
    async function load() {
      loading=true;location.disabled=manual.disabled=true;add.disabled=photo.disabled=empty.disabled=confirm.disabled=true;list.replaceChildren();snapshot=null;
      try{snapshot=await workApi('/api/work/opening?loc_code='+encodeURIComponent(location.value));
      const done=!!snapshot.completed,occupied=snapshot.items.length>0;
      add.disabled=photo.disabled=empty.disabled=confirm.disabled=done||occupied;
      info.replaceChildren();staleDraft=false;
      if(done)info.textContent='此格位已建立底账。数量变化请办理出入库或盘点。';
      else if(occupied){info.append(el('p','此格位已有库存，请通过盘点核对数量。'));if(openCount)info.append(button('盘点此格并继续',()=>{panel.root.close();openCount(location.value,{onClose:()=>opening(roomCode)});}));}
      else{
        const draft=drafts.get(snapshot.loc_code);
        if(draft?.node_id===snapshot.node_id&&draft.rows?.length){for(const row of draft.rows)addRow(row);info.append(el('small','已恢复本机未提交的填写，尚未更新库存。'));
          if(draft.baseline!==snapshot.baseline){staleDraft=true;empty.disabled=confirm.disabled=true;info.append(el('p','填写期间库存或流水有变化，请重新核对实物数量。'),button('已重新核对，继续填写',()=>{staleDraft=false;empty.disabled=confirm.disabled=false;persist();info.replaceChildren(el('p','已按当前库存重新核对，仍需点击确认才会建账。'));}));}
        }else{if(draft)drafts.remove(snapshot.loc_code);addRow(initialRow||{});}initialRow=null;
      }
      }finally{loading=false;location.disabled=manual.disabled=false;}
    }
    let loadedLocation='';
    const changeLocation=async()=>{
      persist();
      await load();loadedLocation=location.value;
    };
    async function finish(rows) {
      if(!snapshot||snapshot.loc_code!==location.value)throw Error('请先加载当前格位');
      if(staleDraft)throw Error('库存有变化，请先重新核对实物数量');
      if(!await confirmOpening(rows.length?`确认 ${location.value} 的期初底账？\n${rows.map(r=>`${r.name}：${r.qty} ${r.unit}`).join('\n')}`:`确认 ${location.value} 是空格位？`))return;
      add.disabled=empty.disabled=confirm.disabled=true;chooser.inert=list.inert=actions.inert=true;
      try {
        const result=await sendWork('/api/work/opening',{loc_code:snapshot.loc_code,baseline:snapshot.baseline,rows});
        drafts.remove(snapshot.loc_code);
        panel.message.textContent=result.rows.map(r=>`${r.name} · ${r.sku} · ${r.qty} ${r.unit}`).join('\n')||'空位已确认';
        progress=await workApi('/api/work/progress?room='+encodeURIComponent(roomCode));catalogue=await workApi('/api/work/catalogue?room='+encodeURIComponent(roomCode));updateProgress();
        for(const option of location.options){const cell=progress.rows.find(c=>c.loc_code===option.value);if(cell)option.textContent=cell.loc_code+' · '+stateName[cell.status];}
        const next=progress.rows.find(c=>!c.completed&&c.status!=='reviewing');
        await onChanged();
        if(next){location.value=next.loc_code;await load();loadedLocation=next.loc_code;panel.message.textContent=`${result.loc_code} 已建账${result.rows.length?'：'+result.rows.map(r=>r.name+' · '+r.sku).join('；'):''}。继续登记 ${next.loc_code}`;}
        else{list.replaceChildren();info.textContent=progress.completed<progress.total?'其余格位已提交盘点复核，请到“我的待办”查看进度。':'当前库区底账已建立。日常存取请使用入库、出库和移库。';}
      }catch(error){add.disabled=empty.disabled=confirm.disabled=false;throw error;}
      finally{chooser.inert=list.inert=actions.inert=false;}
    }
    location.onchange=()=>run(changeLocation);manual.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();run(async()=>{const match=progress.rows.find(c=>c.loc_code===manual.value.trim());if(!match)throw Error('请输入当前库区的完整格位码');location.value=match.loc_code;manual.value='';await changeLocation();});}};
    if(progress.rows.length){await run(load);loadedLocation=location.value;}else info.textContent='库区还没有格位，请先快速建仓。';
  }
  async function tasks() {
    const who=await identity(),room=getRoom(),panel=dialog('我的待办'),{body,run}=panel;
    if(who.mode==='integration'){panel.message.textContent='集成模式请在盘点差异单查看审核、回传任务。';return;}
    const state=await workApi('/api/work/status?room='+encodeURIComponent(room)),result=state.tasks,canOperate=['admin','operator'].includes(who.user.role);
    await recovery(panel,onChanged);
    if(canOperate&&window.CounterWrites)for(const pending of await window.CounterWrites.list()) {
      const row=el('div',undefined,'work-recovery'),input=pending.body;
      row.append(el('strong','出入库结果待确认'),el('small',`${input.name||input.item_id||''} · 数量 ${input.qty??''} · ${input.loc_code||input.from_loc||''}${input.to_loc?' → '+input.to_loc:''}`));
      row.append(button('核对原请求',()=>run(async()=>{const response=await window.CounterWrites.retry(pending.path),receipt=await response.json();if(!response.ok)throw Error(receipt.error||'核对失败');row.replaceChildren(el('p','操作已确认，不会重复记账。'));await onChanged();})));body.append(row);
    }
    const progress=el('p',`当前库区已建账 ${result.progress.completed} / ${result.progress.total} 个格位 · 待办每5秒自动更新`,'work-hint');body.append(progress);
    if(canOperate&&result.progress.completed<result.progress.total)body.append(button('继续首次建账',()=>{panel.root.close();opening(room);}));
    const list=el('section');body.append(list);let revision='';
    const leave=fn=>(...args)=>{panel.root.close();return fn?.(...args);};
    const update=next=>{if(next.room!==room||next.user_id!==who.user.id||!next.enabled||next.revision===revision)return;if(next.role!==who.user.role){panel.root.close();return;}revision=next.revision;const scroll=body.scrollTop;renderWorkTasks(list,next,{canOperate,run,openJob:leave(openJob),openCounter:leave(openCounter),openCount:leave(openCount),locate:leave(locate),openTeam:leave(openTeam)});progress.textContent=`当前库区已建账 ${next.tasks.progress.completed} / ${next.tasks.progress.total} 个格位 · 待办每5秒自动更新`;body.scrollTop=scroll;};
    update(state);
    const updated=event=>update(event.detail),lost=()=>panel.root.close();window.addEventListener('spatial-work-status',updated);window.addEventListener('spatial-auth-required',lost);
    panel.root.addEventListener('close',()=>{window.removeEventListener('spatial-work-status',updated);window.removeEventListener('spatial-auth-required',lost);},{once:true});
    if(who.user.role==='admin') {
      const settings=el('details'),grid=el('div',undefined,'work-grid'),thresholdList=el('div');settings.append(el('summary','设置盘点复核、周期与低库存提醒'),grid,thresholdList);body.append(settings);
      const days=field(grid,'盘点周期（天，0关闭）',result.policy.count_days,'number'),catalogue=await workApi('/api/work/catalogue?room='+encodeURIComponent(room));
      const rule=result.policy.stocktake_review||{mode:'all',qty_limit:null,percent_limit:null};
      const reviewMode=select(grid,'盘点差异复核',[['all','所有差异需管理员复核'],['threshold','超过阈值才复核'],['off','关闭管理员复核']]);reviewMode.value=rule.mode;
      const qtyLimit=field(grid,'单项差异数量阈值（留空不使用）',rule.qty_limit??'','number'),percentLimit=field(grid,'单项差异比例阈值（%，留空不使用）',rule.percent_limit??'','number');qtyLimit.min=percentLimit.min='0';qtyLimit.step=percentLimit.step='any';
      const showRule=()=>{qtyLimit.disabled=percentLimit.disabled=reviewMode.value!=='threshold';};reviewMode.onchange=showRule;showRule();
      settings.append(el('p','数量按各货品的库存单位比较；数量或比例任一项超限即复核。账面为0的新增库存在比例规则下也需复核。已提交的盘点保留提交时规则。','work-hint'));
      function addThreshold(value={}){const row=el('div',undefined,'work-row'),fields=el('div',undefined,'work-grid');row.append(fields);const item=select(fields,'货品',catalogue.map(i=>[i.item_id,i.name+' · '+(i.sku||'未编号')])),minimum=field(fields,'最低库存',value.minimum??1,'number');if(value.item_id)item.value=value.item_id;row.read=()=>({item_id:item.value,minimum:Number(minimum.value)});row.append(button('删除提醒',()=>row.remove()));thresholdList.append(row);}
      for(const t of result.policy.thresholds)addThreshold(t);
      settings.append(button('＋ 添加低库存提醒',()=>addThreshold()),button('保存规则',()=>run(async()=>{await workApi('/api/work/policy',{room,count_days:Number(days.value),thresholds:[...thresholdList.children].map(r=>r.read()),stocktake_review:{mode:reviewMode.value,qty_limit:qtyLimit.value===''?null:Number(qtyLimit.value),percent_limit:percentLimit.value===''?null:Number(percentLimit.value)}},'PUT');panel.root.close();await tasks();}),true));
    }
  }
  return {quickBuild,opening,tasks};
}
