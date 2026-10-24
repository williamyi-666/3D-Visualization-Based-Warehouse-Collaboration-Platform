export function mountAssistantJobs(app,{jobs,authorize}){
  const run=fn=>async(req,res)=>{try{if(!await authorize(req))throw Object.assign(Error('登录或仓库权限已变化，请重新登录'),{status:401});res.set('Cache-Control','no-store').json(await fn(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  app.post('/api/assistant/jobs/document/preview',run(req=>jobs.previewDocument(req)));
  app.post('/api/assistant/jobs/document',run(req=>jobs.createDocument(req)));
  app.get('/api/assistant/jobs',run(req=>jobs.list(req)));
  app.get('/api/assistant/jobs/:id',run(req=>jobs.get(req,req.params.id)));
  app.post('/api/assistant/jobs',run(req=>jobs.create(req,req.body.operations,{title:req.body.title})));
  app.put('/api/assistant/jobs/:id/rows/:rowId',run(req=>jobs.edit(req,req.params.id,req.params.rowId)));
  app.post('/api/assistant/jobs/:id/rows/:rowId/confirm',run(req=>jobs.confirm(req,req.params.id,req.params.rowId)));
  app.post('/api/assistant/jobs/:id/handoff',run(req=>jobs.handoff(req,req.params.id)));
}
