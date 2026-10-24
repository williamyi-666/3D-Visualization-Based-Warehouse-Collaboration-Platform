import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('新工作台HTTP：真实登录、角色、建仓、建账和多端读取',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'warehouse-work-http-'));
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:'',DB_DRIVER:'sqlite'}});
  let logs='';child.stderr.on('data',chunk=>logs+=chunk);
  try {
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时 '+logs)),15000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
    const base='http://127.0.0.1:'+port;
    const call=(path,token,method='GET',body)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const json=async(path,token,method,body)=>{const response=await call(path,token,method,body);const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;};
    await json('/api/auth/bootstrap',null,'POST',{username:'test-admin',password:'Test-20261013!',name:'测试管理员'});
    const admin=(await json('/api/auth/login',null,'POST',{username:'test-admin',password:'Test-20261013!'})).token;
    for(const role of ['operator','viewer'])await json('/api/users',admin,'POST',{username:role,password:'Test-20261013!',role});
    const operator=(await json('/api/auth/login',null,'POST',{username:'operator',password:'Test-20261013!'})).token;
    const viewer=(await json('/api/auth/login',null,'POST',{username:'viewer',password:'Test-20261013!'})).token;
    const room=(await json('/api/rooms',admin,'POST',{name:'落地验收',w:12,d:8,h:4})).loc_code;
    const params={room,roomCode:room,template:'shelf',count:2,perRow:2,aisle:1.2,gap:0.3};
    const preview=await json('/api/setup/preview?'+new URLSearchParams(params),admin);
    const build={...params,revision:preview.revision,request_id:'http-build'};
    assert.equal((await call('/api/setup/racks',operator,'POST',build)).status,403);
    assert.equal((await call('/api/setup/racks',viewer,'POST',build)).status,403);
    const generated=await json('/api/setup/racks',admin,'POST',build);assert.equal(generated.cellCount,24);
    assert.equal((await json('/api/setup/racks',admin,'POST',build)).replayed,true);
    const from=generated.created[0]+'-L01-B01';
    const snapshot=await json('/api/work/opening?loc_code='+from,operator);
    const opening={loc_code:from,baseline:snapshot.baseline,rows:[{name:'HTTP底账货品',qty:12,unit:'箱'}],request_id:'http-opening'};
    assert.equal((await call('/api/work/opening',viewer,'POST',opening)).status,403);
    const added=await json('/api/work/opening',operator,'POST',opening);assert.match(added.rows[0].sku,/^TMP-/);
    const secondSession=(await json('/api/auth/login',null,'POST',{username:'operator',password:'Test-20261013!'})).token;
    assert.equal((await json('/api/cells/'+from+'/items',secondSession))[0].qty,12);
    assert.equal((await json('/api/work/opening',operator,'POST',opening)).replayed,true);
    assert.equal((await json('/api/cells/'+from+'/items',viewer))[0].qty,12);
    const recommendations=await json('/api/work/recommendations?'+new URLSearchParams({room,sku:added.rows[0].sku,qty:2,unit:'箱'}),operator);assert.equal(recommendations.candidates[0].loc_code,from);
    const rules={room,count_days:7,thresholds:[{item_id:added.rows[0].item_id,minimum:20}]};
    assert.equal((await call('/api/work/policy',operator,'PUT',rules)).status,403);await json('/api/work/policy',admin,'PUT',rules);
    assert.ok((await json('/api/work/tasks?room='+room,operator)).rows.some(t=>t.kind==='low'));
    assert.equal((await call('/api/work/tasks?room='+room)).status,401);
  }finally{child.kill('SIGTERM');await once(child,'exit');rmSync(dir,{recursive:true,force:true});}
});
