import { placementError } from '../../packages/three-kit/layout-geometry.mjs';
// 仅开放明确的空间接口；库存写接口继续由集成模式门禁拒绝。
export function isSpaceWrite(method, path) {
  if(method==='POST'&&path==='/api/setup/racks')return true;
  if (['POST','DELETE'].includes(method) && /^\/api\/node\/[^/]+\/asset$/.test(path)) return true;
  if (['POST','DELETE'].includes(method) && /^\/api\/cell\/[^/]+\/photo$/.test(path))return true;
  if (method === 'POST' && /^\/api\/rack\/[^/]+\/clone$/.test(path)) return true;
  if (method === 'POST') return ['/api/site','/api/rooms','/api/room','/api/rack','/api/furniture','/api/layout','/api/cells/meta','/api/import-layout'].includes(path);
  if (method === 'PUT' && /^\/api\/cell\/[^/]+\/(meta|sku-binding)$/.test(path)) return true;
  if (method === 'PUT') return /^\/api\/(rack|furniture)\/[^/]+(?:\/(merges|cell-names|cells))?$/.test(path);
  return method === 'DELETE' && /^\/api\/(rack|furniture|rooms)\/[^/]+$/.test(path);
}

export function createSpacePolicy(sql, inventory) {
  const node = (key,type) => sql.prepare('SELECT * FROM space_node WHERE node_type=? AND (id=? OR loc_code=?)').get(type,key,key);
  function assertUnreferenced(root) {
    if (!root) throw new Error('空间节点不存在');
    const cells = sql.prepare(`WITH RECURSIVE children(id,loc_code) AS (
      SELECT id,loc_code FROM space_node WHERE id=? UNION ALL
      SELECT n.id,n.loc_code FROM space_node n JOIN children c ON n.parent_id=c.id
    ) SELECT loc_code FROM children`).all(root.id);
    const codes = new Set(cells.map(c=>c.loc_code));
    const ref = [...inventory.list(),...inventory.mappings(),...(inventory.references?.() || [])].find(r=>codes.has(r.loc_code));
    if (ref) throw new Error(`格位 ${ref.loc_code} 被 ${ref.source} 的库存或映射引用，不能删除、改层列或合并；请先解除引用`);
  }
  function validateRack(patch) {
    for (const k of ['x','z','rot','w','h','d','rows','cols']) {
      if (patch[k] == null) continue;
      const n=Number(patch[k]);
      if (!Number.isFinite(n) || (['w','h','d','rows','cols'].includes(k) && n<=0)) throw new Error('非法空间参数: '+k);
      if (['rows','cols'].includes(k) && (!Number.isInteger(n) || n>100)) throw new Error('层列数须为1至100的整数');
    }
  }

  function geometry(row) { return { ...JSON.parse(row.geom || '{}'), code:row.loc_code }; }
  function checkPlacement(rack,patch) {
    const room=node(rack.parent_id,'room');
    const g=JSON.parse(room.geom || '{}');
    const peers=sql.prepare("SELECT * FROM space_node WHERE node_type='rack' AND parent_id=?").all(room.id).map(geometry);
    const problem=placementError({...geometry(rack),...patch},{width:g.w,depth:g.d},peers);
    if(problem)throw new Error(problem);
  }
  function checkRack(code,patch) {
    validateRack(patch);
    const rack=node(code,'rack'); if (!rack) throw new Error('货架不存在: '+code);
    const t=JSON.parse(rack.template || '{}'), g=JSON.parse(rack.geom || '{}');
    if ((patch.rows!=null && Number(patch.rows)!==t.rows) || (patch.cols!=null && Number(patch.cols)!==t.cols) || (patch.type!=null && patch.type!==g.type)) assertUnreferenced(rack);
  }
  return (method,path,body={}) => {
    const parts=path.split('/').map(decodeURIComponent), code=parts[3];
    if(parts[2]==='node' || parts[4]==='photo') return;
    if (method==='DELETE') { assertUnreferenced(node(code,parts[2]==='rooms'?'room':'rack')); return; }
    if (method==='PUT') {
      if (parts[4]==='merges') assertUnreferenced(node(code,'rack'));
      else if (parts[4]==='cells') {
        const rack=node(code,'rack'); if (!rack) throw new Error('货架不存在');
        const old=JSON.parse(rack.template || '{}').merges || {};
        if (JSON.stringify(body.merges)!==JSON.stringify(old)) assertUnreferenced(rack);
      }
      else if (!parts[4]) { checkRack(code,body); if(['x','z','rot','w','d'].some(k=>body[k]!=null)) checkPlacement(node(code,'rack'),body); }
      return;
    }
    if (['/api/rack','/api/furniture'].includes(path)) { validateRack({...body,...body.geom}); return; }
    if (path==='/api/room' || path==='/api/rooms') {
      const room=body;
      for (const k of ['width','depth','height','w','d','h']) if (room[k]!=null && (!Number.isFinite(Number(room[k])) || Number(room[k])<=0)) throw new Error('非法库区尺寸: '+k);
      if (body.id && !node(body.id,'room')) throw new Error('库区不存在');
      if(body.id && ['width','depth','w','d'].some(k=>body[k]!=null)) {
        const current=node(body.id,'room'),g=JSON.parse(current.geom || '{}');
        const bounds={width:body.width ?? body.w ?? g.w,depth:body.depth ?? body.d ?? g.d};
        const racks=sql.prepare("SELECT * FROM space_node WHERE node_type='rack' AND parent_id=?").all(current.id).map(geometry);
        for(const rack of racks)if(placementError(rack,bounds,[]))throw new Error('库区尺寸会使现有货架越界');
      }

    }
    if (path==='/api/layout') {
      const room=body.roomId ? node(body.roomId,'room') : sql.prepare("SELECT * FROM space_node WHERE node_type='room' LIMIT 1").get();
      if (!room) throw new Error('库区不存在');
      if (body.room) for (const k of ['width','depth','height']) if (body.room[k]!=null && (!Number.isFinite(Number(body.room[k])) || Number(body.room[k])<=0)) throw new Error('非法库区尺寸: '+k);
      if (!Array.isArray(body.furniture)) throw new Error('布局家具列表必填');
      if(new Set(body.furniture.map(f=>f?.code)).size!==body.furniture.length)throw new Error('布局货架编码重复');
      // 在任何写入发生前检查整份布局，避免先改房间再在删除货架时失败。
      for (const f of body.furniture) {
        if (!f || !f.code) throw new Error('货架编码必填');
        const rack=node(f.code,'rack');
        if (rack && rack.parent_id!==room.id) throw new Error('不可修改其他库区货架');
        if(rack) {
          checkRack(f.code,f);
          const oldMerges=JSON.parse(rack.template || '{}').merges || {};
          if(f.merges && JSON.stringify(f.merges)!==JSON.stringify(oldMerges))assertUnreferenced(rack);
        } else validateRack(f);
      }
      const rg=JSON.parse(room.geom || '{}');
      const bounds={width:body.room?.width ?? rg.w,depth:body.room?.depth ?? rg.d};
      for(const f of body.furniture) { const error=placementError(f,bounds,body.furniture); if(error)throw new Error(f.code+'：'+error); }
      if (body.replace) {
        const keep=new Set(body.furniture.map(f=>f.code));
        for (const rack of sql.prepare("SELECT * FROM space_node WHERE parent_id=? AND node_type='rack'").all(room.id)) if (!keep.has(rack.loc_code)) assertUnreferenced(rack);
      }
    }
  };
}
