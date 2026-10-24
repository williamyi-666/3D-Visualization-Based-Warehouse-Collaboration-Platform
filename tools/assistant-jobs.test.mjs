import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAssistantJobs} from '../apps/api/assistant-jobs.mjs';
import {createAssistantTools} from '../apps/api/assistant-tools.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {planQuickBuild} from '../packages/three-kit/quick-build.mjs';
import {groundJobInput,jobOrdinal,isBatchRequest} from '../apps/api/assistant-job-intent.mjs';

test('多项作业和清单补参只采用明确数量，第几项不混为数量',()=>{
  assert.ok(isBatchRequest('分别入库轴承3套、螺母5盒'));
  assert.equal(jobOrdinal('第二项数量改为5套'),2);
  assert.equal(jobOrdinal('第十二项目标改B架'),12);
  assert.deepEqual(groundJobInput({qty:2,unit:'套'},'第二项目标改为B架'),{});
  assert.deepEqual(groundJobInput({qty:5,unit:'套'},'第二项数量改为五套'),{qty:5,unit:'套'});
  assert.deepEqual(groundJobInput({qty:6204,unit:'套'},'轴承6204入库'),{});
  assert.deepEqual(groundJobInput({operation:'in',qty:5,unit:'套',to_hint:'B架'},'第二项数量改为5套'),{qty:5,unit:'套'});
});

