import {createHash} from 'node:crypto';

// 读取一个仓库的一致快照；不改业务数据，不合计不同单位的货品数量。
export function readWarehouseSnapshot(sql,siteCode) {
  sql.exec('BEGIN');
  try {
    const nodes=sql.prepare(`WITH RECURSIVE tree AS (
      SELECT * FROM space_node WHERE loc_code=? AND node_type='site'
      UNION ALL SELECT child.* FROM space_node child JOIN tree ON child.parent_id=tree.id
    ) SELECT * FROM tree`).all(siteCode);
    if(!nodes.length)throw Object.assign(Error('仓库不存在：'+siteCode),{code:'WAREHOUSE_NOT_FOUND',siteCode});
    const rows=sql.prepare(`SELECT inv.node_id,inv.item_id,i.name,i.sku,i.unit,inv.batch_no,inv.qty
      FROM inventory inv JOIN item i ON i.id=inv.item_id
      WHERE inv.node_id IN (SELECT value FROM json_each(?)) AND inv.qty>0
      ORDER BY inv.node_id,inv.item_id,inv.batch_no`).all(JSON.stringify(nodes.map(n=>n.id)));
    sql.exec('COMMIT');return {nodes,inventory:rows};
  } catch(error) {sql.exec('ROLLBACK');throw error;}
}

export function buildWarehouseModel({nodes,inventory},{alias='warehouse3d_candidate_structure',name='CandidateWarehouse'}={}) {
  const root={kind:'folder',name,alias,displayName:'候选仓储结构',description:'仓储结构与格位库存快照 v1'};
  const models=[root],values=[],byId=new Map(nodes.map(n=>[n.id,n]));
  const built=new Map(),visiting=new Set();
  function visit(node) {
    if(built.has(node.id))return built.get(node.id);
    if(visiting.has(node.id))throw Error('空间层级存在循环');
    visiting.add(node.id);
    if(!['site','room','rack','cell'].includes(node.node_type))throw Error('不支持的空间类型：'+node.node_type);
    const parentNode=byId.get(node.parent_id);
    if(node.node_type!=='site'&&!parentNode)throw Error('缺少父空间：'+node.loc_code);
    const parent=node.node_type==='site'?root:visit(parentNode);
    if(parent.kind!=='folder')throw Error('格位不能包含下级空间');
    const key='n_'+createHash('sha256').update(node.id).digest('hex').slice(0,20);
    const model={kind:node.node_type==='cell'?'file':'folder',name:key,alias:alias+'_'+key,
      parentAlias:parent.alias,displayName:node.loc_code+' · '+node.name,
      description:'仓储节点 v1 '+node.id,path:(parent.path || root.name)+'/'+key};
    if(model.kind==='file') {
      Object.assign(model,{dataType:1,persistence:false,dashBoard:false,addFlow:false,
        definition:[{name:'occupied',type:'LONG'},{name:'snapshot',type:'STRING',maxLen:16384}]});
      const items=inventory.filter(row=>row.node_id===node.id).map(({node_id,...item})=>item);
      const ancestors=[];let ancestor=byId.get(node.parent_id);
      while(ancestor){ancestors.unshift({id:ancestor.id,type:ancestor.node_type,code:ancestor.loc_code,name:ancestor.name,
        geometry:JSON.parse(ancestor.geom || '{}'),template:JSON.parse(ancestor.template || '{}')});ancestor=byId.get(ancestor.parent_id);}
      const snapshot=JSON.stringify({schema_version:1,ancestors,cell:{id:node.id,code:node.loc_code,name:node.name,
        geometry:JSON.parse(node.geom || '{}'),capacity:node.capacity??null,max_load:node.max_load??null,status:node.status || 'normal'},inventory:items});
      if(Buffer.byteLength(snapshot,'utf8')>16384)throw Error('格位快照超过UNS字段长度：'+node.loc_code);
      values.push({alias:model.alias,path:model.path,loc_code:node.loc_code,occupied:items.length?1:0,snapshot});
    }
    models.push(model);built.set(node.id,model);visiting.delete(node.id);return model;
  }
  for(const node of nodes) {
    // 合并后的非首列仍在库中供旧标签重定向，但不再是独立有效格位。
    // 从当前计划移除，持续同步会清空旧快照；拆分后同一别名自然恢复。
    if(node.node_type==='cell') {
      const rack=byId.get(node.parent_id),suffix=node.loc_code.match(/-(L\d{2})-B(\d{2})$/);
      if(rack?.node_type==='rack'&&suffix) {
        const spans=JSON.parse(rack.template||'{}').merges?.[suffix[1]]||[];
        const col=Number(suffix[2]);
        if(spans.some(([a,b])=>col>Math.min(a,b)&&col<=Math.max(a,b)))continue;
      }
    }
    visit(node);
  }
  return {models,values};
}
