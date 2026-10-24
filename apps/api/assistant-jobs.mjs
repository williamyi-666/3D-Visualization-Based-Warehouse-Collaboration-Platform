import {randomUUID,createHash} from 'node:crypto';
import {actorStore} from './context.mjs';
import {parseWarehouseDocument} from './assistant-document.mjs';
import {businessDetails} from './movement-business.mjs';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const fields=['operation','query','qty','unit','from_hint','to_hint','item_id','from_loc','to_loc','new_item','name','sku'];
const clean=input=>Object.fromEntries(fields.filter(k=>input?.[k]!==undefined&&input[k]!==null).map(k=>[k,input[k]]));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createAssistantJobs({sql,db,tools,teamTasks,integrationMode=false}) {
  sql.exec(`CREATE TABLE IF NOT EXISTS assistant_job (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,room_id TEXT NOT NULL,room_code TEXT NOT NULL,
    title TEXT NOT NULL,rows_json TEXT NOT NULL,revision INTEGER NOT NULL,
    create_key TEXT NOT NULL,signature TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_id,create_key));
    CREATE TABLE IF NOT EXISTS assistant_job_document(job_id TEXT PRIMARY KEY,document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_job_handoff(job_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      request_id TEXT NOT NULL,signature TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const decode=row=>row?{...row,rows:JSON.parse(row.rows_json)}:null;
  const read=id=>decode(sql.prepare('SELECT * FROM assistant_job WHERE id=?').get(id));
  const document=id=>{const row=sql.prepare('SELECT document FROM assistant_job_document WHERE job_id=?').get(id);return row?JSON.parse(row.document):null;};
  const handed=id=>sql.prepare('SELECT * FROM assistant_job_handoff WHERE job_id=?').get(id)||null;
  const editable=job=>{if(handed(job.id))fail('清单已转为团队任务，请在团队任务中继续办理',409);};
  async function scope(req,job){
    if(integrationMode||!['admin','operator'].includes(req.user.role)||req.user.isService)fail('当前账号不能办理本地库存作业清单',403);
    if(job&&job.owner_id!==req.user.id)fail('作业清单不存在',404);
    const scoped={...req,body:{room:job?.room_code||req.body?.room||req.query?.room,context:{}}},ctx=await tools.context(scoped);
    if(job&&ctx.room.id!==job.room_id)fail('原库区已变化，请重新建立清单',409);
    if(job&&req.canAccessLocation)for(const row of job.rows)for(const loc of Object.keys(row.bindings?.locations||{}))if(!req.canAccessLocation(loc))fail('清单包含当前账号无权访问的位置',403);
    return {ctx,req:scoped};
  }
  function bindings(preview,ctx){
    const draft=preview.draft;if(!preview.ready||!draft)return null;
    const codes=[draft.operation!=='in'?draft.from_loc:'',draft.operation!=='out'?draft.to_loc:''].filter(Boolean);
    return {item_id:draft.item_id||null,locations:Object.fromEntries(codes.map(code=>[code,ctx.cells.some(c=>c.loc_code===code)?sql.prepare("SELECT id FROM space_node WHERE node_type='cell' AND loc_code=?").get(code)?.id||null:null]))};
  }
  async function preview(input,req,ctx,context={}){
    const result=await tools.run('prepare_operation',clean(input),{...req,body:{room:ctx.room.loc_code,context}});
    if(input.operation!=='in'||!input.new_item||result.choices.length)return result;
    const name=String(input.name||input.query||'').trim(),sku=String(input.sku||'').trim(),unit=String(input.unit||'').trim(),qty=input.qty;
    const reasons=[];if(!name||name.length>200)reasons.push('请填写完整的新货品名称');
    if(!unit||unit.length>20)reasons.push('请填写库存单位');if(typeof qty!=='number'||!Number.isFinite(qty)||qty<=0)reasons.push('请填写大于零的办理数量');
    if(sku.length>100)reasons.push('SKU不能超过100字');
    const existing=sku?db.getItemByCode(sku):sql.prepare("SELECT id FROM item WHERE name=? AND (sku IS NULL OR trim(sku)='')").get(name);
    if(existing)reasons.push('该编号或同名未编号货品已存在，请选择已有货品或核对SKU');
    const target=result.destinations.length===1?result.destinations[0].loc_code:'';
    if(!target)reasons.push('请选择具体目标格位');
    return {...result,input:{...result.input,name,sku,new_item:true,unit,qty},ready:!reasons.length,new_item:true,
      draft:{operation:'in',name,sku,unit,qty,to_loc:target,loc:target},message:reasons.join('；')||'将登记新货品并入库，请核对名称、SKU、数量和目标格位。'};
  }
  async function prepareRow(input,req,ctx,context={},source){
    const result=await preview(input,req,ctx,context);
    if(source){
      source=structuredClone(source);
      const name=source.fields?.name,matched=result.draft?.name;
      if(name&&matched&&name.replace(/\s/g,'')!==matched.replace(/\s/g,''))source.issues=[...new Set([...source.issues,'原单品名与匹配货品名称不同，请核对SKU和规格'])];
    }
    return {id:randomUUID(),input:clean(result.input),context,bindings:bindings(result,ctx),state:'pending',request_id:randomUUID(),receipt:null,...(source?{source}:{})};
  }
  function write(job,rows,revision){
    const now=new Date().toISOString();
    const result=sql.prepare('UPDATE assistant_job SET rows_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(JSON.stringify(rows),now,job.id,revision);
    if(!result.changes)fail('清单已在其他页面更新，请刷新后继续',409);
  }
  async function view(job,req,ctx){
    const handoff=handed(job.id),doc=document(job.id);
    const rows=[];
    for(const row of job.rows){
      if(row.state==='done'){rows.push({...row});continue;}
      const result=await preview(row.input,req,ctx,row.context),current=bindings(result,ctx);
      const unchanged=!!row.bindings&&JSON.stringify(current)===JSON.stringify(row.bindings);
      const sourceReview=row.source?.issues?.length&&!row.source.reviewed;
      rows.push({...row,preview:result,canConfirm:!handoff&&result.ready&&unchanged&&!sourceReview,reviewMessage:[sourceReview?'请对照单据原文核对本项并保存。':'',!result.ready?result.message:!unchanged?'货品或格位已变化，请保存并更新预览后重新核对。':''].filter(Boolean).join(' ')});
    }
    return {kind:'job',id:job.id,title:job.title,room:job.room_code,revision:job.revision,rows,completed:rows.filter(r=>r.state==='done').length,total:rows.length,updated_at:job.updated_at,
      locations:ctx.cells.map(c=>({loc_code:c.loc_code,room_name:c.rack?.roomName||''})),document:doc,
      handoff:handoff?{task_id:handoff.task_id,created_at:handoff.created_at}:null,
      can_handoff:!!teamTasks&&req.user.role==='admin'&&!handoff&&rows.every(row=>row.state==='pending'&&row.canConfirm)};
  }
  async function create(req,inputs,{title='',requestId,document:doc}={}){
    const {ctx,req:scoped}=await scope(req);
    if(!Array.isArray(inputs)||!inputs.length||inputs.length>(doc?50:20))fail(doc?'每份单据支持1至50项作业':'每份清单支持1至20项作业');
    const context=doc?{}:{loc_code:req.body?.context?.loc_code||'',item_id:req.body?.context?.item_id||''};
    const key=requestId||req.body?.request_id||randomUUID();if(typeof key!=='string'||key.length>128)fail('清单请求编号无效');
    const signature=hash([ctx.room.id,inputs.map(clean),context,...(doc?[doc]:[])]),previous=decode(sql.prepare('SELECT * FROM assistant_job WHERE owner_id=? AND create_key=?').get(req.user.id,key));
    if(previous){if(previous.signature!==signature)fail('清单请求内容已变化，请刷新后重新保存',409);return get(req,previous.id);}
    const rows=[];for(const [index,input] of inputs.entries())rows.push(await prepareRow(input,scoped,ctx,context,doc?.rows[index]?.source));
    const raced=decode(sql.prepare('SELECT * FROM assistant_job WHERE owner_id=? AND create_key=?').get(req.user.id,key));
    if(raced){if(raced.signature!==signature)fail('清单请求内容已变化，请重新保存',409);return get(req,raced.id);}
    const now=new Date().toISOString(),id=randomUUID();
    sql.exec('SAVEPOINT assistant_job_create');
    try{
      sql.prepare('INSERT INTO assistant_job VALUES(?,?,?,?,?,?,1,?,?,?,?)').run(id,req.user.id,ctx.room.id,ctx.room.loc_code,String(title||'库存作业清单').slice(0,120),JSON.stringify(rows),key,signature,now,now);
      if(doc)sql.prepare('INSERT INTO assistant_job_document VALUES(?,?)').run(id,JSON.stringify({title:doc.title,source:doc.source,business:businessDetails(doc.business)}));
      sql.exec('RELEASE SAVEPOINT assistant_job_create');
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT assistant_job_create; RELEASE SAVEPOINT assistant_job_create');throw error;}
    return get(req,id);
  }
  async function get(req,id){const job=read(id);if(!job)fail('作业清单不存在',404);const scoped=await scope(req,job);return view(job,scoped.req,scoped.ctx);}
  async function list(req){
    const {ctx}=await scope(req);
    let receipts=0;
    // 未完成清单全部保留入口，已完成回执仅展示最近50份。
      return sql.prepare("SELECT * FROM assistant_job WHERE owner_id=? AND room_id=? ORDER BY EXISTS(SELECT 1 FROM json_each(assistant_job.rows_json) WHERE json_extract(value,'$.state')='pending') DESC,updated_at DESC").all(req.user.id,ctx.room.id).map(decode).filter(j=>!handed(j.id)&&j.rows.some(row=>row.state==='pending')||receipts++<50).map(j=>({id:j.id,title:j.title,room:j.room_code,total:j.rows.length,completed:j.rows.filter(r=>r.state==='done').length,updated_at:j.updated_at,handoff:handed(j.id)?.task_id||null}));
  }
  async function edit(req,id,rowId){
    const job=read(id);if(!job)fail('作业清单不存在',404);const scoped=await scope(req,job);
    editable(job);
    if(req.body.revision!==job.revision)fail('清单已更新，请刷新后继续',409);
    if(rowId==='new'){
      if(job.rows.length>=(document(id)?50:20))fail('清单项目已达上限');job.rows.push(await prepareRow(req.body.input||{operation:'in'},scoped.req,scoped.ctx));
    }else{
      const index=job.rows.findIndex(r=>r.id===rowId);if(index<0)fail('作业项不存在',404);
      if(job.rows[index].state==='done')fail('已完成的作业不能修改，请通过新的业务单处理',409);
      const source=job.rows[index].source?{...job.rows[index].source,reviewed:req.body.source_reviewed===true||job.rows[index].source.reviewed}:undefined;
      const prepared=await prepareRow(req.body.input||{},scoped.req,scoped.ctx,{},source);
      job.rows[index]={...prepared,id:rowId};
    }
    write(job,job.rows,req.body.revision);return get(req,id);
  }
  async function confirm(req,id,rowId){
    let job=read(id);if(!job)fail('作业清单不存在',404);const scoped=await scope(req,job);
    editable(job);
    let row=job.rows.find(r=>r.id===rowId);if(!row)fail('作业项不存在',404);
    if(req.body.confirmed!==true)fail('请先核对并确认本项作业');
    if(row.state==='done')return get(req,id);
    if(row.source?.issues?.length&&!row.source.reviewed)fail('请先对照单据原文核对本项并保存',409);
    if(req.body.revision!==job.revision)fail('清单已更新，请刷新后继续',409);
    const result=await preview(row.input,scoped.req,scoped.ctx,row.context);
    if(!result.ready)fail(result.message,409);
    if(!row.bindings||JSON.stringify(bindings(result,scoped.ctx))!==JSON.stringify(row.bindings))fail('货品或格位已变化，请更新预览并重新核对',409);
    // 作业回执与原出入库事务一起落库；响应丢失后重试只返回已完成结果。
    sql.exec('SAVEPOINT assistant_job_confirm');
    try{
      job=read(id);row=job.rows.find(r=>r.id===rowId);
      editable(job);
      if(row.state!=='done'){
        if(req.body.revision!==job.revision)fail('清单已更新，请刷新后继续',409);
        const d=result.draft,request_id=row.request_id,business=document(id)?.business||{};
        const receipt=actorStore.run({...req.user,business},()=>d.operation==='in'?db.inbound({name:d.name,sku:d.sku||result.choices.find(c=>c.item_id===d.item_id)?.sku||'',item_id:d.item_id,qty:d.qty,unit:d.unit,loc_code:d.to_loc,request_id,...business}):d.operation==='out'?db.outbound({loc_code:d.from_loc,item_id:d.item_id,qty:d.qty,request_id,...business}):db.moveItem({from_loc:d.from_loc,to_loc:d.to_loc,item_id:d.item_id,qty:d.qty,request_id,...business}));
        row.state='done';row.receipt={...receipt,operation:d.operation,name:d.name,unit:d.unit,operation_qty:d.qty,from_loc:d.from_loc||'',to_loc:d.to_loc||'',confirmed_at:new Date().toISOString()};
        write(job,job.rows,job.revision);
      }
      sql.exec('RELEASE SAVEPOINT assistant_job_confirm');
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT assistant_job_confirm; RELEASE SAVEPOINT assistant_job_confirm');throw error;}
    return get(req,id);
  }
  async function createDocument(req){
    const doc=parseWarehouseDocument(req.body);
    if(req.body.business)doc.business=businessDetails(req.body.business);
    return create(req,doc.rows.map(row=>row.input),{title:doc.title,document:doc});
  }
  async function previewDocument(req){await scope(req);return parseWarehouseDocument(req.body);}
  async function handoff(req,id){
    let job=read(id);if(!job)fail('作业清单不存在',404);await scope(req,job);
    if(!teamTasks||req.user.role!=='admin')fail('只有管理员可以将清单发布为团队任务',403);
    if(req.body.confirmed!==true)fail('请先核对整单并确认发布');
    const business=businessDetails(req.body.business||document(id)?.business||{}),title=String(req.body.title||job.title).trim(),assignee_id=req.body.assignee_id||null;
    if(!title||title.length>120)fail('任务名称须填写1至120个字');
    const signature=hash([title,assignee_id,business]);
    const previous=handed(id);
    if(previous){if(previous.signature!==signature)fail('此清单已按其他内容发布，请进入原团队任务核对',409);return {kind:'job_handoff',task_id:previous.task_id,task:teamTasks.get(req,previous.task_id),replayed:true};}
    if(req.body.revision!==job.revision)fail('清单已更新，请刷新后核对',409);
    if(job.rows.some(row=>row.state!=='pending'))fail('清单已有办理记录，请完成个人作业，不能重复转为团队任务',409);
    const current=await get(req,id);
    if(!current.can_handoff)fail('请先核对每项货品、数量、单位和位置，再发布团队任务',409);
    const lines=current.rows.map(row=>{const d=row.preview.draft;return {...d,sku:d.sku||row.preview.choices.find(c=>c.item_id===d.item_id)?.sku||'',new_item:!!row.input.new_item,from_node_id:row.bindings.locations[d.from_loc],to_node_id:row.bindings.locations[d.to_loc]};});
    sql.exec('SAVEPOINT assistant_handoff');
    try{
      job=read(id);editable(job);if(job.revision!==req.body.revision)fail('清单已更新，请刷新后核对',409);
      const result=teamTasks.create({...req,body:{room:job.room_code,room_id:job.room_id,title,assignee_id,...business,lines,request_id:'assistant-handoff:'+job.id}});
      sql.prepare('INSERT INTO assistant_job_handoff VALUES(?,?,?,?,?,?)').run(id,result.task_id,req.user.id,String(req.body.request_id||'').slice(0,128),signature,new Date().toISOString());
      write(job,job.rows,job.revision);sql.exec('RELEASE SAVEPOINT assistant_handoff');
      return {kind:'job_handoff',task_id:result.task_id,task:result.task};
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT assistant_handoff; RELEASE SAVEPOINT assistant_handoff');throw error;}
  }
  return {create,get,list,edit,confirm,createDocument,previewDocument,handoff};
}
