import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseWarehouseDocument,documentTable} from '../apps/api/assistant-document.mjs';
import {createAssistantJobs} from '../apps/api/assistant-jobs.mjs';
import {createAssistantTools} from '../apps/api/assistant-tools.mjs';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {createWarehouseAccess} from '../apps/api/warehouse-access.mjs';
import {createTeamTasks} from '../apps/api/team-tasks.mjs';
import {photoDocumentTable} from '../apps/web/prototype/document-photo-table.mjs';
import {workAttention} from '../apps/api/work-attention.mjs';

test('整单表格保留来源、规格与未识别行，不把型号当数量，不静默截断',()=>{
  const doc=parseWarehouseDocument({operation:'out',rows:[['领料单号：REQ-1'],['物料编码','品名','规格型号','数量','单位','来源格位'],['BRG-6204','深沟球轴承','6204','3','套','WH-2-A-L01-B01'],['WASH','垫圈','M8','','盒',''],['合计','', '',3]]});
  assert.equal(doc.business.document_no,'REQ-1');assert.equal(doc.rows.length,2);assert.equal(doc.rows[0].input.qty,3);assert.equal(doc.rows[0].source.line,3);assert.equal(doc.rows[0].source.fields.specification,'6204');
  assert.equal(doc.rows[1].input.qty,undefined);assert.ok(doc.rows[1].source.issues.includes('缺少明确的正数数量'));assert.equal(doc.source.notes.length,2);
  const text=parseWarehouseDocument({operation:'out',text:'1. 轴承6204\n2. 垫圈 5盒'});assert.equal(text.rows[0].input.qty,undefined);assert.equal(text.rows[1].input.qty,5);assert.equal(text.rows[1].input.query,'垫圈');
  const csv=parseWarehouseDocument({operation:'in',text:'SKU,品名,数量,单位\nB-1,"轴承,6204",3,套'});assert.equal(csv.rows[0].input.name,'轴承,6204');
  assert.deepEqual(documentTable('品名,数量\n"两行\n名称",3'),[['品名','数量'],['两行\n名称','3']]);
  assert.throws(()=>parseWarehouseDocument({operation:'in',rows:[['品名','数量'],...Array.from({length:51},(_,i)=>['货品'+i,1])]}),/最多50/);
  const manual=parseWarehouseDocument({operation:'out',rows:[['名称A','个数B','单位C'],['轴承',3,'套']],header_row:0,mapping:{name:0,qty:1,unit:2}});assert.equal(manual.rows[0].input.qty,3);
  const photo=parseWarehouseDocument({operation:'out',text:'轴承 3套',source_kind:'photo'});assert.ok(photo.rows[0].source.issues.some(s=>s.includes('照片')));
  const withTitle=parseWarehouseDocument({operation:'out',text:'单号：REQ-T\nSKU\t品名\t数量\t单位\nB1\t轴承\t3\t套'});assert.equal(withTitle.rows.length,1);assert.equal(withTitle.business.document_no,'REQ-T');
  const ambiguous=parseWarehouseDocument({operation:'out',rows:[['SKU','数量','单位'],['B1','1,5','套']]});assert.equal(ambiguous.rows[0].input.qty,undefined);
});

test('照片用文字坐标恢复列，异常排序来自记录和阈值',()=>{
  const word=(text,left,width=25)=>({text,left,width});
  const rows=photoDocumentTable([{text:'SKU 品名 数量 单位',words:[word('SKU',0),word('品名',100),word('数',220,10),word('量',231,10),word('单位',300)]},{text:'B-1 轴承 3 套',words:[word('B-1',0),word('轴承',100),word('3',220),word('套',300)]}]);
  const doc=parseWarehouseDocument({operation:'out',source_kind:'photo',rows});assert.equal(doc.rows[0].input.sku,'B-1');assert.equal(doc.rows[0].input.qty,3);assert.equal(doc.rows[0].input.unit,'套');assert.equal(doc.needs_review,1);
  assert.equal(photoDocumentTable([{text:'无法识别的表头',words:[word('无法识别',0)]}]),null);
  const attention=workAttention({rows:[{kind:'low',item_id:'almost',evidence:{qty:9,minimum:10}},{kind:'review',id:'new',updated_at:'2026-10-19T12:00:00Z'},{kind:'low',item_id:'empty',evidence:{qty:0,minimum:10}},{kind:'review',id:'old',updated_at:'2026-10-18T12:00:00Z'}]},{attention:[{kind:'team',id:'blocked',status:'blocked',evidence:{note:'现场找不到货'}}]});
  assert.deepEqual(attention.map(row=>row.id||row.item_id),['blocked','old','new','empty','almost']);assert.equal(attention[0].evidence.note,'现场找不到货');
});

