// 事件中的库位一旦确定就保留；不把数据库UUID伪装成物理库位。
export function resolveEventLocation(sql,payload={}) {
 if(payload.loc_code || !payload.node_id)return payload;
 const node=sql.prepare('SELECT loc_code FROM space_node WHERE id=?').get(payload.node_id);
 if(node)return {...payload,loc_code:node.loc_code};
 // 已删除节点只能从保留的业务历史恢复；没有证据或存在歧义时不猜测。
 const rows=sql.prepare(`SELECT DISTINCT loc FROM (
   SELECT json_extract(history_json,'$.from_loc') AS loc FROM movement WHERE from_node_id=?
   UNION SELECT json_extract(history_json,'$.to_loc') AS loc FROM movement WHERE to_node_id=?
 ) WHERE loc IS NOT NULL`).all(payload.node_id,payload.node_id);
 return rows.length===1?{...payload,loc_code:rows[0].loc}:payload;
}
