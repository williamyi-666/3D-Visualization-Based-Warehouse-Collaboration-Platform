import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {createKnowledgeStore,knowledgeTerms,safeKnowledgeLink} from '../packages/knowledge/store.mjs';
import {createKnowledgeService} from '../packages/knowledge/server.mjs';
import {createKnowledgeSettings,validateKnowledgeSettings,retrieveEnterpriseKnowledge,isLiveKnowledgeQuestion} from '../apps/api/knowledge.mjs';

test('中文规程可检索，更新重建索引，停用及知识库隔离',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const store=createKnowledgeStore(db);
  const a=store.save('warehouse',{title:'盘点差异复核规程',content:'盘点发现差异时，登记实际数量，填写差异原因，提交管理员复核。库存未经审核不得调整。'},'admin');
  store.save('private',{title:'盘点保密说明',content:'盘点差异包含保密物料数据。'},'admin');
  const query={knowledge_id:'warehouse',query:'盘点发现数量差异应该如何复核？'};
  let rows=store.retrieve(query).records;assert.equal(rows[0].metadata.document_id,a.id);assert.ok(rows.every(row=>row.metadata.knowledge_id==='warehouse'));
  const changed=store.save('warehouse',{id:a.id,title:'危险品入库规程',content:'危险品必须由有权限的人员入库，禁止擅自拆封。'},'admin');assert.equal(changed.version,2);assert.equal(store.current('warehouse',rows),false);
  assert.equal(store.retrieve(query).records.length,0);
  assert.ok(store.retrieve({knowledge_id:'warehouse',query:'危险品入库'}).records.length);
  store.save('warehouse',{id:a.id,active:false},'admin');assert.equal(store.retrieve({knowledge_id:'warehouse',query:'危险品入库'}).records.length,0);
  store.save('warehouse',{id:a.id,active:true},'admin');assert.equal(store.list('warehouse')[0].version,4);
  assert.throws(()=>store.get('other',a.id),e=>e.status===404);
});
test('长资料分段保留位置，无关问题无召回，错误更新不会覆盖旧资料',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const store=createKnowledgeStore(db);
  const content=('货架摆放需要保留安全通道，保持消防设施可用。\n').repeat(80),doc=store.save('warehouse',{title:'通道要求',content},'admin');
  const rows=store.retrieve({knowledge_id:'warehouse',query:'货架安全通道要求'}).records;assert.ok(rows.length);assert.match(rows[0].metadata.section,/片段/);assert.ok(store.list('warehouse')[0].chunks>1);
  assert.equal(store.retrieve({knowledge_id:'warehouse',query:'火星卫星轨道偏心率'}).records.length,0);
  assert.throws(()=>store.save('warehouse',{id:doc.id,content:''},'admin'));
  assert.equal(store.get('warehouse',doc.id).version,1);
  assert.deepEqual(knowledgeTerms('BRG-6204库存').filter(term=>term.startsWith('brg')),['brg-6204']);
  assert.equal(safeKnowledgeLink('javascript:alert(1)'),'');assert.equal(safeKnowledgeLink('http://user:password@host/a'),'');
});
test('连接设置默认关闭，密钥不返回，变更地址不得复用旧密钥',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const settings=createKnowledgeSettings(db);
  assert.equal(settings.get().mode,'off');
  const input={mode:'enterprise',url:'https://kb.example/retrieval',knowledge_id:'warehouse',api_key:'private-test-key',roles:['viewer'],rooms:['WH-2']};
  settings.save(input,'admin');assert.equal(settings.publicConfig().api_key,undefined);assert.equal(settings.publicConfig().has_key,true);
  assert.ok(!JSON.stringify(settings.publicConfig()).includes(input.api_key));
  settings.save({...input,api_key:''},'admin');assert.equal(settings.get().api_key,input.api_key);
  assert.throws(()=>settings.save({...input,url:'https://other.example/retrieval',api_key:''},'admin'));
  assert.equal(settings.get().url,input.url);
  for(const patch of [{mode:'yes'},{roles:['owner']},{rooms:['WH-2-A']},{url:'https://user:pass@host/'},{api_key:'bad\nkey'}])assert.throws(()=>validateKnowledgeSettings({...input,...patch},settings.get()));
});
test('企业接口采用检索协议，返回原文；异常和危险来源链接不进入前端',async()=>{
  const config={url:'https://kb.example/retrieval',api_key:'private-test-key',knowledge_id:'warehouse'};
  const result=await retrieveEnterpriseKnowledge(config,'盘点差异',{fetchImpl:async(url,options)=>{
    assert.equal(url,config.url);assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+config.api_key);
    assert.deepEqual(JSON.parse(options.body),{knowledge_id:'warehouse',query:'盘点差异',retrieval_setting:{top_k:4,score_threshold:.2}});
    return Response.json({records:[{title:'盘点规则',content:'提交复核',score:.8,metadata:{source:'https://example.test/rules'}}]});
  }});assert.equal(result.records[0].content,'提交复核');
  await assert.rejects(retrieveEnterpriseKnowledge(config,'test',{fetchImpl:async()=>Response.json({records:[{}]})}),e=>e.status===502);
  await assert.rejects(retrieveEnterpriseKnowledge(config,'test',{fetchImpl:async()=>new Response('private-test-key',{status:403})}),e=>e.status===502&&!e.message.includes('private-test-key'));
  for(const q of ['6204轴承还有多少套','现在库存有多少','请帮我把轴承移库到B架'])assert.equal(isLiveKnowledgeQuestion(q),true,q);
  for(const q of ['盘点差异如何处理','入库流程是什么','出库需要怎么审批'])assert.equal(isLiveKnowledgeQuestion(q),false,q);
});
test('独立知识服务要求密钥，支持接口复用及知识库边界',async t=>{
  const db=new DatabaseSync(':memory:'),key='service-test-key-long-enough-20261021';
  const server=createKnowledgeService({sql:db,key});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();});
  const base='http://127.0.0.1:'+server.address().port;
  const call=(path,body,token=key)=>fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/documents',null,'wrong')).status,401);
  assert.equal((await call('/documents',{title:'包装要求',content:'轴承必须保持原包装，存放于干燥位置。'})).status,200);
  const response=await retrieveEnterpriseKnowledge({url:base+'/retrieval',api_key:key,knowledge_id:'warehouse'},'轴承包装要求');assert.ok(response.records.length);
  assert.equal((await call('/retrieval',{knowledge_id:'secret',query:'轴承'})).status,404);
});
