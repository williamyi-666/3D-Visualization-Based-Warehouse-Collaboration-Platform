// 固定仿真基准。只启动临时实例，不读取现有库存、凭据或部署配置。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir,cpus,totalmem,platform,release} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {mountLiveInventory} from '../apps/web/prototype/live-inventory.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const outIndex=process.argv.indexOf('--out');
const out=resolve(outIndex>=0?process.argv[outIndex+1]:'output/benchmark');
const dir=mkdtempSync(join(tmpdir(),'spatial-oa2026-'));
const env={...process.env};
for(const key of Object.keys(env))if(/^(SPATIAL_|SUPOS_|OUTBOUND_)/.test(key)||key==='PGURL')delete env[key];
Object.assign(env,{PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:'',DB_DRIVER:'sqlite',NODE_NO_WARNINGS:'1'});
const start=performance.now(),child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
const raw=[];let logs='',cleanupObserver=()=>{};
child.stderr.on('data',chunk=>logs+=chunk);
const password=randomUUID()+'!';let base,admin,worker,reader;
const round=n=>Math.round(n*100)/100;
const record=(metric,index,startTime,extra={})=>raw.push({metric,sample:index,ms:round(performance.now()-startTime),...extra});
const call=(path,token,method='GET',body)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
async function json(path,token=admin,method='GET',body){const res=await call(path,token,method,body),value=await res.json();assert.ok(res.ok,path+' '+JSON.stringify(value));return value;}
const q=(a,p)=>a[Math.ceil(a.length*p)-1];
try{
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('临时服务启动超时 '+logs)),20000);child.stdout.on('data',b=>{const m=String(b).match(/running at http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('临时服务退出 '+code+' '+logs));});});
  base='http://127.0.0.1:'+port;await json('/api/health',null);record('server_startup_ms',1,start);
  await json('/api/auth/bootstrap',null,'POST',{username:'benchmark-admin',password,name:'仿真基准管理员'});
  admin=(await json('/api/auth/login',null,'POST',{username:'benchmark-admin',password})).token;
  for(const [username,role] of [['benchmark-worker','operator'],['benchmark-reader','viewer']])await json('/api/users',admin,'POST',{username,password,role});
  worker=(await json('/api/auth/login',null,'POST',{username:'benchmark-worker',password})).token;
  reader=(await json('/api/auth/login',null,'POST',{username:'benchmark-reader',password})).token;
  for(let i=1;i<=10;i++){
    const t=performance.now(),room=(await json('/api/rooms',admin,'POST',{name:'建仓仿真-'+i,w:16,d:12,h:5})).loc_code;
    const params={room,roomCode:room,template:'shelf',count:6,perRow:3,aisle:1.2,gap:.3};
    const preview=await json('/api/setup/preview?'+new URLSearchParams(params));
    const result=await json('/api/setup/racks',admin,'POST',{...params,revision:preview.revision,request_id:randomUUID()});
    assert.equal(result.cellCount,72);record('build_6_racks_72_cells_ms',i,t,{racks:6,cells:72});
  }
  const room=(await json('/api/rooms',admin,'POST',{name:'1000格仿真检索与同步',w:40,d:20,h:6})).loc_code;
  const params={room,roomCode:room,template:'rack',count:10,perRow:5,aisle:1.5,gap:.5,w:4,h:4,d:.8,rows:10,cols:10};
  const preview=await json('/api/setup/preview?'+new URLSearchParams(params));
  const built=await json('/api/setup/racks',admin,'POST',{...params,revision:preview.revision,request_id:randomUUID()});
  assert.equal(built.cellCount,1000);
  const stock=[];
  for(let i=0;i<100;i++){
    const loc=built.created[Math.floor(i/10)]+'-L01-B'+String(i%10+1).padStart(2,'0');
    stock.push(await json('/api/counter/inbound',worker,'POST',{name:'仿真轴承-'+String(i).padStart(3,'0'),sku:'SIM-'+String(i).padStart(3,'0'),loc_code:loc,qty:20+i%20,unit:'箱',request_id:randomUUID()}));
  }
  // 首次预热单列；查询样本均使用正常的搜索接口，不调用数据库内部方法。
  await json('/api/search?q=SIM-050',reader);
  for(let i=1;i<=50;i++){const t=performance.now(),rows=await json('/api/search?q=SIM-'+String(i%100).padStart(3,'0'),reader);assert.ok(JSON.stringify(rows).includes('SIM-'+String(i%100).padStart(3,'0')));record('search_api_ms',i,t);}
  for(let i=1;i<=20;i++){const t=performance.now(),scene=await json('/api/scene?room='+room,reader);assert.equal(scene.furniture.length,10);record('scene_api_1000_cells_ms',i,t);}
  const loc=built.created[0]+'-L01-B01',target=built.created[0]+'-L01-B02',item=stock[0].item_id;
  // 第二个独立登录会话使用网页同一自动同步模块；不宣称这是手机渲染或无线网络性能。
  const doc=new EventTarget();doc.hidden=false;const win=new EventTarget();let expected=null,observed,subscribed;
  const ready=new Promise(resolve=>subscribed=resolve);
  cleanupObserver=mountLiveInventory({getRoom:()=>room,isBusy:()=>false,doc,win,
    fetcher:(path,options={})=>fetch(base+path,{...options,headers:{Authorization:'Bearer '+reader}}),
    status:message=>{if(message==='库存自动同步已连接')subscribed();},
    refresh:async()=>{const scene=await json('/api/scene?room='+room,reader);const qty=scene.furniture[0].items['L01-B01'].find(row=>row.id===item).qty;if(expected!==null&&qty===expected){const done=observed;observed=null;done?.();}}
  });
  await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('订阅超时')),10000))]);
  let quantity=20;
  for(let i=1;i<=20;i++){
    expected=++quantity;let timer;
    const done=new Promise((resolve,reject)=>{observed=resolve;timer=setTimeout(()=>reject(Error('协同观察超时')),10000);});
    const t=performance.now();await json('/api/counter/inbound',worker,'POST',{item_id:item,sku:'SIM-000',name:'仿真轴承-000',loc_code:loc,qty:1,unit:'箱',request_id:randomUUID()});
    await done;clearTimeout(timer);record('write_to_second_session_model_ms',i,t);
  }
  cleanupObserver();cleanupObserver=()=>{};
  const model=await json('/api/assistant/status');
  assert.equal(model.configured,false);assert.equal(model.available,false);
  const t=performance.now(),inbound=await json('/api/counter/inbound',worker,'POST',{name:'无模型业务样例',sku:'NO-MODEL-SIM',loc_code:loc,qty:10,unit:'件',request_id:randomUUID()});
  await json('/api/counter/outbound',worker,'POST',{loc_code:loc,item_id:inbound.item_id,qty:2,request_id:randomUUID()});
  await json('/api/counter/move',worker,'POST',{from_loc:loc,to_loc:target,item_id:inbound.item_id,qty:3,request_id:randomUUID()});
  assert.equal((await json('/api/cells/'+loc+'/items')).find(row=>row.item_id===inbound.item_id).qty,5);
  assert.equal((await json('/api/cells/'+target+'/items')).find(row=>row.item_id===inbound.item_id).qty,3);
  let count=await json('/api/stocktakes',worker,'POST',{loc_code:loc});
  count=await json('/api/stocktakes/'+count.id,worker,'PUT',{revision:count.revision,counts:count.baseline.map(row=>({item_id:row.item_id,qty:row.qty})),reason:'无模型仿真验收'});
  count=await json('/api/stocktakes/'+count.id+'/finish',worker,'POST',{action:'confirm',revision:count.revision});
  assert.equal(count.state,'confirmed');
  assert.equal((await call('/api/counter/outbound',reader,'POST',{loc_code:loc,item_id:inbound.item_id,qty:1})).status,403);
  record('no_model_in_out_move_stocktake_verify_ms',1,t,{passed:true,source_qty:5,target_qty:3,stocktake:count.state});
  const metrics=[...new Set(raw.map(row=>row.metric))].map(metric=>{const values=raw.filter(row=>row.metric===metric).map(row=>row.ms).sort((a,b)=>a-b);return {metric,samples:values.length,min_ms:values[0],median_ms:round(q(values,.5)),p95_ms:round(q(values,.95)),max_ms:values.at(-1)};});
  const report={type:'固定仿真环境实测',version:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,created_at:new Date().toISOString(),environment:{node:process.version,os:platform()+' '+release(),cpu:cpus()[0]?.model,logical_cpus:cpus().length,visible_memory_gb:round(totalmem()/1024**3),transport:'容器内部回环 HTTP；两个独立登录会话；真实前端同步模块，无浏览器渲染'},fixture:{rooms_for_build:10,racks_per_build:6,cells_per_build:72,query_scene_cells:1000,query_scene_skus:100,query_scene_stock_rows:100},no_model:{configured:false,status:model,business_passed:true},limitations:['非企业现场数据','建仓指标不包含人工填写、货架实物部署或软件安装','查询指标是API响应，不是点击到3D飞行完成','同步指标包含提交、通知及第二会话数据读取，不含真实手机渲染或Wi-Fi链路','样本较少的指标仅为一次功能检查，不作性能结论'],metrics};
  mkdirSync(out,{recursive:true});writeFileSync(join(out,'summary.json'),JSON.stringify(report,null,2)+'\n');writeFileSync(join(out,'samples.json'),JSON.stringify(raw,null,2)+'\n');
  const csv=['metric,sample,ms',...raw.map(row=>[row.metric,row.sample,row.ms].join(','))].join('\r\n');writeFileSync(join(out,'samples.csv'),'\ufeff'+csv+'\r\n');
  const digest=createHash('sha256').update(readFileSync(join(out,'samples.json'))).digest('hex');writeFileSync(join(out,'samples.sha256'),digest+'  samples.json\n');
  console.log(JSON.stringify({completed:true,metrics,no_model_business_passed:true,sample_sha256:digest}));
}finally{
  cleanupObserver();child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');
  assert.ok(dir.startsWith(join(tmpdir(),'spatial-oa2026-')));rmSync(dir,{recursive:true,force:true});
}
