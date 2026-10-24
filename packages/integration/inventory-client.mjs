// ERP侧通用推送协议；只发送来源系统已经提交的库存，不推断出入库业务。
export function inspectInventoryPayload(payload){
  if(!payload||typeof payload.source!=='string'||!payload.source.trim())throw Error('source 必填');
  const mode=payload.mode||'snapshot';
  if(!['snapshot','delta','reconcile','events'].includes(mode))throw Error('未知同步模式');
  const rows=mode==='delta'?payload.changes:mode==='events'?payload.events:payload.rows;
  if(!Array.isArray(rows))throw Error('需要对应模式的 rows、changes 或 events 数组');
  if(mode!=='events'&&(!Number.isSafeInteger(payload.version)||payload.version<1))throw Error('version 必须是正整数');
  return {source:payload.source,mode,version:payload.version,count:rows.length};
}
export function inventoryEndpoint(baseUrl){
  const url=new URL(baseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('URL应为应用入口根路径，不带凭证、查询参数或片段');
  url.pathname=url.pathname.replace(/\/$/,'')+'/api/integration/snapshot';return url;
}
export async function sendInventory({baseUrl,token,payload,fetcher=fetch}){
  inspectInventoryPayload(payload);const url=inventoryEndpoint(baseUrl);
  if(!token)throw Error('请设置 SPATIAL_SYNC_TOKEN 为来源专用同步凭证');
  const response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
  let result;try{result=await response.json();}catch{throw Object.assign(Error('接口未返回JSON，请核对应用根路径及网关配置'),{status:response.status,retryable:response.status>=500});}
  if(!response.ok)throw Object.assign(Error(`同步失败（HTTP ${response.status}）：${result.error||'请查看同步历史'}`),{status:response.status,retryable:response.status>=500||[408,429].includes(response.status)});
  if(!result||typeof result!=='object'||(!Object.hasOwn(result,'applied')&&!Object.hasOwn(result,'reconciled')))throw Object.assign(Error('接口未返回有效同步回执，请核对接入地址'),{retryable:false});
  return result;
}
