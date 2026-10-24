import { currentActor } from './context.mjs';

// SQLite 同步写入使用 SAVEPOINT，允许布局组合调用已有的单节点事务。
export function createSpaceAudit(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS space_operation (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor_id TEXT, actor_name TEXT,
    before_json TEXT NOT NULL, after_json TEXT NOT NULL, changed_count INTEGER NOT NULL, created_at TEXT NOT NULL
  )`);
  let depth=0;
  const snapshot=()=>sql.prepare('SELECT id,parent_id,loc_code,node_type,name,geom,template,capacity,capacity_rules,max_load,status,tags,note FROM space_node ORDER BY id').all();
  function run(action,fn) {
    if (depth) return fn();
    sql.exec('SAVEPOINT space_operation_write'); depth++;
    try {
      const before=snapshot();
      const result=fn();
      const after=snapshot();
      const b=new Map(before.map(n=>[n.id,JSON.stringify(n)])), a=new Map(after.map(n=>[n.id,JSON.stringify(n)]));
      const changed=new Set([...b.keys(),...a.keys()].filter(id=>b.get(id)!==a.get(id)));
      const actor=currentActor();
      sql.prepare('INSERT INTO space_operation(action,actor_id,actor_name,before_json,after_json,changed_count,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(action,actor?.id || null,actor?.name || actor?.username || '系统',JSON.stringify(before.filter(n=>changed.has(n.id))),JSON.stringify(after.filter(n=>changed.has(n.id))),changed.size,new Date().toISOString());
      sql.exec('RELEASE SAVEPOINT space_operation_write');
      return result;
    } catch(e) {
      sql.exec('ROLLBACK TO SAVEPOINT space_operation_write');
      sql.exec('RELEASE SAVEPOINT space_operation_write');
      throw e;
    } finally { depth--; }
  }
  return {
    run,
    list:()=>sql.prepare('SELECT id,action,actor_id,actor_name,changed_count,created_at FROM space_operation ORDER BY id DESC LIMIT 100').all(),
    page:({page=1,action='',actor=''}={})=>{
      page=Number(page);if(!Number.isInteger(page) || page<1)throw new Error('页码须为正整数');
      const size=20,where='WHERE (?=\'\' OR action=?) AND (?=\'\' OR actor_name LIKE ?)';
      const args=[action,action,actor,'%'+actor+'%'];
      const total=sql.prepare('SELECT COUNT(*) AS n FROM space_operation '+where).get(...args).n;
      const pages=Math.max(1,Math.ceil(total/size));page=Math.min(page,pages);
      const rows=sql.prepare('SELECT id,action,actor_id,actor_name,changed_count,created_at FROM space_operation '+where+' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args,size,(page-1)*size);
      return {rows,total,page,pages};
    },
    detail:id=>{
      const row=sql.prepare('SELECT * FROM space_operation WHERE id=?').get(id);
      return row ? {...row,before:JSON.parse(row.before_json),after:JSON.parse(row.after_json),before_json:undefined,after_json:undefined} : null;
    }
  };
}
