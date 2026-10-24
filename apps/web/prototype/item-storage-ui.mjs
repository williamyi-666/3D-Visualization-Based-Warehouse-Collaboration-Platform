import {createWorkDialog} from './warehouse-work-ui.mjs';
import {workApi,sendWork,pendingWork,retryWork,setWorkUser} from './work-request.mjs';
import {formatBusinessTime} from './business-time.mjs';

const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
const button=(text,action,primary=false)=>{const node=el('button',text,primary?'primary':'');node.type='button';node.onclick=action;return node;};
function field(parent,text,value='',type='text'){const label=el('label',text),input=el('input');input.type=type;input.value=value??'';input.setAttribute('aria-label',text);label.append(input);parent.append(label);return input;}
const describe=p=>[p.width==null?'尺寸未登记':`${p.width} × ${p.height} × ${p.depth} 米`,p.weight_kg==null?'重量未登记':`${p.weight_kg} kg`,p.required_tags.length?'要求：'+p.required_tags.join('、'):p.configured===false?'存放条件未登记':'未指定特殊条件'].join(' · ');
function closeOnAuth(root){const lost=()=>root.close();window.addEventListener('spatial-auth-required',lost);root.addEventListener('close',()=>window.removeEventListener('spatial-auth-required',lost),{once:true});}
export function appendStorageReasons(host,candidate){
  const distance=candidate.reasons.find(text=>text.includes('按通道')),brief=[candidate.reasons[0],distance].filter(Boolean);
  host.append(el('p',brief.join('；')));
  const checks=candidate.reasons.filter(text=>!brief.includes(text));
  if(checks.length){const details=el('details'),list=el('ul');details.append(el('summary','查看存放条件核对'),list);for(const text of checks)list.append(el('li',text));host.append(details);}
  if(candidate.warnings.length)host.append(el('p',candidate.warnings.join('；'),'work-message'));
}

export async function openItemStorage({itemId,room,onChanged=async()=>{},locate,openCounter}){
  const identity=await workApi('/api/auth/me');setWorkUser(identity.user.id);
  const path='/api/items/'+encodeURIComponent(itemId)+'/storage',panel=createWorkDialog('货品存放资料'),{root,body,run,message}=panel;
  closeOnAuth(root);
  const content=el('section'),recovery=el('div');body.append(recovery,content);let current,busy=false;
  async function load(){
    const data=await workApi(path);if(!root.isConnected)return;current=data;content.replaceChildren(el('h3',data.name),el('p',`${data.sku||'未编号'} · 库存单位：${data.unit}`,'work-hint'),el('p',`按 1 ${data.unit} 的实际包装填写，宽、高、深采用米，重量采用千克。`,'work-hint'));
    const grid=el('div',null,'work-grid');content.append(grid);const inputs={};
    for(const [key,title] of [['width','包装宽（米）'],['height','包装高（米）'],['depth','包装深（米）'],['weight_kg','每库存单位重量（kg）']]){const input=field(grid,title,data.profile[key],'number');input.min='0';input.step='any';input.inputMode='decimal';input.disabled=!data.can_edit;inputs[key]=input;}
    const layers=field(grid,'最大叠放层数',data.profile.max_stack_layers,'number');layers.min='1';layers.step='1';layers.placeholder='未知则仅估算单层';layers.disabled=!data.can_edit;inputs.max_stack_layers=layers;
    content.append(el('p','容量按规整摆放估算，需核对实际净空；未登记叠放条件时仅计算单层。','work-hint'));
    const tags=field(content,'必需存放条件标签（逗号分隔）',data.profile.required_tags.join('，'));tags.disabled=!data.can_edit;tags.placeholder='如：干燥、避光';
    content.append(el('p','推荐只选择含全部所需标签的格位。对应标签在“格位属性”中维护，现场条件仍需人工确认。','work-hint'));
    const rotate=field(content,'允许水平转向，始终保持朝上','','checkbox');rotate.checked=data.profile.horizontal_rotation;rotate.disabled=!data.can_edit;rotate.style.cssText='width:18px;min-height:18px;height:18px;flex:0 0 auto;order:-1';rotate.parentElement.style.cssText='display:flex;align-items:center;gap:8px;margin-top:16px';
    const controls=el('div',null,'work-actions');content.append(controls);
    if(data.can_edit)controls.append(button('保存资料',()=>run(async()=>{
      const profile={...Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.value.trim()===''?null:Number(input.value)])),required_tags:tags.value.split(/[,，、\n]/).map(v=>v.trim()).filter(Boolean),horizontal_rotation:rotate.checked};
      if(busy)return;busy=true;content.inert=true;
      try{await sendWork(path,{revision:current.revision,profile});await load();message.textContent='存放资料已保存，库存数量未改变。';try{await onChanged();}catch(error){message.textContent='资料已保存，场景暂未刷新：'+error.message;}}
      finally{busy=false;content.inert=false;showRecovery();}
    }),true));else content.append(el('p',data.message,'work-hint'));
    if(room&&openCounter&&['admin','operator'].includes(identity.user.role))controls.append(button('推荐存放位置',()=>run(async()=>{await openStorageRecommendations({itemId,room,onChanged,locate,openCounter});root.close();})));
    const history=el('details');history.append(el('summary','存放资料修改记录'));content.append(history);
    history.addEventListener('toggle',()=>{if(!history.open||history.dataset.loaded)return;void run(async()=>{const rows=await workApi(path+'/history');history.dataset.loaded='1';if(!rows.length)history.append(el('p','尚无修改记录。'));for(const row of rows){const record=el('div',null,'work-row');record.append(el('strong',row.actor_name),el('small',formatBusinessTime(row.created_at)),el('p','修改前：'+describe(row.before)),el('p','修改后：'+describe(row.after)));history.append(record);}});});
  }
  function showRecovery(){recovery.replaceChildren();if(pendingWork()?.path!==path)return;recovery.className='work-recovery';recovery.append(el('p','上次资料保存结果待确认。'),button('核对上次保存',()=>run(async()=>{await retryWork();await load();showRecovery();message.textContent='原保存请求已核对。';})));}
  root.addEventListener('cancel',event=>{if(busy)event.preventDefault();});root.querySelector('.work-head button').onclick=()=>{if(!busy)root.close();};
  await run(load);showRecovery();return panel;
}

