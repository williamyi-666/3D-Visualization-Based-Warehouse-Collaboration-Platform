// 一页共用一次状态检查。后台页暂停，恢复可见/联网时立即补查，不启动模型。
export function watchWorkStatus({getRoom,onUpdate,onError=()=>{},fetcher=fetch,doc=document,win=window,intervalMs=5000}){
  let stopped=false,timer,controller,room='',generation=0;
  async function check(){
    // 浏览器的联网标志不能代表局域网仓库服务是否可达，按实际请求结果重试。
    clearTimeout(timer);if(stopped||doc.hidden)return;
    const target=getRoom()||'';
    if(!target){timer=setTimeout(check,intervalMs);return;}
    if(controller)return;
    if(target!==room){room=target;generation++;}
    const version=generation,own=new AbortController();controller=own;
    const timeout=setTimeout(()=>own.abort(),10000);
    try{
      const response=await fetcher('/api/work/status?room='+encodeURIComponent(target),{signal:own.signal});
      if(stopped||version!==generation||target!==getRoom())return;
      if(response.status===401||response.status===403){onError({accessLost:true,message:'登录或仓库权限已变化，请重新登录'});stopped=true;return;}
      if(!response.ok)throw Error('待办暂未同步，将自动重试');
      const value=await response.json();
      await onUpdate(value);onError(null);
    }catch(error){if(!stopped&&!own.signal.aborted)onError({message:error.message});}
    finally{clearTimeout(timeout);if(controller===own)controller=null;if(!stopped&&version===generation)timer=setTimeout(check,intervalMs);}
  }
  const resume=()=>{generation++;controller?.abort();controller=null;clearTimeout(timer);if(!doc.hidden)void check();};
  doc.addEventListener('visibilitychange',resume);win.addEventListener('online',resume);
  void check();
  return {refresh:resume,stop(){stopped=true;generation++;clearTimeout(timer);controller?.abort();doc.removeEventListener('visibilitychange',resume);win.removeEventListener('online',resume);}};
}
