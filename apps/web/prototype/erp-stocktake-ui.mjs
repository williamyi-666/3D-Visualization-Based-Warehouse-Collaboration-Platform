import {formatBusinessTime} from './business-time.mjs';
export function createErpStocktakeUI(){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;};
 const modal=el('div'),box=el('section');modal.className='modal hidden';box.className='modal-box';box.style.cssText='width:min(700px,94vw);max-height:92vh;overflow:auto';box.setAttribute('role','dialog');box.setAttribute('aria-label','ERP盘点差异');modal.append(box);document.body.append(modal);
 let loc='',rights={},record=null,busy=false,dirty=false,prefill=null;
 const names={draft:'实盘草稿',submitted:'待审核',approved:'已审核，待发送',rejected:'已驳回',cancelled:'已取消',sending:'发送结果待核对',uncertain:'发送结果待核对',waiting_sync:'ERP已受理，等待库存回传',confirmed:'回传已核对'};
 const message=el('p');message.setAttribute('role','status');
 async function api(path='',method='GET',body){const r=await fetch('/api/erp-stocktakes'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'操作失败');return data;}
 async function run(fn){if(busy)return;busy=true;message.textContent='';try{await fn();}catch(e){message.textContent=e.message;}finally{busy=false;}}
 function button(parent,label,fn){const b=el('button',label);b.type='button';b.className='toolbtn';b.onclick=()=>run(fn);parent.append(b);return b;}
 function start(title){box.replaceChildren(el('h3',title),message);}
 async function leave(){return !dirty||window.confirm('有未保存的实盘填写，确定放弃？');}
 async function list(){
   const data=await api('?loc_code='+encodeURIComponent(loc));record=null;dirty=false;start('ERP盘点差异 · '+loc);
   box.append(el('p','实盘提交审核后发送ERP；以ERP回传库存为准。'));
   if(data.simulation)box.append(el('p','当前为模拟ERP联调，不代表已接入企业ERP。'));
   if(!data.configured)box.append(el('p','尚未配置ERP接口，可以保存和审核差异单。'));
   if(rights.canOperate){const source=el('select');source.setAttribute('aria-label','盘点库存来源');for(const s of data.sources)source.append(new Option(s,s));box.append(source);button(box,'新建 / 继续盘点',async()=>{if(!source.value)throw Error('此格位没有外部库存来源');record=await api('','POST',{loc_code:loc,source:source.value});render();});}
   for(const r of data.records){const row=el('div');row.className='card';row.append(el('p',`${names[r.state]} · ${r.source} · ${formatBusinessTime(r.updated_at)}`));button(row,'查看差异单',async()=>{record=await api('/'+r.id);render();});box.append(row);}
   button(box,'关闭',()=>modal.classList.add('hidden'));
 }
 function render(){
   dirty=false;start('ERP盘点差异 · '+record.loc_code);
   if(prefill&&rights.canOperate&&record.state==='draft'){for(const count of prefill.counts||[]){const row=record.baseline.find(r=>r.item_id===count.item_id||r.id===count.item_id);if(row){record.counts=record.counts.filter(c=>c.id!==row.id);record.counts.push({id:row.id,qty:count.qty});dirty=true;}}if(prefill.reason)record.reason=prefill.reason;prefill=null;}
   box.append(el('p',`${names[record.state]} · 来源 ${record.source}`),el('p','单号：'+record.id));
   if(record.last_error)box.append(el('p',record.last_error+'；请核对或重试原单，不要新建请求。'));
   if(record.review_note)box.append(el('p','驳回原因：'+record.review_note));
   if(record.receipt)box.append(el('p',(record.receipt.simulated?'模拟ERP回执：':'ERP回执：')+record.receipt.receipt_id));
   const inputs=[],editable=rights.canOperate&&record.state==='draft';
   for(const row of record.baseline){
     const saved=record.counts.find(c=>c.id===row.id),label=el('label',`${row.name} · ${row.sku} · 账面 ${row.qty} ${row.unit}`),input=el('input'),difference=el('p');
     label.style.cssText='display:block;margin:16px 0';
     if(row.batch_no)label.append(el('small',' · 批次 '+row.batch_no));
     input.type='number';input.min=0;input.step='any';input.value=saved?.qty??'';input.disabled=!editable;input.setAttribute('aria-label',row.name+' 实盘数量');
     difference.setAttribute('aria-live','polite');difference.dataset.stocktakeDifference=row.id;
     const updateDifference=()=>{
       const qty=Number(input.value);
       if(input.value===''||!Number.isFinite(qty)||qty<0){difference.textContent='差异：待填写有效实盘数量';return;}
       const delta=Number((qty-Number(row.qty)).toFixed(8));
       difference.textContent=delta===0?'账实一致':`差异：${delta>0?'盘盈 +':'盘亏 '}${delta} ${row.unit}`;
     };
     input.oninput=()=>{dirty=true;updateDifference();};updateDifference();label.append(input,difference);box.append(label);inputs.push({id:row.id,input});
   }
   const reasonLabel=el('label','盘点原因'),reason=el('textarea');reason.value=record.reason;reason.maxLength=500;reason.disabled=!editable;reason.oninput=()=>dirty=true;reasonLabel.append(reason);box.append(reasonLabel);
   const action=async(action,note)=>{if(dirty)throw Error('请先保存实盘');record=await api('/'+record.id+'/action','POST',{revision:record.revision,action,note});render();};
   if(editable){button(box,'保存实盘',async()=>{const counts=inputs.map(({id,input})=>{if(input.value==='')throw Error('请填写所有实盘数量，缺货填0');return {id,qty:Number(input.value)};});record=await api('/'+record.id,'PUT',{revision:record.revision,counts,reason:reason.value});render();message.textContent='实盘已保存，ERP库存尚未调整。';});button(box,'提交审核',()=>action('submit'));}
   if(rights.canAdmin&&record.state==='submitted'){button(box,'审核通过',()=>action('approve'));button(box,'驳回',()=>{const note=window.prompt('填写驳回原因');if(note!==null)return action('reject',note);});}
   if(rights.canAdmin&&['approved','sending','uncertain'].includes(record.state))button(box,'发送 / 核对原请求',async()=>{if(!window.confirm('确认向ERP提交此差异单？重试会复用原请求编号。'))return;record=await api('/'+record.id+'/send','POST',{revision:record.revision});render();});
   if(rights.canAdmin&&record.state==='waiting_sync')button(box,'核对回传库存',async()=>{record=await api('/'+record.id+'/reconcile','POST',{revision:record.revision});render();if(!record.matched)message.textContent='当前回传库存尚未与实盘一致，请稍后再核对。';});
   if(rights.canOperate&&['draft','submitted','approved'].includes(record.state))button(box,'取消差异单',async()=>{if(await leave()&&window.confirm('确认取消此差异单？')){dirty=false;await action('cancel');}});
   const history=el('details');history.append(el('summary','处理记录'));for(const h of record.history)history.append(el('p',`${formatBusinessTime(h.at)} · ${h.actor.name} · ${names[h.state]}`));box.append(history);
   button(box,'重新加载',async()=>{if(await leave()){record=await api('/'+record.id);render();}});
   button(box,'返回列表',async()=>{if(await leave())await list();});button(box,'关闭',async()=>{if(await leave())modal.classList.add('hidden');});
 }
 return {async open(code,access,options={}){loc=code;rights=access;prefill=options.prefill||null;modal.classList.remove('hidden');start('正在读取ERP盘点…');button(box,'关闭',()=>modal.classList.add('hidden'));await run(async()=>{if(prefill&&rights.canOperate){const info=await api('?loc_code='+encodeURIComponent(loc)),source=info.sources.includes(prefill.source)?prefill.source:info.sources.length===1?info.sources[0]:'';if(source){record=await api('','POST',{loc_code:loc,source});render();}else await list();}else await list();});}};
}
