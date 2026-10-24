import {createWorkDialog} from './warehouse-work-ui.mjs';
import {createFieldDrafts} from './field-drafts.mjs';
import {workApi} from './work-request.mjs';
import {scanFieldCode} from './scan-code-ui.mjs';
import {validateMobileStock} from './mobile-revalidate.mjs';
import {openMobileCountDraft} from './mobile-count-draft.mjs';

const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(text,action)=>{const node=el('button',text);node.type='button';node.onclick=action;return node;};
const label=(parent,text,tag='input')=>{const box=el('label',text),input=el(tag);box.append(input);parent.append(box);return input;};
const names={in:'入库',out:'出库',move:'移库',count:'盘点'};

export function createMobileOperations({getRoom,confirm,onChanged,openCount,read=workApi,isHistorical=()=>false}) {
  async function open(code,mode,{itemCode,draft}={}){
    if(!names[mode])throw Error('请选择入库、出库、移库或盘点');
    const who=await read('/api/auth/me');
    if(who.mode==='integration'||!['admin','operator'].includes(who.user.role))throw Error('当前账号不能办理独立库存作业');
    const roomCode=getRoom(),room=(await read('/api/rooms')).find(row=>row.loc_code===roomCode);
    if(!room)throw Error('请先选择可访问库区');
    let progress=await read('/api/work/progress?room='+encodeURIComponent(roomCode));
    if(!progress.rows.length)throw Error('当前库区还没有格位，请先布置存放位置');
    const store=createFieldDrafts({userId:who.user.id,roomId:room.id,kind:'counter-'+mode}),saved=store.get('current');
    const panel=createWorkDialog('连续'+names[mode]),{root,body,run,message}=panel;root.classList.add('mobile-operation-dialog');
    let busy=false,loading=false,snapshot,chosen,stock=[],catalogue=[],targetSnapshot;
    const validSaved=saved&&progress.rows.some(row=>row.loc_code===saved.loc_code&&row.node_id===saved.node_id)?saved:null;
    body.append(el('p',mode==='count'?'扫描或选择格位，实盘确认后继续下一格。':'选择格位、扫描货品、填数量。确认成功后继续下一笔，未提交填写保留在本机。','work-hint'));
    const recovery=el('div'),form=el('div'),result=el('div');body.append(recovery,form,result);
    const location=label(form,mode==='in'?'存入格位':'当前格位','select');
    for(const cell of progress.rows){const option=el('option',cell.loc_code);option.value=cell.loc_code;location.append(option);}
    location.value=progress.rows.some(row=>row.loc_code===code)?code:validSaved?.loc_code||(mode==='count'?progress.rows.find(row=>!row.completed&&row.status!=='reviewing')?.loc_code:'')||progress.rows[0].loc_code;
    const locationTools=el('div',undefined,'work-actions'),manual=label(locationTools,'格位码');manual.placeholder='完整格位码，回车确认';
    locationTools.append(button('扫描格位码',()=>run(async()=>{const value=await scanFieldCode('扫描格位码');if(value)await selectLocation(value);})));form.append(locationTools);
    async function selectLocation(value){if(!progress.rows.some(row=>row.loc_code===value.trim()))throw Error('请选择当前库区的完整格位码');persistIfReady();location.value=value.trim();if(mode!=='count')await load();manual.value='';}
    function persistIfReady(){if(mode!=='count')persist();}
    manual.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();run(()=>selectLocation(manual.value));}};
    if(mode==='count'){
      const next=button('填写此格实盘',()=>run(async()=>{const loc=location.value;await openMobileCountDraft({code:loc,read,openCount,isHistorical});root.close();}));next.classList.add('primary');body.append(next);return panel;
    }
    const choice=label(form,mode==='in'?'常用货品 / 新货品':'本格位货品','select');
    const scanBox=el('div',undefined,'work-actions'),sku=label(scanBox,'货品条码 / SKU');sku.placeholder='扫码枪输入，或点右侧扫码';sku.autocomplete='off';
    const lookup=button('识别',()=>run(resolveItem)),scanItem=button('扫码',()=>run(async()=>{const value=await scanFieldCode('扫描货品码');if(value){sku.value=value;await resolveItem();}}));
    lookup.setAttribute('aria-label','识别条码');scanItem.setAttribute('aria-label','扫描货品码');scanBox.append(lookup,scanItem);form.append(scanBox);
    const fields=el('div',undefined,'work-grid'),name=label(fields,'货品名称'),unit=label(fields,'库存单位'),qty=label(fields,'本次数量');qty.type='number';qty.min='0';qty.step='any';qty.inputMode='decimal';form.append(fields);
    const available=el('p','','work-hint');form.append(available);
    let target;
    if(mode==='move'){
      target=label(form,'移入格位','select');target.append(el('option','请选择目标格位'));
      target.firstChild.value='';for(const cell of progress.rows){const option=el('option',cell.loc_code);option.value=cell.loc_code;target.append(option);}
      form.append(button('扫描目标格位',()=>run(async()=>{const value=await scanFieldCode('扫描格位码');if(!value)return;if(!progress.rows.some(row=>row.loc_code===value))throw Error('目标格位不在当前库区');target.value=value;targetSnapshot=await read('/api/work/opening?loc_code='+encodeURIComponent(value));persist();})));
      target.onchange=()=>run(async()=>{targetSnapshot=target.value?await read('/api/work/opening?loc_code='+encodeURIComponent(target.value)):null;persist();});
    }
    const business=window.SpatialBusiness.mount(form,{onChange:()=>persist()});
    const keepBox=el('label'),keep=el('input');keep.type='checkbox';keep.checked=mode==='in';keep.style.width='auto';keepBox.append(keep,document.createTextNode(' 保留当前货品，继续办理下一笔'));form.append(keepBox);
    const actions=el('div',undefined,'work-actions'),save=button('确认'+names[mode]+'并继续',()=>run(submit));save.classList.add('primary');
    actions.append(save,button('清空当前填写',()=>run(async()=>{if(!await confirm('清空本机当前填写？已完成的库存作业不受影响。'))return;store.remove('current');choose(null);qty.value='';business.clear();if(target)target.value='';message.textContent='当前填写已清空。';})));body.append(actions);
    function current(){return {loc_code:snapshot?.loc_code||location.value,node_id:snapshot?.node_id,item_id:chosen?.item_id||'',name:name.value.trim(),sku:sku.value.trim(),unit:unit.value.trim(),qty:qty.value,to_loc:target?.value||'',to_node_id:targetSnapshot?.node_id,...business.read()};}
    function persist(){if(loading||!snapshot)return;try{const value=current();if(value.name||value.sku||value.qty||value.to_loc||Object.keys(business.read()).length){store.save('current',value);if(isHistorical())message.textContent='已保存本机草稿，尚未提交，库存未更新。联网后请重新核对并确认。';}else store.remove('current');}catch(error){message.textContent=error.message;}}
    function choose(item){chosen=item;name.value=item?.name||'';sku.value=item?.sku||'';unit.value=item?.unit||'件';name.readOnly=unit.readOnly=!!item||mode!=='in';choice.value=item?.item_id||'';
      const held=stock.find(row=>row.item_id===item?.item_id);available.textContent=held?`本格位现有 ${held.qty} ${held.unit||'件'}${held.reserved_qty?' · 任务预占 '+held.reserved_qty+' · 可用 '+held.available_qty:''}`:item?'当前格位暂无此货品。':'';}
    function renderChoices(){choice.replaceChildren();const empty=el('option',mode==='in'?'登记新货品 / 扫码选货':'请选择货品');empty.value='';choice.append(empty);
      for(const item of mode==='in'?catalogue:stock){const option=el('option',item.name+' · '+(item.sku||'未编号')+(mode==='in'?'':` · ${item.qty} ${item.unit||'件'}`));option.value=item.item_id;choice.append(option);}}
    async function resolveItem(){
      if(!sku.value.trim())throw Error('请先扫描或填写货品条码');const value=sku.value.trim(),item=await read('/api/items/by-code?code='+encodeURIComponent(value));
      if(mode!=='in'&&!stock.some(row=>row.item_id===item.item_id))throw Error('当前格位没有此货品，请核对货品和格位');
      if(!catalogue.some(row=>row.item_id===item.item_id))catalogue.push(item);renderChoices();choose(item);persist();qty.focus();
    }
    sku.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();lookup.click();}};
    choice.onchange=()=>{choose((mode==='in'?catalogue:stock).find(row=>row.item_id===choice.value));persist();qty.focus();};
    name.oninput=unit.oninput=qty.oninput=()=>{persist();};sku.oninput=()=>{if(chosen&&sku.value.trim()!==chosen.sku){chosen=null;name.value='';unit.value='件';name.readOnly=unit.readOnly=mode!=='in';choice.value='';}persist();};
    async function load(){
      loading=true;save.disabled=true;
      try{snapshot=await read('/api/work/opening?loc_code='+encodeURIComponent(location.value));stock=snapshot.items;
        catalogue=await read('/api/work/catalogue?room='+encodeURIComponent(roomCode));renderChoices();
        const old=chosen;if(old&&(mode==='in'||stock.some(row=>row.item_id===old.item_id)))choose(old);else choose(mode!=='in'&&stock.length===1?stock[0]:null);
        manual.value='';
      }finally{loading=false;save.disabled=false;}
    }
    location.onchange=()=>run(async()=>{persist();await load();persist();});
    async function showPending(){
      if(isHistorical()){recovery.replaceChildren(el('p','联网后将核对原请求和最新库存，再确认提交。','work-hint'));return;}
      recovery.replaceChildren();const rows=await window.CounterWrites.list();
      for(const row of rows){const box=el('div',undefined,'work-recovery');box.append(el('strong','有一笔作业结果待确认'),el('p',`${row.body.loc_code||row.body.from_loc||''} · ${row.body.name||row.body.item_id||''} · ${row.body.qty}`));
        box.append(button('核对原请求',()=>run(async()=>{const response=await window.CounterWrites.retry(row.path),receipt=await response.json();if(!response.ok)throw Error(receipt.error||'核对失败');
          const same=row.path==='/api/counter/'+({in:'inbound',out:'outbound',move:'move'}[mode])&&(row.body.loc_code||row.body.from_loc)===location.value&&Number(row.body.qty)===Number(qty.value)&&(row.body.item_id?row.body.item_id===chosen?.item_id:row.body.name===name.value.trim())&&(!target||row.body.to_loc===target.value);
          const sameBusiness=['document_no','recipient','department','purpose'].every(key=>(row.body[key]||'')===(business.read()[key]||''));
          if(same&&sameBusiness){store.remove('current');qty.value='';}await load();if(!same||!sameBusiness)persist();await showPending();message.textContent='原请求已确认，没有重复记账。';await onChanged();})));recovery.append(box);}
      save.disabled=rows.some(row=>row.path==='/api/counter/'+({in:'inbound',out:'outbound',move:'move'}[mode]));
    }
    async function submit(){
      if(busy||loading)return;const identity=await workApi('/api/auth/me');if(identity.user.id!==who.user.id)throw Error('登录账号已变化，请重新打开作业');
      if(!snapshot||snapshot.loc_code!==location.value)throw Error('请先重新选择格位');
      // 手动输入已有条码也按原货品复用；不要求使用者必须点一次“识别”。
      if(!chosen&&sku.value.trim()){try{const item=await workApi('/api/items/by-code?code='+encodeURIComponent(sku.value.trim()));if(mode!=='in'&&!stock.some(row=>row.item_id===item.item_id))throw Error('当前格位没有此货品');choose(item);}catch(error){if(error.status!==404||mode!=='in')throw error;}}
      const amount=Number(qty.value);if(!Number.isFinite(amount)||amount<=0)throw Error('请填写大于零的本次数量');
      if(!name.value.trim()||!unit.value.trim())throw Error('请填写货品名称和库存单位');
      if(mode!=='in'&&!chosen)throw Error('请先选择本格位货品');
      if(mode==='move'&&(!target.value||target.value===location.value))throw Error('请选择与当前格位不同的目标格位');
      const now=await workApi('/api/work/opening?loc_code='+encodeURIComponent(location.value));
      const freshItem=chosen?await workApi('/api/items/by-code?code='+encodeURIComponent(chosen.item_id)):null;
      const next=target?await workApi('/api/work/opening?loc_code='+encodeURIComponent(target.value)):null;
      validateMobileStock({mode,amount,item:freshItem,source:now,originalNode:snapshot.node_id,unit:unit.value.trim(),target:next,targetNode:targetSnapshot?.node_id});
      if(freshItem&&(freshItem.name!==name.value.trim()||freshItem.sku!==sku.value.trim()))throw Error('货品名称或编码已变化，请重新选择货品后核对');
      if(next)targetSnapshot=next;
      const context=business.read();persist();if(!await confirm(`${names[mode]} ${name.value.trim()} ${amount} ${unit.value.trim()}\n${location.value}${target?' → '+target.value:''}${Object.keys(context).length?'\n'+window.SpatialBusiness.describe(context):''}\n确认后更新库存。`))return;
      busy=true;save.disabled=true;form.inert=actions.inert=true;let committed=false;
      const path='/api/counter/'+({in:'inbound',out:'outbound',move:'move'}[mode]);
      const payload=mode==='in'?{loc_code:location.value,name:name.value.trim(),sku:sku.value.trim(),unit:unit.value.trim(),qty:amount,...(chosen?{item_id:chosen.item_id}:{})}:mode==='out'?{loc_code:location.value,item_id:chosen.item_id,qty:amount}:{from_loc:location.value,to_loc:target.value,item_id:chosen.item_id,qty:amount};
      try{
        await workApi(path,{...payload,...context},'POST');committed=true;const description=`${names[mode]}成功：${name.value} ${amount} ${unit.value}`;
        store.remove('current');qty.value='';if(!keep.checked)choose(null);await load();result.replaceChildren(el('p',description,'work-receipt'));message.textContent='本笔已完成，继续扫描下一笔货品。';await onChanged();qty.focus();
      }catch(error){if(committed)throw Error('库存已更新，界面刷新尚未完成：'+error.message);throw Error(await window.CounterWrites.failureMessage(path,error.message));}
      finally{busy=false;form.inert=actions.inert=false;save.disabled=false;await showPending();}
    }
    root.querySelector('.work-head button').onclick=()=>{if(busy){message.textContent='正在提交，请等待作业结果。';return;}root.close();};
    root.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    await run(async()=>{
      await load();
      if(validSaved&&validSaved.loc_code===location.value){const item=validSaved.item_id?catalogue.find(row=>row.item_id===validSaved.item_id)||stock.find(row=>row.item_id===validSaved.item_id)||null:null;
        business.set(validSaved);
        if(item){if(!catalogue.some(row=>row.item_id===item.item_id))catalogue.push(item);renderChoices();choose(item);}else{choose(null);name.value=validSaved.name;sku.value=validSaved.sku;unit.value=validSaved.unit;}
        qty.value=validSaved.qty;if(target&&progress.rows.some(row=>row.loc_code===validSaved.to_loc&&row.node_id===validSaved.to_node_id)){target.value=validSaved.to_loc;targetSnapshot=await read('/api/work/opening?loc_code='+encodeURIComponent(target.value));}
        message.textContent='已恢复本机未提交草稿，请核对后办理。';
      }
      if(draft?.item_id){const item=await workApi('/api/items/by-code?code='+encodeURIComponent(draft.item_id));if(!catalogue.some(row=>row.item_id===item.item_id))catalogue.push(item);renderChoices();choose(item);qty.value=draft.qty??'';if(target)target.value=draft.to_loc||'';persist();}
      else if(itemCode){sku.value=itemCode;await resolveItem();}
      await showPending();
    });return panel;
  }
  return {open};
}
