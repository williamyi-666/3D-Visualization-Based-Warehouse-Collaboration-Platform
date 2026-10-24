import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readWarehouseSnapshot,buildWarehouseModel} from '../../packages/integration/warehouse-model.mjs';
import {publishWarehouseModel,warehouseUnsRequest} from '../../packages/integration/warehouse-publish.mjs';
import {createWarehouseSync} from '../../packages/integration/warehouse-sync.mjs';
import {startDispatchLoop} from '../../packages/integration/scheduler.mjs';
import {SupOSAdapter} from '../../packages/integration/adapters/suposUnsAdapter.mjs';

export function startWarehouseUns(sql,dataDir,onStatus=()=>{}) {
  const site=process.env.SUPOS_WAREHOUSE_SITE;
  if(!site){onStatus({state:'disabled'});return ()=>{};}
  let lastVerifiedAt=null;
  onStatus({state:'starting',site,lastVerifiedAt});
  if(process.env.SPATIAL_MODE!=='standalone')throw Error('仓储快照同步目前仅支持独立库存模式');
  const alias=process.env.SUPOS_WAREHOUSE_ALIAS;
  const name=process.env.SUPOS_WAREHOUSE_NAME;
  if(!alias||!name)throw Error('仓储同步需设置专用模型别名和名称');
  const intervalMs=Number(process.env.SUPOS_WAREHOUSE_INTERVAL_MS || 15000);
  if(!Number.isFinite(intervalMs)||intervalMs<5000)throw Error('仓储同步间隔至少5000毫秒');
  const statePath=join(dataDir,'uns-warehouse-state.json');
  const adapter=new SupOSAdapter(fileURLToPath(new URL('../../packages/integration/mapping/supos-uns.yaml',import.meta.url)));
  const request=warehouseUnsRequest(process.env.SUPOS_INTERNAL_API||'http://backend:8080');
  const context=JSON.stringify({site,alias,name,api:process.env.SUPOS_INTERNAL_API||'http://backend:8080'});
  const run=createWarehouseSync({
    readPlan:()=>buildWarehouseModel(readWarehouseSnapshot(sql,site),{alias,name}),
    load:()=>{
      if(!existsSync(statePath))return null;
      const state=JSON.parse(readFileSync(statePath,'utf8'));
      if(state.context!==context)throw Error('仓储同步目标已变化，请核对原同步状态');
      return state.plan;
    },
    save:plan=>{writeFileSync(statePath+'.tmp',JSON.stringify({context,plan}));renameSync(statePath+'.tmp',statePath);},
    publish:plan=>publishWarehouseModel(plan,{request,register:process.env.SUPOS_WAREHOUSE_REGISTER==='1',update:process.env.SUPOS_WAREHOUSE_UPDATE==='1',
      publish:async(path,value)=>{
        const client=await adapter.ensureClient();
        if(!client||!adapter.connected)throw Error('仓储同步MQTT未连接');
        await adapter.publish(path,value,'warehouse-snapshot');
      }})
  });
  const stop=startDispatchLoop({dispatch:run,intervalMs,
    report:r=>{
      if(!r.unchanged)lastVerifiedAt=new Date().toISOString();
      onStatus({state:r.status||'ready',site,lastVerifiedAt});
      if(r.verified||r.created||r.updated||r.status==='warehouse_missing')console.log('[warehouse-uns]',JSON.stringify(r));
    },
    onError:e=>{onStatus({state:'error',site,lastVerifiedAt});console.error('[warehouse-uns] 同步未完成，将重试：',e.message);}});
  return ()=>{stop();adapter._client?.end(true);};
}