export async function openStorageRecommendations({itemId,room,onChanged,locate,openCounter}){
  const path='/api/items/'+encodeURIComponent(itemId)+'/storage';
  const [data,options]=await Promise.all([workApi(path),workApi('/api/work/route-options?room='+encodeURIComponent(room))]);
  const panel=createWorkDialog('推荐存放位置'),{root,body,run,message}=panel;
  closeOnAuth(root);
  const profileInfo=el('p',`库存单位：${data.unit} · ${describe(data.profile)}`,'work-hint');body.append(el('h3',data.name),profileInfo);
  const form=el('div',null,'work-grid'),results=el('section'),controls=el('div',null,'work-actions');body.append(form,controls,results);
  const qty=field(form,`本次存放数量（${data.unit}）`,1,'number');qty.min='0';qty.step='any';
  const label=el('label','搬运起点'),start=el('select');start.setAttribute('aria-label','搬运起点');label.append(start);form.append(label);
  for(const row of [{value:'',label:'自动选择可用入口'},...options.entrances.map(v=>({value:'entry:'+v.index,label:v.label})),...options.locations.map(v=>({value:'loc:'+v.loc_code,label:'格位附近 · '+v.loc_code}))]){const option=el('option',row.label);option.value=row.value;start.append(option);}
  if(options.entrances.length)start.value='entry:'+options.entrances[0].index;
  let generation=0;
  const query=()=>{const origin=start.value.split(':');return new URLSearchParams({room,item_id:itemId,qty:qty.value,unit:data.unit,...(origin[0]==='loc'?{start_loc:origin.slice(1).join(':')}:origin[0]==='entry'?{entry:origin[1]}:{})});};
  async function calculate(){
    const own=++generation,signature=query().toString();results.replaceChildren(el('p','正在核对格位条件…'));
    const value=await workApi('/api/work/recommendations?'+signature);if(own!==generation||!root.isConnected)return;results.replaceChildren();
    profileInfo.textContent=`库存单位：${data.unit} · ${describe(value.profile)}`;
    results.append(el('p',`已检查 ${value.checked} 个格位，符合已知条件 ${value.eligible} 个，显示前 ${value.candidates.length} 个。`,'work-hint'),el('p','优先集中同款，再选空位；同类候选按通道距离排序。','work-hint'));
    if(!value.candidates.length)results.append(el('p','没有符合条件的格位，请核对尺寸、条件标签、容量和通道设置。','work-message'));
    for(const candidate of value.candidates){
      const row=el('div',null,'work-row');row.append(el('strong',candidate.loc_code));appendStorageReasons(row,candidate);
      const actions=el('div',null,'work-actions');row.append(actions);
      if(locate)actions.append(button('3D定位',()=>run(async()=>{await locate(candidate.loc_code);root.close();})));
      if(openCounter)actions.append(button('在此格位入库',()=>run(async()=>{
        const fresh=await workApi('/api/work/recommendations?'+signature);
        if(!root.isConnected)return;
        if(signature!==query().toString()||fresh.layout_revision!==value.layout_revision||JSON.stringify(fresh.profile)!==JSON.stringify(value.profile)||!fresh.candidates.some(v=>v.loc_code===candidate.loc_code))throw Error('库存、资料或布局已变化，请更新推荐后重新核对');
        await openCounter(candidate.loc_code,'in',{itemCode:data.sku||itemId,draft:{item_id:itemId,name:data.name,qty:Number(qty.value),unit:data.unit,to_loc:candidate.loc_code}});root.close();
      }),true));results.append(row);
    }
  }
  controls.append(button('更新推荐',()=>run(calculate),true),button(data.can_edit?'修改存放资料':'查看存放资料',()=>run(async()=>{await openItemStorage({itemId,room,onChanged,locate,openCounter});root.close();})));
  form.oninput=form.onchange=()=>{generation++;results.replaceChildren(el('p','填写已变化，请更新推荐。','work-hint'));message.textContent='';};
  await run(calculate);return panel;
}
