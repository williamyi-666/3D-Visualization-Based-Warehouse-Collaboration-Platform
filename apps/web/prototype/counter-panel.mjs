// 复用出入库台，在当前页面操作；关闭后保留三维场景与所选格位。
export function createCounterPanel({confirm,onAuthRequired,getRoom}) {
  let modal=null, frame=null, opener=null, dirty=false, closing=false;
  async function close() {
    if (!modal || closing) return;
    closing=true;
    try {
      if (dirty && !await confirm('关闭出入库台？尚未提交的填写将清空；已提交或待核对的业务记录会保留。')) return;
      modal.remove(); modal=null; frame=null; dirty=false;
      opener?.focus();
    } finally { closing=false; }
  }
  window.addEventListener('message', event=>{
    if(!frame||event.source!==frame.contentWindow||event.origin!==location.origin)return;
    if(event.data?.type==='counter-updated')dirty=false;
    if(event.data?.type==='counter-close-request')void close();
    if(event.data?.type==='counter-auth-required')onAuthRequired?.();
  });
  window.addEventListener('spatial-auth-required',()=>{
    // 身份失效直接卸载子页面；已发请求的恢复记录由counter-write持久化。
    modal?.remove();modal=null;frame=null;dirty=false;
  });
  window.addEventListener('keydown', event=>{
    if (modal && !closing && event.key==='Escape') {
      event.preventDefault();event.stopImmediatePropagation();void close();
    }
  },true);
  return function open(loc='',mode='in',{itemCode,draft}={}) {
    if (modal) return;
    opener=document.activeElement;dirty=false;
    modal=document.createElement('div');modal.className='modal';
    const box=document.createElement('section');box.className='modal-box';
    box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label','出入库台');
    box.style.cssText='width:min(680px,96vw);height:90vh;max-height:90vh;padding:12px;display:flex;flex-direction:column;overflow:hidden';
    const header=document.createElement('header');header.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px';
    const title=document.createElement('strong');title.textContent='出入库台';
    const back=document.createElement('button');back.type='button';back.className='toolbtn';back.textContent='关闭并返回格位';back.onclick=close;
    header.append(title,back);
    frame=document.createElement('iframe');frame.title='出入库操作';frame.allow='camera';
    frame.style.cssText='width:100%;flex:1;min-height:0;border:0;border-radius:8px';
    frame.src='./counter.html?'+new URLSearchParams({loc,mode,room:getRoom?.() || '',...(itemCode?{item:itemCode}:{}),...(draft?{item_id:draft.item_id,qty:String(draft.qty),to:draft.to_loc||''}:{})});
    frame.onload=()=>{frame?.contentDocument?.addEventListener('input',()=>{dirty=true;});};
    box.append(header,frame);modal.append(box);document.body.insertBefore(modal,document.getElementById('confirmModal'));back.focus();
  };
}
