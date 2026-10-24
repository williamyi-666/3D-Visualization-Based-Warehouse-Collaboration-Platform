// 仅隔离联调使用：模拟ERP受理回执，不自动修改仓储库存。
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
if(process.env.SPATIAL_TEST_ERP!=='1')throw Error('仅允许在显式标记的ERP测试环境启动');
const receipts=new Map();
createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.method!=='POST'||req.url!=='/adjustments'){res.writeHead(404);res.end('{}');return;}
 try{
  let body='';for await(const part of req){body+=part;if(body.length>100000)throw Error('请求过大');}
  const p=JSON.parse(body),fingerprint=createHash('sha256').update(body).digest('hex');
  if(!p.request_id||req.headers['idempotency-key']!==p.request_id)throw Error('缺少一致的请求编号');
  const prior=receipts.get(p.request_id);
  if(prior&&prior.fingerprint!==fingerprint){res.writeHead(409);res.end(JSON.stringify({error:'原请求内容不一致'}));return;}
  const entry=prior||{fingerprint,receipt:{request_id:p.request_id,receipt_id:'SIMULATED-'+p.request_id,status:'accepted',simulated:true}};
  receipts.set(p.request_id,entry);res.end(JSON.stringify(entry.receipt));
 }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
}).listen(3100,'127.0.0.1',()=>console.log('ERP模拟服务已启动，仅用于测试'));
