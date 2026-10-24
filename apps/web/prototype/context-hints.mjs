// 提示随真实窗口出现，不接管操作，也不影响保存、取消或权限。
export const CONTEXT_HINTS={
  locPickerModal:'先选择仓库和库区；用「库区设置」填写现场尺寸，点「完成」返回仓库。',
  roomModal:'按现场测量填写宽、深、高，单位为米；核对后点「应用」。宽 × 深就是库区面积。',
  layoutModal:'用「＋ 添加」放入货架、地面存放区或门窗，拖动摆放后点「保存布局」。',
  furnModal:'按实物填写尺寸和层列；层数 × 列数生成格位。点「生成」加入草稿，保存布局后生效。'
};

export function mountContextHints({account,document=globalThis.document,window=globalThis.window,storage=globalThis.localStorage}) {
  const mounted=[];
  for(const [id,text] of Object.entries(CONTEXT_HINTS)){
    const heading=document.getElementById(id)?.querySelector('h3');if(!heading)continue;
    const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');
    details.className='context-hint';summary.textContent='操作提示（点击收起 / 展开）';body.textContent=text;details.append(summary,body);heading.after(details);
    const key=()=>`spatial_context_hint:${account()||'local'}:${id}`;
    const restore=()=>{try{details.open=storage.getItem(key())!=='closed';}catch{details.open=true;}};
    details.addEventListener('toggle',()=>{try{storage.setItem(key(),details.open?'open':'closed');}catch{}});
    restore();mounted.push(restore);
  }
  window.addEventListener('spatial-auth-ready',()=>mounted.forEach(restore=>restore()));
}
