import {randomUUID,createHash} from 'node:crypto';
import {actorStore} from './context.mjs';
import {businessDetails} from './movement-business.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const closed=new Set(['completed','cancelled']);
const canWork=user=>user&&user.status!=='disabled'&&['admin','operator'].includes(user.role);
const hash=value=>createHash('sha256').update(JSON.stringify(value,(_key,row)=>row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))):row)).digest('hex');

export function createTeamTasks({sql,db,work,access}){
  sql.exec(`CREATE TABLE IF NOT EXISTS team_task (
    id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,room_id TEXT NOT NULL,room_code TEXT NOT NULL,title TEXT NOT NULL,
    status TEXT NOT NULL,assignee_id TEXT,handover_to TEXT,handover_note TEXT NOT NULL DEFAULT '',
    business TEXT NOT NULL DEFAULT '{}',note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS team_task_room ON team_task(room_id,status,updated_at);
    CREATE INDEX IF NOT EXISTS team_task_assignee ON team_task(assignee_id,status);
    CREATE TABLE IF NOT EXISTS team_task_line (
    id TEXT PRIMARY KEY,task_id TEXT NOT NULL,operation TEXT NOT NULL,item_id TEXT,name TEXT NOT NULL,sku TEXT NOT NULL,unit TEXT NOT NULL,
    qty REAL NOT NULL,done_qty REAL NOT NULL DEFAULT 0,from_loc TEXT NOT NULL,to_loc TEXT NOT NULL,from_node_id TEXT,to_node_id TEXT);
    CREATE INDEX IF NOT EXISTS team_line_task ON team_task_line(task_id);
    CREATE TABLE IF NOT EXISTS team_task_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,line_id TEXT,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,
    action TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS team_event_actor ON team_task_event(actor_id,task_id);
    CREATE TABLE IF NOT EXISTS team_task_request (
    actor_id TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));`);
  const read=id=>sql.prepare('SELECT * FROM team_task WHERE id=? AND tenant_id=?').get(id,db.TENANT);
  const lines=id=>sql.prepare('SELECT * FROM team_task_line WHERE task_id=? ORDER BY rowid').all(id);
  const participant=(id,user)=>!!sql.prepare('SELECT 1 FROM team_task_event WHERE task_id=? AND actor_id=? LIMIT 1').get(id,user);
  const member=id=>access.member(id);
  function room(req,code){return work.room(code,req.canAccessLocation);}
  function scope(req,id){
    if(req.user.isService||!['admin','operator','viewer'].includes(req.user.role))fail('当前账号不能查看团队任务',403);
    const task=read(id);if(!task)fail('任务不存在',404);
    const current=room(req,task.room_code);if(current.id!==task.room_id)fail('原库区已重建，任务不能用于新库区',409);
    if(req.user.role!=='admin'&&task.assignee_id!==req.user.id&&task.handover_to!==req.user.id&&task.status!=='open'&&!participant(id,req.user.id))fail('任务不存在',404);
    return task;
  }
  function location(req,code,roomId){
    const canonical=db.resolveCellCode(String(code||'').trim());
    const node=sql.prepare("SELECT c.* FROM space_node c JOIN space_node r ON r.id=c.parent_id WHERE c.loc_code=? AND c.node_type='cell' AND r.parent_id=?").get(canonical,roomId);
    if(!node||!db.getCells().some(cell=>cell.loc_code===canonical))fail('请选择任务库区内的有效格位');
    if(req.canAccessLocation&&!req.canAccessLocation(canonical))fail('当前账号没有该格位权限',403);
    if((node.status||'normal')!=='normal')fail('格位已锁定或盘点中，请先核对现场状态',409);return node;
  }
  function assigned(id,task){
    const user=member(id);if(!canWork(user)||!user.canAccess(task.room_code))fail('接收账号已停用、没有作业角色或没有该仓库权限',409);
    return user;
  }
  function event(task,req,action,details={},lineId=null){sql.prepare('INSERT INTO team_task_event(task_id,line_id,actor_id,actor_name,action,details,created_at) VALUES(?,?,?,?,?,?,?)').run(task.id,lineId,req.user.id,req.user.name||req.user.username||req.user.id,action,JSON.stringify(details),new Date().toISOString());}
  function history(req,id,{before}={}){
    scope(req,id);const cursor=before==null?Number.MAX_SAFE_INTEGER:Number(before);if(!Number.isSafeInteger(cursor)||cursor<1)fail('记录分页位置无效');
    const rows=sql.prepare('SELECT * FROM team_task_event WHERE task_id=? AND id<? ORDER BY id DESC LIMIT 31').all(id,cursor);
    return {rows:rows.slice(0,30).map(row=>({...row,details:JSON.parse(row.details)})),next_before:rows.length>30?rows[29].id:null};
  }
  function get(req,id){
    const task=scope(req,id),actor=req.user,owner=task.assignee_id===actor.id,admin=actor.role==='admin';
    const receiver=task.handover_to===actor.id;
    const rows=lines(id).map(line=>{
      const current=line.item_id?sql.prepare('SELECT name,sku,unit FROM item WHERE id=?').get(line.item_id):null;
      const qty=line.item_id&&line.from_node_id?sql.prepare('SELECT qty FROM inventory WHERE node_id=? AND item_id=?').get(line.from_node_id,line.item_id)?.qty||0:0;
      const reserved=sql.prepare('SELECT qty FROM stock_reservation WHERE line_id=?').get(line.id)?.qty||0;
      const total=line.item_id&&line.from_node_id?sql.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM stock_reservation WHERE node_id=? AND item_id=?').get(line.from_node_id,line.item_id).n:0;
      return {...line,current_name:current?.name||line.name,current_sku:current?.sku||line.sku,remaining:Math.max(0,line.qty-line.done_qty),stock_qty:qty,reserved_qty:reserved,available_qty:Math.max(0,qty-total)};
    });
    const assignee=task.assignee_id?member(task.assignee_id):null;
    return {...task,business:JSON.parse(task.business),lines:rows,assignee_name:assignee?.name||assignee?.username||'未分派',handover_name:task.handover_to?member(task.handover_to)?.name||task.handover_to:'',
      assignment_issue:task.assignee_id&&(!canWork(assignee)||!assignee.canAccess(task.room_code))?'当前接收人已失去作业权限，请管理员重新分派或取消剩余任务。':'',
      permissions:{claim:canWork(actor)&&(task.status==='open'||owner&&task.status==='assigned'),execute:canWork(actor)&&owner&&task.status==='active',
        assign:admin&&!closed.has(task.status)&&task.status!=='awaiting_check',cancel:admin&&!closed.has(task.status)&&task.status!=='awaiting_check',
        handover:canWork(actor)&&owner&&['active','blocked','assigned'].includes(task.status),accept_handover:canWork(actor)&&receiver&&task.status==='handover',
        withdraw_handover:task.status==='handover'&&(owner||admin||receiver),resume:task.status==='blocked'&&(owner||admin),confirm:admin&&task.status==='awaiting_check'},
      history:history(req,id)};
  }
  function eligible(req,code){
    if(!canWork(req.user)||req.user.isService)fail('当前账号不能查看任务成员',403);
    const r=room(req,code);return access.users().map(user=>member(user.id)).filter(user=>canWork(user)&&user.canAccess(r.loc_code)).map(user=>({id:user.id,name:user.name,username:user.username,role:user.role}));
  }
  function list(req){
    if(req.user.isService)fail('机器凭证不能查看团队任务',403);
    const r=room(req,req.query.room),page=Number(req.query.page||1),filter=req.query.filter||'pending';if(!Number.isInteger(page)||page<1)fail('页码无效');
    if(!['pending','mine','pool','history','all'].includes(filter))fail('任务筛选条件无效');
    const actor=req.user;let tasks=sql.prepare('SELECT * FROM team_task WHERE room_id=? AND tenant_id=? ORDER BY updated_at DESC,id DESC').all(r.id,db.TENANT);
    tasks=tasks.filter(task=>(actor.role==='admin'||task.assignee_id===actor.id||task.handover_to===actor.id||task.status==='open'||participant(task.id,actor.id))
      &&(filter==='all'||filter==='history'?filter==='all'||closed.has(task.status):!closed.has(task.status))
      &&(filter!=='mine'||task.assignee_id===actor.id||task.handover_to===actor.id)&&(filter!=='pool'||task.status==='open'));
    const attention=tasks.filter(task=>['blocked','handover','awaiting_check'].includes(task.status)).map(task=>({kind:'team',id:task.id,title:task.title,status:task.status,updated_at:task.updated_at,
      evidence:{task_id:task.id,status:task.status,note:task.status==='handover'?task.handover_note:task.note,lines:lines(task.id).map(line=>({line_id:line.id,name:line.name,qty:line.qty,done_qty:line.done_qty,unit:line.unit}))}}));
    return {page,pages:Math.max(1,Math.ceil(tasks.length/20)),total:tasks.length,attention,rows:tasks.slice((page-1)*20,page*20).map(task=>{
      const rows=lines(task.id);return {id:task.id,title:task.title,status:task.status,assignee_name:task.assignee_id?member(task.assignee_id)?.name||'账号已不可用':'未分派',revision:task.revision,updated_at:task.updated_at,
        total:rows.length,completed:rows.filter(line=>line.done_qty>=line.qty).length,has_partial:rows.some(line=>line.done_qty>0),mine:task.assignee_id===actor.id||task.handover_to===actor.id};})};
  }
  function request(req,input,signature,write){
    if(!canWork(req.user)||req.user.isService)fail('当前账号不能办理团队任务',403);
    if(typeof input.request_id!=='string'||!input.request_id||input.request_id.length>128)fail('需要任务请求编号');
    const previous=sql.prepare('SELECT * FROM team_task_request WHERE actor_id=? AND request_id=?').get(req.user.id,input.request_id);
    if(previous){if(previous.signature!==signature)fail('请求内容已变化，请勿复用原请求编号',409);const receipt=JSON.parse(previous.result);return {...receipt,replayed:true,task:get(req,receipt.task_id)};}
    sql.exec('SAVEPOINT team_task_write');
    try{const result=write(),task=get(req,result.task_id);sql.prepare('INSERT INTO team_task_request VALUES(?,?,?,?)').run(req.user.id,input.request_id,signature,JSON.stringify(result));sql.exec('RELEASE SAVEPOINT team_task_write');return {...result,task};}
    catch(error){sql.exec('ROLLBACK TO SAVEPOINT team_task_write; RELEASE SAVEPOINT team_task_write');throw error;}
  }
  function create(req){
    if(req.user.role!=='admin')fail('只有管理员可以发布团队任务',403);
    const input=req.body,r=room(req,input.room),title=String(input.title||'').trim();if(!title||title.length>120)fail('任务名称须填写1至120个字');
    return request(req,input,hash(['create',input]),()=>{
      if(!Array.isArray(input.lines)||!input.lines.length||input.lines.length>50)fail('每个任务须填写1至50项作业');
      if(input.room_id&&input.room_id!==r.id)fail('库区已重建，请重新选择并预览任务',409);
      const id=randomUUID(),now=new Date().toISOString(),task={id,room_code:r.loc_code};
      if(input.assignee_id)assigned(input.assignee_id,task);
      sql.prepare('INSERT INTO team_task(id,tenant_id,room_id,room_code,title,status,assignee_id,business,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,db.TENANT,r.id,r.loc_code,title,input.assignee_id?'assigned':'open',input.assignee_id||null,JSON.stringify(businessDetails(input)),req.user.id,now,now);
      for(const raw of input.lines){
        const operation=raw.operation,qty=Number(raw.qty);if(!['in','out','move'].includes(operation)||!Number.isFinite(qty)||qty<=0)fail('请选择作业类型并填写大于零的数量');
        const byCode=raw.sku?db.getItemByCode(raw.sku):null;if(raw.item_id&&byCode&&raw.item_id!==byCode.item_id)fail('货品与条码不一致');
        let item=sql.prepare('SELECT id,name,sku,unit FROM item WHERE id=?').get(raw.item_id||byCode?.item_id||'');
        if(raw.new_item&&item)fail('新货品编号已被使用，请选择已有货品后重新预览',409);
        if(!item&&operation!=='in')fail('出库和移库必须选择已有货品');
        if(!item){const name=String(raw.name||'').trim(),unit=String(raw.unit||'件').trim(),sku=String(raw.sku||'').trim()||'TMP-'+randomUUID().slice(0,8).toUpperCase();if(!name||name.length>200||!unit||unit.length>20||sku.length>120)fail('请填写新货品名称、编号和库存单位');item={id:null,name,sku,unit};}
        if(raw.unit&&raw.unit!==item.unit)fail('货品单位与系统不一致');
        const from=operation!=='in'?location(req,raw.from_loc,r.id):null,to=operation!=='out'?location(req,raw.to_loc,r.id):null;
        if(raw.from_node_id&&from?.id!==raw.from_node_id||raw.to_node_id&&to?.id!==raw.to_node_id)fail('格位已重建，请重新选择并预览任务',409);
        if(from&&to&&from.id===to.id)fail('移库的源格位与目标格位不能相同');
        const lineId=randomUUID();sql.prepare('INSERT INTO team_task_line(id,task_id,operation,item_id,name,sku,unit,qty,from_loc,to_loc,from_node_id,to_node_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(lineId,id,operation,item.id,item.name,item.sku||'',item.unit||'件',qty,from?.loc_code||'',to?.loc_code||'',from?.id||null,to?.id||null);
        if(from)sql.prepare('INSERT INTO stock_reservation VALUES(?,?,?,?,?,?)').run(lineId,id,db.TENANT,from.id,item.id,qty);
      }
      event(task,req,'created',{title,assignee_id:input.assignee_id||null});return {task_id:id,action:'created'};
    });
  }
  function act(req,id){
    scope(req,id);const input=req.body,action=input.action;
    return request(req,input,hash([id,input]),()=>{
      const task=scope(req,id);
      if(task.revision!==input.revision)fail('任务已被其他人更新，请刷新后核对',409);
      if(closed.has(task.status))fail('任务已结束',409);
      const owner=task.assignee_id===req.user.id,admin=req.user.role==='admin',note=String(input.note||'').trim();if(note.length>500)fail('说明最多500字');
      let state=task.status,assignee=task.assignee_id,handover=task.handover_to,handoverNote=task.handover_note,receipt;
      if(action==='claim'){
        if(task.status!=='open'&&!(owner&&task.status==='assigned'))fail('任务已被领取或未分派给当前账号',409);
        assigned(req.user.id,task);assignee=req.user.id;state='active';
      }else if(action==='assign'){
        if(!admin||task.status==='awaiting_check')fail('当前任务不能重新分派',403);assigned(input.assignee_id,task);
        if(lines(id).some(line=>line.done_qty>0)&&!note)fail('已有部分作业完成，请填写重新分派的交接说明');
        assignee=input.assignee_id;handover=null;handoverNote='';state='assigned';
      }else if(action==='handover'){
        if(!owner||!['active','assigned','blocked'].includes(task.status))fail('当前账号不能发起交接',403);
        assigned(input.assignee_id,task);if(input.assignee_id===req.user.id||!note)fail('请选择其他接收人并填写交接说明');
        handover=input.assignee_id;handoverNote=note;state='handover';
      }else if(action==='accept_handover'){
        if(task.status!=='handover'||task.handover_to!==req.user.id)fail('当前账号不是交接接收人',403);
        assigned(req.user.id,task);assignee=req.user.id;handover=null;handoverNote='';state='active';
      }else if(action==='withdraw_handover'){
        if(task.status!=='handover'||!owner&&!admin&&task.handover_to!==req.user.id)fail('不能撤回或退回此交接',403);
        if(!note)fail('请填写撤回或退回说明');handover=null;handoverNote='';state='assigned';
      }else if(action==='shortage'){
        if(!owner||task.status!=='active')fail('请先领取此任务',403);if(!note)fail('请说明缺货或现场异常');state='blocked';
      }else if(action==='resume'){
        if(task.status!=='blocked'||!owner&&!admin)fail('不能恢复此任务',403);if(!note)fail('请填写异常处理结果');state='active';
      }else if(action==='cancel'){
        if(!admin||task.status==='awaiting_check')fail('只有管理员可以取消未完成任务',403);if(!note)fail('请填写取消原因');
        sql.prepare('DELETE FROM stock_reservation WHERE task_id=?').run(id);state='cancelled';handover=null;handoverNote='';
      }else if(action==='confirm'){
        if(!admin||task.status!=='awaiting_check')fail('只有管理员可以确认已办完的任务',403);state='completed';
      }else if(action==='execute'){
        if(!owner||task.status!=='active')fail('请先领取任务，交接或暂停期间不能办理',403);
        assigned(req.user.id,task);
        const line=sql.prepare('SELECT * FROM team_task_line WHERE task_id=? AND id=?').get(id,input.line_id),qty=Number(input.qty);
        if(!line)fail('任务明细不存在',404);if(!Number.isFinite(qty)||qty<=0||qty>line.qty-line.done_qty)fail('本次数量须大于零且不超过任务剩余数量');
        const from=line.from_loc?location(req,line.from_loc,task.room_id):null,to=line.to_loc?location(req,line.to_loc,task.room_id):null;
        if(from&&from.id!==line.from_node_id||to&&to.id!==line.to_node_id)fail('任务格位已重建，请取消剩余任务后重新安排',409);
        let item=line.item_id?sql.prepare('SELECT id,name,sku,unit FROM item WHERE id=?').get(line.item_id):null;
        if(line.item_id&&!item)fail('原货品已不存在，请重新安排任务',409);
        if(!item){const linked=db.getItemByCode(line.sku);if(linked){if(linked.name!==line.name||linked.unit!==line.unit)fail('新货品编号已被其他货品使用，请管理员核对',409);item={id:linked.item_id,...linked};}}
        if(item&&(item.unit||'件')!==line.unit)fail('库存单位已变化，请重新安排任务',409);
        if(from){const reserved=sql.prepare('SELECT qty FROM stock_reservation WHERE line_id=?').get(line.id);if(!reserved||reserved.qty<qty)fail('任务预占记录已变化，请管理员核对',409);
          const remaining=reserved.qty-qty;if(remaining>0)sql.prepare('UPDATE stock_reservation SET qty=? WHERE line_id=?').run(remaining,line.id);else sql.prepare('DELETE FROM stock_reservation WHERE line_id=?').run(line.id);}
        const business={...JSON.parse(task.business),team_task_id:id,team_line_id:line.id};
        const requestId='team:'+hash([id,input.request_id]);
        receipt=actorStore.run({...req.user,business},()=>line.operation==='in'?db.inbound({loc_code:to.loc_code,item_id:item?.id,name:item?.name||line.name,sku:item?.sku||line.sku,unit:line.unit,qty,request_id:requestId}):line.operation==='out'?db.outbound({loc_code:from.loc_code,item_id:item.id,qty,request_id:requestId}):db.moveItem({from_loc:from.loc_code,to_loc:to.loc_code,item_id:item.id,qty,request_id:requestId}));
        sql.prepare('UPDATE team_task_line SET done_qty=done_qty+?,item_id=COALESCE(item_id,?) WHERE id=?').run(qty,receipt.item_id||item?.id,line.id);
        if(lines(id).every(row=>row.done_qty>=row.qty))state='awaiting_check';
      }else fail('未知任务操作');
      sql.prepare('UPDATE team_task SET status=?,assignee_id=?,handover_to=?,handover_note=?,note=?,revision=revision+1,updated_at=? WHERE id=?').run(state,assignee,handover,handoverNote,note||task.note,new Date().toISOString(),id);
      event(task,req,action,{...(['execute'].includes(action)?{qty:Number(input.qty),receipt}:{}),...(input.assignee_id?{assignee_id:input.assignee_id}:{}),...(note?{note}:{}),status:state},input.line_id||null);
      return {task_id:id,action,...(receipt?{receipt}:{}),...(input.line_id?{line_id:input.line_id}:{})};
    });
  }
  return {get,list,create,act,eligible,history};
}

export function mountTeamTasks(app,{tasks,requireRole}){
  const route=fn=>(req,res)=>{try{res.set('Cache-Control','no-store').json(fn(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  app.get('/api/team-tasks',route(req=>tasks.list(req)));
  app.get('/api/team-tasks/members',requireRole('admin','operator'),route(req=>tasks.eligible(req,req.query.room)));
  app.get('/api/team-tasks/:id',route(req=>tasks.get(req,req.params.id)));
  app.get('/api/team-tasks/:id/events',route(req=>tasks.history(req,req.params.id,req.query)));
  app.post('/api/team-tasks',requireRole('admin'),route(req=>tasks.create(req)));
  app.post('/api/team-tasks/:id/actions',requireRole('admin','operator'),route(req=>tasks.act(req,req.params.id)));
}
