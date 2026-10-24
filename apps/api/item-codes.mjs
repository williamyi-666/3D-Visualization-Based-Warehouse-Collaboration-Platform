import {createHash} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const kinds=new Set(['barcode','supplier','legacy']);

export function installItemCodes(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS item_code (
    tenant_id TEXT NOT NULL,code TEXT NOT NULL,item_id TEXT NOT NULL,kind TEXT NOT NULL,
    PRIMARY KEY(tenant_id,code));
    CREATE INDEX IF NOT EXISTS item_code_item ON item_code(item_id);
    CREATE TABLE IF NOT EXISTS item_code_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,item_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,request_id TEXT NOT NULL,
    signature TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(actor_id,request_id));`);
  // 在数据库入口保留编码唯一性，CSV、建账及其它写入口也不能占用别人的旧条码。
  const occupied=(code,id,tenant)=>`EXISTS(SELECT 1 FROM item WHERE tenant_id=${tenant} AND id!=${id} AND (sku=${code} OR id=${code}))
    OR EXISTS(SELECT 1 FROM item_code WHERE tenant_id=${tenant} AND item_id!=${id} AND code=${code})
    OR EXISTS(SELECT 1 FROM external_mapping m JOIN item i ON i.id=m.local_id WHERE i.tenant_id=${tenant}
      AND m.external_system='erp' AND m.local_type='item' AND m.local_id!=${id} AND m.external_id=${code})`;
  for(const [name,action] of [['insert','INSERT'],['update','UPDATE OF sku']])sql.exec(`
    CREATE TRIGGER IF NOT EXISTS item_sku_code_${name} BEFORE ${action} ON item
    WHEN NEW.sku IS NOT NULL AND trim(NEW.sku)!='' ${name==='update'?'AND NEW.sku IS NOT OLD.sku':''}
    BEGIN SELECT CASE WHEN ${occupied('NEW.sku','NEW.id','NEW.tenant_id')}
      THEN RAISE(ABORT,'货品码已被其他货品使用') END; END;`);
  for(const [name,action] of [['insert','INSERT'],['update','UPDATE']])sql.exec(`
    CREATE TRIGGER IF NOT EXISTS item_alias_code_${name} BEFORE ${action} ON item_code
    BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM item WHERE id=NEW.item_id AND tenant_id=NEW.tenant_id)
      THEN RAISE(ABORT,'货品不存在') END;
      SELECT CASE WHEN ${occupied('NEW.code','NEW.item_id','NEW.tenant_id')}
      THEN RAISE(ABORT,'货品码已被其他货品使用') END; END;
    CREATE TRIGGER IF NOT EXISTS item_erp_code_${name} BEFORE ${action} ON external_mapping
    WHEN NEW.external_system='erp' AND NEW.local_type='item'
    BEGIN SELECT CASE WHEN ${occupied('NEW.external_id','NEW.local_id','NEW.tenant_id')}
      THEN RAISE(ABORT,'ERP编码已被其他货品使用') END; END;`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS item_alias_cleanup AFTER DELETE ON item
    BEGIN DELETE FROM item_code WHERE item_id=OLD.id; END;`);
}

