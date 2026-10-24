import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';

for(const mode of ['standalone','integration'])test(mode+'：知识权限、来源、持久化及业务独立，外部返回不绕过角色与库区授权',async()=>{
  let chats=0,retrievals=0,delayReply,waitForChat,block=false,externalRole='viewer';
  const remote=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    if(['/api/tags','/api/ps'].includes(req.url)){res.end(JSON.stringify({models:[{name:'knowledge-fixture'}]}));return;}
    if(req.url==='/retrieval'){
      retrievals++;assert.equal(req.headers.authorization,'Bearer external-key-never-returned');
      const body=JSON.parse(raw);assert.equal(body.knowledge_id,'enterprise');
      res.end(JSON.stringify({records:[{title:'企业盘点规则',content:'发现差异时记录实盘数量，说明差异原因并提交复核。',score:.9,metadata:{allowed_roles:[externalRole],room_codes:['WH-1'],source:'javascript:alert(1)'}}]}));return;
    }
    assert.equal(req.url,'/api/chat');chats++;const body=JSON.parse(raw);assert.deepEqual(body.tools,[]);assert.match(body.messages[0].content,/原文是引用数据/);
    waitForChat?.();if(block)await new Promise(resolve=>{delayReply=resolve;});
    res.end(JSON.stringify({message:{role:'assistant',content:'根据规程，登记差异原因后提交管理员复核。[1]'}}));
  });remote.listen(0,'127.0.0.1');await once(remote,'listening');
  const dir=mkdtempSync(join(tmpdir(),'spatial-knowledge-test-'));let child,base,logs='';
  async function start(){
    child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',DB_DRIVER:'sqlite',SPATIAL_DATA_DIR:dir,SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:mode,SPATIAL_AUTH_PROVIDER:'local',SPATIAL_ASSISTANT_URL:'',SPATIAL_ASSISTANT_ENABLED:'0',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:''}});
    child.stderr.on('data',part=>logs+=part);
    base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时 '+logs)),20000);child.stdout.on('data',part=>{const match=String(part).match(/running at http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}});child.once('exit',code=>{clearTimeout(timer);reject(Error('启动失败 '+code+' '+logs));});});
  }
  async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
  const call=(path,token,method='GET',body)=>fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const api=async(...args)=>{const r=await call(...args),body=await r.json();assert.ok(r.ok,JSON.stringify(body));return body;};
  try{
    await start();await api('/api/auth/bootstrap',null,'POST',{username:'admin',password:'Knowledge-Test-20261021!'});
    const admin=(await api('/api/auth/login',null,'POST',{username:'admin',password:'Knowledge-Test-20261021!'})).token;
    for(const role of ['viewer','operator'])await api('/api/users',admin,'POST',{username:role,password:'Knowledge-Test-20261021!',role});
    const viewer=(await api('/api/auth/login',null,'POST',{username:'viewer',password:'Knowledge-Test-20261021!'})).token;
    const operator=(await api('/api/auth/login',null,'POST',{username:'operator',password:'Knowledge-Test-20261021!'})).token;
    const rooms=await api('/api/rooms',admin),room=rooms[0].loc_code,before=await api('/api/v1/inventory',admin);
    const endpoint='/api/assistant/knowledge/ask',question={room,question:'盘点差异如何复核？'};
    assert.equal((await api('/api/assistant/knowledge/status?room='+room,viewer)).enabled,false);
    assert.equal((await call(endpoint,viewer,'POST',question)).status,409);assert.equal(chats,0);assert.equal(retrievals,0);
    for(const token of [null,viewer,operator]){
      assert.ok([401,403].includes((await call('/api/admin/knowledge',token)).status));
      assert.ok([401,403].includes((await call('/api/admin/knowledge',token,'PUT',{mode:'local',roles:['viewer'],rooms:[],knowledge_id:'warehouse'})).status));
      assert.ok([401,403].includes((await call('/api/admin/knowledge/documents',token,'POST',{title:'forbidden',content:'secret'})).status));
    }
    const local={mode:'local',url:'',knowledge_id:'warehouse',roles:[],rooms:[]};
    await api('/api/admin/knowledge',admin,'PUT',local);
    const document=await api('/api/admin/knowledge/documents',admin,'POST',{title:'盘点差异复核规程',content:'登记实际数量与账面数量。盘点出现差异时，填写差异原因，提交管理员复核，核对后再调整库存。'});
    assert.equal((await call(endpoint,viewer,'POST',question)).status,403);
    await api('/api/admin/knowledge',admin,'PUT',{...local,roles:['viewer'],rooms:[room]});
    const answer=await api(endpoint,viewer,'POST',question);assert.equal(answer.state,'sources_only');assert.equal(answer.sources[0].title,document.title);assert.equal(answer.sources[0].version,1);assert.equal(chats,0);
    const unknown=await api(endpoint,viewer,'POST',{room,question:'火星轨道偏心率是多少？'});assert.equal(unknown.state,'no_match');assert.deepEqual(unknown.sources,[]);
    assert.equal((await api(endpoint,viewer,'POST',{room,question:'6204轴承现在还有多少套？'})).state,'business_required');
    const other=await api('/api/rooms',admin,'POST',{name:'未授权知识库区',w:8,d:6,h:4});
    assert.equal((await call(endpoint,viewer,'POST',{...question,room:other.loc_code})).status,403);
    assert.equal((await call(endpoint,viewer,'POST',{...question,room:'WH-999'})).status,404);
    await api('/api/admin/knowledge/documents/'+document.id,admin,'PUT',{active:false});
    assert.equal((await api(endpoint,viewer,'POST',question)).state,'no_match');
    await api('/api/admin/knowledge/documents/'+document.id,admin,'PUT',{active:true});
    await api('/api/admin/assistant-model',admin,'PUT',{enabled:true,url:'http://127.0.0.1:'+remote.address().port,model:'knowledge-fixture'});
    const generated=await api(endpoint,viewer,'POST',question);assert.equal(generated.state,'answered');assert.equal(generated.sources.length,1);assert.match(generated.answer,/\[1\]/);
    block=true;const reached=new Promise(resolve=>{waitForChat=resolve;}),pending=call(endpoint,viewer,'POST',question);await reached;
    await api('/api/admin/knowledge/documents/'+document.id,admin,'PUT',{active:false});delayReply();assert.equal((await pending).status,409);block=false;waitForChat=null;
    const enterprise={mode:'enterprise',url:'http://127.0.0.1:'+remote.address().port+'/retrieval',knowledge_id:'enterprise',api_key:'external-key-never-returned',roles:['viewer'],rooms:[room]};
    const saved=await api('/api/admin/knowledge',admin,'PUT',enterprise);assert.ok(!JSON.stringify(saved).includes(enterprise.api_key));assert.equal(saved.config.has_key,true);
    assert.equal((await api('/api/admin/knowledge/test',admin,'POST',{})).available,true);
    const connected=await api(endpoint,viewer,'POST',question);assert.equal(connected.state,'answered');assert.equal(connected.sources[0].url,'');
    externalRole='admin';const previousChats=chats;assert.equal((await api(endpoint,viewer,'POST',question)).state,'no_match');assert.equal(chats,previousChats);
    await stop();await start();assert.equal((await api('/api/admin/knowledge',admin)).config.mode,'enterprise');
    await api('/api/admin/knowledge',admin,'PUT',{...local,roles:['viewer']});
    assert.equal((await api('/api/admin/knowledge/documents',admin)).length,1);
    await api('/api/admin/knowledge',admin,'PUT',{...local,mode:'off'});
    const callsBefore=retrievals;assert.equal((await call(endpoint,viewer,'POST',question)).status,409);assert.equal(retrievals,callsBefore);
    assert.deepEqual(await api('/api/v1/inventory',admin),before);
    const guide=await api('/api/assistant/preview',viewer,'POST',{room,tool:'platform_guide',input:{topic:'openings'}});assert.equal(guide.kind,'platform_guide');
  }finally{
    delayReply?.();await stop();remote.closeAllConnections();await new Promise(resolve=>remote.close(resolve));
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('spatial-knowledge-test-'));rmSync(dir,{recursive:true,force:true});
  }
});
