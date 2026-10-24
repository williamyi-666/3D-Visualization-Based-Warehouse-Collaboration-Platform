// 发送前保留请求；刷新或关闭窗口后仍使用原编号核对结果。
(() => {
  const send=window.fetch.bind(window),flights=new Map();
  async function scope(){
    const response=await window.fetch('/api/auth/me');
    if(!response.ok)throw Error('请先登录，再核对出入库结果');
    const {user}=await response.json();
    if(!user?.id)throw Error('无法确认当前操作账号');
    return 'spatial-counter-pending:'+JSON.stringify([window.SPATIAL_RUNTIME?.basePath||'',user.id]);
  }
  function read(key){return JSON.parse(window.localStorage.getItem(key)||'{}');}
  function save(key,records,afterSend=false){
    try{window.localStorage.setItem(key,JSON.stringify(records));}
    catch{throw Error(afterSend?'操作已返回，但恢复记录未能清理，请使用原记录再次核对':'无法保存操作恢复信息，请检查浏览器存储空间后重试；本次未发送库存操作');}
  }
  window.fetch=async(input,init={})=>{
    if(typeof input!=='string'||!/^\/api\/(counter\/(inbound|outbound|move)|import|items)$/.test(input)||init.method!=='POST'||JSON.parse(init.body).preview===true)return send(input,init);
    const key=await scope(),records=read(key),signature=init.body;
    let record=records[input];
    if(record&&record.signature!==signature)throw Error('上一笔操作结果尚未确认，请先在“待确认操作”中核对，再填写新操作');
    if(!record){record={signature,id:globalThis.spatialRandomUUID(),at:new Date().toISOString()};records[input]=record;save(key,records);}
    const flightKey=key+input;
    if(!flights.has(flightKey)){
      const body={...JSON.parse(init.body),request_id:record.id};
      const flight=send(input,{...init,body:JSON.stringify(body)}).then(response=>{
        // 身份过期/权限变更不能证明旧请求未提交，保留待恢复记录。
        if(response.ok||response.status===400){const current=read(key);delete current[input];save(key,current,true);}
        return response;
      }).finally(()=>{flights.delete(flightKey);window.CounterWrites.onChange?.();});
      flights.set(flightKey,flight);
    }
    return flights.get(flightKey).then(response=>response.clone());
  };
  window.CounterWrites={
    get busy(){return flights.size>0;},
    async failureMessage(path,detail){
      // 是否保留原请求决定提示，不能把未知结果当作未入账。
      try{
        if(read(await scope())[path])return '操作结果待确认，请在“待确认操作”中核对原请求，勿重新录入。';
      }catch{return detail+'；请重新登录后检查“待确认操作”，勿重复录入。';}
      return detail;
    },
    async list(){return Object.entries(read(await scope())).map(([path,record])=>({path,...record,body:JSON.parse(record.signature)}));},
    async retry(path){
      const record=read(await scope())[path];
      if(!record)throw Error('该账号没有此待确认操作，请刷新列表');
      return window.fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:record.signature});
    }
  };
})();
