// 草稿按部署地址、账号、库区节点和作业类型隔离；库区重建不会继承旧草稿。
export function createFieldDrafts({userId,roomId,kind,storage=localStorage,basePath=window.SPATIAL_RUNTIME?.basePath||''}) {
  const key='spatial-field-drafts:'+JSON.stringify([basePath,userId,roomId,kind]);
  function all(){const value=JSON.parse(storage.getItem(key)||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error('作业草稿无法读取，请联系管理员检查浏览器存储');return value;}
  function write(rows){try{storage.setItem(key,JSON.stringify(rows));}catch{throw Error('草稿未能保存，请保留当前页面并检查浏览器存储空间');}}
  return {
    list:()=>Object.entries(all()).map(([id,value])=>({id,...value})).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)),
    get:id=>all()[id]||null,
    save(id,value){const rows=all();rows[id]={...value,updated_at:new Date().toISOString()};write(rows);},
    remove(id){const rows=all();delete rows[id];write(rows);}
  };
}
