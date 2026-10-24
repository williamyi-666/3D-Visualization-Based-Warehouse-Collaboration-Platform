import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('编码管理HTTP：管理员整理，操作员使用别码，手机电脑读取一致',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'item-codes-http-'));
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:'',DB_DRIVER:'sqlite'}});
  let logs='';child.stderr.on('data',chunk=>logs+=chunk);
  try {
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时 '+logs)),15000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
    const call=(path,token,method='GET',body)=>fetch('http://127.0.0.1:'+port+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const json=async(...args)=>{const response=await call(...args),result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;};
    const password='Codes-20261019!';await json('/api/auth/bootstrap',null,'POST',{username:'codes-admin',password,name:'编码管理员'});
    const admin=(await json('/api/auth/login',null,'POST',{username:'codes-admin',password})).token;
    for(const role of ['operator','viewer'])await json('/api/users',admin,'POST',{username:role,password,role});
    const operator=(await json('/api/auth/login',null,'POST',{username:'operator',password})).token;
    const viewer=(await json('/api/auth/login',null,'POST',{username:'viewer',password})).token;
    const loc=(await json('/api/cells',admin))[0].loc_code;
    const item=await json('/api/counter/inbound',operator,'POST',{name:'HTTP轴承',sku:'TMP-HTTP',loc_code:loc,qty:5,unit:'套'});
    const path='/api/admin/item-codes/'+item.item_id,detail=await json(path,admin),body={revision:detail.revision,sku:'HTTP-6204',codes:[{code:'SUP-HTTP-6204',kind:'supplier'}],request_id:'http-rename'};
    assert.equal((await call('/api/admin/item-codes')).status,401);
    assert.equal((await call(path,operator)).status,403);assert.equal((await call(path,viewer,'POST',body)).status,403);
    await json(path,admin,'POST',body);assert.equal((await json(path,admin,'POST',body)).replayed,true);
    for(const token of [admin,operator,viewer])for(const code of ['TMP-HTTP','HTTP-6204','SUP-HTTP-6204'])assert.equal((await json('/api/items/by-code?code='+code,token)).item_id,item.item_id);
    assert.equal((await json('/api/counter/inbound',operator,'POST',{name:'供方名称',sku:'SUP-HTTP-6204',loc_code:loc,qty:2,unit:'套'})).item_id,item.item_id);
    const second=(await json('/api/auth/login',null,'POST',{username:'operator',password})).token;
    assert.equal((await json('/api/cells/'+loc+'/items',second)).find(row=>row.item_id===item.item_id).qty,7);
    assert.equal((await json(path+'/history',admin)).length,1);
  }finally{child.kill('SIGTERM');await once(child,'exit');rmSync(dir,{recursive:true,force:true});}
});
