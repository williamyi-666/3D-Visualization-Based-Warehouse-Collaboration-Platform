const fail=message=>Object.assign(Error(message),{status:400});
export function validateAssistantSettings(input){
  if(typeof input?.enabled!=='boolean')throw fail('请选择是否启用智能模型');
  if(typeof input.url!=='string'||typeof input.model!=='string')throw fail('请填写模型服务地址和模型名称');
  let url=input.url.trim();const model=input.model.trim();
  if(url){
    let parsed;try{parsed=new URL(url);}catch{throw fail('请输入有效的 HTTP 或 HTTPS 服务地址');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash||url.length>500)throw fail('服务地址只支持 HTTP 或 HTTPS，不能包含账号、参数或片段');
    url=parsed.href.replace(/\/$/,'');
  }
  if(input.enabled&&(!url||!model))throw fail('启用时请填写服务地址和模型名称');
  if(model.length>150||/\s/.test(model))throw fail('模型名称不能包含空白，最长150个字符');
  return {enabled:input.enabled,url,model};
}
export function createAssistantSettings(sql,{env=process.env}={}){
  sql.exec('CREATE TABLE IF NOT EXISTS assistant_model_settings (id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)');
  function get(){
    const row=sql.prepare('SELECT * FROM assistant_model_settings WHERE id=1').get();
    // 已有部署沿用环境配置；管理员保存后以数据库中的设置为准。
    return row?{...JSON.parse(row.config),updated_at:row.updated_at}:{enabled:env.SPATIAL_ASSISTANT_ENABLED!=='0'&&!!env.SPATIAL_ASSISTANT_URL,url:env.SPATIAL_ASSISTANT_URL||'',model:env.SPATIAL_ASSISTANT_MODEL||'qwen3:4b-instruct-2507-q4_K_M',updated_at:null};
  }
  function save(config,actor){sql.prepare('INSERT INTO assistant_model_settings(id,config,updated_by,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(JSON.stringify(config),actor,new Date().toISOString());return get();}
  return {get,save};
}
export function mountAssistantSettings(app,{settings,model,authorize,requireRole}){
  const wrap=action=>async(req,res)=>{try{if(!await authorize(req)||req.user?.role!=='admin'||req.user.isService)return res.status(403).json({error:'仅管理员可管理智能模型'});res.json(await action(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  const result=()=>({config:settings.get(),status:model.snapshot()});
  app.get('/api/admin/assistant-model',requireRole('admin'),wrap(async req=>{if(req.query.active==='1')await model.status();return result();}));
  app.put('/api/admin/assistant-model',requireRole('admin'),wrap(req=>{
    const next=validateAssistantSettings(req.body),previous=settings.get();model.configure(next);
    try{settings.save(next,req.user.id);}catch(error){model.configure(previous);throw error;}
    if(next.enabled)void model.status({retry:true});return result();
  }));
  app.post('/api/admin/assistant-model/connect',requireRole('admin'),wrap(async()=>{await model.status({retry:true});return result();}));
}
