import test from 'node:test';
import assert from 'node:assert/strict';
import express from '../apps/api/node_modules/express/index.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWarehouseWork} from '../apps/api/warehouse-work.mjs';
import {createAssistantTools} from '../apps/api/assistant-tools.mjs';
import {createAssistantJobs} from '../apps/api/assistant-jobs.mjs';
import {createStocktakes} from '../apps/api/stocktake.mjs';
import {mountWorkStatus} from '../apps/api/work-status.mjs';

test('当前库区不能读取其他库区清单，跨库格位撤权后移除私有作业入口',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'work-status-access-'));process.env.SPATIAL_DATA_DIR=dir;
  const db=await import('../apps/api/db.mjs'),sql=db.default,work=createWarehouseWork(sql,{db});
  createStocktakes(sql,{tenant:db.TENANT,logMovement:db.logMovement,emit:db.emit});
  const a=db.createRoomNode({name:'允许库区',w:12,d:8,h:4}),b=db.createRoomNode({name:'撤权库区',w:12,d:8,h:4});
  const from=db.createRack({roomCode:a.loc_code,rows:1,cols:1}).furn_code+'-L01-B01',to=db.createRack({roomCode:b.loc_code,rows:1,cols:1}).furn_code+'-L01-B01';
  db.inbound({loc_code:from,name:'范围验收轴承',sku:'ACCESS-6204',unit:'套',qty:10});
  const actor={id:'scope-worker',role:'operator'},tools=createAssistantTools({db,work,readInventory:()=>db.listInventory()}),jobs=createAssistantJobs({sql,db,tools}),req={user:actor,body:{room:a.loc_code,context:{}}};
  const local=await jobs.create(req,[{operation:'out',query:'ACCESS-6204',from_loc:from,qty:1,unit:'套'}]);
  const cross=await jobs.create(req,[{operation:'move',query:'ACCESS-6204',from_loc:from,to_loc:to,qty:1,unit:'套'}]);
  let allowB=true,allowA=true,authenticated=true;
  const canAccess=loc=>(loc===a.loc_code||loc.startsWith(a.loc_code+'-'))?allowA:(loc===b.loc_code||loc.startsWith(b.loc_code+'-'))?allowB:false;
  const app=express();mountWorkStatus(app,{sql,db,work,authorize:request=>{request.user=actor;request.canAccessLocation=canAccess;return authenticated;}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const read=room=>fetch('http://127.0.0.1:'+server.address().port+'/api/work/status?room='+room);
  try{
    assert.equal((await (await read(a.loc_code)).json()).counts.jobs,2);
    assert.equal((await (await read(b.loc_code)).json()).counts.jobs,0);
    allowB=false;const restricted=await (await read(a.loc_code)).json();assert.deepEqual(restricted.jobs.map(job=>job.id),[local.id]);assert.ok(!JSON.stringify(restricted).includes(cross.id));
    assert.equal((await read(b.loc_code)).status,403);
    allowA=false;assert.equal((await read(a.loc_code)).status,403);
    allowA=true;authenticated=false;assert.equal((await read(a.loc_code)).status,403);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));sql.close();rmSync(dir,{recursive:true,force:true});}
});
