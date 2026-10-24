// 运行 node tools/batch-http-benchmark.mjs；临时数据库、模拟supOS身份和随机本地端口，不连接正式平台。
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const dir=mkdtempSync(join(tmpdir(),'batch-http-bench-'));
process.env.SPATIAL_DATA_DIR=dir;
const db=await import('../apps/api/db.mjs'),sql=db.default;
const room=sql.prepare("SELECT * FROM space_node WHERE node_type='room' LIMIT 1").get();
const site=sql.prepare('SELECT loc_code FROM space_node WHERE id=?').get(room.parent_id);
const insert=sql.prepare('INSERT INTO space_node(id,tenant_id,parent_id,loc_code,node_type,name,template) VALUES(?,?,?,?,?,?,?)');
const {createWarehouseAccess}=await import('../apps/api/warehouse-access.mjs');createWarehouseAccess(sql);
const codes=[];
sql.exec('BEGIN');
for(let i=0;i<50;i++){
 const rack='BENCH-'+i;insert.run(rack,room.tenant_id,room.id,rack,'rack',rack,'{}');
 for(let r=1;r<=10;r++)for(let c=1;c<=10;c++){
  const code=rack+'-L'+String(r).padStart(2,'0')+'-B'+String(c).padStart(2,'0');codes.push(code);insert.run(code,room.tenant_id,rack,code,'cell',code,'{}');
 }
}
insert.run('other-site',room.tenant_id,null,'OTHER','site','未授权仓库','{}');
insert.run('other-cell',room.tenant_id,'other-site','OTHER-CELL','cell','未授权格位','{}');
sql.prepare('INSERT INTO warehouse_access(user_id,sites,updated_by,updated_at,role) VALUES(?,?,?,?,?)').run('supos:bulk-editor',JSON.stringify([site.loc_code]),'fixture',new Date().toISOString(),'spaceAdmin');
sql.exec('COMMIT');sql.close();
const identity=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{sub:'bulk-editor',preferredUsername:'隔离批量维护员',enabled:true,superAdmin:false}}));});
identity.listen(0,'127.0.0.1');await once(identity,'listening');
const child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,PORT:'0',SPATIAL_UPLOAD_DIR:join(dir,'uploads'),SPATIAL_MODE:'integration',SPATIAL_AUTH_PROVIDER:'supos',SPATIAL_PUBLIC_ORIGIN:'http://test.local',SUPOS_USERINFO_URL:'http://127.0.0.1:'+identity.address().port+'/userinfo',SUPOS_MQTT_URL:'',OUTBOUND_BASE_URL:'',DB_DRIVER:'sqlite'},stdio:['ignore','pipe','pipe']});
try{
 const port=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('服务启动超时')),10000);
  child.stdout.on('data',b=>{const m=String(b).match(/running at http:\/\/localhost:(\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('服务退出 '+code));});
 });
 const headers={'Content-Type':'application/json',Cookie:'supos_community_token=bulk-fixture',Origin:'http://test.local','X-Spatial-Request':'1'};
 const call=(path,body)=>fetch('http://127.0.0.1:'+port+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});
 const read=async()=>{const response=await call('/api/scene');assert.equal(response.status,200);return response.json();};
 const versions=scene=>Object.fromEntries(scene.furniture.flatMap(r=>Object.entries(r.cellMeta).map(([suffix,meta])=>[r.code+'-'+suffix,meta.revision])));
 const samples=[];
 let scene=await read();
 for(let i=0;i<6;i++){
  const payload={codes,meta:{note:'HTTP批量'+i},revisions:versions(scene)};
  const start=performance.now(),response=await call('/api/cells/meta',payload),result=await response.json();
  samples.push(Math.round(performance.now()-start));assert.equal(response.status,200);assert.equal(result.updated.length,5000);
  const stale=await call('/api/cells/meta',payload);assert.equal(stale.status,409);
  scene=await read();
 }
 const revisions=versions(scene);
 assert.equal((await call('/api/cells/meta',{codes:[codes[0],'OTHER-CELL'],meta:{note:'越权写入'},revisions:{...revisions,'OTHER-CELL':'forbidden'}})).status,403);
 scene=await read();const records=scene.furniture.filter(r=>r.code.startsWith('BENCH-')).flatMap(r=>Object.values(r.cellMeta));
 assert.equal(records.length,5000);assert.ok(records.every(meta=>meta.note==='HTTP批量5'));
 const {DatabaseSync}=await import('node:sqlite');const verification=new DatabaseSync(join(dir,'spatial.db'),{readOnly:true});
 try{
  const audit=verification.prepare("SELECT changed_count FROM space_operation WHERE action='setCellsMeta'").all();
  assert.equal(audit.length,6);assert.ok(audit.every(row=>row.changed_count===5000));
  assert.notEqual(verification.prepare("SELECT note FROM space_node WHERE id='other-cell'").get().note,'越权写入');
  assert.equal(verification.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{verification.close();}
 console.log(JSON.stringify({count:5000,requestMs:samples,stale:409,crossWarehouse:403,verified:records.length,auditOperations:6}));
}finally{
 if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
 identity.close();
}

