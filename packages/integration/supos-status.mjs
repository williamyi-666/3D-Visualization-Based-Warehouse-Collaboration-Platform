// 对应本机Open supOS 1.0.11-T19的状态联调模型；不复用旧库存事件主题映射。
export const statusFolder={name:'Warehouse3D_Lab',alias:'warehouse3d_lab',displayName:'仓储三维联调',description:'仓储应用模型联调，仅展示应用状态，不是ERP库存业务写入'};
export const statusFile={name:'inventory_rows',alias:'warehouse3d_lab_rows',displayName:'模拟库存记录数',parentAlias:statusFolder.alias,dataType:1,definition:[{name:'value',type:'LONG'}],persistence:false,dashBoard:false,addFlow:false,description:'模拟来源快照的记录行数，非库存数量合计'};
export function createUnsClient(base,fetcher=fetch) {
 async function request(path,body) {
  const r=await fetcher(base.replace(/\/$/,'')+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  const data=await r.json();
  if(!r.ok || ![0,200].includes(data.code)){const e=new Error(data.msg || 'UNS接口失败');e.code=data.code;throw e;}
  return data.data;
 }
 async function ensure(kind,model,register) {
  let existing;
  try{existing=await request('/open-api/uns/'+kind+'/'+model.alias);}
  catch(e){if(!register || e.code!==400 || !/找不到|not found/i.test(e.message))throw e;await request('/open-api/uns/'+kind,model);existing=await request('/open-api/uns/'+kind+'/'+model.alias);}
  if(existing.name!==model.name || existing.description!==model.description)throw new Error('UNS别名已由不同模型占用：'+model.alias);
  return existing;
 }
 return {
  async model(register=false) {
   await ensure('folder',statusFolder,register);
   const file=await ensure('file',statusFile,register);
   if(file.dataType!==1 || file.path!=='Warehouse3D_Lab/inventory_rows' || !file.definition?.some(f=>f.name==='value' && f.type==='LONG'))throw new Error('UNS模型结构与状态契约不一致');
   return file;
  },
  async current(){return (await request('/open-api/uns/file/current/batchQuery',[statusFile.alias]))?.[statusFile.alias];}
 };
}
