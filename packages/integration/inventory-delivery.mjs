import {createHash} from 'node:crypto';
import {inspectInventoryPayload,inventoryEndpoint,sendInventory} from './inventory-client.mjs';
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);

// SQLite队列部署在ERP适配侧。凭证只留在进程环境，不写入队列文件。
export function createInventoryDelivery(sql,{baseUrl,token,source,fetcher=fetch,retryMs=1000,now=Date.now}){
  const target=inventoryEndpoint(baseUrl).href;
  if(!source||!token)throw Error('需要固定来源和来源专用同步凭证');
  sql.exec(`CREATE TABLE IF NOT EXISTS inventory_delivery_target(id INTEGER PRIMARY KEY CHECK(id=1),url TEXT NOT NULL,source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory_delivery(id INTEGER PRIMARY KEY AUTOINCREMENT,delivery_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',receipt TEXT,sent_at TEXT);`);
  const binding=sql.prepare('SELECT * FROM inventory_delivery_target WHERE id=1').get();
  if(binding&&(binding.url!==target||binding.source!==source))throw Error('此队列已绑定其他平台或来源，请使用独立队列文件');
  if(!binding)sql.prepare('INSERT INTO inventory_delivery_target VALUES(1,?,?)').run(target,source);
  let flight;
  function enqueue(key,payload){
    inspectInventoryPayload(payload);
    if(payload.source!==source)throw Error('消息来源与队列绑定不一致');
    if(typeof key!=='string'||!key.trim()||key.length>200)throw Error('需要稳定的业务消息编号，最长200字');
    const body=canonical(JSON.parse(JSON.stringify(payload))),fingerprint=createHash('sha256').update(body).digest('hex'),prior=sql.prepare('SELECT id,fingerprint FROM inventory_delivery WHERE delivery_key=?').get(key);
    if(prior){if(prior.fingerprint!==fingerprint)throw Error('同一业务消息编号内容冲突');return prior.id;}
    return Number(sql.prepare('INSERT INTO inventory_delivery(delivery_key,fingerprint,payload) VALUES(?,?,?)').run(key,fingerprint,body).lastInsertRowid);
  }
  function status(){return sql.prepare('SELECT id,delivery_key,state,attempts,next_attempt_at,last_error,sent_at FROM inventory_delivery ORDER BY id').all();}
  function retry(id){
    if(flight)throw Error('正在发送，请等待本轮结束');
    sql.prepare("UPDATE inventory_delivery SET state='pending',next_attempt_at=0,last_error='' WHERE id=? AND state='blocked'").run(id);
  }
  async function deliver(){
    while(true){
      const row=sql.prepare("SELECT * FROM inventory_delivery WHERE state!='sent' ORDER BY id LIMIT 1").get();
      if(!row||row.state==='blocked'||row.next_attempt_at>now())return status();
      try{
        const receipt=await sendInventory({baseUrl,token,payload:JSON.parse(row.payload),fetcher});
        sql.prepare("UPDATE inventory_delivery SET state='sent',attempts=attempts+1,next_attempt_at=0,last_error='',receipt=?,sent_at=? WHERE id=?").run(JSON.stringify(receipt),new Date(now()).toISOString(),row.id);
      }catch(error){
        const retryable=error.retryable!==false&&(error.status===undefined||error.retryable===true),delay=Math.min(60000,retryMs*2**Math.min(row.attempts,6));
        const message=String(error.message).replaceAll(token,'[已隐藏]').slice(0,500);
        sql.prepare('UPDATE inventory_delivery SET state=?,attempts=attempts+1,next_attempt_at=?,last_error=? WHERE id=?').run(retryable?'pending':'blocked',retryable?now()+delay:0,message,row.id);
        return status(); // 严格串行；前一版本未确认时，不越过它发送后续版本。
      }
    }
  }
  function flush(){if(flight)return flight;flight=deliver().finally(()=>{flight=null;});return flight;}
  return {enqueue,flush,status,retry};
}
