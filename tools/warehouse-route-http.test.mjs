import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('路线HTTP：真实身份、分仓、合并码、布局变化及规划不改库存',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'route-http-'));
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',DB_DRIVER:'sqlite',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:''}});let logs='';child.stderr.on('data',chunk=>logs+=chunk);
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时 '+logs)),15000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
    const call=(path,token,method='GET',body)=>fetch('http://127.0.0.1:'+port+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const json=async(...args)=>{const r=await call(...args),v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
    const password='Route-20261019!';await json('/api/auth/bootstrap',null,'POST',{username:'admin',password});
    const admin=(await json('/api/auth/login',null,'POST',{username:'admin',password})).token;
    const worker=await json('/api/users',admin,'POST',{username:'worker',password,role:'operator'}),token=(await json('/api/auth/login',null,'POST',{username:'worker',password})).token;
    const room=(await json('/api/rooms',admin,'POST',{name:'取货路线',w:12,d:8,h:4,door:[{side:'back',offset:.5}]})).loc_code;
    const a=(await json('/api/rack',admin,'POST',{roomCode:room,name:'A架',rows:2,cols:2,x:-2,z:0})).furn_code;
    const b=(await json('/api/rack',admin,'POST',{roomCode:room,name:'B架',rows:2,cols:2,x:2,z:0})).furn_code;
    const from=a+'-L01-B01',target=b+'-L01-B01';
    const item=await json('/api/counter/inbound',token,'POST',{name:'路线货品',sku:'ROUTE-01',qty:10,unit:'套',loc_code:from,request_id:'route-stock'});
    await json('/api/integration/warehouse-access',admin,'PUT',{user_id:worker.id,sites:['WH']});
    const options=await json('/api/work/route-options?room='+room,token);assert.equal(options.entrances.length,1);
    const query=new URLSearchParams({room,locations:[from,target].join(','),revision:options.layout.revision});
    const route=await json('/api/work/route?'+query,token);assert.equal(route.stops.length,2);assert.equal(route.unreachable.length,0);assert.ok(route.distance>0);
    assert.equal((await call('/api/work/route?'+query)).status,401);
    assert.equal((await call('/api/work/route?'+new URLSearchParams({room,locations:'WH-1-A-L01-B01'}),token)).status,403);
    assert.equal((await call('/api/work/route?'+new URLSearchParams({room,locations:from,clearance:'0'}),token)).status,400);
    assert.equal((await json('/api/cells/'+from+'/items',token))[0].qty,10);
    assert.equal((await json('/api/cell/'+from+'/history',token)).filter(v=>v.item_id===item.item_id).length,1);
    await json('/api/rack/'+a+'/merges',admin,'PUT',{merges:{L01:[[1,2]]}});
    assert.equal((await call('/api/work/route?'+query,token)).status,409);
    const merged=await json('/api/work/route?'+new URLSearchParams({room,locations:a+'-L01-B02',start_loc:target}),token);assert.equal(merged.stops[0].loc_code,from);
    await json('/api/integration/warehouse-access',admin,'PUT',{user_id:worker.id,sites:[]});
    assert.equal((await call('/api/work/route-options?room='+room,token)).status,403);assert.equal((await call('/api/work/route?'+query,token)).status,403);
  }finally{child.kill('SIGTERM');await once(child,'exit');rmSync(dir,{recursive:true,force:true});}
});
