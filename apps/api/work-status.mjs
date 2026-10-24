import {createHash} from 'node:crypto';
import {workAttention} from './work-attention.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// 私有作业只按账号读取，不经过库存事件出站；每次检查重新验证权限。
export function mountWorkStatus(app,{sql,db,work,authorize,integrationMode=false,teamTasks}){
  app.get('/api/work/status',async(req,res)=>{
    try{
      if(!await authorize(req))return res.status(403).json({error:'登录或仓库权限已变化，请重新登录'});
      const room=work.room(req.query.room,req.canAccessLocation);
      if(integrationMode)return res.set('Cache-Control','no-store').json({enabled:false,room:room.loc_code,user_id:req.user.id,total:0});
      const tasks=work.tasks(room.loc_code,req.canAccessLocation,req.user);
      const canOperate=['admin','operator'].includes(req.user.role);
      const all=canOperate?sql.prepare('SELECT id,title,room_code,rows_json,revision,updated_at FROM assistant_job WHERE owner_id=? AND room_id=? AND NOT EXISTS(SELECT 1 FROM assistant_job_handoff h WHERE h.job_id=assistant_job.id) ORDER BY updated_at DESC,id DESC').all(req.user.id,room.id).map(row=>({...row,rows:JSON.parse(row.rows_json)})).filter(job=>job.rows.every(row=>Object.keys(row.bindings?.locations||{}).every(loc=>!req.canAccessLocation||req.canAccessLocation(loc)))):[];
      const pending=all.filter(job=>job.rows.some(row=>row.state!=='done'));
      const jobs=pending.slice(0,50).map(job=>({id:job.id,title:job.title,room:job.room_code,revision:job.revision,updated_at:job.updated_at,total:job.rows.length,completed:job.rows.filter(row=>row.state==='done').length}));
      const counts={count:tasks.rows.filter(row=>row.kind==='count').length,draft:tasks.rows.filter(row=>row.kind==='draft').length,low:tasks.rows.filter(row=>row.kind==='low').length,jobs:pending.length};
      const reviews=tasks.rows.filter(row=>row.kind==='review').length;if(reviews)counts.review=reviews;
      const team=canOperate&&teamTasks?teamTasks.list({...req,query:{room:room.loc_code,filter:req.user.role==='admin'?'pending':'mine'}}):{total:0,rows:[]};
      const locations=new Set(db.getCells().filter(cell=>cell.loc_code.startsWith(room.loc_code+'-')).map(cell=>cell.loc_code));
      for(const job of pending)for(const row of job.rows)for(const loc of Object.keys(row.bindings?.locations||{}))locations.add(loc);
      const cells=sql.prepare("SELECT id,loc_code FROM space_node WHERE node_type='cell' ORDER BY loc_code").all().filter(cell=>locations.has(cell.loc_code));
      const inventory=db.listInventory().filter(row=>locations.has(row.loc_code));
      const tasksRevision=digest(tasks),jobsRevision=digest([req.user.role,all.map(job=>[job.id,job.revision]),cells,inventory,db.getLayout(room.loc_code)]);
      const teamRevision=digest(team);
      res.set('Cache-Control','no-store').json({enabled:true,user_id:req.user.id,role:req.user.role,room:room.loc_code,counts,total:tasks.total+pending.length+team.total,tasks,jobs,team,attention:workAttention(tasks,team),tasks_revision:tasksRevision,jobs_revision:jobsRevision,team_revision:teamRevision,revision:digest([tasksRevision,jobsRevision,teamRevision])});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
}
