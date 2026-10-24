import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('存放资料HTTP：分仓权限、只读、保存回执、尺寸推荐及三维重量一致',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'storage-http-')),child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',DB_DRIVER:'sqlite',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:''}});let logs='';child.stderr.on('data',chunk=>logs+=chunk);
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时 '+logs)),15000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
    const call=(path,token,method='GET',body)=>fetch('http://127.0.0.1:'+port+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const json=async(...args)=>{const r=await call(...args),v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
    const password='Storage-20261019!';await json('/api/auth/bootstrap',null,'POST',{username:'admin',password});const admin=(await json('/api/auth/login',null,'POST',{username:'admin',password})).token;
    const worker=await json('/api/users',admin,'POST',{username:'worker',password,role:'operator'});await json('/api/users',admin,'POST',{username:'viewer',password,role:'viewer'});
    const token=(await json('/api/auth/login',null,'POST',{username:'worker',password})).token,viewer=(await json('/api/auth/login',null,'POST',{username:'viewer',password})).token;
    const room=await json('/api/rooms',admin,'POST',{name:'尺寸推荐验收',w:12,d:8,h:4,door:[{side:'back',offset:.5}]}),rack=await json('/api/rack',admin,'POST',{roomCode:room.loc_code,rows:2,cols:2,x:0,z:0}),loc=rack.furn_code+'-L01-B01';
    const item=await json('/api/counter/inbound',token,'POST',{name:'包装物料',sku:'STORAGE-HTTP',loc_code:loc,qty:10,unit:'箱'}),path='/api/items/'+item.item_id+'/storage';
    await json('/api/integration/warehouse-access',admin,'PUT',{user_id:worker.id,sites:['WH']});const initial=await json(path,token);
    const input={revision:initial.revision,profile:{width:.2,height:.3,depth:.2,weight_kg:2,required_tags:['干燥'],horizontal_rotation:false},request_id:'storage-http-save'};
    assert.equal((await call(path)).status,401);assert.equal((await call(path,viewer,'POST',input)).status,403);
    await json(path,token,'POST',input);assert.equal((await json(path,token,'POST',input)).replayed,true);assert.equal((await json(path+'/history',token)).length,1);
    let result=await json('/api/work/recommendations?'+new URLSearchParams({room:room.loc_code,item_id:item.item_id,qty:2,unit:'箱'}),token);assert.equal(result.candidates.length,0);
    const meta=(await json('/api/scene?room='+room.loc_code,admin)).furniture[0].cellMeta['L01-B01'];await json('/api/cell/'+loc+'/meta',admin,'PUT',{tags:['干燥'],capacity:50,max_load:100,revision:meta.revision});
    result=await json('/api/work/recommendations?'+new URLSearchParams({room:room.loc_code,item_id:item.item_id,qty:2,unit:'箱'}),token);assert.equal(result.candidates[0].loc_code,loc);assert.ok(result.candidates[0].reasons.some(v=>v.includes('条件标签')));assert.ok(result.route.available);
    const scene=await json('/api/scene?room='+room.loc_code,token),visible=Object.values(scene.furniture[0].items).flat().find(row=>row.id===item.item_id);assert.equal(visible.unit_weight_kg,2);assert.equal(visible.qty,10);
    assert.equal(visible.storage_profile.width,.2);
    const capacityBody={revision:scene.furniture[0].cellMeta['L01-B01'].revision,capacity_rule:{product:{sku:visible.sku,unit:visible.unit},capacity:80}};
    assert.equal((await call('/api/cell/'+loc+'/meta',viewer,'PUT',capacityBody)).status,403);
    await json('/api/cell/'+loc+'/meta',admin,'PUT',capacityBody);
    assert.equal((await call('/api/cell/'+loc+'/meta',admin,'PUT',capacityBody)).status,409);
    const calibrated=await json('/api/scene?room='+room.loc_code,token);
    assert.equal(calibrated.furniture[0].cellMeta['L01-B01'].capacity_rules[0].capacity,80);
    assert.equal(calibrated.furniture[0].items['L01-B01'][0].qty,10);
    assert.equal((await json('/api/cells/'+loc+'/items',token))[0].qty,10);
    await json('/api/integration/warehouse-access',admin,'PUT',{user_id:worker.id,sites:[]});assert.equal((await call(path,token)).status,404);assert.equal((await call(path+'/history',token)).status,404);assert.equal((await call(path,token,'POST',input)).status,404);
  }finally{child.kill('SIGTERM');await once(child,'exit');rmSync(dir,{recursive:true,force:true});}
});