test('整单核对、团队转交、预占与个人办理互斥，重复与失败不会重复发布或扣库存',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'assistant-doc-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,work=createWarehouseWork(sql,{db}),access=createWarehouseAccess(sql,{standalone:true,localUsers:true});
  const admin=db.createUser({username:'doc-manager',role:'admin',name:'管理员',pw_hash:'fixture',pw_salt:'fixture'}),worker=db.createUser({username:'doc-worker',role:'operator',name:'作业员',pw_hash:'fixture',pw_salt:'fixture'});
  const room=db.createRoomNode({name:'整单验收',w:12,d:8,h:4}),rack=db.createRack({roomCode:room.loc_code,rows:1,cols:2}),from=rack.furn_code+'-L01-B01',target=rack.furn_code+'-L01-B02';
  const item=db.inbound({loc_code:from,name:'深沟球轴承6204',sku:'DOC-6204',qty:20,unit:'套'});
  const tools=createAssistantTools({db,work,readInventory:()=>db.listInventory()}),teamTasks=createTeamTasks({sql,db,work,access}),jobs=createAssistantJobs({sql,db,tools,teamTasks});
  const req=(body={},user=admin)=>({user,body:{room:room.loc_code,...body},query:{room:room.loc_code}});
  const stock=()=>db.getCellItems(from).find(i=>i.item_id===item.item_id);
  const docBody={operation:'out',request_id:'doc-create',rows:[['领料单号：REQ-100'],['SKU','品名','数量','单位','来源格位'],['DOC-6204','深沟球轴承6204',3,'套',from],['DOC-6204','品名不一致',2,'套',from]]};
  try{
    let job=await jobs.createDocument(req(docBody));assert.equal(job.total,2);assert.equal(stock().qty,20);assert.equal(stock().reserved_qty||0,0);assert.equal(job.rows[0].canConfirm,true);assert.equal(job.rows[1].canConfirm,false);assert.equal(job.document.business.document_no,'REQ-100');
    assert.equal((await jobs.createDocument(req(docBody))).id,job.id);
    await assert.rejects(jobs.confirm(req({revision:job.revision,confirmed:true}),job.id,job.rows[1].id),/单据原文/);
    await assert.rejects(jobs.handoff(req({revision:job.revision,confirmed:true}),job.id),/每项/);
    job=await jobs.edit(req({revision:job.revision,input:job.rows[1].input,source_reviewed:true}),job.id,job.rows[1].id);assert.ok(job.rows.every(row=>row.canConfirm));assert.equal(job.rows[1].source.fields.name,'品名不一致');
    const body={revision:job.revision,confirmed:true,assignee_id:worker.id,request_id:'publish-once'};
    const result=await jobs.handoff(req(body),job.id);assert.equal(result.task.lines.length,2);assert.equal(result.task.business.document_no,'REQ-100');assert.equal(stock().qty,20);assert.equal(stock().reserved_qty,5);
    assert.equal((await jobs.handoff(req(body),job.id)).task_id,result.task_id);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM team_task').get().n,1);
    await assert.rejects(jobs.handoff(req({...body,title:'另一个任务'}),job.id),e=>e.status===409);
    await assert.rejects(jobs.confirm(req({revision:job.revision,confirmed:true}),job.id,job.rows[0].id),/团队任务/);
    await assert.rejects(jobs.edit(req({revision:job.revision,input:job.rows[0].input}),job.id,job.rows[0].id),/团队任务/);
    assert.equal((await jobs.get(req(),job.id)).handoff.task_id,result.task_id);assert.equal((await jobs.list(req())).find(row=>row.id===job.id).handoff,result.task_id);
    await assert.rejects(jobs.get(req({},worker),job.id),e=>e.status===404);
    const own=await jobs.createDocument(req({...docBody,request_id:'operator-create'},worker));await assert.rejects(jobs.handoff(req({revision:own.revision,confirmed:true},worker),own.id),e=>e.status===403);
    const personal=await jobs.createDocument(req({...docBody,request_id:'personal-create',rows:docBody.rows.slice(0,3)}));
    const confirmed=await jobs.confirm(req({revision:personal.revision,confirmed:true}),personal.id,personal.rows[0].id);assert.equal(confirmed.completed,1);assert.equal(stock().qty,17);assert.equal(stock().reserved_qty,5);
    const business=sql.prepare('SELECT details FROM movement_business ORDER BY movement_id DESC LIMIT 1').get();assert.equal(JSON.parse(business.details).document_no,'REQ-100');
    await assert.rejects(jobs.handoff(req({revision:confirmed.revision,confirmed:true}),personal.id),/已有办理/);
    const rollback=await jobs.createDocument(req({...docBody,request_id:'rollback-create',rows:docBody.rows.slice(0,3)}));
    sql.exec("CREATE TRIGGER fail_doc_handoff BEFORE INSERT ON assistant_job_handoff BEGIN SELECT RAISE(ABORT,'handoff-storage-failure'); END;");
    await assert.rejects(jobs.handoff(req({revision:rollback.revision,confirmed:true}),rollback.id),/handoff-storage-failure/);assert.equal(stock().reserved_qty,5);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM team_task').get().n,1);
    sql.exec('DROP TRIGGER fail_doc_handoff');
    const tooMuch=await jobs.createDocument(req({...docBody,request_id:'too-much',rows:[docBody.rows[1],['DOC-6204','深沟球轴承6204',8,'套',from],['DOC-6204','深沟球轴承6204',8,'套',from]]}));
    await assert.rejects(jobs.handoff(req({revision:tooMuch.revision,confirmed:true}),tooMuch.id),/可用库存不足/);assert.equal(stock().reserved_qty,5);assert.equal(stock().qty,17);
    const moved=await jobs.createDocument(req({operation:'move',text:`DOC-6204 2套 ${from} ${target}`,request_id:'move-create'}));assert.equal(moved.rows[0].canConfirm,true);
    const old=moved.rows[0].bindings.locations[target];sql.prepare('UPDATE space_node SET id=? WHERE loc_code=?').run('recreated-node',target);
    await assert.rejects(jobs.handoff(req({revision:moved.revision,confirmed:true}),moved.id),/核对每项/);sql.prepare('UPDATE space_node SET id=? WHERE loc_code=?').run(old,target);
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
