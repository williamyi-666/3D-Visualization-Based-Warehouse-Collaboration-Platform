import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createKnowledgeStore} from './store.mjs';

// 独立运行时仅暴露检索及资料接口；不包含模型或仓储数据库。
export function createKnowledgeService({sql,key,knowledgeId='warehouse'}){
  if(typeof key!=='string'||key.length<24)throw Error('请配置至少24字的 SPATIAL_KNOWLEDGE_KEY');
  const store=createKnowledgeStore(sql),digest=value=>createHash('sha256').update(value).digest(),expected=digest('Bearer '+key);
  return createServer(async(req,res)=>{
    const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const url=new URL(req.url,'http://knowledge');
      if(req.method==='GET'&&url.pathname==='/health'){reply(200,{ok:true,retrieval:'全文检索'});return;}
      if(!timingSafeEqual(expected,digest(req.headers.authorization||''))){reply(401,{error:'认证失败'});return;}
      let body={};
      if(['POST','PUT'].includes(req.method)){
        const parts=[];let length=0;for await(const part of req){length+=part.length;if(length>1024*1024)throw Object.assign(Error('资料过大，请分批导入'),{status:413});parts.push(part);}
        try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Object.assign(Error('请提交 JSON 格式'),{status:400});}
      }
      const selected=body.knowledge_id||url.searchParams.get('knowledge_id')||knowledgeId;
      if(selected!==knowledgeId){reply(404,{error:'知识库不存在'});return;}
      if(req.method==='POST'&&url.pathname==='/retrieval'){
        if(typeof body.query!=='string'||!body.query.trim()||body.query.length>600){reply(400,{error:'问题需为1至600字'});return;}
        reply(200,store.retrieve({...body,knowledge_id:knowledgeId}));return;
      }
      if(req.method==='GET'&&url.pathname==='/documents'){reply(200,store.list(knowledgeId));return;}
      if(req.method==='POST'&&url.pathname==='/documents'){reply(200,store.save(knowledgeId,body,'service-admin'));return;}
      const match=url.pathname.match(/^\/documents\/([a-z0-9-]+)$/);
      if(match&&req.method==='GET'){reply(200,store.get(knowledgeId,match[1]));return;}
      if(match&&req.method==='PUT'){reply(200,store.save(knowledgeId,{...body,id:match[1]},'service-admin'));return;}
      reply(404,{error:'接口不存在'});
    }catch(error){reply(error.status||400,{error:error.message});}
  });
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const dir=process.env.KNOWLEDGE_DATA_DIR||'./knowledge-data';mkdirSync(dir,{recursive:true});
  const sql=new DatabaseSync(join(dir,'knowledge.sqlite'));sql.exec('PRAGMA journal_mode=WAL');
  const server=createKnowledgeService({sql,key:process.env.SPATIAL_KNOWLEDGE_KEY,knowledgeId:process.env.SPATIAL_KNOWLEDGE_ID||'warehouse'});
  server.listen(Number(process.env.PORT||38210),process.env.HOST||'127.0.0.1',()=>console.log('知识服务已启动；检索接口 /retrieval，资料接口 /documents；所有资料接口均需 Bearer 密钥。'));
}
