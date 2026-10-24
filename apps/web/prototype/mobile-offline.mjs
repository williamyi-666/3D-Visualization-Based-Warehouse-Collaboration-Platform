// 业务数据只存本机，按部署和账号隔离。缓存不是登录凭证，也不能用于确认库存写入。
export function canRemember(path){
  return /^\/api\/(auth\/me|rooms|scene|search|cells|cells\/[^/?]+\/items|work\/(progress|opening|catalogue)|items\/by-code)(\?|$)/.test(path);
}
export function createMobileOffline({storage,scope,credential,fetcher,onState=()=>{},onAccessLost=()=>{},now=Date.now,timeoutMs=6000}){
  const prefix='spatial-mobile-history:'+scope+':',activeKey=prefix+'active';
  let identity=null,stale=new Map(),warning='';
  const fingerprint=value=>{let a=2166136261,b=5381;for(const c of value){a=Math.imul(a^c.charCodeAt(0),16777619);b=Math.imul(b,33)^c.charCodeAt(0);}return (a>>>0).toString(16)+(b>>>0).toString(16);};
  const binding=()=>fingerprint(credential()||'');
  function readJSON(key){try{return JSON.parse(storage.getItem(key)||'null');}catch{return null;}}
  const dataKey=()=>identity?prefix+identity.user.id:null;
  function emit(){onState({stale:[...stale].map(([path,at])=>({path,at})),warning});}
  function put(key,value){try{storage.setItem(key,JSON.stringify(value));return true;}catch{warning='本机存储空间不足，最近记录未能保存。';emit();return false;}}
  function forget(){const key=dataKey();if(key)storage.removeItem(key);storage.removeItem(activeKey);identity=null;stale.clear();emit();}
  function restore(){const saved=readJSON(activeKey);identity=credential()&&saved?.binding===binding()&&saved.identity?.user?.id&&now()-saved.at<7*86400000?saved.identity:null;if(!identity)stale.clear();return identity;}
  function remember(path,value){
    if(!canRemember(path))return;
    if(path==='/api/auth/me'){
      if(identity&&identity.user.id!==value.user.id)forget();
      identity=value;put(activeKey,{binding:binding(),identity:value,at:now()});
    }
    const key=dataKey();if(!key)return;
    let rows=readJSON(key)||{};
    // 库区节点已重建时，不保留旧格位、场景和查询记录。
    if(path==='/api/rooms'&&rows[path]&&JSON.stringify(rows[path].value.map(r=>[r.id,r.loc_code]))!==JSON.stringify(value.map(r=>[r.id,r.loc_code])))rows={};
    const entry={at:now(),value};if(JSON.stringify(entry).length>450000)return;
    rows[path]=entry;
    const ordered=Object.entries(rows).sort((a,b)=>b[1].at-a[1].at);rows=Object.fromEntries(ordered.slice(0,60));
    while(JSON.stringify(rows).length>1800000){const oldest=Object.keys(rows).at(-1);delete rows[oldest];}
    put(key,rows);
  }
  async function read(path){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    let response;
    try{response=await fetcher(path,{cache:'no-store',signal:controller.signal});}
    catch(cause){
      restore();const row=canRemember(path)&&readJSON(dataKey())?.[path];
      if(row&&now()-row.at<7*86400000){stale.set(path,row.at);emit();return structuredClone(row.value);}
      throw Error('暂时无法连接仓库服务；本机没有这项最近记录。请保留草稿，联网后重试。',{cause});
    }finally{clearTimeout(timer);}
    if(!response.ok){
      if(response.status===401||response.status===403){forget();onAccessLost(response.status);}
      const value=await response.json().catch(()=>({}));
      throw Object.assign(Error(value.error||(response.status===401?'请先登录仓库作业。':response.status===403?'当前账号没有此仓库的访问权限。':'读取失败，请稍后重试。')),{status:response.status});
    }
    const value=await response.json();remember(path,value);stale.delete(path);emit();return value;
  }
  restore();
  return {read,forget,isStale:path=>stale.has(path),get historical(){return stale.size>0;},get identity(){return identity;}};
}
