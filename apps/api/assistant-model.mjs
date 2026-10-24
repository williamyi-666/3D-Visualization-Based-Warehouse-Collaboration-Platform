import {assistantToolSchema} from './assistant-tools.mjs';

export function createLocalAssistantModel({url=process.env.SPATIAL_ASSISTANT_URL||'',model=process.env.SPATIAL_ASSISTANT_MODEL||'qwen3:4b-instruct-2507-q4_K_M',enabled=process.env.SPATIAL_ASSISTANT_ENABLED!=='0'&&!!url,fetchImpl=fetch,maxQueue=4,retryMs=15000,activeMs=60000,now=Date.now}={}) {
  let config={url,model,enabled},busy=false,warming=null,checking=null,controller=null,timer,version=0,activeUntil=0,checkedAt=0;
  let state=enabled?(url?'idle':'unconfigured'):'disabled',error='';
  const queue=[];
  const endpoint=path=>new URL(path,config.url.endsWith('/')?config.url:config.url+'/');
  const unavailable=()=>Object.assign(Error('智能模型暂不可用，仍可使用普通查询、出入库和操作指引。'),{status:503});
  const snapshot=()=>({enabled:config.enabled,configured:!!config.url,available:state==='ready',state,model:config.model,busy,queued:queue.length,warming:state==='warming',error,checked_at:checkedAt?new Date(checkedAt).toISOString():null,retry_after_ms:retryMs});
  function schedule(){
    clearTimeout(timer);
    if(config.enabled&&config.url&&activeUntil>now()){
      timer=setTimeout(()=>{if(activeUntil>now())void probe();},retryMs);timer.unref?.();
    }
  }
  function failed(message){state='unavailable';error=message;checkedAt=now();}
  function probe(){
    if(checking)return checking;
    if(warming||busy||!config.enabled||!config.url)return Promise.resolve(snapshot());
    const current=version,selected=config.model;
    controller=new AbortController();const signal=controller.signal;
    state='checking';error='';
    checking=Promise.resolve().then(async()=>{
      if(current!==version)return snapshot();
      try{
        const response=await fetchImpl(endpoint('api/tags'),{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
        if(!response.ok)throw unavailable();
        const tags=await response.json();if(current!==version)return snapshot();
        if(!tags.models?.some(m=>m.name===selected||m.model===selected)){
          failed('服务已连接，但未找到指定模型。请管理员核对模型名称。');return snapshot();
        }
        const running=await fetchImpl(endpoint('api/ps'),{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
        if(!running.ok)throw unavailable();
        const loaded=await running.json();if(current!==version)return snapshot();checkedAt=now();
        if(loaded.models?.some(m=>m.name===selected||m.model===selected)){state='ready';error='';}
        else{
          state='warming';
          // 只在有人使用助手时加载模型；仓储后台启动不占用模型显存。
          warming=fetchImpl(endpoint('api/generate'),{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.any([signal,AbortSignal.timeout(180000)]),body:JSON.stringify({model:selected,prompt:'',stream:false,keep_alive:'30m',options:{num_ctx:4096,num_thread:4}})})
            .then(async r=>{if(!r.ok)throw unavailable();const data=await r.json();if(data.error)throw unavailable();if(current===version){state='ready';error='';checkedAt=now();}})
            .catch(()=>{if(current===version)failed('模型暂时未能加载，将自动重试；普通作业可继续使用。');})
            .finally(()=>{if(current===version){warming=null;schedule();}});
        }
      }catch{if(current===version)failed('暂时无法连接模型服务，将自动重试；普通作业可继续使用。');}
      finally{if(current===version){checking=null;schedule();}}
      return snapshot();
    });
    return checking;
  }
  async function status({retry=false,activate=true}={}){
    if(!config.enabled||!config.url)return snapshot();
    if(activate)activeUntil=now()+activeMs;
    if(activate&&(retry||state==='idle'||(!checkedAt||now()-checkedAt>=retryMs)))await probe();
    return snapshot();
  }
  function configure(next){
    if(busy||queue.length)throw Object.assign(Error('助手仍有请求正在处理，请完成后再修改模型设置。'),{status:409});
    version++;controller?.abort();clearTimeout(timer);checking=warming=null;
    config={enabled:next.enabled,url:next.url,model:next.model};checkedAt=activeUntil=0;error='';
    state=config.enabled?(config.url?'idle':'unconfigured'):'disabled';return snapshot();
  }
  async function plan(messages,{schema=assistantToolSchema,onState,signal}={}) {
    const current=version,health=await status({retry:state==='unavailable'});
    if(current!==version)throw unavailable();
    if(health.warming)throw Object.assign(Error('智能模型正在准备，请稍后再试；普通作业可继续使用。'),{status:503});
    if(!health.available)throw unavailable();
    if(queue.length>=maxQueue)throw Object.assign(Error('助手等待队列已满，请稍后重试；普通作业可继续使用。'),{status:429});
    return new Promise((resolve,reject)=>{queue.push({messages,schema,onState,signal,resolve,reject});notifyQueue();if(!busy)void drain();});
  }
  function notifyQueue(){queue.forEach((job,index)=>job.onState?.({state:'queued',ahead:index+(busy?1:0)}));}
  async function drain(){
    busy=true;
    while(queue.length){
      const job=queue.shift();job.onState?.({state:'running',ahead:0});notifyQueue();
      try{
        if(job.signal?.aborted)throw job.signal.reason;
        const timeout=AbortSignal.timeout(90000),signal=job.signal?AbortSignal.any([job.signal,timeout]):timeout;
        const response=await fetchImpl(endpoint('api/chat'),{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({model:config.model,messages:job.messages,tools:job.schema,stream:false,think:false,keep_alive:'30m',options:{temperature:0,num_ctx:4096,num_predict:job.schema.some(t=>t.function.name==='prepare_batch')?1600:350,num_thread:4}})});
        if(!response.ok)throw unavailable();
        const result=await response.json();if(result.error)throw unavailable();state='ready';error='';checkedAt=now();job.resolve(result.message||{});
      }catch(error){
        if(!job.signal?.aborted)failed('模型响应暂不可用，将自动重试；普通作业可继续使用。');
        job.reject(error.name==='TimeoutError'?Object.assign(Error('模型响应较慢，请重试或使用普通查询。'),{status:504}):error);
      }
    }
    busy=false;schedule();
  }
  // 没有人打开助手时，不持续请求或反复预热模型。
  return {status,plan,configure,snapshot,close(){version++;controller?.abort();clearTimeout(timer);}};
}
