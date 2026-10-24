import {assistantPrompt,assistantToolSchema} from './assistant-tools.mjs';
import {createAssistantSessions} from './assistant-session.mjs';
import {groundWarehouseCall} from './assistant-grounding.mjs';
import {assistantIntent} from './assistant-intent.mjs';
import {guideRequest} from './assistant-guidance.mjs';
import {listsJobs,isJobPatch,jobOrdinal,groundJobInput} from './assistant-job-intent.mjs';

export function mountAssistant(app,{model,tools,jobs,authorize,requireRole}) {
  const failAccess=()=>Object.assign(Error('登录或仓库权限已变化，请重新登录后继续。'),{status:401});
  const sessions=createAssistantSessions();
  async function state(req){
    if(!await authorize(req))throw failAccess();
    const ctx=await tools.context(req),session=sessions.get(req),valid=new Set(ctx.cells.map(c=>c.loc_code));
    session.lastStock=session.lastStock.filter(row=>valid.has(row.loc_code));
    if(session.pending&&((['preview_warehouse'].includes(session.pending.name)&&!ctx.canManage)||(['prepare_operation','prepare_opening','recommend_location'].includes(session.pending.name)&&!ctx.canOperate)||(session.pending.name==='prepare_stocktake'&&!ctx.canCount)))session.pending=null;
    return {ctx,session};
  }
  app.get('/api/assistant/session',async(req,res)=>{
    try{
      req.body={room:req.query.room};const {session,ctx}=await state(req);
      const pending=session.pending?await tools.run(session.pending.name,session.pending.input,req):null;
      if(!pending&&!session.jobId&&ctx.canOperate&&jobs&&session.state==='idle'){const saved=await jobs.list(req);session.jobId=saved.find(j=>!j.handoff&&j.completed<j.total)?.id||null;}
      res.json({session_id:session.id,state:session.state,ahead:session.ahead,pending,job_id:pending?null:session.jobId||null});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  app.post('/api/assistant/session/reset',async(req,res)=>{
    try{const {session}=await state(req);if(session.state!=='idle')throw Object.assign(Error('请等待当前请求完成后开始新对话'),{status:409});sessions.reset(session);res.json({session_id:session.id});}
    catch(error){res.status(error.status||400).json({error:error.message});}
  });
  async function execute(name,input,req,session,message){
    if(name==='prepare_batch'){
      const operations=Array.isArray(input.operations)?input.operations.map(row=>message?groundJobInput(row,message):row):input.operations;
      const result=await jobs.create(req,operations,{title:message,requestId:req.body.request_id});sessions.remember(session,name,input,result,message);return result;
    }
    if(name==='update_job'){
      const id=Object.hasOwn(req.body.context||{},'job_id')?req.body.context.job_id:session.jobId;
      if(!id)return {kind:'notice',message:'请先打开一份作业清单，再说明要修改哪一项。'};
      const job=await jobs.get(req,id),ordinal=jobOrdinal(message),selected=job.rows.find(r=>r.id===req.body.context?.row_id);
      const pending=job.rows.filter(r=>r.state!=='done'),row=ordinal!==null?job.rows[ordinal-1]:selected||(pending.length===1?pending[0]:null);
      if(!row)return {kind:'notice',message:'请展开要编辑的作业项，或说明“第几项”，再修改数量或位置。'};
      const patch=groundJobInput(input,message,row.input.unit),next={...row.input,...patch};
      if(!Object.keys(patch).length)return {kind:'notice',message:'请明确要修改的数量或位置，例如“第二项数量改为5套”。本次未修改清单。'};
      if(patch.query!==undefined){delete next.item_id;delete next.name;delete next.sku;next.new_item=false;}
      if(patch.from_hint!==undefined)delete next.from_loc;
      if(patch.to_hint!==undefined)delete next.to_loc;
      const result=await jobs.edit({...req,body:{...req.body,revision:job.revision,input:next}},id,row.id);sessions.remember(session,name,input,result,message);return result;
    }
    if(name==='update_request'){
      if(!session.pending)return {kind:'notice',message:'当前没有待补充请求，请先说明要办理的业务。'};
      name=session.pending.name;input={...session.pending.input,...input};
      const patch=req.assistantPatch||{};
      if(patch.query!==undefined){delete input.item_id;if(name==='prepare_opening'){delete input.name;delete input.sku;}}
      if(patch.from_hint!==undefined)delete input.from_loc;
      if(patch.to_hint!==undefined)delete input.to_loc;
      if(patch.loc_hint!==undefined)delete input.loc_code;
    }
    const result=await tools.run(name,input,req);sessions.remember(session,name,input,result,message);return result;
  }
  app.get('/api/assistant/status',async(req,res)=>{
    try{if(req.user.isService)throw failAccess();res.json(await model.status({retry:req.query.retry==='1'}));}catch(error){res.status(error.status||400).json({error:error.message});}
  });
  app.post('/api/assistant/ask',async(req,res)=>{
    try {
      const message=typeof req.body?.message==='string'?req.body.message.trim():'';
      if(!message||message.length>1200)throw Error('请输入不超过1200字的查询或操作要求');
      const {ctx,session}=await state(req);
      if(session.state!=='idle')throw Object.assign(Error('当前会话已有请求，请等待完成'),{status:409});
      const guide=guideRequest(message);
      if(guide){const result=await execute(guide.name,guide.args,req,session,message);if(!await authorize(req))throw failAccess();res.json({results:[result],session_id:session.id});return;}
      if(listsJobs(message)){session.jobId=null;res.json({results:[{kind:'job_list',rows:await jobs.list(req)}],session_id:session.id});return;}
      const jobId=Object.hasOwn(req.body.context||{},'job_id')?req.body.context.job_id:session.jobId,job=jobId?await jobs.get(req,jobId):null;
      session.state='planning';
      const intent=job&&isJobPatch(message)?'update_job':assistantIntent(message,session.pending);
      if(intent&&session.pending?.name!==intent){session.pending=null;session.history=[];}
      const schema=intent?assistantToolSchema.filter(tool=>tool.function.name===intent||tool.function.name==='update_request'&&session.pending):assistantToolSchema;
      const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort(Error('浏览器已取消请求'));});
      const scene={view:ctx.view,room:{name:ctx.room.name,code:ctx.room.loc_code,...ctx.roomDimensions},selectedLoc:ctx.selectedLoc,selectedItem:ctx.selectedItem,itemsAtSelection:ctx.selection.slice(0,5),pending:session.pending,lastStock:session.lastStock,canManage:ctx.canManage,canCount:ctx.canCount};
      if(job){const index=jobOrdinal(message),row=index!==null?job.rows[index-1]:job.rows.find(r=>r.id===req.body.context?.row_id);scene.job={id:job.id,total:job.total,selected:row?{index:job.rows.indexOf(row)+1,input:row.input,state:row.state}:null,rows:job.rows.map((r,i)=>({index:i+1,name:(r.preview?.draft?.name||r.receipt?.name||r.input.query||'待选货品').slice(0,40),operation:r.input.operation,state:r.state}))};}
      const history=session.history.map(h=>({role:'user',content:h.message}));
      const messages=[{role:'system',content:assistantPrompt(ctx.room.name,ctx.canOperate,scene)},...history,{role:'user',content:message}];
      let results=[];
      try{
      for(let round=0;round<2;round++) {
        const reply=await model.plan(messages,{schema,onState:status=>{session.state=status.state;session.ahead=status.ahead;},signal:abort.signal}),calls=reply.tool_calls;
        if(!Array.isArray(calls)||!calls.length){results=[{kind:'notice',message:'请给出货品关键词，或说明要办理的数量和位置。例如：6204轴承在哪里？把A架的3套轴承移到B架。'}];break;}
        if(calls.length>4)throw Error('请用“批量办理”整理多项作业，或将本次查询分成较短的要求');
        messages.push(reply);results=[];
        for(const call of calls) {
          if(!await authorize(req))throw failAccess();
          let name=call.function?.name;
          let args=call.function?.arguments||{};
          if(typeof args==='string')args=JSON.parse(args);
          if(!args||typeof args!=='object'||Array.isArray(args))throw Error('模型未生成有效操作参数，请补充具体要求');
          const definition=schema.find(tool=>tool.function.name===name);
          if(!definition)throw Error('不支持的助手工具');
          const allowed=new Set(Object.keys(definition.function.parameters.properties));
          args=Object.fromEntries(Object.entries(args).filter(([key,value])=>allowed.has(key)&&value!==null));
          ({name,args}=groundWarehouseCall(name,args,message,session.pending));
          req.assistantPatch=name==='update_request'?args:null;
          const result=await execute(name,args,req,session,message);results.push(result);
          messages.push({role:'tool',tool_name:name,content:JSON.stringify(result)});
        }
        if(!results.every(r=>r.retryable))break;
      }
      if(results.length>1&&results.every(r=>r.kind==='draft')){const job=await jobs.create(req,results.map(r=>groundJobInput(r.input,message)),{title:message,requestId:req.body.request_id});sessions.remember(session,'prepare_batch',{},job,message);results=[job];}
      if(!await authorize(req))throw failAccess();res.json({results,session_id:session.id});
      }finally{session.state='idle';session.ahead=0;}
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  // 选择歧义项或修改数量后重新核对真实库存，仅生成草稿，不改数量。
  app.post('/api/assistant/draft',requireRole('admin','operator'),async(req,res)=>{
    try{const {session}=await state(req);res.json(await execute('prepare_operation',req.body.input||{},req,session,''));}
    catch(error){res.status(error.status||400).json({error:error.message});}
  });
  app.post('/api/assistant/preview',async(req,res)=>{
    try{const {session}=await state(req);const name=req.body.tool;if(!assistantToolSchema.some(tool=>tool.function.name===name)||name==='update_request')throw Error('不支持的助手工具');if(session.state!=='idle'&&!['setup_progress','platform_guide','find_stock'].includes(name))throw Object.assign(Error('请等待当前助手请求完成，再保存新的预览。普通库存作业可继续办理。'),{status:409});res.json(await execute(name,req.body.input||{},req,session,''));}
    catch(error){res.status(error.status||400).json({error:error.message});}
  });
}
