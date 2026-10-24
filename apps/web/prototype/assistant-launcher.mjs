// 平台级入口：轻点打开，拖动超过 6px 才移动，避免拖完误触打开。
export function createAssistantLauncher(open) {
  const launcher=document.createElement('button');
  launcher.type='button';launcher.className='assistant-launcher';launcher.hidden=true;
  launcher.textContent='✦ 智能助手';launcher.title='点击打开智能助手 · 拖动调整位置';
  launcher.setAttribute('aria-label','打开智能助手');document.body.append(launcher);
  const key='spatial-assistant-position:'+location.pathname;
  let position,drag;
  try{position=JSON.parse(localStorage.getItem(key));}catch{}
  const place=(left,top)=>{
    const box=launcher.getBoundingClientRect();
    position={left:Math.max(8,Math.min(left,innerWidth-box.width-8)),top:Math.max(8,Math.min(top,innerHeight-box.height-8))};
    Object.assign(launcher.style,{left:position.left+'px',top:position.top+'px',right:'auto',bottom:'auto'});
  };
  const keepInView=()=>{if(!launcher.hidden&&position)place(position.left,position.top);};
  launcher.addEventListener('pointerdown',event=>{
    if(!event.isPrimary||event.button!==0)return;
    const box=launcher.getBoundingClientRect();
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:box.left,top:box.top,moved:false};
    launcher.setPointerCapture(event.pointerId);
  });
  launcher.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    if(!drag.moved&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6)return;
    drag.moved=true;launcher.classList.add('dragging');
    place(drag.left+event.clientX-drag.x,drag.top+event.clientY-drag.y);
  });
  const end=event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const activate=event.type==='pointerup'&&!drag.moved;
    drag=null;launcher.classList.remove('dragging');
    if(launcher.hasPointerCapture(event.pointerId))launcher.releasePointerCapture(event.pointerId);
    if(position)try{localStorage.setItem(key,JSON.stringify(position));}catch{}
    if(activate)open();
  };
  launcher.addEventListener('pointerup',end);launcher.addEventListener('pointercancel',end);
  launcher.addEventListener('lostpointercapture',end);
  // 鼠标与触控在 pointerup 打开；click 只处理键盘/辅助技术激活。
  launcher.onclick=event=>{if(event.detail===0)open();};
  window.addEventListener('resize',keepInView);
  return {launcher,keepInView};
}
