// 复核规则按库区 ID 保存；编号复用不会继承旧库区规则。
export function installStocktakeReview(sql){
  sql.exec(`CREATE TABLE IF NOT EXISTS stocktake_review_policy (
    room_id TEXT PRIMARY KEY,rule TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stocktake_review (
    stocktake_id TEXT PRIMARY KEY,policy TEXT NOT NULL,triggers TEXT NOT NULL,
    submitted_by TEXT NOT NULL,submitted_at TEXT NOT NULL,decision TEXT,
    reviewed_by TEXT,reviewed_at TEXT,note TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS stocktake_review_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,stocktake_id TEXT NOT NULL,action TEXT NOT NULL,
    actor TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS stocktake_review_history ON stocktake_review_event(stocktake_id,id DESC);`);
}
export function normalizeStocktakeRule(input){
  if(!input||!['all','threshold','off'].includes(input.mode))throw Error('请选择盘点差异复核规则');
  const rule={mode:input.mode,qty_limit:null,percent_limit:null};
  for(const key of ['qty_limit','percent_limit'])if(input[key]!==undefined&&input[key]!==null&&input[key]!==''){
    if(typeof input[key]!=='number'||!Number.isFinite(input[key])||input[key]<0)throw Error('复核阈值须为大于等于0的数字，留空表示不使用该项');
    rule[key]=input[key];
  }
  if(rule.mode==='threshold'&&rule.qty_limit===null&&rule.percent_limit===null)throw Error('请至少设置一个差异数量或比例阈值');
  return rule;
}
export function stocktakeRule(sql,roomId){
  const row=roomId&&sql.prepare('SELECT rule FROM stocktake_review_policy WHERE room_id=?').get(roomId);
  return row?JSON.parse(row.rule):{mode:'all',qty_limit:null,percent_limit:null};
}
export function saveStocktakeRule(sql,roomId,rule,actor={id:'system',name:'系统'}){
  sql.prepare('INSERT INTO stocktake_review_policy(room_id,rule,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET rule=excluded.rule,updated_by=excluded.updated_by,updated_at=excluded.updated_at')
    .run(roomId,JSON.stringify(normalizeStocktakeRule(rule)),JSON.stringify({id:actor.id,name:actor.name||actor.username||actor.id}),new Date().toISOString());
}
export function evaluateStocktakeReview(rule,counts){
  const triggers=[];
  if(rule.mode==='off')return {required:false,triggers};
  for(const line of counts){
    const difference=Math.abs(line.difference);if(!difference)continue;
    const percent=line.book_qty>0?difference/line.book_qty*100:null,reasons=[];
    if(rule.mode==='all')reasons.push('存在盘点差异');
    else{
      if(rule.qty_limit!==null&&difference>rule.qty_limit)reasons.push('差异数量超过 '+rule.qty_limit+' '+line.unit);
      if(rule.percent_limit!==null&&(percent===null||percent>rule.percent_limit))reasons.push(percent===null?'账面为0，发现账外库存':'差异比例超过 '+rule.percent_limit+'%');
    }
    if(reasons.length)triggers.push({item_id:line.item_id,name:line.name,unit:line.unit,book_qty:line.book_qty,actual_qty:line.qty,difference:line.difference,percent,reasons});
  }
  return {required:!!triggers.length,triggers};
}
