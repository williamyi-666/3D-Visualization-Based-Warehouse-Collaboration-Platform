import {createWorkDialog} from './warehouse-work-ui.mjs';
import {createFieldDrafts} from './field-drafts.mjs';
import {workApi} from './work-request.mjs';

export async function openMobileCountDraft({code,read,openCount,isHistorical}){
  const who=await read('/api/auth/me'),rooms=await read('/api/rooms'),room=rooms.find(row=>code.startsWith(row.loc_code+'-'));
  if(!room)throw Error('当前库区不可访问');
  const snapshot=await read('/api/work/opening?loc_code='+encodeURIComponent(code));
  const store=createFieldDrafts({userId:who.user.id,roomId:room.id,kind:'count-offline'}),saved=store.get(code);
  const restored=saved?.node_id===snapshot.node_id?saved:null;
  const panel=createWorkDialog('填写实盘 · '+code),{body,message,run,root}=panel;
  const text=(tag,value)=>{const el=document.createElement(tag);el.textContent=value;return el;};
  body.append(text('p','填写自动保存在本机，不会调整库存。联网核对后进入盘点单，保存实盘并按规则提交。'));
  const fields=snapshot.items.map(item=>{
    const label=text('label',`${item.name} · ${item.unit||'件'} · 账面 ${item.qty}`),input=document.createElement('input');
    input.type='number';input.min='0';input.step='any';input.inputMode='decimal';input.placeholder='填写实盘数量，缺货填0';
    input.value=restored?.counts.find(row=>row.item_id===item.item_id)?.qty??'';label.append(input);body.append(label);return {item,input};
  });
  if(!fields.length)body.append(text('p','此格位最近记录中暂无货品。联网后可在盘点单内补录。'));
  const label=text('label','盘点说明'),reason=document.createElement('textarea');reason.rows=2;reason.value=restored?.reason||'';label.append(reason);body.append(label);
  function persist(){
    try{store.save(code,{node_id:snapshot.node_id,counts:fields.map(({item,input})=>({item_id:item.item_id,qty:input.value,unit:item.unit})),reason:reason.value});message.textContent='本机盘点草稿已保存，库存未更新。';}
    catch(error){message.textContent=error.message;}
  }
  for(const {input} of fields)input.oninput=persist;reason.oninput=persist;
  message.textContent=restored?'已恢复本机盘点草稿，请核对后继续。':isHistorical()?'当前账面来自最近记录；填写仅保存本机草稿。':'';
  const next=text('button','联网核对并打开盘点单');next.type='button';next.className='primary';body.append(next);
  next.onclick=()=>run(async()=>{
    const identity=await workApi('/api/auth/me');if(identity.user.id!==who.user.id)throw Error('登录账号已变化，请重新打开盘点');
    const fresh=await workApi('/api/work/opening?loc_code='+encodeURIComponent(code));
    if(fresh.node_id!==snapshot.node_id)throw Error('格位已重建，请重新选择格位并重新清点');
    if(fresh.items.length!==fields.length||fields.some(({item})=>!fresh.items.some(row=>row.item_id===item.item_id&&row.unit===item.unit)))throw Error('格位货品或单位已变化，请保留草稿并重新打开盘点核对');
    const counts=fields.map(({item,input})=>{const qty=Number(input.value);if(input.value===''||!Number.isFinite(qty)||qty<0)throw Error('请填写全部实盘数量，缺货填0');return {item_id:item.item_id,qty};});
    persist();await openCount(code,{prefill:{counts,reason:reason.value},onSaved:()=>store.remove(code)});root.close();
  });
  return panel;
}
