import {isSpaceWrite} from './space-policy.mjs';
// 授权按已验证的平台用户 ID 保存。未配置保持既有全库范围，[] 明确禁止全部仓库。
export function createWarehouseAccess(sql, {standalone = false, localUsers = false, resolveImportLoc} = {}) {
  const roles=standalone?['viewer','spaceAdmin','operator']:['viewer','spaceAdmin'];
  sql.exec(`CREATE TABLE IF NOT EXISTS warehouse_access (
    user_id TEXT PRIMARY KEY,sites TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  if(!sql.prepare('PRAGMA table_info(warehouse_access)').all().some(column=>column.name==='role'))sql.exec('ALTER TABLE warehouse_access ADD COLUMN role TEXT');
  sql.exec('CREATE TABLE IF NOT EXISTS platform_access_user (id TEXT PRIMARY KEY,username TEXT NOT NULL,name TEXT NOT NULL,base_role TEXT NOT NULL)');
  function identityMiddleware(req,res,next) {
    const user=req.user;
    if(user?.provider==='supos') {
      sql.prepare('INSERT INTO platform_access_user(id,username,name,base_role) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,name=excluded.name,base_role=excluded.base_role WHERE username!=excluded.username OR name!=excluded.name OR base_role!=excluded.base_role').run(user.id,user.username,user.name,user.role);
      if(user.role!=='admin') {
        const override=sql.prepare('SELECT role FROM warehouse_access WHERE user_id=?').get(user.id)?.role;
        if(roles.includes(override))user.role=override;
      }
    }
    next();
  }
  const users=()=>localUsers?sql.prepare("SELECT id,username,name,role AS base_role,status,'local' AS provider FROM user ORDER BY username,id").all()
    :sql.prepare("SELECT *, 'supos' AS provider,'active' AS status FROM platform_access_user ORDER BY username,id").all();
  function member(id){
    const user=users().find(user=>user.id===id);if(!user)return null;
    const record=sql.prepare('SELECT sites,role FROM warehouse_access WHERE user_id=?').get(id);
    const role=user.base_role==='admin'?'admin':user.provider==='supos'&&roles.includes(record?.role)?record.role:user.base_role;
    const sites=record?JSON.parse(record.sites):null;
    return {...user,role,sites,canAccess(code){
      if(user.status!=='active')return false;
      let node=sql.prepare('SELECT id,parent_id,node_type,loc_code FROM space_node WHERE loc_code=? OR id=?').get(code,code);
      if(!node)return false;if(role==='admin'||sites===null)return true;
      const visited=new Set();while(node&&!visited.has(node.id)){
        if(node.node_type==='site')return sites.includes(node.loc_code);visited.add(node.id);
        node=sql.prepare('SELECT id,parent_id,node_type,loc_code FROM space_node WHERE id=?').get(node.parent_id);
      }return false;
    }};
  }
  const list=()=>sql.prepare('SELECT * FROM warehouse_access ORDER BY user_id').all().map(r=>({...r,sites:JSON.parse(r.sites)}));
  function save({user_id,sites,role},actor) {
    if(typeof user_id!=='string'||!user_id||user_id.length>250||user_id!==user_id.trim()||(!localUsers&&!user_id.startsWith('supos:'))||!Array.isArray(sites)||sites.some(s=>typeof s!=='string'))throw new Error('需要有效账号ID和仓库编码数组');
    const local=localUsers?users().find(user=>user.id===user_id):null;
    if(localUsers&&!local)throw Error('本地账号不存在，请先创建账号');
    if(local?.base_role==='admin')throw Error('本地管理员具有全部仓库权限');
    if(local&&role!=null&&role!==local.base_role)throw Error('本地账号角色请在用户管理中修改，此处只分配仓库');
    if(role!==undefined && role!==null && !roles.includes(role))throw Error('当前模式不支持此角色');
    if(role!==undefined&&!local){
      const user=sql.prepare('SELECT * FROM platform_access_user WHERE id=?').get(user_id);
      if(!user)throw Error('请先让该账号登录本应用，验证身份后再配置角色');
      if(user.base_role==='admin')throw Error('平台管理员权限由supOS管理');
    }
    const effectiveRole=local?null:role===undefined?(sql.prepare('SELECT role FROM warehouse_access WHERE user_id=?').get(user_id)?.role || null):role;
    const codes=[...new Set(sites)].sort();
    for(const code of codes)if(!sql.prepare("SELECT id FROM space_node WHERE node_type='site' AND loc_code=?").get(code))throw new Error('仓库不存在：'+code);
    sql.prepare('INSERT INTO warehouse_access(user_id,sites,updated_by,updated_at,role) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET sites=excluded.sites,updated_by=excluded.updated_by,updated_at=excluded.updated_at,role=excluded.role').run(user_id,JSON.stringify(codes),actor,new Date().toISOString(),effectiveRole);
    return {user_id,sites:codes};
  }
  function remove(user_id){sql.prepare('DELETE FROM warehouse_access WHERE user_id=?').run(user_id);return {removed:true};}
  function middleware(req,res,next) {
    if(!req.user || req.user.role==='admin'||req.user.isService)return next();
    const record=sql.prepare('SELECT sites FROM warehouse_access WHERE user_id=?').get(req.user.id);
    if(!record)return next();
    const sites=JSON.parse(record.sites),nodes=sql.prepare('SELECT id,parent_id,loc_code,node_type FROM space_node').all();
    const byId=new Map(nodes.map(n=>[n.id,n])),byCode=new Map(nodes.map(n=>[n.loc_code,n]));
    const allowed=new Set();
    function permitted(node){
      const seen=new Set();
      while(node && !seen.has(node.id)){
        if(node.node_type==='site')return sites.includes(node.loc_code);
        seen.add(node.id);node=byId.get(node.parent_id);
      }return false;
    }
    for(const node of nodes)if(permitted(node))allowed.add(node.loc_code);
    req.canAccessLocation=code=>allowed.has(code);
    req.allowedLocations=[...allowed];
    req.warehouseSites=sites;
    const deny=()=>res.status(403).json({error:'当前账号没有此仓库的访问权限'});
    function check(key,type){const n=byId.get(key)||byCode.get(key);return !!n&&(!type||n.node_type===type)&&allowed.has(n.loc_code);}
    function first(type){return nodes.find(n=>n.node_type===type&&allowed.has(n.loc_code))?.loc_code;}
    if(req.path.startsWith('/uploads/')){
      const asset=sql.prepare('SELECT loc_code FROM node_asset WHERE asset_url=?').all(decodeURIComponent(req.path));
      return asset.some(a=>allowed.has(a.loc_code))?next():deny();
    }
    if(!req.path.startsWith('/api/'))return next();
    const path=req.path,parts=path.split('/').map(decodeURIComponent),body=req.body||{};
    // 新工作台接口在服务内部校验库区/格位，不把未知接口普遍放开。
    if(/^\/api\/team-tasks(?:\/|$)/.test(path)||/^\/api\/assistant\/jobs(?:\/|$)/.test(path)||/^\/api\/assistant\/session(?:\/reset)?$/.test(path)||path==='/api/assistant/preview'||['/api/assistant/media/status','/api/assistant/media/recognize','/api/assistant/media/text'].includes(path))return next();
    if(['/api/setup/templates','/api/setup/preview','/api/setup/racks','/api/work/catalogue','/api/work/opening','/api/work/progress','/api/work/recommendations','/api/work/route-options','/api/work/route','/api/work/tasks','/api/work/policy','/api/work/status','/api/assistant/status','/api/assistant/ask','/api/assistant/draft'].includes(path))return next();
    if(/^\/api\/erp-stocktakes(?:\/|$)/.test(path))return next(); // 单据服务按已保存的格位校验范围。
    if(standalone&&/^\/api\/items\/[^/]+\/storage(?:\/history)?$/.test(path))return next(); // 货品资料服务按实际关联库位校验读取和修改范围。
    if(standalone) {
      // 盘点单按其保存的库位检查权限，不能用请求中的库位替换绕过。
      if(/^\/api\/stocktakes(?:\/|$)/.test(path))return next();
      const itemLocations=id=>sql.prepare('SELECT n.loc_code FROM inventory i JOIN space_node n ON n.id=i.node_id WHERE i.item_id=?').all(id);
      const readableItem=id=>itemLocations(id).some(n=>allowed.has(n.loc_code));
      if(['GET','HEAD'].includes(req.method)) {
        const json=res.json.bind(res);
        if(['/api/search','/api/v1/inventory'].includes(path))res.json=value=>json(Array.isArray(value)?value.filter(r=>allowed.has(r.loc_code)):value);
        if(path==='/api/v1/items')res.json=value=>json(Array.isArray(value)?value.filter(r=>readableItem(r.id)):value);
        if(path==='/api/items/by-code') {
          res.json=value=>value?.item_id&&!readableItem(value.item_id)?res.status(404).json({error:'未找到匹配货品'}):json(value);
          return next();
        }
        const visibleMovement=m=>{
          const locations=[m.from_loc_code ?? m.from_loc,m.to_loc_code ?? m.to_loc].filter(Boolean);
          return locations.length>0&&locations.every(loc=>allowed.has(loc));
        };
        if(path==='/api/v1/movements')res.json=value=>{
          const movements=(value.movements||[]).filter(visibleMovement);
          return json({...value,movements,count:movements.length});
        };
        if(/^\/api\/cell\/[^/]+\/history$/.test(path))res.json=value=>json(Array.isArray(value)?value.filter(visibleMovement):value);
        if(path==='/api/access/status')return next();
      } else {
        if(['/api/counter/inbound','/api/counter/outbound','/api/items','/api/v1/items'].includes(path))return check(body.loc_code,'cell')?next():deny();
        if(path==='/api/counter/move')return check(body.from_loc,'cell')&&check(body.to_loc,'cell')?next():deny();
        if(path==='/api/import'){
          if(!Array.isArray(body.rows))return res.status(400).json({error:'需要导入行数组'});
          for(const [index,row] of body.rows.entries()){
            const location=resolveImportLoc?.(row?.loc_code||row?.loc||row?.location,row?.rack||row?.shelf);
            // 不返回全库候选编码，避免歧义提示泄漏其他仓库；解析与导入使用同一规则。
            if(!location?.ok)return res.status(400).json({error:`第${index+1}行格位无法唯一确定，请填写完整格位编码或补充货架列`});
            if(!check(location.locCode,'cell'))return deny();
          }
          return next();
        }
        if(/^\/api\/items\/[^/]+$/.test(path)){
          const locations=itemLocations(parts[3]);
          return locations.length&&locations.every(n=>allowed.has(n.loc_code))&&(!body.loc_code||check(body.loc_code,'cell'))?next():deny();
        }
      }
    }
    if(['GET','HEAD'].includes(req.method)) {
      if(['/api/scene','/api/scene/events','/api/scene/revision','/api/layout'].includes(path)){
        req.scopeRoom=req.query.room||first('room');if(!check(req.scopeRoom,'room'))return deny();
      }else if(path==='/api/rooms'){
        if(req.query.site&&!check(req.query.site,'site'))return deny();
      }else if(/^\/api\/(cell|cells|node)\/[^/]+\/(items|meta|history|asset|sku-binding)$/.test(path)){
        if(!check(parts[3]))return deny();
      }else if(path==='/api/integration/events'){
        if(!check(req.query.loc_code,'cell'))return deny();
      }else if(!['/api/sites','/api/cells','/api/locations/tree','/api/v1/locations/tree','/api/v1/inventory','/api/v1/items','/api/v1/movements','/api/search','/api/integration/inventory/page','/api/integration/facets','/api/integration/status'].includes(path))return deny();
      const filtered=['/api/sites','/api/rooms','/api/cells','/api/locations/tree','/api/v1/locations/tree'];
      if(filtered.includes(path)){
        const json=res.json.bind(res);res.json=value=>json(Array.isArray(value)?value.filter(n=>allowed.has(n.loc_code)):value);
      }
      return next();
    }
    if(!isSpaceWrite(req.method,path)||path==='/api/site')return deny();
    if(path==='/api/import-layout')return next(); // 仅解析上传文件，不读取或保存仓库。
    if(path==='/api/cells/meta'){
      if(!Array.isArray(body.codes)||!body.codes.every(code=>check(code,'cell')))return deny();
    }else if(path==='/api/rooms'){
      body.siteCode=body.siteCode||first('site');if(!check(body.siteCode,'site'))return deny();
    }else if(['/api/rack','/api/furniture','/api/room','/api/layout'].includes(path)){
      const key=path==='/api/room'?'id':path==='/api/layout'?'roomId':'roomCode';
      body[key]=body[key]||first('room');if(!check(body[key],'room'))return deny();
    }else if(!check(parts[3]))return deny();
    req.body=body;
    next();
  }
  return {list,save,remove,middleware,identityMiddleware,users,member};
}
