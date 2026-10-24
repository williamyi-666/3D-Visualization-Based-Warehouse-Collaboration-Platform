import {createErpStocktakes} from './erp-stocktake.mjs';
export function mountErpStocktakes(app,{sql,inventoryView,requireRole,env=process.env,fetcher=fetch}){
  const endpoint=env.SPATIAL_ERP_STOCKTAKE_URL,source=env.SPATIAL_ERP_STOCKTAKE_SOURCE;
  if(endpoint){const u=new URL(endpoint);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!source)throw Error('ERP盘点地址须为HTTP(S)，并配置来源；凭证请使用独立环境变量');}
  const dispatch=endpoint?async payload=>{
    if(payload.source!==source)throw Error('此库存来源尚未配置盘点接口');
    const headers={'Content-Type':'application/json','Idempotency-Key':payload.request_id};
    if(env.SPATIAL_ERP_STOCKTAKE_TOKEN)headers.Authorization='Bearer '+env.SPATIAL_ERP_STOCKTAKE_TOKEN;
    const r=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!r.ok)throw Error('ERP接口未确认请求，HTTP '+r.status);return r.json();
  }:null;
  const service=createErpStocktakes(sql,{inventory:()=>inventoryView.list(),sourceVersion:s=>sql.prepare('SELECT version FROM external_inventory_snapshot WHERE source=?').get(s)?.version||0,dispatch});
  const run=(fn,status=200)=>async(req,res)=>{try{res.status(status).json(await fn(req));}catch(e){res.status(e.status||400).json({error:e.message});}};
  const base='/api/erp-stocktakes';
  app.get(base,run(req=>({records:service.list(req.query.loc_code,req.canAccessLocation),sources:[...new Set(inventoryView.list().filter(r=>r.loc_code===req.query.loc_code).map(r=>r.source))],configured:!!endpoint,configuredSource:source||null,simulation:env.SPATIAL_TEST_ERP==='1'})));
  app.get(base+'/:id',run(req=>service.get(req.params.id,req.canAccessLocation)));
  app.post(base,requireRole('admin','operator'),run(req=>service.create(req.body,req.user,req.canAccessLocation),201));
  app.put(base+'/:id',requireRole('admin','operator'),run(req=>service.save(req.params.id,req.body,req.user,req.canAccessLocation)));
  app.post(base+'/:id/action',requireRole('admin','operator'),run(req=>service.transition(req.params.id,req.body,req.user,req.canAccessLocation)));
  app.post(base+'/:id/send',requireRole('admin'),run(req=>service.send(req.params.id,req.body,req.user,req.canAccessLocation)));
  app.post(base+'/:id/reconcile',requireRole('admin'),run(req=>service.reconcile(req.params.id,req.body,req.user,req.canAccessLocation)));
  return service;
}
