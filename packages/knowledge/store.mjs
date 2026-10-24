import {createHash,randomUUID} from 'node:crypto';

const fail=message=>Object.assign(Error(message),{status:400});
const ignored=new Set(['怎么','如何','什么','应该','请问','一下','进行','是否','可以','需要','处理','我们','这个','那个','哪些']);
// 中文相邻双字和英文单词参与全文检索；首版无需下载向量模型。
export function knowledgeTerms(value){
  const result=[];
  for(const token of String(value).toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9_-]*/gu)||[]){
    if(/\p{Script=Han}/u.test(token)){
      if(token.length===1)continue;
      for(let i=0;i<token.length-1;i++){const term=token.slice(i,i+2);if(!ignored.has(term))result.push(term);}
    }else result.push(token);
  }
  return [...new Set(result)];
}
function chunks(value){
  const result=[];let start=0;
  while(start<value.length){
    let end=Math.min(start+650,value.length);
    if(end<value.length){const boundary=value.lastIndexOf('\n',end);if(boundary>start+350)end=boundary;}
    const content=value.slice(start,end).trim();if(content)result.push(content);
    if(end===value.length)break;start=end-70;
  }
  return result;
}
export function safeKnowledgeLink(value){
  if(!value)return '';
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
}
export function createKnowledgeStore(sql){
  sql.exec(`CREATE TABLE IF NOT EXISTS knowledge_document (
    id TEXT PRIMARY KEY,knowledge_id TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge_chunk (id INTEGER PRIMARY KEY,document_id TEXT NOT NULL,ordinal INTEGER NOT NULL,content TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS knowledge_chunk_document ON knowledge_chunk(document_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_index USING fts5(title,content);`);
  function get(knowledgeId,id){const row=sql.prepare('SELECT * FROM knowledge_document WHERE knowledge_id=? AND id=?').get(knowledgeId,id);if(!row)throw Object.assign(Error('资料不存在'),{status:404});return {...row,active:!!row.active};}
  function list(knowledgeId){return sql.prepare(`SELECT id,title,source,active,version,updated_at,LENGTH(content) AS characters,
    (SELECT COUNT(*) FROM knowledge_chunk WHERE document_id=knowledge_document.id) AS chunks
    FROM knowledge_document WHERE knowledge_id=? ORDER BY updated_at DESC,id`).all(knowledgeId).map(row=>({...row,active:!!row.active}));}
  function save(knowledgeId,input,actor){
    const previous=input.id?get(knowledgeId,input.id):null;
    const title=String(input.title??previous?.title??'').trim(),content=String(input.content??previous?.content??'').replace(/\r\n/g,'\n').trim();
    if(!title||title.length>150)throw fail('资料标题需为1至150字');
    if(!content||content.length>200000)throw fail('资料正文需为1至200000字，请导入文本或分批整理');
    if(input.active!==undefined&&typeof input.active!=='boolean')throw fail('资料状态无效');
    const source=String(input.source??previous?.source??'').trim();if(source&&!safeKnowledgeLink(source))throw fail('来源链接需为不含账号密码的 HTTP 或 HTTPS 地址');
    const id=previous?.id||randomUUID(),updatedAt=new Date().toISOString(),active=input.active??previous?.active??true;
    const hash=createHash('sha256').update(content).digest('hex');
    sql.exec('SAVEPOINT knowledge_save');
    try{
      const ids=sql.prepare('SELECT id FROM knowledge_chunk WHERE document_id=?').all(id);
      for(const row of ids)sql.prepare('DELETE FROM knowledge_index WHERE rowid=?').run(row.id);
      sql.prepare('DELETE FROM knowledge_chunk WHERE document_id=?').run(id);
      sql.prepare(`INSERT INTO knowledge_document VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,content=excluded.content,source=excluded.source,active=excluded.active,version=knowledge_document.version+1,
        updated_at=excluded.updated_at,updated_by=excluded.updated_by,hash=excluded.hash`).run(id,knowledgeId,title,content,source,Number(active),1,updatedAt,String(actor||'admin'),hash);
      let ordinal=0;
      for(const chunk of chunks(content)){
        const row=sql.prepare('INSERT INTO knowledge_chunk(document_id,ordinal,content) VALUES(?,?,?)').run(id,++ordinal,chunk);
        sql.prepare('INSERT INTO knowledge_index(rowid,title,content) VALUES(?,?,?)').run(row.lastInsertRowid,knowledgeTerms(title).join(' '),knowledgeTerms(chunk).join(' '));
      }
      sql.exec('RELEASE SAVEPOINT knowledge_save');return get(knowledgeId,id);
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT knowledge_save; RELEASE SAVEPOINT knowledge_save');throw error;}
  }
  function retrieve({knowledge_id:knowledgeId,query,retrieval_setting={}}){
    const terms=knowledgeTerms(query).slice(0,60);if(!terms.length)return {records:[]};
    const top=Math.max(1,Math.min(6,Number(retrieval_setting.top_k)||4)),threshold=Number(retrieval_setting.score_threshold)||0;
    const match=terms.map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR ');
    const rows=sql.prepare(`SELECT c.id AS chunk_id,c.ordinal,c.content,d.id AS document_id,d.title,d.source,d.version,d.updated_at
      FROM knowledge_index JOIN knowledge_chunk c ON c.id=knowledge_index.rowid JOIN knowledge_document d ON d.id=c.document_id
      WHERE knowledge_index MATCH ? AND d.knowledge_id=? AND d.active=1 ORDER BY bm25(knowledge_index,3,1),c.id LIMIT 30`).all(match,knowledgeId);
    const records=rows.map(row=>{
      const found=new Set(knowledgeTerms(row.title+'\n'+row.content)),count=terms.filter(term=>found.has(term)).length;
      const score=Math.min(1,count/Math.max(2,Math.min(terms.length,6)));
      return {title:row.title,content:row.content,score,metadata:{document_id:row.document_id,chunk_id:String(row.chunk_id),knowledge_id:knowledgeId,
        section:'片段 '+row.ordinal,version:row.version,updated_at:row.updated_at,source:row.source}};
    }).filter(row=>row.score>=threshold);
    records.sort((a,b)=>b.score-a.score);
    return {records:records.slice(0,top)};
  }
  function current(knowledgeId,records){return records.every(row=>{try{const doc=get(knowledgeId,row.metadata.document_id);return doc.active&&doc.version===row.metadata.version;}catch{return false;}});}
  return {get,list,save,retrieve,current};
}
