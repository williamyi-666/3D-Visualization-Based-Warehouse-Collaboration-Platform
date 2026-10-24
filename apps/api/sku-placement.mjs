// SKU 绑定只改变展示归属；原始快照不改写，解除绑定可回到原库位。
export function createSkuPlacement(sql, {getUsableCells, rawRows}) {
  sql.exec(`CREATE TABLE IF NOT EXISTS cell_sku_binding (
    loc_code TEXT PRIMARY KEY, mode TEXT NOT NULL, source TEXT NOT NULL,
    warehouse_code TEXT NOT NULL, sku TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
    CREATE UNIQUE INDEX IF NOT EXISTS cell_sku_unique ON cell_sku_binding(source,warehouse_code,sku) WHERE mode='sku'`);
  if(!sql.prepare('PRAGMA table_info(cell_sku_binding)').all().some(c=>c.name==='bindings_json'))sql.exec('ALTER TABLE cell_sku_binding ADD COLUMN bindings_json TEXT');
  const unpack=row=>row.bindings_json!=null?JSON.parse(row.bindings_json):(row.mode==='sku'?[{source:row.source,sku:row.sku}]:[]);
  const bindings=()=>sql.prepare("SELECT * FROM cell_sku_binding WHERE mode='sku'").all().flatMap(row=>unpack(row).map(item=>({loc_code:row.loc_code,warehouse_code:row.warehouse_code,...item})));
  function siteResolver() {
    const nodes=sql.prepare('SELECT * FROM space_node').all(), byId=new Map(nodes.map(n=>[n.id,n])), byCode=new Map(nodes.map(n=>[n.loc_code,n]));
    return code=>{let node=byCode.get(code);while(node){if(node.node_type==='site')return node.loc_code;node=byId.get(node.parent_id);}return null;};
  }
  const siteFor=code=>siteResolver()(code);
  function get(code) {
    const row=sql.prepare('SELECT * FROM cell_sku_binding WHERE loc_code=?').get(code) ||
      {loc_code:code,mode:'location',source:'',warehouse_code:siteFor(code),sku:'',revision:0};
    const {bindings_json,...result}=row;return {...result,items:unpack(row)};
  }
  const key=(source,warehouse,sku)=>JSON.stringify([source,warehouse,sku]);
  function sourcesFor(rows,warehouse,sku) {
    const site=siteResolver();
    return [...new Set(rows.filter(r=>r.sku===sku && (r.warehouse_code || site(r.loc_code))===warehouse).map(r=>r.source))].sort();
  }
  function project(rows) {
    const all=bindings();
    if(!all.length && !rows.some(r=>r.placement==='sku'))return rows;
    const byKey=new Map(all.map(b=>[key(b.source,b.warehouse_code,b.sku),b]));
    const byCell=new Map(all.map(b=>[b.loc_code,b]));
    // 尚未同步的 SKU 可先绑定；只在当前仓库来源唯一时自动归入。
    const automatic=new Map(all.filter(b=>!b.source).map(b=>[key('',b.warehouse_code,b.sku),{binding:b,sources:sourcesFor(rows,b.warehouse_code,b.sku)}]));
    const siteCache=new Map(),resolveSite=siteResolver(),modes=new Map();
    const site=code=>{if(!siteCache.has(code))siteCache.set(code,resolveSite(code));return siteCache.get(code);};
    return rows.map(row=>{
      const warehouse=row.warehouse_code || site(row.loc_code);
      const inventoryKey=key(row.source,warehouse,row.sku),mode=row.placement==='sku'?'sku':'location';
      if(modes.has(inventoryKey)&&modes.get(inventoryKey)!==mode)throw new Error('同一来源、仓库和 SKU 不能同时按库位和 SKU 重复上报');
      modes.set(inventoryKey,mode);
      const auto=automatic.get(key('',warehouse,row.sku));
      const binding=byKey.get(inventoryKey) || (auto?.sources.length===1 ? auto.binding : null);
      if(binding)return {...row,loc_code:binding.loc_code,warehouse_code:warehouse,placement:'sku',original_loc_code:row.loc_code || null};
      if(row.placement==='sku' || auto)return {...row,loc_code:null,warehouse_code:warehouse,assignment:'unassigned'};
      if(row.qty>0 && byCell.has(row.loc_code))
        throw new Error(`SKU ${row.sku} 未绑定或与目标格位绑定冲突，请先配置正确的 SKU 归位规则`);
      return row;
    });
  }
  function save(code,body) {
    const usable=getUsableCells?.();
    if((usable&&!usable.has(code)) || !sql.prepare("SELECT id FROM space_node WHERE loc_code=? AND node_type='cell'").get(code))throw new Error('未知或不可用的格位');
    const warehouse=siteFor(code);if(!warehouse)throw new Error('格位没有所属仓库');
    const prior=get(code);
    if(body.revision!==prior.revision){const e=new Error('SKU 绑定已更新，请重新打开格位后修改');e.status=409;throw e;}
    const isList=Object.hasOwn(body,'items');
    if(isList && !Array.isArray(body.items))throw new Error('SKU 列表格式错误');
    if(!isList && prior.items.length>1)throw new Error('当前格位有多个 SKU，请刷新后使用列表编辑');
    const mode=body.mode ?? (String(body.sku || '').trim()?'sku':'location');
    if(!isList && !['location','sku'].includes(mode))throw new Error('请选择库位映射或 SKU 归位');
    const input=isList?body.items:(mode==='sku'?[body]:[]),rows=rawRows(),all=bindings();
    const items=[];
    for(const [index,item] of input.entries()) {
      const sku=String(item?.sku || '').trim();let source=String(item?.source || '').trim();
      if(!sku || sku.length>200 || source.length>120)throw new Error('每项需填写 SKU，SKU 不超过200字，来源不超过120字');
      if(!source) {
        const candidates=sourcesFor(rows,warehouse,sku);
        if(candidates.length>1){const error=new Error('SKU '+sku+' 有多个库存来源，请选择来源后保存');error.sources=candidates;error.bindingIndex=index;throw error;}
        source=candidates[0] || '';
      }
      if(items.some(b=>b.sku===sku && (!b.source || !source || b.source===source)))throw new Error('SKU '+sku+' 重复，请保留一项');
      const duplicate=all.find(b=>b.loc_code!==code&&(!b.source || !source || b.source===source)&&b.warehouse_code===warehouse&&b.sku===sku);
      if(duplicate)throw new Error('该来源、仓库和 SKU 已绑定格位 '+duplicate.loc_code);
      items.push({source,sku});
    }
    sql.exec('SAVEPOINT sku_binding');
    try {
      sql.prepare(`INSERT INTO cell_sku_binding(loc_code,mode,source,warehouse_code,sku,revision,bindings_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(loc_code) DO UPDATE SET
        mode=excluded.mode,source=excluded.source,warehouse_code=excluded.warehouse_code,sku=excluded.sku,revision=excluded.revision,bindings_json=excluded.bindings_json`)
        .run(code,items.length?'sku':'location',items[0]?.source || '',warehouse,items[0]?.sku || '',prior.revision+1,JSON.stringify(items));
      project(rawRows()); // 冲突则整次回滚，不能让已有库存消失。
      sql.exec('RELEASE SAVEPOINT sku_binding');return get(code);
    }catch(e){sql.exec('ROLLBACK TO SAVEPOINT sku_binding; RELEASE SAVEPOINT sku_binding');throw e;}
  }
  return {bindings,get,save,project,siteFor};
}
