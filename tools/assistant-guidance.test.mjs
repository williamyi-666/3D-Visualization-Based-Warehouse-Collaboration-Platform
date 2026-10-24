import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {guideRequest} from '../apps/api/assistant-guidance.mjs';
import {createAssistantTools} from '../apps/api/assistant-tools.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {planQuickBuild} from '../packages/three-kit/quick-build.mjs';

test('操作指引与实际查货分开，明确的首次使用请求不依赖模型',()=>{
  assert.equal(guideRequest('这个仓库还需要配置什么？').name,'setup_progress');
  assert.equal(guideRequest('我要开始使用这个仓库').name,'setup_progress');
  assert.equal(guideRequest('门窗在哪里添加？').args.topic,'openings');
  assert.equal(guideRequest('怎么把模型关联到当前库区？').args.topic,'model');
  assert.equal(guideRequest('货架上的轴承在哪里？'),null);
  assert.equal(guideRequest('1号库区的轴承在哪里？'),null);
  assert.equal(guideRequest('门轴承在哪里？'),null);
  assert.equal(guideRequest('怎么入库？').args.topic,'operations');
});

test('起步进度根据保存的布局与逐格建账恢复，标签不冒充已打印，权限沿用账号',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'assistant-guidance-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,work=createWarehouseWork(sql,{db});
  const tools=createAssistantTools({db,work,readInventory:()=>db.listInventory()}),actor={id:'guide-admin',role:'admin'};
  const room=db.createRoomNode({name:'从零起步',w:12,d:8,h:4}),req={body:{room:room.loc_code,context:{}},user:actor};
  try{
    const initial=await tools.run('setup_progress',{},req);assert.equal(initial.completed,1);assert.equal(initial.next,'layout');
    const params={roomCode:room.loc_code,template:'shelf',count:2,perRow:2,rows:1,cols:2,w:1.2,h:1.8,d:0.5,aisle:1.2,gap:0.3};
    const plan=planQuickBuild(db.getLayout(room.loc_code),params);db.quickBuildRacks({...params,revision:plan.revision,request_id:'guide-build'},planQuickBuild);
    const before=db.listInventory(),layout=db.getLayout(room.loc_code);
    const built=await tools.run('setup_progress',{},req);assert.equal(built.completed,3);assert.equal(built.next,'opening');assert.equal(built.steps.find(s=>s.id==='labels').optional,true);assert.equal(built.steps.find(s=>s.id==='labels').done,undefined);
    const viewer={...req,user:{id:'viewer',role:'viewer'}};
    const readOnly=await tools.run('setup_progress',{},viewer);assert.equal(readOnly.steps.find(s=>s.id==='layout').allowed,false);assert.equal(readOnly.steps.find(s=>s.id==='opening').allowed,false);
    assert.equal((await tools.run('platform_guide',{topic:'openings'},viewer)).allowed,false);
    assert.deepEqual(db.listInventory(),before);assert.deepEqual(db.getLayout(room.loc_code),layout);
    for(const row of work.progress(room.loc_code).rows){const snapshot=work.opening(row.loc_code);work.establish({loc_code:row.loc_code,baseline:snapshot.baseline,rows:[],request_id:'guide-empty-'+row.loc_code},actor);}
    const resumed=await tools.run('setup_progress',{},req);assert.equal(resumed.completed,4);assert.equal(resumed.next,'');assert.equal(resumed.next_loc,'');
    await assert.rejects(tools.run('setup_progress',{}, {...req,canAccessLocation:()=>false}),error=>error.status===403);
    assert.deepEqual(db.listInventory(),before);
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
