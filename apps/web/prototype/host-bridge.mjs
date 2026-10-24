// 宿主协议只传业务标识；宿主负责打开自己的 ERP/WMS 页面。
export function createHostBridge({window:win,allowedOrigins,locate,onConnectionChange=()=>{}}) {
  const allowed=new Set(allowedOrigins);
  let origin=null,queue=Promise.resolve();
  const send=(type,payload={},requestId)=>{
    if(origin) win.parent.postMessage({channel:'spatial-inventory',version:1,type,payload,...(requestId?{requestId}:{})},origin);
  };
  const receive=event=>{
    if(win.parent===win || event.source!==win.parent || !allowed.has(event.origin)) return;
    const data=event.data;
    if(data?.channel!=='spatial-inventory' || data.version!==1) return;
    if(data.type==='hello') {if(origin && origin!==event.origin) return;origin=event.origin;onConnectionChange(true);send('ready',{},data.requestId);return;}
    if(event.origin!==origin || data.type!=='locate') return;
    const p=data.payload;
    if(!p || !['loc','sku'].some(k=>typeof p[k]==='string' && p[k].trim()) || ['loc','sku','source'].some(k=>p[k]!=null && (typeof p[k]!=='string' || p[k].length>200))) {
      send('error',{message:'需要有效的 loc 或 sku'},data.requestId);return;
    }
    queue=queue.then(async()=>{
      try {send('located',await locate(p),data.requestId);}
      catch(e) {send('error',{message:e.message},data.requestId);}
    });
  };
  win.addEventListener('message',receive);
  return {send,connected:()=>origin!==null,destroy:()=>{win.removeEventListener('message',receive);origin=null;onConnectionChange(false);}};
}
