import {formatBusinessTime} from './business-time.mjs';
// 复用主界面的弹窗样式；保存实盘和确认调账分开，关闭不取消盘点单。
export function createStocktakeUI({confirm,onChanged}){
  const element=(tag,text,className)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;};
  const modal=element('div',null,'modal hidden'),box=element('section',null,'modal-box');
  modal.id='stocktakeModal';box.style.width='min(700px,94vw)';box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','格位盘点');modal.append(box);document.body.append(modal);
  const title=element('h3','格位盘点'),content=element('div'),message=element('p',null,'msg'),footer=element('div',null,'actions');
  message.setAttribute('role','status');footer.style.cssText='position:sticky;bottom:-22px;background:var(--surface);padding:12px 0;flex-wrap:wrap';box.append(title,content,message,footer);
  let loc='',canOperate=false,canAdmin=false,userId='',record=null,dirty=false,busy=false,rows=[],reasonInput=null,opener=null,onClose=null,prefill=null;
  const stateName={draft:'进行中',review:'待管理员复核',confirmed:'已确认',cancelled:'已取消'};
  let pageCursors=[''],onSaved=null;
  const api=async(path,method='GET',body)=>{
    let status;
    try{
      const response=await fetch('/api/stocktakes'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      status=response.status;const result=await response.json();
      if(!response.ok)throw Error(result.error||'盘点操作失败');return result;
    }catch(error){error.uncertain=method!=='GET'&&(!status||status>=500||status<300);throw error;}
  };
  async function refreshInventory(){
    const result=record.state==='review'?'已提交管理员复核，库存尚未调整。':record.state==='draft'?'已退回重盘，请按当前账面重新填写实盘数量。':'盘点已确认，库存已更新。';
    try{await onChanged();message.style.color='#86efac';message.textContent=result;}
    catch(error){message.style.color='#fbbf24';message.textContent=result+'视图尚未刷新：'+error.message;}
  }
  function button(parent,label,fn){const b=element('button',label,'toolbtn btn-ghost');b.type='button';b.onclick=()=>run(fn);parent.append(b);return b;}
  async function run(fn){
    if(busy)return;busy=true;message.textContent='';
    const controls=[...box.querySelectorAll('button,input,select,textarea')].map(el=>[el,el.disabled]);controls.forEach(([el])=>el.disabled=true);
    try{await fn();}catch(error){message.textContent=error.message;message.style.color='#fca5a5';}
    finally{busy=false;controls.forEach(([el,disabled])=>{if(el.isConnected)el.disabled=disabled;});}
  }
  const abandon=async()=>!dirty||await confirm('有尚未保存或提交的填写，返回将放弃这些填写。已保存的盘点和复核记录仍会保留。');
  async function close(){if(!await abandon())return;dirty=false;modal.classList.add('hidden');const callback=onClose;onClose=null;callback?.();opener?.focus();}
  async function list(cursors=pageCursors){
    const page=await api('?loc_code='+encodeURIComponent(loc)+'&limit=20&before='+encodeURIComponent(cursors.at(-1)));
    const records=page.records;pageCursors=cursors;record=null;dirty=false;
    content.replaceChildren();footer.replaceChildren();title.textContent='格位盘点 · '+loc;
    content.append(element('p',canOperate?'先保存实盘。需要复核的差异提交管理员，复核通过后才调整库存。':'可查看该格位的盘点历史，当前账号不能修改或调账。','hint'));
    if(canOperate){
      const help=element('details');help.append(element('summary','第一次盘点？查看操作步骤'),element('p','① 新建或打开盘点 → ② 填写每件货品的实际总数（缺货填0）→ ③ 保存实盘、核对差异，再按规则确认或提交复核。','hint'));content.append(help);
    }
    if(canOperate)button(content,page.has_draft?'打开当前盘点':'新建盘点',async()=>{record=await api('','POST',{loc_code:loc});render();});
    if(!records.length)content.append(element('p','暂无盘点记录','muted'));
    for(const entry of records){
      const card=element('div',null,'card');
      const state=stateName[entry.state];
      card.append(element('p',`${state} · ${formatBusinessTime(entry.created_at)}`),element('p',entry.created_by.name,'hint'));
      button(card,'查看盘点',async()=>{record=await api('/'+encodeURIComponent(entry.id));render();});content.append(card);
    }
    if(pageCursors.length>1)button(footer,'上一页',()=>list(pageCursors.slice(0,-1)));
    footer.append(element('span',`第 ${pageCursors.length} 页 · 本页 ${records.length} 条`,'hint'));
    if(page.next_before)button(footer,'下一页',()=>list([...pageCursors,page.next_before]));
    button(footer,'关闭',close);
  }
  function render(){
    dirty=false;rows=[];content.replaceChildren();footer.replaceChildren();
    const editable=canOperate&&record.state==='draft';
    title.textContent='格位盘点 · '+loc;
    content.append(element('p',`${stateName[record.state]} · ${record.updated_by.name}`,'stocktake-state'));
    content.append(element('p',editable?'请逐项填写实盘数量，缺货填0。保存后核对差异，再提交。':record.state==='review'?'实盘已锁定，等待管理员复核；当前库存尚未调整。':'以下为已保存的账面、实盘和差异记录。','hint'));
    if(record.state==='draft'&&record.review?.decision==='returned')content.append(element('p','退回原因：'+record.review.note,'stocktake-return'));
    const metadata=element('details',null,'stocktake-meta');metadata.append(element('summary','盘点信息与复核规则'),element('p','盘点单号：'+record.id),element('p','更新于 '+formatBusinessTime(record.updated_at)));content.append(metadata);
    const rule=record.review_policy;
    if(rule)metadata.append(element('p','复核规则：'+(rule.mode==='all'?'所有有差异的盘点均需管理员复核':rule.mode==='off'?'不要求管理员复核':[['qty_limit','差异数量','（按货品库存单位）'],['percent_limit','差异比例','%']].filter(([key])=>rule[key]!==null).map(([key,text,unit])=>text+'超过 '+rule[key]+unit).join('，任一项触发即复核'))));
    if(record.review){
      metadata.append(element('p',`提交人：${record.review.submitted_by.name} · ${formatBusinessTime(record.review.submitted_at)}`));
      if(record.review.reviewed_by)metadata.append(element('p',`${record.review.decision==='returned'?'退回人':'复核人'}：${record.review.reviewed_by.name} · ${formatBusinessTime(record.review.reviewed_at)}${record.review.note?' · '+record.review.note:''}`));
    }
    if(record.review_requirement?.required)for(const trigger of record.review_requirement.triggers)metadata.append(element('p',`${trigger.name}：${trigger.reasons.join('；')}`));
    const navigation=element('div',null,'stocktake-navigation');navigation.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px';content.append(navigation);
    const lines=new Map(record.baseline.map(item=>[item.item_id,{...item,book_qty:item.qty,qty:null}]));
    for(const item of record.counts)lines.set(item.item_id,item);
    let filled=false;
    if(editable&&prefill){for(const count of prefill.counts||[]){const row=lines.get(count.item_id);if(row){row.qty=count.qty;filled=true;}}if(prefill.reason)record.reason=prefill.reason;prefill=null;}
    const table=element('div');table.style.cssText='display:grid;gap:8px';content.append(table);
    const changed=()=>{dirty=true;confirmButton&&(confirmButton.disabled=true);};
    function addRow(item){
      const card=element('div',null,'card'),label=element('label',`${item.name} · ${item.sku||'未编号'} · ${item.unit||'件'}`),input=element('input'),difference=element('p',null,'hint');
      card.style.cssText='padding:10px 12px;margin:0';label.style.margin='0';difference.style.margin='6px 0 0';
      input.type='number';input.min='0';input.step='any';input.placeholder='填写实盘数量';input.value=item.qty??'';input.disabled=!editable;
      input.setAttribute('aria-label',item.name+' 实盘数量');label.append(input);
      const update=()=>{difference.textContent=input.value===''?`账面 ${item.book_qty} ${item.unit||'件'} · 尚未填写`:`账面 ${item.book_qty} → 实盘 ${input.value} · 差异 ${Number(input.value)-item.book_qty} ${item.unit||'件'}`;};
      input.oninput=()=>{update();changed();};update();card.append(label,difference);table.append(card);rows.push({item,input});
    }
    let confirmButton=null;
    for(const item of lines.values())addRow(item);
    if(filled)dirty=true;
    if(editable){
      const extra=element('details'),summary=element('summary','发现账面外货品');extra.append(summary);
      const select=element('select');select.setAttribute('aria-label','选择账面外货品');select.append(new Option('先加载可用货品',''));extra.append(select);
      button(extra,'加载货品',async()=>{
        const response=await fetch('/api/v1/items');if(!response.ok)throw Error('无法加载货品列表');
        const items=await response.json();select.replaceChildren(new Option('选择已有货品',''));
        for(const item of items)if(!rows.some(row=>row.item.item_id===item.id)){const option=new Option(`${item.name} · ${item.sku||'未编号'} · ${item.unit||'件'}`,item.id);option._item=item;select.append(option);}
      });
      button(extra,'加入实盘',()=>{const item=select.selectedOptions[0]?._item;if(!item)throw Error('请先选择货品');if(rows.some(row=>row.item.item_id===item.id))throw Error('该货品已在实盘列表');addRow({item_id:item.id,name:item.name,sku:item.sku,unit:item.unit,book_qty:0,qty:null});changed();});
      extra.append(element('p','新货品请先录入货品资料；此处只选择已有货品。','hint'));content.append(extra);
    }
    const reasonLabel=element('label','盘点说明 / 调账原因');reasonInput=element('textarea');reasonInput.rows=2;reasonInput.maxLength=500;reasonInput.value=record.reason;reasonInput.disabled=!editable;reasonInput.oninput=changed;reasonLabel.append(reasonInput);content.append(reasonLabel);
    if(editable){
      button(footer,'保存实盘',async()=>{
        const counts=rows.map(({item,input})=>{if(input.value===''||!Number.isFinite(Number(input.value))||Number(input.value)<0)throw Error('请填写全部实盘数量，缺货填0');return {item_id:item.item_id,qty:Number(input.value)};});
        record=await api('/'+record.id,'PUT',{revision:record.revision,counts,reason:reasonInput.value});onSaved?.();onSaved=null;render();message.style.color='#86efac';message.textContent='实盘已保存，库存尚未调整。请核对差异后确认。';
      });
      confirmButton=button(footer,record.review_requirement?.required?'提交管理员复核':'确认调账',async()=>{
        if(dirty)throw Error('请先保存实盘数量');
        if(!await confirm(record.review_requirement?.required?'提交已保存的实盘差异给管理员复核？提交后锁定本次填写，库存尚不调整。':'确认按已保存的实盘数量调整库存？本次差异和原因会记入历史。'))return;
        try{record=await api('/'+record.id+'/finish','POST',{revision:record.revision,action:'confirm'});}
        catch(error){if(error.uncertain)throw Error('调账结果待确认，请点击“重新加载”核对原盘点单，勿重新建单。');throw error;}
        render();await refreshInventory();
      });
      confirmButton.disabled=!record.counts.length&&record.baseline.length>0;
      confirmButton.className='toolbtn btn-primary';
      button(navigation,'取消盘点',async()=>{if(!await confirm('取消这张盘点单？库存不会改变，未保存的填写将放弃。'))return;record=await api('/'+record.id+'/finish','POST',{revision:record.revision,action:'cancel'});render();});
    }
    if(record.state==='review'&&canAdmin){
      const label=element('label','复核说明（退回重盘时必填）'),note=element('textarea');note.rows=2;note.maxLength=500;label.append(note);content.append(label);
      note.oninput=()=>{dirty=true;};
      button(footer,'复核通过并调账',async()=>{
        if(!await confirm('确认已核对实盘差异并调整库存？系统会再次校验账面、预占和格位，复核人及结果会保留。'))return;
        try{record=await api('/'+record.id+'/finish','POST',{revision:record.revision,action:'approve',note:note.value});}
        catch(error){if(error.uncertain)throw Error('复核结果待确认，请重新加载原盘点单核对，勿重新调账。');throw error;}
        render();await refreshInventory();
      }).className='toolbtn btn-primary';
      button(footer,'退回重新盘点',async()=>{
        if(!note.value.trim())throw Error('请填写退回重盘原因');
        if(!await confirm('退回后按当前账面重新清点。本次实盘、差异和退回原因保留在复核记录中。'))return;
        record=await api('/'+record.id+'/finish','POST',{revision:record.revision,action:'return',note:note.value});render();await refreshInventory();
      });
    }
    if(record.state==='review'&&canOperate&&(canAdmin||record.review?.submitted_by.id===userId))button(navigation,'撤回并取消',async()=>{
      if(!await confirm('撤回复核并取消这张盘点单？库存不会改变，已提交记录保留。'))return;
      record=await api('/'+record.id+'/finish','POST',{revision:record.revision,action:'cancel'});render();await onChanged();
    });
    if(record.history?.rows.length){
      const history=element('details'),entries=element('div');history.append(element('summary','提交与复核记录'),entries);content.append(history);let cursor=record.history.next_before;
      const append=events=>{for(const event of events){const card=element('div',null,'card');card.append(element('p',`${{submit:'提交复核',approve:'复核通过',return:'退回重盘',confirm:'确认盘点',cancel:'取消盘点'}[event.action]||event.action} · ${event.actor.name} · ${formatBusinessTime(event.created_at)}`));if(event.details.note)card.append(element('p',event.details.note,'hint'));if(event.details.reason)card.append(element('p','盘点说明：'+event.details.reason,'hint'));for(const line of event.details.counts||[])card.append(element('p',`${line.name}：账面 ${line.book_qty} → 实盘 ${line.qty} ${line.unit||'件'} · 差异 ${line.difference}`,'hint'));entries.append(card);}};
      append(record.history.rows);const more=button(history,'加载更早复核记录',async()=>{const page=await api('/'+record.id+'/events?before='+cursor);append(page.rows);cursor=page.next_before;more.hidden=!cursor;});more.hidden=!cursor;
    }
    button(navigation,'返回盘点列表',async()=>{if(await abandon())await list();});
    button(navigation,'重新加载',async()=>{if(await abandon()){record=await api('/'+record.id);render();if(record.state==='confirmed')await refreshInventory();}});
    button(footer,'关闭',close);
  }
  modal.onclick=event=>{if(event.target===modal)run(close);};
  let statusRevision='';
  window.addEventListener('spatial-work-status',event=>{
    const state=event.detail;if(modal.classList.contains('hidden')||!record||busy||state.user_id!==userId||state.tasks_revision===statusRevision)return;statusRevision=state.tasks_revision;
    if(dirty){message.textContent='盘点待办有更新，当前填写已保留。提交前请重新加载核对。';return;}
    const id=record.id;void run(async()=>{const next=await api('/'+id);if(record?.id!==id||modal.classList.contains('hidden')||dirty)return;
      if(next.revision!==record.revision||JSON.stringify(next.review_policy)!==JSON.stringify(record.review_policy)){
        record=next;render();if(record.state==='confirmed')await refreshInventory();else if(record.state==='draft'&&record.review?.decision==='returned')message.textContent='管理员已退回重盘：'+record.review.note;
      }
    });
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!modal.classList.contains('hidden')&&document.getElementById('confirmModal')?.classList.contains('hidden')){event.stopPropagation();run(close);}},true);
  return {async open(code,access,options={}){
    if(busy)return;
    const identityResponse=await fetch('/api/auth/me');if(!identityResponse.ok)throw Error('请重新登录后盘点');const identity=await identityResponse.json();canAdmin=identity.user.role==='admin';userId=identity.user.id;
    opener=document.activeElement;onClose=options.onClose||null;onSaved=options.onSaved||null;loc=code;canOperate=!!access?.canOperate;pageCursors=[''];prefill=options.prefill||null;
    record=null;dirty=false;content.replaceChildren();footer.replaceChildren();title.textContent='格位盘点 · '+loc;
    button(footer,'关闭',close);modal.classList.remove('hidden');
    await run(async()=>{
      if(options.recordId){record=await api('/'+encodeURIComponent(options.recordId));loc=record.loc_code;render();}
      else if(prefill&&canOperate){record=await api('','POST',{loc_code:loc});render();}
      else await list();
    });
  }};
}
