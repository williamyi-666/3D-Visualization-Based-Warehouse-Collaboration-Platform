// 同步历史查询使用固定最大 ID，翻页期间的新记录不会挤动已有结果。
export function createSyncHistory(sql) {
  sql.exec('CREATE INDEX IF NOT EXISTS sync_history_source_id ON external_inventory_sync_log(source,id)');
  return function historyPage(query={}) {
    const integer=(value,fallback,max)=>{
      const n=value==null || value===''?fallback:Number(value);
      if(!Number.isSafeInteger(n) || n<1 || n>max)throw Error('分页参数无效');
      return n;
    };
    const requested=integer(query.page,1,Number.MAX_SAFE_INTEGER);
    const pageSize=integer(query.page_size,25,100);
    const maxId=sql.prepare('SELECT COALESCE(MAX(id),0) AS id FROM external_inventory_sync_log').get().id;
    const through=query.through_id==null?maxId:Number(query.through_id);
    if(!Number.isSafeInteger(through) || through<0)throw Error('查询边界无效');
    const where=['id<=?'],values=[through];
    if(query.source){where.push('source=?');values.push(String(query.source));}
    const result=String(query.result || 'all');
    if(result==='issues')where.push("result IN ('failed','different')");
    else if(result==='retryable')where.push("result='failed' AND request_json IS NOT NULL");
    else if(['applied','skipped','failed','matched','different'].includes(result)){where.push('result=?');values.push(result);}
    else if(result!=='all')throw Error('结果筛选无效');
    const dates={};
    for(const [key,operator] of [['from','>='],['to','<']]) {
      if(!query[key])continue;
      const date=new Date(query[key]);
      if(Number.isNaN(date.getTime()))throw Error('日期格式无效');
      dates[key]=date.toISOString();where.push('created_at '+operator+' ?');values.push(dates[key]);
    }
    if(dates.from && dates.to && dates.from>=dates.to)throw Error('开始日期必须早于结束边界');
    const clause=' WHERE '+where.join(' AND ');
    const counts=sql.prepare("SELECT COUNT(*) total, COALESCE(SUM(result='failed'),0) failed, COALESCE(SUM(result='different'),0) different FROM external_inventory_sync_log"+clause).get(...values);
    const pages=Math.max(1,Math.ceil(counts.total/pageSize)),page=Math.min(requested,pages);
    const rows=sql.prepare('SELECT id,source,version,actor,result,row_count,message,created_at,kind,retry_of,request_json IS NOT NULL AS retryable FROM external_inventory_sync_log'+clause+' ORDER BY id DESC LIMIT ? OFFSET ?').all(...values,pageSize,(page-1)*pageSize);
    return {...counts,page,page_size:pageSize,pages,through_id:through,rows};
  };
}
