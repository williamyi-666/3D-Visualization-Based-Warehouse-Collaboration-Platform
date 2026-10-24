import {createHash} from 'node:crypto';

const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=['width','height','depth','weight_kg','required_tags','horizontal_rotation','max_stack_layers'];
export function normalizeStorageProfile(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))fail('存放资料格式无效');
  const profile={width:null,height:null,depth:null,weight_kg:null,required_tags:[],horizontal_rotation:false};
  for(const key of ['width','height','depth','weight_kg'])if(input[key]!==undefined&&input[key]!==null&&input[key]!==''){
    if(typeof input[key]!=='number'||!Number.isFinite(input[key])||input[key]<=0)fail('尺寸和单库存单位重量须大于零，未知可留空');profile[key]=input[key];
  }
  const dimensions=['width','height','depth'].filter(key=>profile[key]!==null).length;
  if(dimensions!==0&&dimensions!==3)fail('包装宽、高、深请全部填写，或全部留空');
  if(input.required_tags!==undefined){
    if(!Array.isArray(input.required_tags)||input.required_tags.length>20||input.required_tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.trim().length>40))fail('存放要求最多20项，每项1至40个字');
    profile.required_tags=[...new Set(input.required_tags.map(tag=>tag.trim()))].sort();
  }
  if(input.horizontal_rotation!==undefined){if(typeof input.horizontal_rotation!=='boolean')fail('水平转向选项格式无效');profile.horizontal_rotation=input.horizontal_rotation;}
  if(input.max_stack_layers!=null && input.max_stack_layers!=='') {
    if(!Number.isInteger(input.max_stack_layers)||input.max_stack_layers<1)fail('最大叠放层数须为正整数，未知可留空');
    profile.max_stack_layers=input.max_stack_layers;
  }
  return profile;
}
export function readStorageProfile(attributes={}){
  const attrs=typeof attributes==='string'?JSON.parse(attributes||'{}'):attributes;
  const profile=attrs.storage_profile||{};
  return {...normalizeStorageProfile(profile),weight_kg:profile.weight_kg??(Number(attrs.weight_kg)>0?Number(attrs.weight_kg):null),configured:Object.hasOwn(attrs,'storage_profile')};
}

export function createItemStorage(sql,{tenant,emit=()=>{}}){
  sql.exec(`CREATE TABLE IF NOT EXISTS item_storage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,item_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,
    before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL,
    UNIQUE(actor_id,request_id));`);
  function get(id,actor,canAccess){
    const item=sql.prepare('SELECT id,name,sku,unit,attributes FROM item WHERE tenant_id=? AND id=?').get(tenant,id);
    if(!item)fail('货品不存在或不可访问',404);
    const locations=sql.prepare('SELECT n.loc_code FROM inventory i JOIN space_node n ON n.id=i.node_id WHERE i.item_id=?').all(id);
    if(canAccess&&!locations.some(row=>canAccess(row.loc_code)))fail('货品不存在或不可访问',404);
    const profile=readStorageProfile(item.attributes),can_edit=!!actor&&!actor.isService&&['admin','operator'].includes(actor.role)&&(!canAccess||locations.every(row=>canAccess(row.loc_code)));
    return {item_id:id,name:item.name,sku:item.sku||'',unit:item.unit||'件',profile,can_edit,
      revision:hash([item.id,item.name,item.sku,item.unit,profile]),message:can_edit?'按一个库存单位填写包装尺寸和重量。':'共享货品资料请由具备全部关联仓库权限的管理员或操作员维护。'};
  }
  function save(id,input,actor,canAccess){
    const before=get(id,actor,canAccess);if(!before.can_edit)fail('当前账号不能维护此货品存放资料',403);
    if(typeof input.request_id!=='string'||!input.request_id||input.request_id.length>128)fail('需要资料保存请求编号');
    const signature=hash([id,input]),prior=sql.prepare('SELECT * FROM item_storage_history WHERE actor_id=? AND request_id=?').get(actor.id,input.request_id);
    if(prior){if(prior.signature!==signature)fail('保存内容已变化，请使用新的请求编号',409);return {...get(id,actor,canAccess),replayed:true};}
    if(input.revision!==before.revision)fail('货品资料已更新，请重新打开后核对',409);
    const profile=normalizeStorageProfile(input.profile);sql.exec('SAVEPOINT save_item_storage');
    try{
      const attrs=JSON.parse(sql.prepare('SELECT attributes FROM item WHERE id=?').get(id).attributes||'{}');attrs.storage_profile=profile;
      // 三维承重提示沿用已有重量字段，两个入口使用同一份单位重量。
      if(profile.weight_kg===null)delete attrs.weight_kg;else attrs.weight_kg=profile.weight_kg;
      sql.prepare('UPDATE item SET attributes=? WHERE id=?').run(JSON.stringify(attrs),id);
      const after=get(id,actor,canAccess);
      sql.prepare('INSERT INTO item_storage_history(tenant_id,item_id,actor_id,actor_name,request_id,signature,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(tenant,id,actor.id,actor.name||actor.username||actor.id,input.request_id,signature,JSON.stringify(before),JSON.stringify(after),new Date().toISOString());
      emit('item.updated',{item_id:id});sql.exec('RELEASE SAVEPOINT save_item_storage');return after;
    }catch(error){sql.exec('ROLLBACK TO SAVEPOINT save_item_storage; RELEASE SAVEPOINT save_item_storage');throw error;}
  }
  function history(id,actor,canAccess){get(id,actor,canAccess);return sql.prepare('SELECT id,actor_name,before_json,after_json,created_at FROM item_storage_history WHERE tenant_id=? AND item_id=? ORDER BY id DESC LIMIT 30').all(tenant,id).map(row=>({id:row.id,actor_name:row.actor_name,before:JSON.parse(row.before_json).profile,after:JSON.parse(row.after_json).profile,created_at:row.created_at}));}
  return {get,save,history};
}
export function mountItemStorage(app,{storage,requireRole}){
  const run=fn=>(req,res)=>{try{res.set('Cache-Control','no-store').json(fn(req));}catch(error){res.status(error.status||400).json({error:error.message});}};
  app.get('/api/items/:id/storage',run(req=>storage.get(req.params.id,req.user,req.canAccessLocation)));
  app.get('/api/items/:id/storage/history',run(req=>storage.history(req.params.id,req.user,req.canAccessLocation)));
  app.post('/api/items/:id/storage',requireRole('admin','operator'),run(req=>storage.save(req.params.id,req.body,req.user,req.canAccessLocation)));
}
