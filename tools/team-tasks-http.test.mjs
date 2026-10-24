import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('本地分仓与团队任务HTTP：真实登录、越权拦截、预占和双端领取',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'team-http-')),child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:'',DB_DRIVER:'sqlite'}});let logs='';child.stderr.on('data',chunk=>logs+=chunk);
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时 '+logs)),15000);child.stdout.on('data',chunk=>{const match=String(chunk).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
    const call=(path,token,method='GET',body)=>fetch('http://127.0.0.1:'+port+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const json=async(...args)=>{const response=await call(...args),data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
    const password='Team-20261019!';await json('/api/auth/bootstrap',null,'POST',{username:'admin',password,name:'管理员'});
    const admin=(await json('/api/auth/login',null,'POST',{username:'admin',password})).token;
    const worker=await json('/api/users',admin,'POST',{username:'worker',password,role:'operator'}),other=await json('/api/users',admin,'POST',{username:'other',password,role:'operator'});
    const workerId=worker.id||worker.user?.id,otherId=other.id||other.user?.id;
    const a=(await json('/api/auth/login',null,'POST',{username:'worker',password})).token,b=(await json('/api/auth/login',null,'POST',{username:'other',password})).token;
    const room=await json('/api/rooms',admin,'POST',{name:'任务验收',w:12,d:8,h:4}),rack=await json('/api/rack',admin,'POST',{roomCode:room.loc_code,rows:1,cols:2});
    const loc=rack.furn_code+'-L01-B01',item=await json('/api/counter/inbound',a,'POST',{loc_code:loc,name:'团队轴承',sku:'TEAM-HTTP',qty:10,unit:'套'});
    assert.ok((await json('/api/integration/access-users',admin)).some(user=>user.id===workerId));
    await json('/api/integration/warehouse-access',admin,'PUT',{user_id:otherId,sites:[]});
    assert.equal((await call('/api/work/opening?loc_code='+loc,b)).status,403);assert.equal((await call('/api/counter/inbound',b,'POST',{loc_code:loc,name:'禁止写入',qty:1})).status,403);
    assert.ok(!(await json('/api/team-tasks/members?room='+room.loc_code,admin)).some(user=>user.id===otherId));
    assert.equal((await call('/api/integration/warehouse-access',a,'PUT',{user_id:workerId,sites:[]})).status,403);
    const input={room:room.loc_code,title:'领用单',assignee_id:workerId,document_no:'REQ-HTTP',recipient:'生产班组',lines:[{operation:'out',item_id:item.item_id,from_loc:loc,qty:8}],request_id:'http-create'};
    assert.equal((await call('/api/team-tasks',a,'POST',input)).status,403);let task=(await json('/api/team-tasks',admin,'POST',input)).task;
    assert.equal((await json('/api/cells/'+loc+'/items',a))[0].available_qty,2);
    assert.equal((await call('/api/counter/outbound',a,'POST',{loc_code:loc,item_id:item.item_id,qty:3})).status,400);
    task=(await json('/api/team-tasks/'+task.id+'/actions',a,'POST',{action:'claim',revision:task.revision,request_id:'http-claim'})).task;
    const second=(await json('/api/auth/login',null,'POST',{username:'worker',password})).token;
    const body={action:'execute',revision:task.revision,line_id:task.lines[0].id,qty:3,request_id:'http-execute'};
    const done=await json('/api/team-tasks/'+task.id+'/actions',second,'POST',body);assert.equal(done.task.lines[0].done_qty,3);
    assert.equal((await json('/api/team-tasks/'+task.id+'/actions',a,'POST',body)).replayed,true);assert.equal((await json('/api/cells/'+loc+'/items',a))[0].qty,7);
    assert.equal((await json('/api/cell/'+loc+'/history',a))[0].business.document_no,'REQ-HTTP');
    await json('/api/integration/warehouse-access',admin,'PUT',{user_id:workerId,sites:[]});assert.equal((await call('/api/team-tasks/'+task.id,a)).status,403);
    await json('/api/team-tasks/'+task.id+'/actions',admin,'POST',{action:'cancel',revision:done.task.revision,note:'撤权后由管理员释放剩余任务',request_id:'http-cancel'});
    assert.equal((await json('/api/cells/'+loc+'/items',admin))[0].reserved_qty,undefined);
    for(const user_id of [workerId,otherId])await json('/api/integration/warehouse-access',admin,'PUT',{user_id,sites:['WH']});
    const pool=(await json('/api/team-tasks',admin,'POST',{...input,title:'并发领取验收',assignee_id:null,lines:[{operation:'out',item_id:item.item_id,from_loc:loc,qty:2}],request_id:'http-pool'})).task;
    const claims=await Promise.all([call('/api/team-tasks/'+pool.id+'/actions',a,'POST',{action:'claim',revision:pool.revision,request_id:'claim-a'}),call('/api/team-tasks/'+pool.id+'/actions',b,'POST',{action:'claim',revision:pool.revision,request_id:'claim-b'})]);
    assert.equal(claims.filter(response=>response.ok).length,1);assert.ok(claims.filter(response=>!response.ok).every(response=>[403,404,409].includes(response.status)));
    const claimed=await json('/api/team-tasks/'+pool.id,admin);assert.equal(claimed.status,'active');assert.ok([workerId,otherId].includes(claimed.assignee_id));
    await json('/api/team-tasks/'+pool.id+'/actions',admin,'POST',{action:'cancel',revision:claimed.revision,note:'并发领取验收结束',request_id:'cancel-pool'});
  }finally{child.kill('SIGTERM');await once(child,'exit');rmSync(dir,{recursive:true,force:true});}
});
