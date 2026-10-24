// 仅隔离验收：自行启动空数据库实例，不接受外部平台地址，不连接真实ERP。
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInventoryDelivery} from '../packages/integration/inventory-delivery.mjs';
import {sendInventory} from '../packages/integration/inventory-client.mjs';

export async function startErpSyncLab(dir){
  if(process.env.SPATIAL_TEST_ERP!=='1')throw Error('只允许显式标记的隔离ERP验收环境');
  if(existsSync(join(dir,'spatial.db')))throw Error('验收必须使用空数据目录，不允许接管已有库存');
  mkdirSync(dir,{recursive:true});
  const source='模拟ERP联调',locA='WH-1-A-L01-B01',locB='WH-1-B-L01-B01',room='WH-1';
  const credentials={username:'erp_lab_admin',password:'ErpLab-20261018!',name:'ERP隔离验收'};
  const receipts=new Map();let receiptCalls=0,loseReceipt=false;
  const erp=createServer(async(req,res)=>{
    try{
      if(req.method!=='POST'||req.url!=='/adjustments'){res.writeHead(404).end();return;}
      let raw='';for await(const part of req)raw+=part;const payload=JSON.parse(raw);
      if(req.headers['idempotency-key']!==payload.request_id)throw Error('请求编号不一致');
      receiptCalls++;const prior=receipts.get(payload.request_id);
      if(prior&&prior.raw!==raw){res.writeHead(409).end('{}');return;}
      const receipt=prior?.receipt||{request_id:payload.request_id,status:'accepted',receipt_id:'SIMULATED-'+payload.request_id,simulated:true};
      receipts.set(payload.request_id,{raw,receipt});
      if(loseReceipt){loseReceipt=false;res.destroy();return;}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(receipt));
    }catch(error){res.writeHead(400).end(JSON.stringify({error:error.message}));}
  });erp.listen(0,'127.0.0.1');await once(erp,'listening');
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'integration',SPATIAL_AUTH_PROVIDER:'local',DB_DRIVER:'sqlite',SPATIAL_LOCAL_BYPASS:'0',SPATIAL_ASSISTANT_URL:'',SPATIAL_ASSISTANT_ENABLED:'0',SPATIAL_ERP_STOCKTAKE_URL:'http://127.0.0.1:'+erp.address().port+'/adjustments',SPATIAL_ERP_STOCKTAKE_SOURCE:source,SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:'',BACKUP_INTERVAL_MS:'0'}});
  let stderr='';child.stderr.on('data',data=>{stderr=(stderr+data).slice(-2000);});
  const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('隔离实例启动超时：'+stderr)),20000);child.stdout.on('data',data=>{const m=String(data).match(/running at http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve('http://127.0.0.1:'+m[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('隔离实例退出 '+code+' '+stderr));});});
  let token,operatorToken,syncToken,offline=false,loseAck=false,clock=0,version=1,qtyA=100,qtyB=0,externalA='ERP-A-01',queueSql,queue,stocktake;
  async function request(path,body,method=body===undefined?'GET':'POST',auth=token){return fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  async function api(path,body,method,auth){const r=await request(path,body,method,auth),value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status});return value;}
  await api('/api/auth/bootstrap',credentials);
  token=(await api('/api/auth/login',credentials)).token;
  await api('/api/users',{username:'erp_lab_operator',password:credentials.password,name:'ERP验收操作员',role:'operator'});
  operatorToken=(await api('/api/auth/login',{username:'erp_lab_operator',password:credentials.password})).token;
  syncToken=(await api('/api/integration/credentials',{name:'隔离模拟ERP',source})).token;
  for(const [external_loc_code,loc_code] of [['ERP-A-01',locA],['ERP-B-01',locB]])await api('/api/integration/locations',{source,external_loc_code,loc_code});
  await api('/api/integration/source-policy',{source,expected_interval_minutes:1},'PUT');
  const row=(external_loc_code,qty)=>({sku:'ERP-6204',name:'模拟ERP轴承6204',unit:'套',external_loc_code,qty});
  const rows=()=>[row(externalA,qtyA),row('ERP-B-01',qtyB)];
  function openQueue(){
    queueSql=new DatabaseSync(join(dir,'delivery.db'));
    queue=createInventoryDelivery(queueSql,{baseUrl:base,token:syncToken,source,now:()=>Date.now()+clock,fetcher:async(url,init)=>{
      if(offline)throw Error('模拟ERP发送链路断开');
      const response=await fetch(url,init);if(loseAck&&response.ok){loseAck=false;await response.arrayBuffer();throw Error('模拟提交成功但回执丢失');}return response;
    }});
  }
  openQueue();queue.enqueue('initial',{source,version,rows:rows()});await queue.flush();
  async function state(){return {version,erp:{A:qtyA,B:qtyB},inventory:await api('/api/v1/inventory'),queue:queue.status(),stocktake,receiptCalls,uniqueReceipts:receipts.size,sourceStatus:(await api('/api/integration/status')).sources};}
  async function change(kind,qty){
    if(!Number.isFinite(qty)||qty<=0)throw Error('数量必须为正数');
    const previous=version;
    if(kind==='in')qtyA+=qty;else if(kind==='out'){if(qty>qtyA)throw Error('ERP库存不足');qtyA-=qty;}
    else if(kind==='move'){if(qty>qtyA)throw Error('ERP库存不足');qtyA-=qty;qtyB+=qty;}
    else throw Error('未知模拟业务');
    version++;const id='ERP-TX-'+version;
    queue.enqueue(id,{source,mode:'delta',base_version:previous,version,message_id:id,changes:rows().map(r=>({...r,op:'upsert'}))});
    const at=new Date().toISOString(),event=(type,loc_code,n)=>({event_id:id+'-'+type,document_no:id,type,loc_code,sku:'ERP-6204',name:'模拟ERP轴承6204',unit:'套',qty:n,occurred_at:at});
    queue.enqueue(id+'-events',{source,mode:'events',events:kind==='move'?[event('outbound',locA,qty),event('inbound',locB,qty)]:[event(kind==='in'?'inbound':'outbound',locA,qty)]});
    await queue.flush();return state();
  }
  async function action(name,body={}){
    if(['in','out','move'].includes(name))return change(name,body.qty);
    if(name==='offline'){offline=true;return state();}
    if(name==='online'){offline=false;clock+=60000;queueSql.close();openQueue();await queue.flush();return state();}
    if(name==='lose-ack'){loseAck=true;return change('in',body.qty||2);}
    if(name==='retry'){clock+=60000;await queue.flush();return state();}
    if(name==='mapping-error'){externalA='ERP-NEW-A';return change('in',1);}
    if(name==='fix-mapping'){await api('/api/integration/locations',{source,external_loc_code:externalA,loc_code:locA});const blocked=queue.status().find(r=>r.state==='blocked');if(blocked)queue.retry(blocked.id);await queue.flush();return state();}
    if(name==='reconcile'||name==='reconcile-difference')return sendInventory({baseUrl:base,token:syncToken,payload:{source,mode:'reconcile',version,rows:rows().map((r,i)=>name==='reconcile-difference'&&i===0?{...r,qty:r.qty+1}:r)}});
    if(name==='stale'){const sql=new DatabaseSync(join(dir,'spatial.db'));sql.prepare('UPDATE external_inventory_snapshot SET received_at=? WHERE source=?').run(new Date(Date.now()-120000).toISOString(),source);sql.close();return state();}
    if(name==='stocktake-send'){
      stocktake=await api('/api/erp-stocktakes',{source,loc_code:locA},'POST',operatorToken);
      stocktake=await api('/api/erp-stocktakes/'+stocktake.id,{revision:stocktake.revision,counts:stocktake.baseline.map(r=>({id:r.id,qty:r.qty-1})),reason:'隔离模拟实盘少一套'},'PUT',operatorToken);
      stocktake=await api('/api/erp-stocktakes/'+stocktake.id+'/action',{revision:stocktake.revision,action:'submit'},'POST',operatorToken);
      if((await request('/api/erp-stocktakes/'+stocktake.id+'/action',{revision:stocktake.revision,action:'approve'},'POST',operatorToken)).status!==403)throw Error('操作员越权审核');
      stocktake=await api('/api/erp-stocktakes/'+stocktake.id+'/action',{revision:stocktake.revision,action:'approve'});
      loseReceipt=true;stocktake=await api('/api/erp-stocktakes/'+stocktake.id+'/send',{revision:stocktake.revision});
      if(stocktake.state!=='uncertain')throw Error('回执丢失未保留待核对状态');
      stocktake=await api('/api/erp-stocktakes/'+stocktake.id+'/send',{revision:stocktake.revision});return state();
    }
    if(name==='stocktake-return'){
      qtyA=stocktake.counts[0].qty;const previous=version;version++;
      queue.enqueue('stocktake-'+version,{source,mode:'delta',version,base_version:previous,message_id:'stocktake-'+version,changes:rows().map(r=>({...r,op:'upsert'}))});await queue.flush();
      stocktake=await api('/api/erp-stocktakes/'+stocktake.id+'/reconcile',{revision:stocktake.revision});return state();
    }
    throw Error('未知验收动作');
  }
  const control=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    try{let raw='';for await(const part of req)raw+=part;const result=req.method==='GET'?await state():await action(req.url.slice(1),JSON.parse(raw||'{}'));res.end(JSON.stringify(result));}
    catch(error){res.writeHead(error.status||400).end(JSON.stringify({error:error.message}));}
  });control.listen(0,'127.0.0.1');await once(control,'listening');
  const info={simulation:true,baseUrl:base,controlUrl:'http://127.0.0.1:'+control.address().port,source,room,locA,locB,credentials};
  writeFileSync(join(dir,'lab.json'),JSON.stringify(info),{mode:0o600});
  return {...info,api,request,machineRequest:(path,body,method)=>request(path,body,method,syncToken),action,state,async close(){control.closeAllConnections();await new Promise(r=>control.close(r));queueSql.close();child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');erp.closeAllConnections();await new Promise(r=>erp.close(r));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const lab=await startErpSyncLab(process.argv[2]||'/lab');console.log(JSON.stringify({simulation:true,baseUrl:lab.baseUrl,controlUrl:lab.controlUrl}));
  for(const event of ['SIGTERM','SIGINT'])process.once(event,async()=>{await lab.close();process.exit(0);});
}
