import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateAssistantSettings} from '../apps/api/assistant-settings.mjs';

test('模型设置只接受明确启用选项和有效服务地址',()=>{
  const config={enabled:true,url:'http://192.168.1.20:11434/',model:'qwen3:4b'};
  assert.equal(validateAssistantSettings(config).url,'http://192.168.1.20:11434');
  for(const url of ['file:///tmp/a','http://user:password@model/','http://model/?key=test','http://model/#test'])assert.throws(()=>validateAssistantSettings({...config,url}));
  assert.throws(()=>validateAssistantSettings({...config,enabled:'false'}));
  assert.throws(()=>validateAssistantSettings({...config,model:''}));
  assert.deepEqual(validateAssistantSettings({enabled:false,url:'',model:''}),{enabled:false,url:'',model:''});
});

for(const mode of ['standalone','integration'])test(mode+'：设置权限、停用业务独立、运行时启用及重启持久化',async()=>{
  let modelCalls=0;
  const model=createServer(async(req,res)=>{
    modelCalls++;let raw='';for await(const chunk of req)raw+=chunk;
    if(['/api/tags','/api/ps'].includes(req.url)){res.end(JSON.stringify({models:[{name:'settings-fixture'}]}));return;}
    assert.equal(req.url,'/api/chat');res.end(JSON.stringify({message:{role:'assistant',tool_calls:[{function:{name:'find_stock',arguments:{query:'轴承'}}}]}}));
  });model.listen(0,'127.0.0.1');await once(model,'listening');
  const dir=mkdtempSync(join(tmpdir(),'assistant-settings-'));
  let child,base;
  async function start(){
    child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',DB_DRIVER:'sqlite',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:mode,SPATIAL_AUTH_PROVIDER:'local',SPATIAL_ASSISTANT_URL:'',SPATIAL_ASSISTANT_ENABLED:'0',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:''}});
    base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),20000);child.stdout.on('data',data=>{const match=String(data).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code));});});
  }
  async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
  const call=(path,token,method='GET',body)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const json=async(...args)=>{const response=await call(...args),data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  try{
    await start();await json('/api/auth/bootstrap',null,'POST',{username:'admin',password:'Test-Settings-20261018!'});
    const admin=(await json('/api/auth/login',null,'POST',{username:'admin',password:'Test-Settings-20261018!'})).token;
    for(const role of ['operator','viewer'])await json('/api/users',admin,'POST',{username:role,password:'Test-Settings-20261018!',role});
    const operator=(await json('/api/auth/login',null,'POST',{username:'operator',password:'Test-Settings-20261018!'})).token;
    const viewer=(await json('/api/auth/login',null,'POST',{username:'viewer',password:'Test-Settings-20261018!'})).token;
    const config={enabled:true,url:'http://127.0.0.1:'+model.address().port,model:'settings-fixture'};
    const room=(await json('/api/rooms',admin))[0].loc_code,before=await json('/api/v1/inventory',admin);
    for(const token of [null,operator,viewer])for(const [path,method,body] of [['/api/admin/assistant-model','GET'],['/api/admin/assistant-model','PUT',config],['/api/admin/assistant-model/connect','POST',{}]])assert.ok([401,403].includes((await call(path,token,method,body)).status));
    assert.equal((await json('/api/assistant/status',viewer)).state,'disabled');assert.equal(modelCalls,0);
    const guide=await json('/api/assistant/preview',admin,'POST',{room,tool:'setup_progress',input:{}});assert.equal(guide.kind,'setup_progress');
    await json('/api/assistant/preview',viewer,'POST',{room,tool:'find_stock',input:{query:'轴承'}});
    if(mode==='standalone'){
      const row=before.find(r=>r.qty>0);assert.ok(row);
      const draft=await json('/api/assistant/preview',operator,'POST',{room,tool:'prepare_batch',input:{operations:[{operation:'out',query:row.name,qty:1,from_loc:row.loc_code,unit:row.unit}]},request_id:'settings-independent'});assert.equal(draft.kind,'job');
    }
    await json('/api/admin/assistant-model',admin,'PUT',config);
    assert.equal((await json('/api/admin/assistant-model/connect',admin,'POST',{})).status.state,'ready');
    const publicStatus=await json('/api/assistant/status',viewer);assert.equal(publicStatus.available,true);assert.equal(publicStatus.url,undefined);assert.ok(!JSON.stringify(publicStatus).includes(config.url));
    const answer=await json('/api/assistant/ask',viewer,'POST',{room,message:'轴承在哪里'});assert.equal(answer.results[0].kind,'stock');
    await stop();const callsBeforeRestart=modelCalls;await start();await new Promise(resolve=>setTimeout(resolve,50));assert.equal(modelCalls,callsBeforeRestart);
    const saved=await json('/api/admin/assistant-model',admin);assert.equal(saved.config.url,config.url);assert.equal(saved.config.enabled,true);assert.equal(saved.status.state,'idle');
    const disabled=await json('/api/admin/assistant-model',admin,'PUT',{...config,enabled:false});assert.equal(disabled.status.state,'disabled');
    assert.deepEqual(await json('/api/v1/inventory',admin),before);
  }finally{await stop();model.closeAllConnections();await new Promise(resolve=>model.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
