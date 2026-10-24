import {tipPosition} from './guided-tour.mjs';
import {ensureWorkStyles} from './warehouse-work-ui.mjs';

const step=(target,title,text)=>({target,title,text});
const paths={
  room:[step('#room_name','确认库区','核对当前库区名称。'),step('#r_w','填写现场尺寸','填写宽、深、高，单位为米；按现场测量值填写。'),step('#room_save','核对后应用','尺寸正确后点击「应用」。退出指引不会保存或放弃你的填写。')],
  layout:[step('#layoutAddMenu > summary','添加存放位置','点击「＋ 添加」，选择货架或地面存放区。'),step('#layoutSvg','按实际位置摆放','在画布中拖动货架移动，拖动蓝点旋转。右侧可修改尺寸和层列。'),step('#layout_save','保存布局','核对通道和位置后保存；正式格位在保存成功后生成。')],
  openings:[step('#layoutAddMenu > summary','找到门窗入口','点击「＋ 添加」，再选「门」或「窗」。'),step('#layoutSvg','选择墙面位置','在画布的目标墙面点击放置，再在右侧门窗列表调整宽度和位置。'),step('#layout_save','保存门窗','核对后点击「保存布局」，门窗才正式生效。')],
  model:[step('#assetTarget','关联到已有空间','选择当前库区，或当前库区下已有的货架；无需另建一个库区。'),step('#assetFile','选择 Blender 模型','选择导出的 GLB 文件。模型只负责外观，格位和库存仍沿用已有数据。'),step('#assetUpload','校准并绑定','核对缩放、朝向和偏移，再点「上传并绑定」。关闭后切换写实视图查看。')],
  cells:[step('#spaceFilterDetails','筛选目标格位','展开筛选，可按货架、层或格位编码缩小范围。'),step('#spaceTitle','维护格位属性','选中目标格位，修改容量、承重或名称，核对后保存。填写 SKU 不会增加库存。')],
  quickBuild:[step('dialog[aria-label="快速建仓"] .work-grid','填写存放需求','选择模板，填写货架数量、尺寸、层列和通道宽度。已有货架会保留。'),step('dialog[aria-label="快速建仓"] .work-actions','先预览摆放','点击「预览摆放」，蓝色为本次新增，灰色为已有。检查尺寸与通道提示。'),step('dialog[aria-label="快速建仓"] .work-actions','核对后生成','方案正确再点「确认生成」。随后可调整摆放、打印标签或建立底账。')],
  opening:[step('dialog[aria-label="首次建账 · 按格位登记"] .work-grid','选择现场格位','核对格位码，避免把货品登记到相邻格位。默认接着尚未建账的位置。'),step('dialog[aria-label="首次建账 · 按格位登记"] .work-row','登记现场货品','优先选择已有货品，再填写实盘数量和单位。新货品没有 SKU 可以留空。'),step('dialog[aria-label="首次建账 · 按格位登记"] .work-actions','逐格完成核对','有货点击「核对并建立底账」，无货点击「确认空位」。成功后自动进入下一格。')],
  operations:[step('#addBtn','办理日常存取','入库填写本次增加量；出库、移库填写本次取出量。盘点填写实际总数。'),step('#sidebar','从格位开始操作','先点击三维格位，在右侧核对货品和数量，再选择入库、出库、移库或盘点。')],
  integration:[step('#integrationAdminLink','配置库存协同','在管理设置中配置库存来源与库位映射，再核对外部库存关联。')],
};
const mobilePaths={
  cells:[step('#browseCells','浏览格位','点击「浏览格位」，按格位码筛选并打开详情。')],
  operations:[step('#quickActions','办理库存作业','点击入库、出库或移库，选择格位后填写本次数量；盘点填写实际总数。')],
};

export function createAssistantGuide({prepare,getRoom,mobile=false}) {
  let coach,highlight,timer,room,steps,index;
  const stop=()=>{clearInterval(timer);highlight?.classList.remove('assistant-guide-target');highlight=null;coach?.remove();coach=null;};
  function render(){
    const current=steps[index];coach.querySelector('small').textContent=`操作指引 · ${index+1} / ${steps.length}`;
    coach.querySelector('strong').textContent=current.title;coach.querySelector('p').textContent=current.text;
    coach.querySelector('[data-next]').textContent=index===steps.length-1?'结束指引':'下一步';locate(true);
  }
  function locate(scroll=false){
    if(!coach?.isConnected){stop();return;}
    if(room!==getRoom()){stop();return;}
    const target=document.querySelector(steps[index].target);
    if(target?.closest('dialog:not([open]),.modal.hidden')){stop();return;}
    if(highlight!==target){highlight?.classList.remove('assistant-guide-target');highlight=target;}
    const visible=target?.getClientRects().length;
    coach.querySelector('[role="status"]').textContent=visible?'按高亮位置操作，填写仍由你确认。':'当前界面已关闭或该项尚未展开，可重新打开指引。';
    if(!visible){highlight?.classList.remove('assistant-guide-target');return;}
    const host=target.closest('dialog[open]')||document.body;if(coach.parentNode!==host)host.append(coach);
    highlight.classList.add('assistant-guide-target');if(scroll)target.scrollIntoView({block:'nearest'});
    let bounds=target.getBoundingClientRect();
    // 展开的菜单也属于操作区域，提示卡不能盖住门/窗选项。
    const menu=target.closest('details[open]')?.querySelector(':scope > div');
    if(menu){const box=menu.getBoundingClientRect();bounds={left:Math.min(bounds.left,box.left),top:Math.min(bounds.top,box.top),right:Math.max(bounds.right,box.right),bottom:Math.max(bounds.bottom,box.bottom)};}
    const position=tipPosition(bounds,coach.offsetWidth,coach.offsetHeight,{width:innerWidth,height:innerHeight});
    Object.assign(coach.style,{left:position.left+'px',top:position.top+'px'});
  }
  async function open(topic){
    stop();ensureWorkStyles();room=getRoom();
    const desktopOnly=mobile&&['room','layout','openings','model','integration'].includes(topic);
    if(!desktopOnly)await prepare(topic);
    steps=desktopOnly?[step('#desktopViewSwitch','切换电脑版设置空间','门窗、模型与精细布局可在电脑版设置；手机可继续查货、建账和库存作业。')]:mobilePaths[topic]&&mobile?mobilePaths[topic]:paths[topic];
    if(!steps)return;
    index=0;coach=document.createElement('aside');coach.className='assistant-guide';coach.setAttribute('aria-label','助手操作指引');
    coach.innerHTML='<header><small></small><button type="button" aria-label="退出助手指引">退出</button></header><strong></strong><p></p><div role="status"></div><button type="button" data-next></button>';
    coach.querySelector('[aria-label="退出助手指引"]').onclick=stop;
    coach.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();stop();}};
    coach.querySelector('[data-next]').onclick=()=>{if(index===steps.length-1)stop();else{index++;render();}};
    document.body.append(coach);render();timer=setInterval(locate,350);
  }
  window.addEventListener('spatial-auth-required',stop);window.addEventListener('pagehide',stop);
  return {open,stop};
}
