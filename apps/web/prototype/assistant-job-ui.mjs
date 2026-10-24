import {formatBusinessTime} from './business-time.mjs';
const el=(tag,text,className)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;};
const kinds={in:'入库',out:'出库',move:'移库'};
const button=(text,click)=>{const node=el('button',text);node.type='button';node.onclick=click;return node;};
function field(parent,title,value='',type='text'){
  const label=el('label',title),node=el(type==='select'?'select':'input');label.htmlFor=node.id='job-'+window.spatialRandomUUID();
  if(type!=='select'){node.type=type;node.value=value??'';if(type==='number'){node.min='0';node.step='any';}}
  parent.append(label,node);return node;
}
function options(node,rows,selected=''){
  const blank=el('option','请选择');blank.value='';node.append(blank);
  for(const [value,title] of rows){const option=el('option',title);option.value=value;node.append(option);}
  node.value=selected;
}
export function renderAssistantJob(host,job,actions){
  const {api,run,locate,onContext,onList}=actions;
  host.replaceChildren(el('strong',job.title),el('p',job.handoff?`${job.total} 项已发布为团队任务 · 此处保留原单`:`已完成 ${job.completed} / ${job.total} 项 · 未完成项目保存在当前账号下`,'work-hint'));
  const toolbar=el('div',null,'work-actions');host.append(toolbar);
  let busy=false,dirtyRow='';actions.onDirty?.(false);
  const perform=(fn,saving='')=>run(async()=>{
    if(busy)return;if(dirtyRow&&dirtyRow!==saving)throw Error('请先保存当前作业项的填写，再切换或刷新清单。');
    busy=true;actions.onBusy?.(true);const controls=[...host.querySelectorAll('button,input,select')].map(node=>[node,node.disabled]);controls.forEach(([node])=>node.disabled=true);
    try{await fn();}finally{busy=false;actions.onBusy?.(false);for(const [node,disabled] of controls)if(node.isConnected)node.disabled=disabled;}
  });
  const show=(next,selectedId)=>renderAssistantJob(host,next,{...actions,selectedId});
  toolbar.append(button('刷新清单',()=>perform(async()=>show(await api('/'+job.id),actions.selectedId))),button('清单列表',()=>perform(onList)));
  if(job.document){const source=el('details',null,'assistant-document-source');source.append(el('summary',`单据来源：${job.document.source.name}`));for(const [key,label] of [['document_no','单号'],['department','部门'],['recipient','领用人'],['purpose','用途']])if(job.document.business[key])source.append(el('p',`${label}：${job.document.business[key]}`));const original=el('pre',job.document.source.text||job.rows.map(row=>row.source?.raw||'').join('\n'));source.append(original);host.append(source);}
  if(job.handoff){
    onContext(job.id,'');host.append(el('p','此清单已发布为团队任务，后续办理与回执请在该任务中查看。','work-receipt'));
    if(actions.openTeam)host.append(button('打开团队任务',()=>perform(()=>actions.openTeam(job.handoff.task_id))));
    for(const [index,row] of job.rows.entries())host.append(el('p',`${index+1}. ${row.input.query||row.input.name||'货品'} · ${row.input.qty} ${row.input.unit}`));return;
  }
  toolbar.append(button('添加一项',()=>perform(async()=>{const next=await api('/'+job.id+'/rows/new',{revision:job.revision,input:{operation:'in'}},'PUT');show(next,next.rows.at(-1).id);})));
  const discard=button('放弃填写并刷新',()=>perform(async()=>show(await api('/'+job.id),dirtyRow),dirtyRow));discard.hidden=true;toolbar.append(discard);
  const selected=job.rows.find(r=>r.id===actions.selectedId&&r.state!=='done')||job.rows.find(r=>r.state!=='done');
  onContext(job.id,selected?.id||'');
  if(actions.members&&job.completed===0){
    const area=el('details',null,'assistant-document-handoff'),form=el('div');area.append(el('summary','发布为团队任务'),form);host.append(area);
    form.append(el('p',job.can_handoff?'核对整单后发布，系统只预占库存，领取并办理后才会扣账。':'请先完成下方每项的核对，再发布团队任务。','work-hint'));
    const title=field(form,'任务名称',job.title),assignee=field(form,'接收人','','select');options(assignee,[]);assignee.firstChild.textContent='不指定，放入待领取任务';
    let loaded=false;area.addEventListener('toggle',()=>{if(area.open&&!loaded)perform(async()=>{const users=await actions.members();assignee.replaceChildren();options(assignee,users.map(user=>[user.id,user.name||user.username]));assignee.firstChild.textContent='不指定，放入待领取任务';loaded=true;});});
    const businessBox=el('details');businessBox.append(el('summary','单据信息与领用信息'));form.append(businessBox);
    const business={};for(const [key,label] of [['document_no','业务单号'],['department','部门'],['recipient','领用人'],['purpose','用途']])business[key]=field(businessBox,label,job.document?.business[key]||'');
    const check=el('label',null,'assistant-source-ack'),confirmed=el('input');confirmed.type='checkbox';check.append(confirmed,el('span','已核对整单，确认发布并预占库存'));form.append(check);
    form.addEventListener('input',()=>{dirtyRow='handoff';discard.hidden=false;actions.onDirty?.(true);});
    const key=window.spatialRandomUUID(),publish=button('确认发布团队任务',()=>perform(async()=>{if(!confirmed.checked)throw Error('请核对整单并勾选确认发布');await api('/'+job.id+'/handoff',{revision:job.revision,confirmed:true,title:title.value,assignee_id:assignee.value||null,business:Object.fromEntries(Object.entries(business).map(([key,node])=>[key,node.value.trim()])),request_id:key},'POST');show(await api('/'+job.id));},'handoff'));
    publish.classList.add('primary');publish.disabled=!job.can_handoff;form.append(publish);
  }
  for(const [index,row] of job.rows.entries()){
    const d=row.state==='done'?row.receipt:row.preview.draft;
    const name=d?.name||row.input.name||row.input.query||'待选货品',amount=d?.operation_qty??row.input.qty;
    const box=el('details',null,'assistant-job-row'),summary=el('summary',`${index+1}. ${kinds[row.input.operation]} · ${name} · ${amount??'待填数量'} ${row.input.unit||''} · ${row.state==='done'?'已完成':row.canConfirm?'待确认':'待核对'}`);
    box.dataset.rowId=row.id;box.append(summary);host.append(box);
    if(row.state==='done'){
      box.append(el('p',`${row.receipt.from_loc||'外部'} → ${row.receipt.to_loc||'外部'}`),el('small',`已记账 ${formatBusinessTime(row.receipt.confirmed_at)} · 本项不会重复办理`));continue;
    }
    box.open=row.id===selected?.id;
    box.addEventListener('toggle',()=>{if(box.isConnected&&box.open){if(dirtyRow&&dirtyRow!==row.id){box.open=false;run(()=>{throw Error('请先保存当前作业项的填写。');});return;}for(const other of host.querySelectorAll('.assistant-job-row'))if(other!==box)other.open=false;onContext(job.id,row.id);}});
    box.addEventListener('focusin',()=>onContext(job.id,row.id));
    let acknowledged;
    if(row.source){
      const original=el('div',null,'assistant-document-source');original.append(el('small',`单据第${row.source.line}行`),el('pre',row.source.raw));
      if(row.source.issues.length){original.append(el('p',row.source.issues.join('；'),'work-message'));const label=el('label',null,'assistant-source-ack');acknowledged=el('input');acknowledged.type='checkbox';acknowledged.checked=!!row.source.reviewed;label.append(acknowledged,el('span','已对照原文核对货品、数量与单位'));original.append(label);}
      box.append(original);
    }
    const editor=el('details',null,'assistant-job-edit'),form=el('div',null,'assistant-job-fields');editor.append(el('summary','修改本项'),form);editor.open=!row.canConfirm;box.append(editor);
    const operation=field(form,'办理业务','','select');options(operation,Object.entries(kinds),row.input.operation);
    const query=field(form,'货品名称 / SKU',row.input.query||d?.name||''),quantity=field(form,'本次办理数量',row.input.qty??'','number'),unit=field(form,'库存单位',row.input.unit||'');
    const source=field(form,'选择具体货品和来源','','select'),choices=row.preview.choices;
    const selectedSource=choices.findIndex(c=>c.item_id===row.input.item_id&&(row.input.operation==='in'||c.loc_code===row.input.from_loc));
    options(source,choices.map((c,i)=>[String(i),`${c.name} · ${c.sku||'未编号'}${c.loc_code?' · '+c.loc_code:''}${c.qty!=null?' · '+c.qty+' '+c.unit:''}`]),selectedSource>=0?String(selectedSource):choices.length===1?'0':'');
    const from=field(form,'来源格位 / 货架',row.input.from_hint||row.input.from_loc||'');
    const target=field(form,'目标格位 / 货架',row.input.to_hint||row.input.to_loc||'');
    const destination=field(form,'选择具体目标格位','','select');
    options(destination,job.locations.map(c=>[c.loc_code,`${c.loc_code} · ${c.room_name}`]),row.input.to_loc||'');
    const newLabel=el('label',null,'assistant-job-new'),newItem=el('input');newItem.type='checkbox';newItem.checked=!!row.input.new_item;
    newLabel.append(newItem,el('span','登记新货品'));form.append(newLabel);
    const newFields=el('div');form.append(newFields);
    const newName=field(newFields,'新货品名称',row.input.name||row.input.query||''),newSku=field(newFields,'新货品SKU（可留空）',row.input.sku||'');
    function visibility(){from.hidden=from.previousElementSibling.hidden=operation.value==='in';for(const node of [target,destination])node.hidden=node.previousElementSibling.hidden=operation.value==='out';newLabel.hidden=operation.value!=='in';newFields.hidden=!newItem.checked||operation.value!=='in';}
    visibility();operation.onchange=()=>{source.value='';visibility();};newItem.onchange=()=>{if(newItem.checked&&!newName.value)newName.value=query.value;visibility();};
    query.oninput=()=>{source.value='';};from.oninput=()=>{source.value='';};target.oninput=()=>{destination.value='';};
    source.onchange=()=>{const chosen=choices[Number(source.value)];if(source.value!==''&&chosen){unit.value=chosen.unit;if(chosen.loc_code)from.value=chosen.loc_code;}};
    function read(){
      const chosen=source.value!==''?choices[Number(source.value)]:null,newGoods=operation.value==='in'&&newItem.checked;
      return {operation:operation.value,query:newGoods?newSku.value.trim()||newName.value.trim():query.value.trim(),qty:quantity.value.trim()===''?null:Number(quantity.value),unit:unit.value.trim(),
        ...(chosen&&!newGoods?{item_id:chosen.item_id,...(operation.value!=='in'?{from_loc:chosen.loc_code}:{})}:{from_hint:from.value.trim()}),
        to_hint:destination.value||target.value.trim(),...(newGoods?{new_item:true,name:newName.value.trim(),sku:newSku.value.trim()}:{})};
    }
    const message=el('p',row.reviewMessage||(row.canConfirm?'核对本次数量和位置，确认后才会记账。':row.preview.message),'work-message'),buttons=el('div',null,'work-actions');box.append(message,buttons);
    const save=button('保存并更新预览',()=>perform(async()=>show(await api('/'+job.id+'/rows/'+row.id,{revision:job.revision,input:read(),source_reviewed:acknowledged?.checked},'PUT'),row.id),row.id));
    save.hidden=!editor.open;editor.addEventListener('toggle',()=>{save.hidden=!editor.open;});
    const confirm=button('确认'+kinds[row.input.operation],()=>perform(async()=>{
      confirm.disabled=true;
      try{const next=await api('/'+job.id+'/rows/'+row.id+'/confirm',{revision:job.revision,confirmed:true},'POST');show(next);}
      catch(error){confirm.disabled=false;throw error;}
    }));confirm.classList.add('primary');confirm.disabled=!row.canConfirm;
    form.addEventListener('input',()=>{dirtyRow=row.id;discard.hidden=false;actions.onDirty?.(true);confirm.disabled=true;message.textContent='填写已修改，请先保存并更新预览；尚未改变库存。';});
    if(acknowledged)acknowledged.onchange=()=>{dirtyRow=row.id;discard.hidden=false;actions.onDirty?.(true);confirm.disabled=true;editor.open=true;save.hidden=false;};
    form.addEventListener('change',()=>{confirm.disabled=true;});
    if(row.canConfirm){const preview=el('div',null,'work-receipt');preview.append(el('strong',`本次${kinds[d.operation]} ${d.qty} ${d.unit}`),el('p',`${d.from_loc||'外部'} → ${d.to_loc||'外部'}`));box.insertBefore(preview,buttons);}
    buttons.append(save,confirm);
    const loc=d?.operation==='out'?d.from_loc:d?.to_loc;
    if(loc)buttons.append(button('3D定位',()=>perform(()=>locate(loc))));
  }
  host.scrollIntoView({block:'start'});
}

export function renderAssistantJobList(host,rows,{open,create,importDocument,run}){
  host.replaceChildren(el('strong','我的作业清单'),el('p','按当前账号和库区保存，可继续未完成的项目。','work-hint'));
  host.append(button('新建作业清单',()=>run(create)));
  if(importDocument)host.append(button('导入整张单据',()=>run(importDocument)));
  if(!rows.length)host.append(el('p','当前库区还没有作业清单。'));
  for(const row of rows){const line=el('div',null,'work-row');line.append(el('strong',row.title),el('small',`${row.handoff?'已发布团队任务':`已完成 ${row.completed} / ${row.total} 项`} · ${formatBusinessTime(row.updated_at)}`),button(row.handoff?'查看团队任务':row.completed===row.total?'查看回执':'继续办理',()=>run(()=>open(row.id))));host.append(line);}
  host.scrollIntoView({block:'start'});
}
