export async function mountMobilePwa({button,status}){
  if(!window.isSecureContext||!('serviceWorker' in navigator)){
    status.textContent='当前入口可在线使用并保留已打开页面中的作业草稿。添加桌面和断网重新打开，需要管理员配置受信任的 HTTPS 入口。';return;
  }
  let prompt;
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;button.hidden=false;});
  button.onclick=async()=>{if(!prompt)return;await prompt.prompt();await prompt.userChoice;prompt=null;button.hidden=true;};
  window.addEventListener('appinstalled',()=>{button.hidden=true;status.textContent='已添加快捷入口；断网时只能查看最近记录和填写草稿。';});
  try{
    // 只控制手机页面，避免电脑端使用手机缓存的公共模块或阻止手机版本更新。
    const registration=await navigator.serviceWorker.register(new URL('./mobile-sw.js',import.meta.url),{scope:new URL('./mobile.html',import.meta.url).pathname,updateViaCache:'none'});
    const ready=await navigator.serviceWorker.ready;
    status.textContent=ready.active?'离线页面已准备好。可用浏览器菜单“添加到主屏幕”；断网草稿需要联网核对后提交。':'正在准备离线页面…';
    const update=()=>{if(registration.waiting)status.textContent='新版本已准备好，结束当前作业并关闭页面后，下次打开即可更新。';};
    update();registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',update));
  }catch{status.textContent='离线页面尚未准备好，请联网后重新打开。当前在线作业和本机草稿仍可使用。';}
}
