export function warehouseUnsRequest(base,fetcher=fetch) {
  return async(route,body,method=body===undefined?'GET':'POST')=>{
    const response=await fetcher(base.replace(/\/$/,'')+'/open-api/uns/'+route,{
      method,headers:{'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
    const result=await response.json();
    if(!response.ok||![0,200].includes(result.code)){const error=Error(result.msg||'UNS请求失败');error.code=result.code;throw error;}
    return result.data;
  };
}

// 注册是显式操作；读取既有模型时不覆盖定义。每个格位读回本次时间戳与完整快照。
export async function publishWarehouseModel(plan,{request,publish,register=false,update=false,sleep=ms=>new Promise(r=>setTimeout(r,ms)),progress=()=>{}}) {
  let created=0,updated=0,verified=0;
  for(const model of plan.models) {
    const {kind,path,...definition}=model;
    const route=kind+'/'+encodeURIComponent(model.alias);
    let existing;
    try {existing=await request(route);}
    catch(error) {
      if(!register||error.code!==400||!/找不到|not found/i.test(error.message))throw error;
      await request(kind,definition);created++;existing=await request(route);
    }
    if(existing.alias!==model.alias||existing.name!==model.name||existing.description!==model.description)throw Error('UNS节点身份冲突：'+model.displayName);
    if(kind==='file') {
      const fields=existing.definition?.filter(f=>!f.systemField)||[];
      if(existing.dataType!==1||existing.persistence!==false||fields.length!==2||
        !fields.some(f=>f.name==='occupied'&&f.type==='LONG')||
        !fields.some(f=>f.name==='snapshot'&&f.type==='STRING'&&f.maxLen>=16384))throw Error('UNS格位字段冲突：'+model.displayName);
    }
    const targetPath=path||model.name;
    if(existing.path!==targetPath||existing.displayName!==model.displayName) {
      if(!update)throw Error('UNS节点名称或层级不一致：'+model.displayName);
      const patch={name:model.name,displayName:model.displayName,description:model.description,
        ...(model.parentAlias?{parentAlias:model.parentAlias}:{})};
      await request(kind+'/detail/'+encodeURIComponent(model.alias),patch,'PUT');
      existing=await request(route);
      if(existing.path!==targetPath||existing.displayName!==model.displayName)throw Error('UNS节点更新后读回不一致：'+model.displayName);
      updated++;
    }
  }
  for(const value of plan.values) {
    const timeStamp=Date.now();
    await publish(value.path,{occupied:value.occupied,snapshot:value.snapshot,timeStamp,quality:192});
    let matches=false,lastError;
    for(let i=0;i<20;i++) {
      try {
        const current=(await request('file/current/batchQuery',[value.alias]))?.[value.alias];
        if(Number(current?.timeStamp)===timeStamp&&current.occupied===value.occupied&&current.snapshot===value.snapshot){matches=true;break;}
      } catch(error) {lastError=error;}
      await sleep(250);
    }
    if(!matches)throw Error('UNS未读回本次格位快照：'+value.loc_code+(lastError?' · '+lastError.message:''));
    verified++;if(verified%15===0)progress({verified,total:plan.values.length});
  }
  return {created,updated,verified,models:plan.models.length};
}
