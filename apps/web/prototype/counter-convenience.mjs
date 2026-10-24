import {workApi} from './work-request.mjs';

export function mountCounterConvenience({getRoom,getInbound,getMove,chooseInbound,chooseDestination,message}) {
  const make=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
  const recent=make('div'),heading=make('label','常用货品'),choices=make('div');choices.style.cssText='display:flex;flex-wrap:wrap;gap:6px';recent.append(heading,choices);document.getElementById('inName').previousElementSibling.before(recent);
  const continuous=make('label'),checkbox=make('input');checkbox.type='checkbox';checkbox.id='continuousItem';checkbox.checked=true;checkbox.style.cssText='width:auto;margin-right:6px';continuous.append(checkbox,document.createTextNode('连续录入同一货品（保留名称、SKU和单位）'));document.getElementById('inSubmit').before(continuous);
  let recentRoom='';
  async function refresh() {
    const room=getRoom();if(!room)return;
    try{const catalogue=await workApi('/api/work/catalogue?room='+encodeURIComponent(room));recentRoom=room;choices.replaceChildren();
      for(const item of catalogue.slice(0,6)){const button=make('button',item.name);button.type='button';button.title=(item.sku||'未编号')+' · '+item.unit;button.onclick=()=>chooseInbound(item);choices.append(button);}
      if(!choices.children.length)choices.append(make('small','暂无常用货品，登记后可快捷选择。'));
    }catch(error){choices.replaceChildren(make('small',error.message));}
  }
  function addRecommendation(id,label,getInput,target) {
    const trigger=make('button',label),box=make('div'),weightLabel=make('label','单件重量（kg，可选，用于承重校验）'),weight=make('input');weight.type='number';weight.min='0';weight.step='any';weightLabel.append(weight);
    const details=make('details'),summary=make('summary','货位推荐');details.append(summary,weightLabel,trigger,box);document.getElementById(id).after(details);trigger.type='button';
    let version=0;
    trigger.onclick=async()=>{
      const room=getRoom();if(!room){message('请先选择一个库区或定位源格位',false);return;}
      const current=++version;trigger.disabled=true;box.replaceChildren();
      try {
        const input=getInput();if(input.from_loc&&!input.item_id)throw Error('请选择要移动的货品');
        const result=await workApi('/api/work/recommendations?'+new URLSearchParams({room,...input,...(weight.value?{unit_weight:weight.value}:{})}));
        if(current!==version)return;
        for(const candidate of result.candidates) {
          const button=make('button',candidate.loc_code),why=make('small',candidate.reasons.join('；')),warn=make('small',candidate.warnings.join('；'));button.type='button';button.style.cssText='display:block;text-align:left;width:100%;margin:8px 0;padding:10px';why.style.display=warn.style.display='block';warn.style.color='#c4b18b';button.append(why,warn);button.onclick=()=>{target(candidate.loc_code);box.replaceChildren(make('p','已选择 '+candidate.loc_code+'，请核对后确认作业。'));};box.append(button);
        }
        if(!result.candidates.length)box.append(make('p','未找到满足已配置条件的格位，请调整数量或人工选择。'));
      }catch(error){box.append(make('p',error.message));}finally{trigger.disabled=false;}
    };
  }
  addRecommendation('inUnit','为本次入库推荐格位',getInbound,code=>chooseDestination('in',code));
  addRecommendation('moveToState','为本次移库推荐格位',getMove,code=>chooseDestination('move',code));
  const refreshIfRoomChanged=()=>{if(recentRoom!==getRoom())refresh();};
  document.getElementById('useLoc').addEventListener('click',refreshIfRoomChanged);
  document.getElementById('locInput').addEventListener('keydown',event=>{if(event.key==='Enter')setTimeout(refreshIfRoomChanged);});
  refresh();return {refresh,continuous:()=>checkbox.checked};
}
