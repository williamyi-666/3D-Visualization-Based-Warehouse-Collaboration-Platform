import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createErpStocktakes} from '../apps/api/erp-stocktake.mjs';
import express from '../apps/api/node_modules/express/index.js';
import {mountErpStocktakes} from '../apps/api/erp-stocktake-routes.mjs';
const admin={id:'admin',role:'admin'},operator={id:'operator',role:'operator'};
test('差异单HTTP入口按角色和单据原格位鉴权，未配置接口不能发送',async()=>{
 const sql=new DatabaseSync(':memory:'),app=express();app.use(express.json());
 app.use((req,res,next)=>{req.user={id:'user',role:req.get('test-role')||'operator'};req.canAccessLocation=loc=>loc==='A';next();});
 const rows=[{id:'x',source:'erp',loc_code:'A',sku:'x',qty:2,unit:'件',snapshot_version:1}];
 mountErpStocktakes(app,{sql,inventoryView:{list:()=>rows},env:{},requireRole:(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:'禁止'})});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=(path,method='GET',body,role='operator')=>fetch(`http://127.0.0.1:${server.address().port}/api/erp-stocktakes${path}`,{method,headers:{'Content-Type':'application/json','test-role':role},...(body?{body:JSON.stringify(body)}:{})});
 try{
 assert.equal((await call('?loc_code=B')).status,403);
 assert.equal((await call('','POST',{loc_code:'A',source:'erp'},'viewer')).status,403);
 let r=await(await call('','POST',{loc_code:'A',source:'erp'})).json();
 r=await(await call('/'+r.id,'PUT',{revision:r.revision,counts:[{id:'x',qty:3}],reason:'实盘'})).json();
 r=await(await call('/'+r.id+'/action','POST',{revision:r.revision,action:'submit'})).json();
 assert.equal((await call('/'+r.id+'/action','POST',{revision:r.revision,action:'approve'})).status,403);
 r=await(await call('/'+r.id+'/action','POST',{revision:r.revision,action:'approve'},'admin')).json();
 assert.equal((await call('/'+r.id+'/send','POST',{revision:r.revision})).status,403);
 assert.equal((await call('/'+r.id+'/send','POST',{revision:r.revision},'admin')).status,503);
 assert.equal((await(await call('/'+r.id)).json()).state,'approved');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));sql.close();}
});
test('外部盘点审核、响应丢失重试、回传对账，不直接修改来源库存',async()=>{
 const sql=new DatabaseSync(':memory:');let version=1,calls=0;const ids=[];
 let rows=[{id:'erp:A',source:'erp',loc_code:'WH-A',sku:'A',name:'轴承',unit:'件',qty:5,snapshot_version:1}];
 const api=createErpStocktakes(sql,{inventory:()=>rows,sourceVersion:()=>version,dispatch:async p=>{ids.push(p.request_id);if(++calls===1)throw Error('模拟响应丢失');return {request_id:p.request_id,status:'accepted',receipt_id:'ERP-001'};}});
 try{
 let r=api.create({loc_code:'WH-A',source:'erp'},operator);
 assert.throws(()=>api.get(r.id,()=>false),/权限/);
 r=api.save(r.id,{revision:r.revision,counts:[{id:'erp:A',qty:0}],reason:'盘亏'},operator);
 r=api.transition(r.id,{revision:r.revision,action:'submit'},operator);
 assert.throws(()=>api.transition(r.id,{revision:r.revision,action:'approve'},operator),/权限/);
 r=api.transition(r.id,{revision:r.revision,action:'approve'},admin);
 r=await api.send(r.id,{revision:r.revision},admin);assert.equal(r.state,'uncertain');assert.equal(rows[0].qty,5);
 r=await api.send(r.id,{revision:r.revision},admin);assert.equal(r.state,'waiting_sync');assert.equal(new Set(ids).size,1);
 assert.equal(api.reconcile(r.id,{revision:r.revision},admin).matched,false);
 rows=[];version=2;r=api.reconcile(r.id,{revision:r.revision},admin);assert.equal(r.state,'confirmed');
 assert.deepEqual(r.history.map(h=>h.action),['create','save','submit','approve','send','uncertain','send','accepted','reconciled']);
 }finally{sql.close();}
});
test('库存基线变化阻止提交，无接口时保留已审核差异单',async()=>{
 const sql=new DatabaseSync(':memory:');let qty=2;
 const api=createErpStocktakes(sql,{inventory:()=>[{id:'x',source:'erp',loc_code:'A',sku:'x',unit:'件',qty,snapshot_version:1}],sourceVersion:()=>1});
 try{let r=api.create({loc_code:'A',source:'erp'},operator);r=api.save(r.id,{revision:1,counts:[{id:'x',qty:3}],reason:'盘盈'},operator);
 qty=4;assert.throws(()=>api.transition(r.id,{revision:r.revision,action:'submit'},operator),/重新盘点/);qty=2;
 r=api.transition(r.id,{revision:r.revision,action:'submit'},operator);r=api.transition(r.id,{revision:r.revision,action:'approve'},admin);
 await assert.rejects(api.send(r.id,{revision:r.revision},admin),/尚未配置/);assert.equal(api.get(r.id).state,'approved');
 }finally{sql.close();}
});