test('清单保存与编辑不记账，确认复用出入库事务，跨端并发和失败重试不重复记账',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'assistant-jobs-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,work=createWarehouseWork(sql,{db});
  const room=db.createRoomNode({name:'清单验收',w:12,d:8,h:4}),params={roomCode:room.loc_code,template:'shelf',count:3,perRow:3,rows:1,cols:2,w:1.2,h:1.8,d:0.5,aisle:1.2,gap:0.3};
  const plan=planQuickBuild(db.getLayout(room.loc_code),params),generated=db.quickBuildRacks({...params,revision:plan.revision,request_id:'jobs-build'},planQuickBuild);
  const from=generated.created[0]+'-L01-B01',target=generated.created[1]+'-L01-B01',fresh=generated.created[2]+'-L01-B01',empty=generated.created[2]+'-L01-B02';
  const admin={id:'jobs-admin',name:'清单管理员',role:'admin'},req={body:{room:room.loc_code,context:{},request_id:'jobs-create'},user:admin};
  const snapshot=work.opening(from);work.establish({loc_code:from,baseline:snapshot.baseline,rows:[{name:'轴承6204',sku:'JOB-6204',qty:20,unit:'套'}],request_id:'jobs-opening'},admin);
  const item=db.getCellItems(from)[0],tools=createAssistantTools({db,work,readInventory:()=>db.listInventory()}),jobs=createAssistantJobs({sql,db,tools});
  const qty=loc=>db.getCellItems(loc).find(i=>i.item_id===item.item_id)?.qty||0;
  try{
    const before=db.listInventory(),inputs=[{operation:'out',query:'JOB-6204',from_loc:from,qty:3,unit:'套'},{operation:'move',query:'JOB-6204',from_loc:from,to_loc:target,qty:4,unit:'套'},{operation:'in',query:'JOB-6204',to_loc:from,qty:2,unit:'套'},{operation:'in',query:'新垫圈',name:'新垫圈',sku:'JOB-WASH',new_item:true,to_loc:fresh,qty:5,unit:'盒'}];
    let job=await jobs.create(req,inputs);assert.equal(job.rows.length,4);assert.ok(job.rows.every(r=>r.canConfirm));assert.deepEqual(db.listInventory(),before);
    const duplicates=await Promise.all([jobs.create(req,inputs),jobs.create(req,inputs)]);assert.ok(duplicates.every(j=>j.id===job.id));
    await assert.rejects(jobs.get({...req,user:{id:'other',role:'operator'}},job.id),e=>e.status===404);
    await assert.rejects(jobs.get({...req,user:{id:'viewer',role:'viewer'}},job.id),e=>e.status===403);
    job=await jobs.edit({...req,body:{revision:job.revision,input:{...inputs[0],unit:'箱'}}},job.id,job.rows[0].id);assert.equal(job.rows[0].canConfirm,false);assert.deepEqual(db.listInventory(),before);
    job=await jobs.edit({...req,body:{revision:job.revision,input:inputs[0]}},job.id,job.rows[0].id);
    const first=job.rows[0].id,oldRevision=job.revision;
    await assert.rejects(jobs.confirm({...req,body:{revision:oldRevision}},job.id,first),/核对并确认/);
    const confirmed=await Promise.all([jobs.confirm({...req,body:{revision:oldRevision,confirmed:true}},job.id,first),jobs.confirm({...req,body:{revision:oldRevision,confirmed:true}},job.id,first)]);
    assert.equal(qty(from),17);assert.ok(confirmed.every(j=>j.completed===1));job=confirmed.at(-1);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM movement WHERE move_type='outbound'").get().n,1);
    await assert.rejects(jobs.confirm({...req,body:{revision:oldRevision,confirmed:true}},job.id,job.rows[1].id),e=>e.status===409);
    for(const index of [1,2,3])job=await jobs.confirm({...req,body:{revision:job.revision,confirmed:true}},job.id,job.rows[index].id);
    assert.equal(job.completed,4);assert.equal(qty(from),15);assert.equal(qty(target),4);assert.equal(db.getCellItems(fresh)[0].qty,5);
    assert.equal(sql.prepare("SELECT actor_id FROM movement WHERE move_type='outbound'").get().actor_id,admin.id);
    const reloaded=createAssistantJobs({sql,db,tools});assert.equal((await reloaded.get(req,job.id)).completed,4);
    const failing=await jobs.create({...req,body:{...req.body,request_id:'failure-job'}},[{...inputs[0],qty:1}]);
    const rollbackInventory=db.listInventory(),rollbackMovements=sql.prepare('SELECT count(*) AS n FROM movement').get().n;
    sql.exec(`CREATE TRIGGER fail_job_receipt BEFORE UPDATE ON assistant_job WHEN OLD.id='${failing.id}' BEGIN SELECT RAISE(ABORT,'receipt-storage-failure'); END;`);
    await assert.rejects(jobs.confirm({...req,body:{revision:failing.revision,confirmed:true}},failing.id,failing.rows[0].id),/receipt-storage-failure/);
    assert.deepEqual(db.listInventory(),rollbackInventory);assert.equal(sql.prepare('SELECT count(*) AS n FROM movement').get().n,rollbackMovements);sql.exec('DROP TRIGGER fail_job_receipt');
    await jobs.confirm({...req,body:{revision:failing.revision,confirmed:true}},failing.id,failing.rows[0].id);assert.equal(qty(from),14);
    const changed=await jobs.create({...req,body:{...req.body,request_id:'changed-cell'}},[{...inputs[2],to_loc:empty}]);
    sql.prepare('UPDATE space_node SET id=? WHERE loc_code=?').run(randomUUID(),empty);
    assert.equal((await jobs.get(req,changed.id)).rows[0].canConfirm,false);
    await assert.rejects(jobs.confirm({...req,body:{revision:changed.revision,confirmed:true}},changed.id,changed.rows[0].id),e=>e.status===409);
    await assert.rejects(jobs.get({...req,canAccessLocation:code=>code!==empty},changed.id),e=>e.status===403);
    const external=createAssistantJobs({sql,db,tools,integrationMode:true});await assert.rejects(external.create(req,inputs),e=>e.status===403);
    const sameName=[randomUUID(),randomUUID()],sourceNode=sql.prepare('SELECT id FROM space_node WHERE loc_code=?').get(from).id;
    for(const id of sameName){sql.prepare('INSERT INTO item(id,tenant_id,name,unit,attributes) VALUES(?,?,?,?,?)').run(id,db.TENANT,'同名备件','件','{}');sql.prepare('INSERT INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)').run(randomUUID(),db.TENANT,sourceNode,id,1);}
    const exact=await jobs.create({...req,body:{...req.body,request_id:'same-name-id'}},[{operation:'in',item_id:sameName[1],to_loc:empty,qty:2,unit:'件'}]);
    await jobs.confirm({...req,body:{revision:exact.revision,confirmed:true}},exact.id,exact.rows[0].id);
    assert.equal(db.getCellItems(empty).find(i=>i.item_id===sameName[1]).qty,2);assert.ok(!db.getCellItems(empty).some(i=>i.item_id===sameName[0]));
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
