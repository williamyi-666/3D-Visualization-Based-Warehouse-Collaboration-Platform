// 保存已读回的状态；失败时不前移基线，下一轮继续核对。
export function createWarehouseSync({readPlan,publish,load=()=>null,save=()=>{},now=Date.now,refreshMs=300000}) {
  let previous=load() || {models:[],values:[]},first=true,lastFullRefresh=0;
  const sync=async()=>{
    let current,missing;
    try {current=readPlan();}
    catch(error) {
      // 仅明确缺少仓库时作失效处理；数据库故障不能误清空平台快照。
      if(error.code!=='WAREHOUSE_NOT_FOUND')throw error;
      missing={status:'warehouse_missing',site:error.siteCode,message:error.message};
      current={models:[],values:[]};
    }
    // 当前树按父先子后；历史删除节点追加，随仍存在的父节点调整路径。
    const models=new Map(current.models.map(m=>[m.alias,{...m}]));
    previous.models.forEach(m=>{if(!models.has(m.alias))models.set(m.alias,{...m});});
    function pathFor(model) {
      if(!model.parentAlias)return model.name;
      const parent=models.get(model.parentAlias);
      return parent?pathFor(parent)+'/'+model.name:model.path;
    }
    for(const model of models.values())if(model.parentAlias)model.path=pathFor(model);
    const values=new Map(current.values.map(v=>[v.alias,v]));
    for(const old of previous.values) {
      if(values.has(old.alias))continue;
      const snapshot=JSON.parse(old.snapshot);
      values.set(old.alias,{...old,occupied:0,snapshot:JSON.stringify(missing
        ? {...snapshot,unavailable:true,unavailable_reason:'warehouse_missing',inventory:[]}
        : {...snapshot,deleted:true,inventory:[]})});
    }
    const next={models:[...models.values()],values:[...values.values()].map(v=>({...v,path:models.get(v.alias)?.path||v.path}))};
    const oldValues=new Map(previous.values.map(v=>[v.alias,JSON.stringify(v)]));
    // 平台当前值可能独立丢失；本地不变时也每五分钟重新发布并读回。
    const fullRefresh=first||now()-lastFullRefresh>=refreshMs;
    const changed=next.values.filter(v=>fullRefresh||oldValues.get(v.alias)!==JSON.stringify(v));
    const modelChanged=JSON.stringify(next.models)!==JSON.stringify(previous.models);
    if(!fullRefresh&&!changed.length&&!modelChanged)return {verified:0,unchanged:true,...missing};
    const result=await publish({models:next.models,values:changed});
    save(next);previous=next;first=false;
    // 全量成功才延后刷新；失败下一轮重试，增量不推迟全量。
    if(fullRefresh)lastFullRefresh=now();
    return {...result,...missing};
  };
  return async()=>{
    try{return await sync();}
    catch(error){
      // 失败期间库存可能回到旧基线，仍须读回平台才能确认恢复。
      first=true;
      throw error;
    }
  };
}
