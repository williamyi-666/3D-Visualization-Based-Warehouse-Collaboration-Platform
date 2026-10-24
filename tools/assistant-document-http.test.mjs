import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('整单HTTP入口在无模型下可用，鉴权、私人清单和团队交接保持一致',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'document-http-'));
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',DB_DRIVER:'sqlite',SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_ASSISTANT_URL:'',SPATIAL_ASSISTANT_ENABLED:'0',OUTBOUND_BASE_URL:'',SUPOS_MQTT_URL:''}});
  let errors='';child.stderr.on('data',s=>errors+=s);
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors)),15000);child.stdout.on('data',s=>{const match=String(s).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('测试服务退出 '+code+' '+errors));});});
    const base='http://127.0.0.1:'+port;
    const request=async(path,token,body)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json(),cache:response.headers.get('cache-control')};};
    const api=async(...args)=>{const result=await request(...args);assert.ok(result.status<300,JSON.stringify(result));return result.data;};
    await api('/api/auth/bootstrap',null,{username:'admin',password:'Document-20261020!'});const login=username=>api('/api/auth/login',null,{username,password:'Document-20261020!'});
    const admin=(await login('admin')).token;
    for(const [username,role] of [['worker','operator'],['viewer','viewer']])await api('/api/users',admin,{username,role,password:'Document-20261020!'});
    const worker=(await login('worker')).token,viewer=(await login('viewer')).token;
    const room=(await api('/api/rooms',admin,{name:'整单接口验收',w:12,d:8,h:4})).loc_code;
    const params={room,roomCode:room,template:'shelf',count:1,perRow:1,rows:1,cols:2,aisle:1.2,gap:0.3};
    const preview=await api('/api/setup/preview?'+new URLSearchParams(params),admin),built=await api('/api/setup/racks',admin,{...params,revision:preview.revision,request_id:'doc-http-build'}),loc=built.created[0]+'-L01-B01';
    const opening=await api('/api/work/opening?loc_code='+loc,admin);
    await api('/api/work/opening',admin,{loc_code:loc,baseline:opening.baseline,rows:[{sku:'DOC-HTTP',name:'接口验收备件',qty:20,unit:'件'}],request_id:'doc-http-opening'});
    const body={room,operation:'out',rows:[['SKU','品名','数量','单位','来源格位'],['DOC-HTTP','接口验收备件',3,'件',loc]],request_id:'doc-http-create'};
    const raw=await request('/api/assistant/jobs/document/preview',admin,body);assert.equal(raw.status,200);assert.equal(raw.cache,'no-store');assert.equal(raw.data.rows.length,1);
    assert.ok([401,403].includes((await request('/api/assistant/jobs/document/preview',null,body)).status));assert.equal((await request('/api/assistant/jobs/document/preview',viewer,body)).status,403);
    const job=await api('/api/assistant/jobs/document',admin,body);assert.equal(job.can_handoff,true);assert.equal((await request('/api/assistant/jobs/'+job.id,worker)).status,404);
    const own=await api('/api/assistant/jobs/document',worker,{...body,request_id:'worker-create'});assert.equal((await request('/api/assistant/jobs/'+own.id+'/handoff',worker,{room,revision:own.revision,confirmed:true})).status,403);
    assert.equal((await api('/api/work/status?room='+room,admin)).counts.jobs,1);
    const task=await api('/api/assistant/jobs/'+job.id+'/handoff',admin,{room,revision:job.revision,confirmed:true,request_id:'http-publish'});
    assert.equal((await api('/api/assistant/jobs/'+job.id+'/handoff',admin,{room,revision:job.revision,confirmed:true,request_id:'http-publish'})).task_id,task.task_id);
    const state=await api('/api/work/status?room='+room,admin);assert.equal(state.counts.jobs,0);assert.equal(state.team.total,1);
    const inventory=await api('/api/v1/inventory',admin),item=inventory.find(row=>row.sku==='DOC-HTTP');assert.equal(item.qty,20);assert.equal(item.reserved_qty,3);
    assert.equal((await request('/api/assistant/jobs/'+job.id+'/rows/'+job.rows[0].id+'/confirm',admin,{room,revision:job.revision,confirmed:true})).status,409);
    const saved=await api('/api/assistant/jobs?room='+room,admin);assert.equal(saved[0].handoff,task.task_id);
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}rmSync(dir,{recursive:true,force:true});}
});
