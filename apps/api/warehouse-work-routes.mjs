import {rackTemplates,planQuickBuild} from '../../packages/three-kit/quick-build.mjs';
import {createWarehouseWork} from './warehouse-work.mjs';

export function mountWarehouseWork(app,{sql,db,sqliteDb,integrationMode,requireRole}) {
  const work=createWarehouseWork(sql,{db:sqliteDb});
  const run=(fn,status=200)=>(req,res)=>{try{res.status(status).json(fn(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  const room=req=>req.body?.roomCode||req.query.room;
  const layout=req=>{const r=work.room(room(req),req.canAccessLocation);return db.getLayout(r.loc_code);};
  app.get('/api/setup/templates',run(()=>rackTemplates));
  app.get('/api/setup/preview',run(req=>planQuickBuild(layout(req),req.query)));
  app.post('/api/setup/racks',requireRole('admin','spaceAdmin'),run(req=>{
    work.room(room(req),req.canAccessLocation);
    return db.quickBuildRacks(req.body,planQuickBuild);
  },201));
  // 集成库存保持原有权属；快速建仓仍可用，首次建账与本地规则仅用于独立库存。
  if(integrationMode)return work;
  app.get('/api/work/catalogue',run(req=>work.catalogue(req.query.room,req.canAccessLocation,req.user)));
  app.get('/api/work/opening',run(req=>work.opening(req.query.loc_code,req.canAccessLocation)));
  app.get('/api/work/progress',run(req=>work.progress(req.query.room,req.canAccessLocation)));
  app.post('/api/work/opening',requireRole('admin','operator'),run(req=>work.establish(req.body,req.user,req.canAccessLocation),201));
  app.get('/api/work/recommendations',run(req=>work.recommend(req.query,req.canAccessLocation)));
  app.get('/api/work/route-options',run(req=>work.routeOptions(req.query.room,req.canAccessLocation)));
  app.get('/api/work/route',run(req=>work.route({...req.query,locations:typeof req.query.locations==='string'?req.query.locations.split(','):[]},req.canAccessLocation)));
  app.get('/api/work/tasks',run(req=>work.tasks(req.query.room,req.canAccessLocation,req.user)));
  app.get('/api/work/policy',run(req=>work.policy(req.query.room,req.canAccessLocation)));
  app.put('/api/work/policy',requireRole('admin'),run(req=>work.savePolicy(req.body.room,req.body,req.canAccessLocation,req.user)));
  return work;
}
