import {createWorkDialog} from './warehouse-work-ui.mjs';
import {workApi,sendWork,pendingWork,retryWork,setWorkUser} from './work-request.mjs';
import {formatBusinessTime} from './business-time.mjs';

const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const button=(text,action)=>{const node=el('button',text);node.type='button';node.onclick=action;return node;};
function field(parent,label,tag='input'){
  const box=el('label',label),input=el(tag);box.append(input);parent.append(box);return input;
}
const kindName={barcode:'货品条码',supplier:'供应商编码',legacy:'历史编号'};

export async function openItemCodes({onChanged=async()=>{}}={}) {
  const identity=await workApi('/api/auth/me');
  if(identity.mode==='integration'||identity.user.role!=='admin')throw Error('货品编码整理由独立仓储模式的管理员办理');
  setWorkUser(identity.user.id);
  const panel=createWorkDialog('货品编码整理'),{body,run,message}=panel;
  panel.root.classList.add('item-codes-dialog');
  const hint=el('p','同一货品可关联多个条码。更换正式编号后，旧编号仍可扫码，库存与历史记录保持关联。','work-hint');
  const search=el('form',undefined,'work-actions'),query=el('input'),submit=el('button','查找');
  query.placeholder='名称 / SKU / 供应商条码';query.setAttribute('aria-label','查找待整理货品');submit.type='submit';search.append(query,submit);
  const count=el('p','','work-hint'),list=el('div'),editor=el('section');body.append(hint,search,count,list,editor);
  let selected,version=0;
  async function loadList(){
    const own=++version,items=await workApi('/api/admin/item-codes?q='+encodeURIComponent(query.value.trim()));
    if(own!==version||!panel.root.isConnected)return;
    list.replaceChildren();count.textContent=items.length?`显示 ${items.length} 种货品，未编号及临时编号优先${items.length===100?'；可输入关键词缩小范围':''}。`:'没有匹配货品。';
    for(const item of items){
      const row=button('',()=>run(()=>edit(item.item_id)));row.className='work-choice';
      row.append(el('strong',item.name),el('small',`${item.sku||'未编号'} · ${item.unit}${item.needs_code?' · 待整理编号':''}`));
      if(item.same_name_count>1||item.same_sku_count>1)row.append(el('small','存在同名或同编码记录，请核对规格和实物；此处不会合并货品。'));
      list.append(row);
    }
  }
  search.onsubmit=event=>{event.preventDefault();run(loadList);};
  async function edit(id){
    const own=++version;const data=await workApi('/api/admin/item-codes/'+encodeURIComponent(id));
    if(own!==version||!panel.root.isConnected)return;selected=data;list.hidden=true;search.hidden=true;count.hidden=true;
    editor.replaceChildren(el('h3',data.name),el('p',`库存单位：${data.unit}${data.temporary?' · 当前为临时编号':''}`,'work-hint'));
    const sku=field(editor,'正式编号');sku.value=data.sku;sku.maxLength=120;sku.autocomplete='off';
    if(data.erp_codes.length)editor.append(el('small','ERP对应编码：'+data.erp_codes.join('、')));
    const codeList=el('div'),changes=el('div'),actions=el('div',undefined,'work-actions');editor.append(el('h4','其它条码'),codeList);
    function addCode(value={code:'',kind:'barcode'}){
      const row=el('div',undefined,'work-row'),grid=el('div',undefined,'work-grid');row.append(grid);
      const code=field(grid,'条码'),kind=field(grid,'类型','select');code.value=value.code;code.maxLength=200;
      for(const [key,name] of Object.entries(kindName)){if(key==='legacy'&&value.kind!=='legacy')continue;const option=el('option',name);option.value=key;kind.append(option);}kind.value=value.kind;
      const historic=value.kind==='legacy';code.readOnly=historic;kind.disabled=historic;
      row.read=()=>({code:code.value.trim(),kind:kind.value});
      if(historic)row.append(el('small','历史编号保留，已打印标签可继续使用。'));
      else row.append(button('移除此条码',()=>{row.remove();changes.replaceChildren();}));
      code.oninput=kind.onchange=()=>changes.replaceChildren();codeList.append(row);return code;
    }
    for(const code of data.codes)addCode(code);
    editor.append(button('＋ 添加条码',()=>{changes.replaceChildren();addCode().focus();}),actions,changes);
    function read(){return {revision:data.revision,sku:sku.value.trim(),codes:[...codeList.children].map(row=>row.read())};}
    actions.append(button('返回货品列表',()=>{selected=null;editor.replaceChildren();list.hidden=false;search.hidden=false;count.hidden=false;run(loadList);}),button('核对修改',()=>run(async()=>{
      const input=read();if(!input.sku)throw Error('请填写正式编号');if(input.codes.some(row=>!row.code))throw Error('请填写条码或移除空行');
      if(new Set(input.codes.map(row=>row.code)).size!==input.codes.length)throw Error('请删除重复条码');
      const signature=JSON.stringify(input);changes.replaceChildren();
      const summary=el('div',undefined,'work-recovery');summary.append(el('strong','请确认编码对应同一件实物'),el('p',`${data.sku||'未编号'} → ${input.sku}`),el('p',`其它条码 ${input.codes.length} 个${data.sku&&data.sku!==input.sku?'，旧编号将自动保留':''}。`));
      const save=button('确认保存',()=>run(async()=>{
        if(JSON.stringify(read())!==signature){changes.replaceChildren();throw Error('内容已修改，请重新核对');}
        save.disabled=true;
        try{const result=await sendWork('/api/admin/item-codes/'+encodeURIComponent(id),input);await onChanged();message.textContent='编码已保存，库存数量未改变。';await edit(result.item_id);}
        finally{save.disabled=false;showRecovery();}
      }));save.classList.add('primary');summary.append(save);changes.append(summary);save.focus();
    })));
    sku.oninput=()=>changes.replaceChildren();
    const history=el('details');history.append(el('summary','编号修改记录'));
    history.addEventListener('toggle',()=>{if(!history.open||history.dataset.loaded)return;run(async()=>{
      const rows=await workApi('/api/admin/item-codes/'+encodeURIComponent(id)+'/history');history.dataset.loaded='true';
      for(const row of rows){const entry=el('div',undefined,'work-row');entry.append(el('strong',`${row.before.sku||'未编号'} → ${row.after.sku}`),el('small',`${row.actor_name} · ${formatBusinessTime(row.created_at)}`),el('small','变更后条码：'+(row.after.codes.map(c=>c.code).join('、')||'无')));history.append(entry);}
      if(!rows.length)history.append(el('p','暂无编号修改记录。'));
    });});editor.append(history);
  }
  const recovery=el('div');body.insertBefore(recovery,hint);
  function showRecovery(){
    recovery.replaceChildren();const pending=pendingWork();if(!pending)return;
    recovery.className='work-recovery';recovery.append(el('p','上次操作回执尚未确认，请先核对，避免重复办理。'),button('核对上次操作',()=>run(async()=>{
      const result=await retryWork();message.textContent='上次操作已确认。';showRecovery();await onChanged();if(selected)await edit(selected.item_id);else await loadList();return result;
    })));
  }
  showRecovery();await run(loadList);return panel;
}
