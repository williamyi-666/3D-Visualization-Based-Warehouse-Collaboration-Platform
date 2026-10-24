import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('自然语言多项草稿可逐项修改，换端和服务重启后仍可继续，原角色门禁保持有效',async()=>{
  let from,target,alternate,child,base;
  const model=createServer(async(req,res)=>{
    try{
      if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'test-model'}]}));return;}
      if(req.url==='/api/ps'){res.end(JSON.stringify({models:[{name:'test-model'}]}));return;}
      let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),message=body.messages.at(-1).content;
      const call=message.includes('分别')?{name:'prepare_batch',arguments:{operations:[{operation:'out',query:'批量轴承',qty:3,unit:'套',from_hint:from},{operation:'move',query:'批量轴承',qty:4,unit:'套',from_hint:from,to_hint:target}]}}:
        message.includes('数量')?{name:'update_job',arguments:{qty:5,unit:'套'}}:{name:'update_job',arguments:{to_hint:alternate}};
      assert.ok(body.tools.some(t=>t.function.name===call.name),'模型收到了错误的工具范围');
      res.end(JSON.stringify({message:{tool_calls:[{function:call}]}}));
    }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
  });model.listen(0,'127.0.0.1');await once(model,'listening');
  const dir=mkdtempSync(join(tmpdir(),'assistant-jobs-http-'));
  async function start(withModel=true){
    child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',DB_DRIVER:'sqlite',SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_ASSISTANT_URL:withModel?'http://127.0.0.1:'+model.address().port:'',SPATIAL_ASSISTANT_MODEL:'test-model',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:''}});
    let errors='';child.stderr.on('data',s=>errors+=s);
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors)),15000);child.stdout.on('data',s=>{const match=String(s).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('服务退出 '+code+' '+errors));});});base='http://127.0.0.1:'+port;
  }
  const request=async(path,token,method='GET',body)=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};
  };
  const api=async(...args)=>{const r=await request(...args);assert.ok(r.status<300,JSON.stringify(r));return r.data;};
  try{
    await start();await api('/api/auth/bootstrap',null,'POST',{username:'admin',password:'Test-20261017!'});
    const admin=(await api('/api/auth/login',null,'POST',{username:'admin',password:'Test-20261017!'})).token;
    for(const [username,role] of [['worker','operator'],['other','operator'],['viewer','viewer']])await api('/api/users',admin,'POST',{username,role,password:'Test-20261017!'});
    const login=username=>api('/api/auth/login',null,'POST',{username,password:'Test-20261017!'});
    const worker=(await login('worker')).token,other=(await login('other')).token,viewer=(await login('viewer')).token;
    const room=(await api('/api/rooms',admin,'POST',{name:'HTTP清单验收',w:12,d:8,h:4})).loc_code;
    const params={room,roomCode:room,template:'shelf',count:3,perRow:3,rows:1,cols:2,aisle:1.2,gap:0.3},preview=await api('/api/setup/preview?'+new URLSearchParams(params),admin);
    const built=await api('/api/setup/racks',admin,'POST',{...params,revision:preview.revision,request_id:'jobs-http-build'});
    from=built.created[0]+'-L01-B01';target=built.created[1]+'-L01-B01';alternate=built.created[1]+'-L01-B02';
    const snapshot=await api('/api/work/opening?loc_code='+from,admin);
    const opened=await api('/api/work/opening',admin,'POST',{loc_code:from,baseline:snapshot.baseline,rows:[{name:'批量轴承',sku:'BATCH-6204',qty:20,unit:'套'}],request_id:'jobs-http-opening'});
    const item=opened.rows[0],body={room,session_id:'desktop',context:{loc_code:from,item_id:item.item_id}},before=await api('/api/v1/inventory',worker);
    const question=`分别出库批量轴承3套；从${from}移库批量轴承4套到${target}`;
    let job=(await api('/api/assistant/ask',worker,'POST',{...body,message:question,request_id:'jobs-http-ask'})).results[0];
    assert.equal(job.kind,'job');assert.equal(job.rows.length,2);assert.ok(job.rows.every(r=>r.canConfirm));assert.deepEqual(await api('/api/v1/inventory',worker),before);
    const contextual={...body,context:{...body.context,job_id:job.id,row_id:job.rows[0].id}};
    job=(await api('/api/assistant/ask',worker,'POST',{...contextual,message:'第二项数量改为5套'})).results[0];assert.equal(job.rows[0].input.qty,3);assert.equal(job.rows[1].input.qty,5);
    job=(await api('/api/assistant/ask',worker,'POST',{...contextual,message:'第二项目标改为'+alternate})).results[0];assert.equal(job.rows[1].preview.draft.to_loc,alternate);assert.equal(job.rows[1].input.qty,5);
    const first=job.rows[0].id,revision=job.revision;
    assert.equal((await request('/api/assistant/jobs/'+job.id,other)).status,404);assert.equal((await request('/api/assistant/jobs/'+job.id,viewer)).status,403);
    const guidance=await api('/api/assistant/preview',viewer,'POST',{room,tool:'setup_progress',input:{}});assert.equal(guidance.kind,'setup_progress');
    assert.deepEqual(await api('/api/v1/inventory',worker),before);
    job=await api('/api/assistant/jobs/'+job.id+'/rows/'+first+'/confirm',worker,'POST',{revision,confirmed:true});assert.equal(job.completed,1);
    const written=await api('/api/v1/inventory',worker);await api('/api/assistant/jobs/'+job.id+'/rows/'+first+'/confirm',worker,'POST',{revision,confirmed:true});assert.deepEqual(await api('/api/v1/inventory',worker),written);
    const phone=(await login('worker')).token;assert.equal((await api('/api/assistant/jobs/'+job.id,phone)).completed,1);
    child.kill('SIGTERM');await once(child,'exit');child=null;await start(false);
    job=await api('/api/assistant/jobs/'+job.id,phone);assert.equal(job.completed,1);
    job=await api('/api/assistant/jobs/'+job.id+'/rows/'+job.rows[1].id+'/confirm',phone,'POST',{revision:job.revision,confirmed:true});assert.equal(job.completed,2);
    const stock=await api('/api/v1/inventory',worker);assert.equal(stock.find(r=>r.loc_code===from&&r.item_id===item.item_id).qty,12);assert.equal(stock.find(r=>r.loc_code===alternate&&r.item_id===item.item_id).qty,5);assert.ok(!stock.some(r=>r.loc_code===target&&r.item_id===item.item_id));
    const manual=await api('/api/assistant/jobs',phone,'POST',{room,request_id:'new-goods',operations:[{operation:'in',query:'新垫圈',name:'新垫圈',sku:'BATCH-WASH',new_item:true,qty:2,unit:'盒',to_loc:built.created[2]+'-L01-B01'}]});
    await api('/api/assistant/jobs/'+manual.id+'/rows/'+manual.rows[0].id+'/confirm',phone,'POST',{revision:manual.revision,confirmed:true});
    assert.equal((await api('/api/v1/inventory',phone)).find(r=>r.sku==='BATCH-WASH').qty,2);
    assert.ok((await api('/api/assistant/jobs?room='+room,phone)).some(j=>j.id===job.id&&j.completed===2));
  }finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}model.closeAllConnections?.();model.close();await once(model,'close');rmSync(dir,{recursive:true,force:true});}
});
