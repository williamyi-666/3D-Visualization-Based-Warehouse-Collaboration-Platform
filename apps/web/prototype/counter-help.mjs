// 正式作业只保留就地提示；数量和提交仍由原业务表单处理。
export function counterHelpText(state) {
  if(!state.loc)return state.mode==='move'?'先选择源格位':'先定位操作格位';
  if(!state.item)return state.mode==='in'?'选择常用货品，或填写货品名称':'点击一条货品，确定本次操作对象';
  if(state.mode==='move'&&!state.to)return '选择另一个目标格位';
  if(!state.qtyValid)return '填写本次数量；出库与移库不能超过可用库存';
  return '核对格位、货品和本次数量，再确认操作';
}

export function mountCounterHelp({userId,getState}) {
  const box=document.createElement('details'),summary=document.createElement('summary'),text=document.createElement('p');
  box.className='counter-help';box.style.cssText='position:sticky;top:0;z-index:4;padding:10px 12px;margin:12px 0;border:1px solid #375477;border-radius:10px;background:#15263e;color:#dbeafe;font-size:13px';
  text.style.cssText='line-height:1.7;margin:8px 0 0;color:#b5c5da';box.append(summary,text);document.querySelector('.tabs').after(box);
  const instructions={in:'① 定位格位 → ② 选择已有货品，或填名称和单位（SKU可后补）→ ③ 填本次增加量 → 核对确认。',out:'① 定位格位 → ② 点选货品 → ③ 填本次取出量 → 核对确认。',move:'① 确认源格位和货品 → ② 选择目标格位 → ③ 填本次搬运量 → 核对确认。'};
  let mode;
  const key=()=>`spatial_counter_help:${location.pathname}:${userId}:${mode}`;
  function refresh(){
    const state=getState();
    if(mode!==state.mode){mode=state.mode;try{box.open=localStorage.getItem(key())!=='closed';}catch{box.open=true;}text.textContent=instructions[mode];}
    summary.textContent='操作提示 · '+counterHelpText(state);
  }
  box.addEventListener('toggle',()=>{try{localStorage.setItem(key(),box.open?'open':'closed');}catch{}});
  for(const type of ['click','input','change'])document.addEventListener(type,()=>queueMicrotask(refresh));
  refresh();return {refresh};
}
