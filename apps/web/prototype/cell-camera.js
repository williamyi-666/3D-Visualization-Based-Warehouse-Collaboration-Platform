// 相机仅在用户点击拍照后开启；关闭、离开页面或完成拍摄立即释放摄像头。
export function createCellCamera({save}) {
  const dialog=document.createElement('dialog');
  dialog.setAttribute('aria-label','拍摄格位现场照片');
  dialog.style.cssText='width:min(600px,90vw);max-height:90vh;overflow:auto;border:1px solid #475569;border-radius:12px;background:#0f172a;color:#e2e8f0;padding:18px';
  dialog.innerHTML=`<h3>拍摄现场照片</h3><p data-target></p>
    <video autoplay muted playsinline style="width:100%;max-height:50vh;object-fit:contain"></video>
    <img alt="待保存的现场照片" style="display:none;width:100%;max-height:50vh;object-fit:contain">
    <p role="status"></p><div style="display:flex;gap:8px;flex-wrap:wrap">
    <button type="button" data-shot>拍照</button><button type="button" data-retry style="display:none">重拍</button>
    <button type="button" data-save style="display:none">确认保存</button><button type="button" data-close>取消</button></div>`;
  document.body.append(dialog);
  const q=s=>dialog.querySelector(s),video=q('video'),image=q('img'),status=q('[role=status]');
  let stream=null,generation=0,photo='',code='',saving=false;
  function stop(){generation++;stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;}
  function close(){if(saving)return;stop();dialog.close();photo='';image.removeAttribute('src');}
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('close',stop);
  q('[data-close]').onclick=close;
  window.addEventListener('pagehide',()=>{stop();if(dialog.open)dialog.close();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden && dialog.open){stop();q('[data-shot]').disabled=true;status.textContent='相机已暂停，点击重拍重新打开。';q('[data-retry]').style.display='';}});
  async function start() {
    stop();const request=generation;photo='';image.removeAttribute('src');image.style.display='none';video.style.display='';
    q('[data-save]').style.display='none';q('[data-shot]').style.display='';q('[data-shot]').disabled=true;q('[data-retry]').style.display='none';
    status.textContent='正在请求摄像头，请在浏览器提示中允许访问；不便拍照时可取消后选择图片上传。';
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw Error('当前环境不能调用摄像头，请使用 HTTPS 或 localhost，或取消后选择图片上传。');
      const opened=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      if(request!==generation || !dialog.open){opened.getTracks().forEach(t=>t.stop());return;}
      stream=opened;video.srcObject=stream;await video.play();
      if(request!==generation)return;
      q('[data-shot]').disabled=false;status.textContent='对准现场后点击拍照。';
    }catch(error){if(request!==generation)return;stop();status.textContent=error.name==='NotAllowedError'?'摄像头权限被拒绝，请允许浏览器及嵌入页面使用摄像头，或取消后选择图片上传。':error.name==='NotFoundError'?'未找到摄像头，请取消后选择图片上传。':error.message || '相机无法启动，请取消后选择图片上传。';q('[data-retry]').style.display='';}
  }
  q('[data-retry]').onclick=start;
  q('[data-shot]').onclick=()=>{
    if(!video.videoWidth){status.textContent='画面尚未就绪，请稍后拍照。';return;}
    const canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(video.videoWidth,video.videoHeight));
    canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
    canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    photo=canvas.toDataURL('image/jpeg',0.85);stop();video.style.display='none';image.src=photo;image.style.display='';
    q('[data-shot]').style.display='none';q('[data-retry]').style.display='';q('[data-save]').style.display='';status.textContent='确认照片后保存，也可以重拍。';
  };
  q('[data-save]').onclick=async()=>{
    if(saving || !photo)return;saving=true;dialog.querySelectorAll('button').forEach(b=>b.disabled=true);status.textContent='保存中…';
    try {await save(code,photo);saving=false;close();}
    catch(error){status.textContent=error.message || '保存失败，请重试';}
    finally{saving=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
  return {open(target){if(dialog.open)return;code=target;q('[data-target]').textContent='格位：'+code;dialog.showModal();start();},close};
}
