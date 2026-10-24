// 周期只衡量已应用库存的年龄，不把重放或对账当作更新。
export function createSourceStatus(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS external_source_policy (
    source TEXT PRIMARY KEY, expected_interval_minutes INTEGER NOT NULL
  )`);
  function saveSourcePolicy({source, expected_interval_minutes} = {}) {
    if(typeof source !== 'string' || !source.trim() || source !== source.trim() || source.length > 120) throw new Error('来源名称必填、首尾无空格且不超过120字');
    if(!Number.isInteger(expected_interval_minutes) || expected_interval_minutes < 0 || expected_interval_minutes > 43200) throw new Error('周期须为0至43200的整数分钟，0表示未配置');
    sql.prepare('INSERT INTO external_source_policy VALUES(?,?) ON CONFLICT(source) DO UPDATE SET expected_interval_minutes=excluded.expected_interval_minutes').run(source,expected_interval_minutes);
    return {source,expected_interval_minutes};
  }
  function status(now = Date.now()) {
    const snapshots = new Map(sql.prepare('SELECT source,version,received_at FROM external_inventory_snapshot').all().map(r=>[r.source,r]));
    const policies = new Map(sql.prepare('SELECT * FROM external_source_policy').all().map(r=>[r.source,r.expected_interval_minutes]));
    const attempts = new Map(sql.prepare(`SELECT l.source,l.result,l.created_at FROM external_inventory_sync_log l
      JOIN (SELECT source,MAX(id) id FROM external_inventory_sync_log WHERE kind IN ('snapshot','delta') AND source<>'' GROUP BY source) last ON last.id=l.id`).all().map(r=>[r.source,r]));
    return [...new Set([...snapshots.keys(),...policies.keys(),...attempts.keys()])].sort().map(source=>{
      const snapshot=snapshots.get(source), attempt=attempts.get(source), minutes=policies.get(source) || 0;
      const stale=!!snapshot && minutes>0 && now-Date.parse(snapshot.received_at)>minutes*60000;
      const state=attempt?.result==='failed' ? 'failed' : !snapshot ? 'waiting' : !minutes ? 'unconfigured' : stale ? 'stale' : 'ok';
      return {source,version:snapshot?.version ?? null,received_at:snapshot?.received_at ?? null,expected_interval_minutes:minutes,state,stale,last_attempt_at:attempt?.created_at ?? null};
    });
  }
  return {status,saveSourcePolicy};
}
