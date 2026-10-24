import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {createWarehouseAccess} from '../apps/api/warehouse-access.mjs';
import {createTeamTasks} from '../apps/api/team-tasks.mjs';
import {createStocktakes} from '../apps/api/stocktake.mjs';

test('团队任务、交接、预占和所有库存写入口保持一致',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'team-tasks-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,access=createWarehouseAccess(sql,{standalone:true,localUsers:true}),work=createWarehouseWork(sql,{db});
  const tasks=createTeamTasks({sql,db,work,access}),counts=createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
  const user=(username,role='operator')=>db.createUser({username,role,name:username,pw_hash:'fixture',pw_salt:'fixture'});
  const admin=user('manager','admin'),a=user('worker-a'),b=user('worker-b'),c=user('worker-c'),viewer=user('viewer','viewer');let serial=0;
  const key=()=>String(++serial);
  const req=(actor,body={},room)=>({user:actor,body,query:{room:room||body.room},...(actor.role==='admin'?{}:{canAccessLocation:code=>access.member(actor.id).canAccess(code)})});
  const fixture=(name,qty=20,siteCode)=>{
    const room=db.createRoomNode({name,w:12,d:8,h:4,...(siteCode?{siteCode}:{})}),rack=db.createRack({roomCode:room.loc_code,rows:1,cols:3});
    const loc=rack.furn_code+'-L01-B01',target=rack.furn_code+'-L01-B02',third=rack.furn_code+'-L01-B03';
    const item=db.inbound({loc_code:loc,name,sku:'TEAM-'+key(),qty,unit:'套'});return {room,rack,loc,target,third,item};
  };
  const create=(f,extra={})=>tasks.create(req(admin,{room:f.room.loc_code,title:'团队作业',assignee_id:a.id,lines:[{operation:'out',item_id:f.item.item_id,qty:8,from_loc:f.loc}],request_id:key(),...extra})).task;
  const act=(task,actor,action,extra={})=>{const latest=tasks.get(req(actor),task.id);return tasks.act(req(actor,{revision:latest.revision,request_id:key(),action,...extra}),task.id).task;};
  const stock=f=>db.getCellItems(f.loc)[0];
  try{
    await t.test('发布即预占，可用数量在API与3D中一致，不能超额预占',()=>{
      const f=fixture('预占轴承'),task=create(f);assert.equal(task.status,'assigned');assert.equal(stock(f).qty,20);assert.equal(stock(f).reserved_qty,8);assert.equal(stock(f).available_qty,12);
      const scene=db.getScene(f.room.loc_code);assert.equal(scene.furniture[0].items['L01-B01'][0].reserved_qty,8);
      assert.equal(db.listInventory().find(row=>row.loc_code===f.loc).available_qty,12);
      const n=sql.prepare('SELECT COUNT(*) AS n FROM team_task').get().n;
      assert.throws(()=>create(f,{lines:[{operation:'out',item_id:f.item.item_id,qty:13,from_loc:f.loc}]}),/可用库存不足/);
      assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM team_task').get().n,n);assert.equal(stock(f).reserved_qty,8);
    });
    await t.test('手工出库、移库、旧编辑、替换写入和盘点均不能消耗预占库存',()=>{
      const f=fixture('受保护库存'),task=create(f),before=stock(f),node=sql.prepare('SELECT id FROM space_node WHERE loc_code=?').get(f.loc);
      assert.throws(()=>db.outbound({loc_code:f.loc,item_id:f.item.item_id,qty:13}),/预占/);
      assert.throws(()=>db.moveItem({from_loc:f.loc,to_loc:f.target,item_id:f.item.item_id,qty:13}),/预占/);
      assert.throws(()=>db.updateItem(f.item.item_id,{qty:2}),/预占/);
      const inv=sql.prepare('SELECT * FROM inventory WHERE node_id=? AND item_id=?').get(node.id,f.item.item_id);
      assert.throws(()=>sql.prepare('INSERT OR REPLACE INTO inventory(id,tenant_id,node_id,item_id,qty) VALUES(?,?,?,?,?)').run(inv.id,db.TENANT,node.id,f.item.item_id,1),/预占/);
      assert.throws(()=>sql.prepare('DELETE FROM item WHERE id=?').run(f.item.item_id),/预占/);
      let count=counts.create({loc_code:f.loc},a);count=counts.save(count.id,{revision:count.revision,counts:[{item_id:f.item.item_id,qty:2}],reason:'现场短缺'},a);
      assert.throws(()=>counts.finish(count.id,{revision:count.revision,action:'confirm'},a),/预占/);
      assert.deepEqual(stock(f),before);assert.equal(tasks.get(req(admin),task.id).lines[0].done_qty,0);
    });
    await t.test('领取有唯一接收人，部分完成、丢回执重试与管理确认不重复扣账',()=>{
      const f=fixture('分批领用'),task=create(f,{assignee_id:null,recipient:'生产一组',department:'加工车间',purpose:'设备维修',document_no:'REQ-001'});
      const claim={action:'claim',revision:task.revision,request_id:'claim-once'};
      let current=tasks.act(req(a,claim),task.id).task;assert.equal(current.assignee_id,a.id);
      assert.throws(()=>tasks.act(req(b,{...claim,request_id:key()}),task.id),error=>error.status===404||error.status===409);
      assert.equal(tasks.act(req(a,claim),task.id).replayed,true);
      const input={action:'execute',revision:current.revision,line_id:current.lines[0].id,qty:3,request_id:'execute-once'};
      const n=sql.prepare('SELECT COUNT(*) AS n FROM movement').get().n;
      current=tasks.act(req(a,input),task.id).task;assert.equal(stock(f).qty,17);assert.equal(stock(f).reserved_qty,5);assert.equal(stock(f).available_qty,12);assert.equal(current.lines[0].done_qty,3);
      assert.equal(tasks.act(req(a,input),task.id).replayed,true);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM movement').get().n,n+1);
      assert.throws(()=>tasks.act(req(a,{...input,qty:4}),task.id),error=>error.status===409);
      const movement=db.getCellHistory(f.loc)[0];assert.equal(movement.business.team_task_id,task.id);assert.equal(movement.business.document_no,'REQ-001');assert.equal(movement.business.recipient,'生产一组');
      current=act(current,a,'execute',{line_id:current.lines[0].id,qty:5});assert.equal(current.status,'awaiting_check');assert.equal(stock(f).qty,12);assert.equal(stock(f).reserved_qty,undefined);
      assert.throws(()=>act(current,a,'confirm'),error=>error.status===403);assert.equal(act(current,admin,'confirm').status,'completed');
    });
    await t.test('交接需接收人确认，交接期间和原接收人不能继续扣账',()=>{
      const f=fixture('交接领用');let task=act(create(f),a,'claim');task=act(task,a,'execute',{line_id:task.lines[0].id,qty:2});
      task=act(task,a,'handover',{assignee_id:b.id,note:'已领2套，剩余由下一班办理'});assert.equal(task.status,'handover');assert.equal(stock(f).reserved_qty,6);
      assert.throws(()=>act(task,a,'execute',{line_id:task.lines[0].id,qty:1}),error=>error.status===403);
      assert.throws(()=>act(task,c,'accept_handover'),error=>error.status===404||error.status===403);
      task=act(task,b,'accept_handover');assert.equal(task.assignee_id,b.id);
      assert.throws(()=>act(task,a,'execute',{line_id:task.lines[0].id,qty:1}),error=>error.status===403);
      task=act(task,b,'execute',{line_id:task.lines[0].id,qty:6});assert.equal(task.status,'awaiting_check');assert.equal(stock(f).qty,12);assert.ok(task.history.rows.some(row=>row.action==='accept_handover'));
    });
    await t.test('缺货反馈不修改数量，取消只释放剩余预占且保留已办流水',()=>{
      const f=fixture('短缺与取消');let task=act(create(f),a,'claim');task=act(task,a,'execute',{line_id:task.lines[0].id,qty:2});
      task=act(task,a,'shortage',{note:'现场货品标签不一致，暂缓领用'});assert.equal(task.status,'blocked');assert.equal(stock(f).qty,18);assert.equal(stock(f).reserved_qty,6);
      assert.throws(()=>act(task,a,'execute',{line_id:task.lines[0].id,qty:1}),error=>error.status===403);
      task=act(task,admin,'cancel',{note:'保留已领2套，核对实物后重新安排'});assert.equal(task.status,'cancelled');assert.equal(task.lines[0].done_qty,2);assert.equal(stock(f).qty,18);assert.equal(stock(f).reserved_qty,undefined);
    });
    await t.test('任务执行中途失败，库存、预占、流水、业务关联和执行进度一起回滚',()=>{
      const f=fixture('故障回滚'),task=act(create(f),a,'claim');
      const before=()=>Object.fromEntries(['inventory','stock_reservation','movement','movement_business','team_task_line','team_task_event','counter_request'].map(table=>[table,sql.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
      const snapshot=before(),failing=createTeamTasks({sql,db:{...db,outbound:input=>{db.outbound(input);throw Error('模拟扣账后故障');}},work,access});
      assert.throws(()=>failing.act(req(a,{action:'execute',line_id:task.lines[0].id,qty:2,revision:task.revision,request_id:key()}),task.id),/扣账后故障/);
      assert.deepEqual(before(),snapshot);
    });
    await t.test('收货任务支持新货品、分批复用，移库只生成真实移动流水',()=>{
      const f=fixture('收货与移库');let task=create(f,{lines:[{operation:'in',name:'新增标准件',sku:'NEW-TEAM-001',unit:'箱',qty:4,to_loc:f.target}]});
      task=act(task,a,'claim');task=act(task,a,'execute',{line_id:task.lines[0].id,qty:1});const id=task.lines[0].item_id;assert.ok(id);
      task=act(task,a,'execute',{line_id:task.lines[0].id,qty:3});assert.equal(db.getCellItems(f.target)[0].qty,4);assert.equal(task.lines[0].item_id,id);
      let move=create(f,{lines:[{operation:'move',item_id:f.item.item_id,qty:2,from_loc:f.loc,to_loc:f.third}]});move=act(move,a,'claim');
      const count=sql.prepare('SELECT COUNT(*) AS n FROM movement').get().n;move=act(move,a,'execute',{line_id:move.lines[0].id,qty:2});assert.equal(move.status,'awaiting_check');assert.equal(db.getCellItems(f.third)[0].qty,2);assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM movement').get().n,count+1);
    });
    await t.test('新货架替换同编码后不能执行旧任务，旧版本不能覆盖新分派',()=>{
      const f=fixture('节点身份');let task=create(f,{lines:[{operation:'in',name:'新设备件',sku:'NEW-NODE-001',unit:'件',qty:1,to_loc:f.target}]});
      task=act(task,a,'claim');const oldRevision=task.revision;
      task=act(task,admin,'assign',{assignee_id:b.id,note:'更换接收人'});
      assert.throws(()=>tasks.act(req(a,{action:'execute',revision:oldRevision,line_id:task.lines[0].id,qty:1,request_id:key()}),task.id),error=>error.status===409);
      // 只替换任务所指的空格位，保留同编码以检验节点绑定。
      const node=sql.prepare('SELECT * FROM space_node WHERE loc_code=?').get(f.target);sql.prepare('UPDATE space_node SET id=? WHERE id=?').run('rebuilt-'+key(),node.id);
      task=act(task,b,'claim');assert.throws(()=>act(task,b,'execute',{line_id:task.lines[0].id,qty:1}),/重建/);assert.equal(db.getItemByCode('NEW-NODE-001'),null);
    });
    await t.test('本地分仓即时生效，不能分派给无权接收人，历史参与也不能绕过撤权',()=>{
      const site=db.createSite({name:'分仓验收'}),f=fixture('分仓物资',20,site.loc_code);let task=create(f);task=act(task,a,'claim');
      access.save({user_id:a.id,sites:['WH']},admin.id);assert.equal(access.member(a.id).canAccess(f.room.loc_code),false);
      assert.throws(()=>tasks.get(req(a),task.id),error=>error.status===403);
      assert.throws(()=>create(f),/没有该仓库权限/);assert.ok(!tasks.eligible(req(admin),f.room.loc_code).some(user=>user.id===a.id));
      task=act(task,admin,'assign',{assignee_id:b.id,note:'转交本仓授权人员'});assert.equal(task.assignee_id,b.id);
      access.remove(a.id);
    });
    await t.test('只读和机器账号不能领取或办理，角色撤销后已有任务明确提示',()=>{
      const f=fixture('角色变更'),task=create(f);
      assert.throws(()=>tasks.create(req(viewer,{room:f.room.loc_code,lines:[],request_id:key()})),error=>error.status===403);
      assert.throws(()=>tasks.list({...req(a,{},f.room.loc_code),user:{...a,isService:true}}),error=>error.status===403);
      db.updateUser(a.id,{role:'viewer'});assert.ok(tasks.get(req(admin),task.id).assignment_issue);
      assert.throws(()=>act(task,a,'claim'),/没有作业角色/);db.updateUser(a.id,{role:'operator'});
    });
  }finally{sql.close();rmSync(dir,{recursive:true,force:true});}
});
