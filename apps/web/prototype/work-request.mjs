export async function workApi(path,body,method='GET') {
  let response;
  try{response=await fetch(path,body===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
  catch(error){throw new Error('暂时无法连接仓库服务，请检查连接后重试。',{cause:error});}
  const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'操作失败'),{status:response.status});return data;
}
let userId='';
export function setWorkUser(id){userId=id;}
const key=()=>`spatial-work-pending:${window.SPATIAL_RUNTIME?.basePath||''}:${userId||JSON.parse(localStorage.getItem('spatial_user')||'null')?.id||'platform'}`;
export function pendingWork(){try{return JSON.parse(localStorage.getItem(key())||'null');}catch{return null;}}
export async function sendWork(path,body) {
  const identity=await workApi('/api/auth/me');
  if(userId&&identity.user.id!==userId)throw Error('操作账号已变化，请关闭后以当前账号重新打开');
  setWorkUser(identity.user.id);
  let pending=pendingWork();
  if(pending&&(pending.path!==path||JSON.stringify(pending.body)!==JSON.stringify(body)))throw Error('上次操作结果尚未确认，请先点击“核对上次操作”');
  if(!pending){pending={path,body,request_id:window.spatialRandomUUID(),at:new Date().toISOString()};localStorage.setItem(key(),JSON.stringify(pending));}
  try {
    const result=await workApi(path,{...body,request_id:pending.request_id},'POST');
    localStorage.removeItem(key());return result;
  }catch(error){if(error.status>=400&&error.status<500&&![401,403].includes(error.status))localStorage.removeItem(key());throw error;}
}
export async function retryWork(){const pending=pendingWork();if(!pending)throw Error('没有待核对操作');return sendWork(pending.path,pending.body);}
