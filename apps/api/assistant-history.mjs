export function readAssistantHistory(sql,{allowedLocations,query='',loc='',period='today',now=Date.now()}){
  if(!['today','week','month','all'].includes(period))throw Error('请选择今天、近7天、近30天或全部历史');
  const from="json_extract(m.history_json,'$.from_loc')",to="json_extract(m.history_json,'$.to_loc')",where=[],params=[];
  const allowed=JSON.stringify(allowedLocations);
  where.push(`(${from} IN (SELECT value FROM json_each(?)) OR ${to} IN (SELECT value FROM json_each(?))) AND (${from} IS NULL OR ${from} IN (SELECT value FROM json_each(?))) AND (${to} IS NULL OR ${to} IN (SELECT value FROM json_each(?)))`);params.push(allowed,allowed,allowed,allowed);
  if(loc){where.push(`(${from}=? OR ${to}=?)`);params.push(loc,loc);}
  const words=query.normalize('NFKC').toLowerCase().match(/[a-z0-9]+(?:[_.-][a-z0-9]+)*|\p{Script=Han}+|[\p{L}]+/gu)||[];
  for(const word of words){where.push("instr(lower(COALESCE(json_extract(m.history_json,'$.item_name'),'')||' '||COALESCE(json_extract(m.history_json,'$.sku'),'')),?)>0");params.push(word);}
  let start='',end='';
  if(period!=='all'){
    const day=new Date(now+8*3600000).toISOString().slice(0,10),today=Date.parse(day+'T00:00:00+08:00');
    start=new Date(today-({today:0,week:6,month:29}[period])*86400000).toISOString();end=new Date(today+86400000).toISOString();
    where.push('datetime(m.occurred_at)>=datetime(?) AND datetime(m.occurred_at)<datetime(?)');params.push(start,end);
  }
  const filter='WHERE '+where.join(' AND '),total=sql.prepare(`SELECT COUNT(*) n FROM movement m ${filter}`).get(...params).n;
  const rows=sql.prepare(`SELECT m.id,m.item_id,m.qty,m.move_type,m.occurred_at,m.actor_name,json_extract(m.history_json,'$.item_name') AS name,json_extract(m.history_json,'$.sku') AS sku,json_extract(m.history_json,'$.unit') AS unit,${from} AS from_loc,${to} AS to_loc FROM movement m ${filter} ORDER BY m.id DESC LIMIT 60`).all(...params);
  const scope=loc?JSON.stringify([loc]):allowed;
  const summary=sql.prepare(`SELECT COALESCE(json_extract(m.history_json,'$.unit'),'单位未记录') AS unit,SUM(CASE WHEN ${to} IN (SELECT value FROM json_each(?)) THEN ABS(m.qty) ELSE 0 END) AS incoming,SUM(CASE WHEN ${from} IN (SELECT value FROM json_each(?)) THEN ABS(m.qty) ELSE 0 END) AS outgoing FROM movement m ${filter} GROUP BY unit`).all(scope,scope,...params).map(row=>({...row,net:Number((row.incoming-row.outgoing).toFixed(8))}));
  return {kind:'history',total,rows,summary,query,loc_code:loc,period,start,end,timeZone:'Asia/Shanghai',truncated:total>rows.length,message:total?`找到 ${total} 条实际流水${total>60?'，展示最近60条':''}；按记录核对数量变化。`:'当前范围内没有流水记录，无法据此解释数量变化。'};
}
