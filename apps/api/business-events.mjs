// 接收来源系统的真实业务事件；不会从库存差额推断出入库，也不改变快照。
// 接入示例：POST /api/integration/snapshot
// {mode:"events",source:"ERP",events:[{event_id:"单据1-行1",type:"inbound",loc_code:"WH-1-A-L01-B01",sku:"A",name:"轴承",qty:5,unit:"件",occurred_at:"2026-09-16T08:00:00+08:00",document_no:"单据1"}]}
// 移库由来源提交同单据的出库、入库两条事件，event_id 各自唯一。
export function createBusinessEvents(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS external_business_event (
    source TEXT NOT NULL,event_id TEXT NOT NULL,loc_code TEXT NOT NULL,occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL,PRIMARY KEY(source,event_id));
    CREATE INDEX IF NOT EXISTS business_event_location ON external_business_event(loc_code,occurred_at)`);
  function receive({source,events}) {
    if(typeof source!=='string'||!source.trim()||source!==source.trim()||source.length>120||!Array.isArray(events)||events.length>1000)throw new Error('需要来源和 events 数组，每批最多1000条');
    const rows=events.map(event=>{
      for(const key of ['event_id','sku','name','loc_code'])if(typeof event[key]!=='string'||!event[key].trim()||event[key].length>200)throw new Error(key+' 必填且不超过200字');
      if(!['inbound','outbound','adjustment'].includes(event.type))throw new Error('事件 type 必须为 inbound、outbound 或 adjustment');
      if(!Number.isFinite(event.qty)||(event.type!=='adjustment'&&event.qty<0))throw new Error('事件 qty 无效，调整事件可使用带符号数量');
      if(typeof event.occurred_at!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(event.occurred_at)||!Number.isFinite(Date.parse(event.occurred_at)))throw new Error('occurred_at 必须是带时区的时间');
      if(!sql.prepare("SELECT id FROM space_node WHERE loc_code=? AND node_type='cell'").get(event.loc_code))throw new Error('事件库位不存在');
      return {source,event_id:event.event_id,loc_code:event.loc_code,sku:event.sku,name:event.name,type:event.type,qty:event.qty,
        unit:String(event.unit||'件'),batch_no:String(event.batch_no||''),document_no:String(event.document_no||''),occurred_at:new Date(event.occurred_at).toISOString()};
    });
    let count=0;
    sql.exec('SAVEPOINT business_events');
    try {
      for(const row of rows) {
        const payload=JSON.stringify(row),prior=sql.prepare('SELECT payload FROM external_business_event WHERE source=? AND event_id=?').get(source,row.event_id);
        if(prior){if(prior.payload!==payload){const error=new Error('同一事件编号内容冲突：'+row.event_id);error.status=409;throw error;}continue;}
        sql.prepare('INSERT INTO external_business_event VALUES(?,?,?,?,?)').run(source,row.event_id,row.loc_code,row.occurred_at,payload);count++;
      }
      sql.exec('RELEASE SAVEPOINT business_events');return {applied:count>0,count,skipped:rows.length-count};
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT business_events; RELEASE SAVEPOINT business_events');throw error;}
  }
  function page({loc_code,page=1}) {
    const current=Number(page);
    if(typeof loc_code!=='string'||!loc_code||!Number.isSafeInteger(current)||current<1)throw new Error('需要库位编码和正整数页码');
    const total=sql.prepare('SELECT COUNT(*) AS n FROM external_business_event WHERE loc_code=?').get(loc_code).n;
    const pages=Math.max(1,Math.ceil(total/20)),selected=Math.min(current,pages);
    const rows=sql.prepare('SELECT payload FROM external_business_event WHERE loc_code=? ORDER BY occurred_at DESC,source,event_id LIMIT 20 OFFSET ?').all(loc_code,(selected-1)*20).map(r=>JSON.parse(r.payload));
    return {rows,total,page:selected,pages};
  }
  return {receive,page};
}
