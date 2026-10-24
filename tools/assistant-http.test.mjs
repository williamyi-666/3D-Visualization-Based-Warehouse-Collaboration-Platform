import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('助手HTTP权限：只读可查货，草稿不写库存，模型等待中撤销会话不泄露数据',async()=>{
  let base='',expireToken='';
  const model=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'test-model'}]}));return;}
    if(req.url==='/api/ps'){res.end(JSON.stringify({models:[{name:'test-model'}]}));return;}
    const body=JSON.parse(raw),message=body.messages.at(-1).content;
    if(message==='expire')await fetch(base+'/api/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+expireToken}});
    const fn=message==='move'?{name:'prepare_operation',arguments:{operation:'move',query:'轴承',qty:3,from_hint:'A架',to_hint:'B架'}}:message==='delete'?{name:'delete_all',arguments:{}}:{name:'find_stock',arguments:{query:'轴承'}};
    res.end(JSON.stringify({message:{role:'assistant',content:'',tool_calls:[{function:fn}]}}));
  });model.listen(0,'127.0.0.1');await once(model,'listening');
  const dir=mkdtempSync(join(tmpdir(),'assistant-http-'));
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',DB_DRIVER:'sqlite',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SPATIAL_ASSISTANT_URL:'http://127.0.0.1:'+model.address().port,SPATIAL_ASSISTANT_MODEL:'test-model',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:''}});
  try {
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),15000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code));});});base='http://127.0.0.1:'+port;
    const call=(path,token,method='GET',body)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const json=async(path,token,method,body)=>{const response=await call(path,token,method,body);const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
    await json('/api/auth/bootstrap',null,'POST',{username:'admin',password:'Test-20261013!'});
    const admin=(await json('/api/auth/login',null,'POST',{username:'admin',password:'Test-20261013!'})).token;
    for(const role of ['operator','viewer'])await json('/api/users',admin,'POST',{username:role,password:'Test-20261013!',role});
    const viewer=(await json('/api/auth/login',null,'POST',{username:'viewer',password:'Test-20261013!'})).token;
    expireToken=(await json('/api/auth/login',null,'POST',{username:'operator',password:'Test-20261013!'})).token;
    const room=(await json('/api/rooms',admin))[0].loc_code,body={room,message:'stock'};
    const before=await json('/api/v1/inventory',admin);
    assert.equal((await call('/api/assistant/ask',null,'POST',body)).status,401);
    assert.equal((await json('/api/assistant/status',viewer)).available,true);
    const answer=await json('/api/assistant/ask',viewer,'POST',body);assert.ok(answer.results[0].rows.length);
    assert.equal((await call('/api/assistant/ask',viewer,'POST',{room,message:'move'})).status,403);
    assert.equal((await call('/api/assistant/draft',viewer,'POST',{room,input:{operation:'move'}})).status,403);
    assert.equal((await call('/api/assistant/ask',admin,'POST',{room,message:'delete'})).status,400);
    const expired=await call('/api/assistant/ask',expireToken,'POST',{room,message:'expire'});assert.equal(expired.status,401);assert.equal((await expired.json()).results,undefined);
    assert.deepEqual(await json('/api/v1/inventory',admin),before);
  }finally{child.kill('SIGTERM');await once(child,'exit');model.close();await once(model,'close');rmSync(dir,{recursive:true,force:true});}
});
