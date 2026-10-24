import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('同账号多端助手会话隔离，补参保留已核对位置和货品，预览不改变数量',async()=>{
  let target='',modelCalls=0;
  const model=createServer(async(req,res)=>{
    if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'test-model'}]}));return;}
    if(req.url==='/api/ps'){res.end(JSON.stringify({models:[{name:'test-model'}]}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),question=body.messages.at(-1).content;modelCalls++;
    const definitions={
      move:{name:'prepare_operation',arguments:{operation:'move',qty:3,unit:'套',to_hint:target}},
      change:{name:'update_request',arguments:{qty:5}},
      '请盘点当前格位，实际只有18套':{name:'prepare_stocktake',arguments:{actual_qty:18,unit:'套'}},
      stock:{name:'find_stock',arguments:{query:''}},
    };
    res.end(JSON.stringify({message:{tool_calls:[{function:definitions[question]||definitions.stock}]}}));
  });model.listen(0,'127.0.0.1');await once(model,'listening');
  const dir=mkdtempSync(join(tmpdir(),'assistant-conversation-'));
  const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',DB_DRIVER:'sqlite',SPATIAL_MODE:'standalone',SPATIAL_AUTH_PROVIDER:'local',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_ASSISTANT_URL:'http://127.0.0.1:'+model.address().port,SPATIAL_ASSISTANT_MODEL:'test-model',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:''}});
  let logs='';child.stderr.on('data',s=>logs+=s);
  try{
    const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),15000);child.stdout.on('data',s=>{const match=String(s).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
    const base='http://127.0.0.1:'+port;
    const call=async(path,token,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
    await call('/api/auth/bootstrap',null,'POST',{username:'admin',password:'Test-20261014!'});
    const admin=(await call('/api/auth/login',null,'POST',{username:'admin',password:'Test-20261014!'})).token;
    await call('/api/users',admin,'POST',{username:'viewer',password:'Test-20261014!',role:'viewer'});
    const viewer=(await call('/api/auth/login',null,'POST',{username:'viewer',password:'Test-20261014!'})).token;
    const room=(await call('/api/rooms',admin,'POST',{name:'会话验证区',w:12,d:8,h:4})).loc_code;
    const params={room,roomCode:room,template:'shelf',count:2,perRow:2,rows:2,cols:3,aisle:1.2,gap:0.3};
    const preview=await call('/api/setup/preview?'+new URLSearchParams(params),admin);
    const generated=await call('/api/setup/racks',admin,'POST',{...params,revision:preview.revision,request_id:'conversation-build'});
    const from=generated.created[0]+'-L01-B01';target=generated.created[1]+'-L01-B01';
    const snapshot=await call('/api/work/opening?loc_code='+from,admin);
    const opened=await call('/api/work/opening',admin,'POST',{loc_code:from,baseline:snapshot.baseline,rows:[{name:'会话轴承',qty:20,unit:'套'}],request_id:'conversation-opening'});
    const item=opened.rows[0],body={room,context:{loc_code:from,item_id:item.item_id},session_id:'desktop'};
    const before=await call('/api/v1/inventory',admin);
    const guided=(await call('/api/assistant/ask',admin,'POST',{...body,message:'门窗在哪里添加？'})).results[0];assert.equal(guided.kind,'platform_guide');assert.equal(guided.topic,'openings');
    const progress=(await call('/api/assistant/ask',admin,'POST',{...body,message:'我要开始使用这个仓库'})).results[0];assert.equal(progress.next,'opening');assert.equal(modelCalls,0);
    const move=(await call('/api/assistant/ask',admin,'POST',{...body,message:'move'})).results[0];assert.equal(move.ready,true);assert.equal(move.draft.qty,3);
    const phone=(await call('/api/assistant/ask',admin,'POST',{...body,session_id:'phone',message:'move'})).results[0];assert.equal(phone.draft.qty,3);
    const changed=(await call('/api/assistant/ask',admin,'POST',{...body,message:'change'})).results[0];assert.equal(changed.draft.qty,5);assert.equal(changed.draft.from_loc,from);assert.equal(changed.draft.to_loc,target);assert.equal(changed.draft.item_id,item.item_id);
    const saved=await call('/api/assistant/session?'+new URLSearchParams({room,session_id:'phone'}),admin);assert.equal(saved.pending.draft.qty,3);
    assert.equal((await call('/api/assistant/session?'+new URLSearchParams({room,session_id:'desktop'}),viewer)).pending,null);
    const count=(await call('/api/assistant/ask',admin,'POST',{...body,message:'请盘点当前格位，实际只有18套'})).results[0];assert.equal(count.kind,'stocktake');assert.equal(count.row.actual_qty,18);assert.equal(count.row.difference,-2);
    assert.equal((await call('/api/assistant/ask',viewer,'POST',{...body,session_id:'viewer',message:'stock'})).results[0].rows[0].item_id,item.item_id);
    await call('/api/assistant/session/reset',admin,'POST',body);assert.equal((await call('/api/assistant/session?'+new URLSearchParams({room,session_id:'desktop'}),admin)).pending,null);
    assert.deepEqual(await call('/api/v1/inventory',admin),before);
  }finally{child.kill('SIGTERM');await once(child,'exit');model.close();await once(model,'close');rmSync(dir,{recursive:true,force:true});}
});