export function createItemCodes(sql,{tenant,onChanged=()=>{}}) {
  function resolve(code) {
    const value=String(code||'').trim();if(!value)return null;
    const matches=sql.prepare(`SELECT id FROM item WHERE tenant_id=? AND (sku=? OR id=?)
      UNION SELECT item_id AS id FROM item_code WHERE tenant_id=? AND code=?
      UNION SELECT m.local_id AS id FROM external_mapping m JOIN item i ON i.id=m.local_id
      WHERE i.tenant_id=? AND m.external_system='erp' AND m.local_type='item' AND m.external_id=?`)
      .all(tenant,value,value,tenant,value,tenant,value);
    if(matches.length>1)fail('货品码对应多个货品，请联系管理员整理编码',409);
    return matches[0]?.id||null;
  }
  function get(id) {
    const item=sql.prepare('SELECT id,name,sku,unit,attributes FROM item WHERE tenant_id=? AND id=?').get(tenant,id);
    if(!item)fail('货品不存在',404);
    const attributes=JSON.parse(item.attributes||'{}');
    const codes=sql.prepare('SELECT code,kind FROM item_code WHERE tenant_id=? AND item_id=? ORDER BY code').all(tenant,id);
    const erp_codes=sql.prepare("SELECT external_id AS code FROM external_mapping WHERE external_system='erp' AND local_type='item' AND local_id=? ORDER BY external_id").all(id).map(row=>row.code);
    return {item_id:id,name:item.name,sku:item.sku||'',unit:item.unit||'件',temporary:attributes.temporary_sku===true||/^TMP-/.test(item.sku||''),codes,erp_codes,
      revision:hash([item,codes,erp_codes])};
  }
  function list(query='') {
    const q=String(query).trim().slice(0,200),pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';
    return sql.prepare(`SELECT i.id AS item_id,i.name,COALESCE(i.sku,'') AS sku,COALESCE(i.unit,'件') AS unit,
      CASE WHEN i.sku IS NULL OR trim(i.sku)='' OR i.sku LIKE 'TMP-%' OR json_extract(i.attributes,'$.temporary_sku')=1 THEN 1 ELSE 0 END AS needs_code,
      (SELECT COUNT(*) FROM item t WHERE t.tenant_id=i.tenant_id AND trim(t.name)=trim(i.name)) AS same_name_count,
      (SELECT COUNT(*) FROM item t WHERE t.tenant_id=i.tenant_id AND t.sku=i.sku AND trim(i.sku)!='') AS same_sku_count
      FROM item i WHERE i.tenant_id=? AND (?='' OR i.name LIKE ? ESCAPE '\\' OR i.sku LIKE ? ESCAPE '\\' OR i.id=?
        OR EXISTS(SELECT 1 FROM item_code c WHERE c.item_id=i.id AND c.code LIKE ? ESCAPE '\\')
        OR EXISTS(SELECT 1 FROM external_mapping m WHERE m.local_id=i.id AND m.local_type='item' AND m.external_system='erp' AND m.external_id LIKE ? ESCAPE '\\'))
      ORDER BY needs_code DESC,i.name,i.id LIMIT 100`).all(tenant,q,pattern,pattern,q,pattern,pattern);
  }
  function save(id,input,actor) {
    if(typeof input.request_id!=='string'||!input.request_id||input.request_id.length>128)fail('需要操作请求编号');
    const signature=hash([id,input]);
    const previous=sql.prepare('SELECT * FROM item_code_history WHERE actor_id=? AND request_id=?').get(actor.id,input.request_id);
    if(previous){if(previous.signature!==signature)fail('请求内容已修改，请重新提交',409);return {...JSON.parse(previous.after_json),replayed:true};}
    const before=get(id);if(input.revision!==before.revision)fail('货品编码已变化，请重新打开后核对',409);
    const sku=typeof input.sku==='string'?input.sku.trim():'';
    if(!sku||sku.length>120)fail('正式编号须填写1至120个字');
    if(!Array.isArray(input.codes)||input.codes.length>100)fail('其它条码最多100个');
    const codes=input.codes.map(row=>({code:typeof row.code==='string'?row.code.trim():'',kind:row.kind||'barcode'}));
    if(codes.some(row=>!row.code||row.code.length>200||!kinds.has(row.kind)))fail('请填写有效条码及条码类型');
    if(new Set(codes.map(row=>row.code)).size!==codes.length)fail('请删除重复条码');
    const merged=new Map(codes.map(row=>[row.code,row]));
    // 曾经打印的 SKU 始终可用；转正式编号不重建货品，也不改库存和流水。
    for(const row of before.codes)if(row.kind==='legacy')merged.set(row.code,row);
    if(before.sku&&before.sku!==sku)merged.set(before.sku,{code:before.sku,kind:'legacy'});
    merged.delete(sku);
    for(const code of [sku,...merged.keys()]) {
      const owner=resolve(code);if(owner&&owner!==id)fail('货品码已被其他货品使用：'+code,409);
    }
    sql.exec('SAVEPOINT organize_item_codes');
    let after;
    try {
      const attrs=JSON.parse(sql.prepare('SELECT attributes FROM item WHERE id=?').get(id).attributes||'{}');
      attrs.temporary_sku=/^TMP-/.test(sku);
      sql.prepare('UPDATE item SET sku=?,attributes=? WHERE id=?').run(sku,JSON.stringify(attrs),id);
      sql.prepare('DELETE FROM item_code WHERE tenant_id=? AND item_id=?').run(tenant,id);
      for(const row of merged.values())sql.prepare('INSERT INTO item_code VALUES(?,?,?,?)').run(tenant,row.code,id,row.kind);
      after=get(id);
      sql.prepare('INSERT INTO item_code_history(tenant_id,item_id,actor_id,actor_name,request_id,signature,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(tenant,id,actor.id,actor.name||actor.username||actor.id,input.request_id,signature,JSON.stringify(before),JSON.stringify(after),new Date().toISOString());
      sql.exec('RELEASE SAVEPOINT organize_item_codes');
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT organize_item_codes; RELEASE SAVEPOINT organize_item_codes');throw error;}
    onChanged(id);return after;
  }
  function history(id){get(id);return sql.prepare('SELECT id,actor_name,before_json,after_json,created_at FROM item_code_history WHERE tenant_id=? AND item_id=? ORDER BY id DESC LIMIT 30').all(tenant,id).map(row=>({...row,before:JSON.parse(row.before_json),after:JSON.parse(row.after_json),before_json:undefined,after_json:undefined}));}
  return {resolve,get,list,save,history};
}
