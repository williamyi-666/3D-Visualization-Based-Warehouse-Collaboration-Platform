export function inventoryDelta(previous,next){
  const structure=s=>JSON.stringify({...s,sync:undefined,furniture:(s.furniture||[]).map(f=>({...f,items:undefined}))});
  return {rebuild:structure(previous)!==structure(next),changed:(next.furniture||[]).filter(f=>JSON.stringify(f.items)!==JSON.stringify(previous.furniture?.find(p=>p.code===f.code)?.items)).map(f=>f.code)};
}

export function inventorySyncMessage(message,sources=[]){
  if(!['库存已同步','库存自动同步已连接'].includes(message))return message;
  if(sources?.some(s=>s.state==='failed'))return 'ERP同步失败 · 当前显示上次成功同步的库存';
  if(sources?.some(s=>s.state==='stale'||s.stale))return 'ERP更新超时 · 当前显示上次成功同步的库存';
  return message;
}

// fetch 流沿用页面的认证和网关路径适配，不把令牌放入 URL。
export function mountLiveInventory({getRoom,refresh,isBusy,status,onAccessLost=()=>{},fetcher=fetch,doc=document,win=window}){
  let controller,room='',revision='',pending=false,applying=false,stopped=false,reconnect,checkTimer,retryAfter=0;
  let offline=false,denied=false;
  function loseAccess(){denied=true;pending=false;controller?.abort();clearTimeout(reconnect);status('登录或权限已变化，请重新登录后继续');onAccessLost();}
  async function apply(){
    if(stopped||offline||denied||!room||!pending||applying||doc.hidden||Date.now()<retryAfter)return;
    if(isBusy()){status('库存有更新，结束当前操作后同步');return;}
    applying=true;pending=false;
    try{await refresh();retryAfter=0;if(!denied&&!offline&&!stopped)status('库存已同步');}catch{pending=true;retryAfter=Date.now()+5000;if(!denied&&!offline&&!stopped)status('同步暂未完成，将自动重试');}
    finally{applying=false;}
  }
  function receive(value){if(value!==revision){revision=value;pending=true;apply();}}
  async function connect(){
    if(stopped||offline||denied||doc.hidden||!room)return;
    const target=room;controller?.abort();const own=new AbortController();controller=own;
    let watchdog,timedOut=false;
    const heartbeat=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>{timedOut=true;own.abort();},25000);};
    heartbeat();
    try{
      const response=await fetcher('/api/scene/events?room='+encodeURIComponent(target),{signal:own.signal});
      if(own.signal.aborted||controller!==own)return;
      if(response.status===401||response.status===403){loseAccess();return;}
      if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('订阅不可用');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      status('库存自动同步已连接');
      while(!own.signal.aborted){
        const {done,value}=await reader.read();if(done)break;
        heartbeat();buffer+=decoder.decode(value,{stream:true});
        let pos;
        while((pos=buffer.indexOf('\n\n'))>=0){
          const event=buffer.slice(0,pos);buffer=buffer.slice(pos+2);
          if(event.includes('event: access-expired')){loseAccess();return;}
          const data=event.split('\n').find(line=>line.startsWith('data: '));
          if(data&&room===target)receive(JSON.parse(data.slice(6)).revision);
        }
      }
    }catch(error){if(own.signal.aborted&&!timedOut)return;status('连接中断，正在补查库存');}
    finally{clearTimeout(watchdog);}
    if(stopped||(own.signal.aborted&&!timedOut))return;
    try{
      const r=await fetcher('/api/scene/revision?room='+encodeURIComponent(target),{signal:AbortSignal.timeout(10000)});
      if(stopped||controller!==own)return;
      if(r.status===401||r.status===403){loseAccess();return;}
      if(r.ok&&room===target)receive((await r.json()).revision);
    }catch{}
    if(!stopped&&room===target&&controller===own)reconnect=setTimeout(connect,5000);
  }
  function check(){
    const next=getRoom()||'';
    if(next!==room){room=next;revision='';pending=false;retryAfter=0;denied=false;controller?.abort();clearTimeout(reconnect);connect();}
    apply();
  }
  function resume(){controller?.abort();clearTimeout(reconnect);if(!doc.hidden){pending=true;connect();apply();}}
  function disconnected(){offline=true;controller?.abort();clearTimeout(reconnect);status('网络已断开，当前为上次库存；恢复连接后自动核对');}
  function connected(){offline=false;resume();}
  checkTimer=setInterval(check,500);check();
  doc.addEventListener('visibilitychange',resume);win.addEventListener('online',connected);win.addEventListener('offline',disconnected);
  return ()=>{stopped=true;controller?.abort();clearInterval(checkTimer);clearTimeout(reconnect);doc.removeEventListener('visibilitychange',resume);win.removeEventListener('online',connected);win.removeEventListener('offline',disconnected);};
}
