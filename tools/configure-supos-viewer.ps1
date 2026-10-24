param(
  [ValidateSet('Check','Apply')][string]$Action='Check',
  [Parameter(Mandatory=$true)][string]$Username,
  [string]$RunnerContainer='opensupos-spatial',
  [string]$BackendUrl='http://backend:8080',
  [ValidatePattern('^/[a-z][a-z0-9-]*$')][string]$BasePath='/warehouse',
  [ValidatePattern('^/[A-Za-z][A-Za-z0-9-]*$')][string]$MenuPath='/Warehouse3D'
)
$ErrorActionPreference='Stop'
$address=[uri]$BackendUrl
if($address.Scheme -notin @('http','https') -or $address.UserInfo -or $address.Query -or $address.Fragment -or $address.AbsolutePath -ne '/'){throw 'BackendUrl必须是平台内部服务来源，不含路径或账号'}
# 由目标机管理员在平台内部网络执行；不创建账号或修改密码。
$script=@'
const base=process.env.SPATIAL_ROLE_BACKEND.replace(/\/$/,'');
const username=process.env.SPATIAL_ROLE_USERNAME;
const apply=process.env.SPATIAL_ROLE_ACTION==='Apply';
const appPath=process.env.SPATIAL_ROLE_BASE,menuPath=process.env.SPATIAL_ROLE_MENU;
const suffix=appPath==='/warehouse'&&menuPath==='/Warehouse3D'?'':appPath+' '+menuPath;
// 平台按角色名查询 Keycloak；斜杠会破坏查询路径，导致角色创建后权限写入失败。
const roleName='仓储只读访问'+(suffix?' '+suffix.replaceAll('/','-'):'');
const roleId='warehouse-viewer'+(suffix?'-'+require('node:crypto').createHash('sha256').update(suffix).digest('hex').slice(0,20):'');
const paths=[menuPath,appPath];
async function api(path, body) {
  const res=await fetch(base+'/inter-api/supos/'+path, {
    method:body?'POST':'GET', headers:body?{'Content-Type':'application/json'}:{},
    body:body?JSON.stringify(body):undefined, signal:AbortSignal.timeout(15000)
  });
  const data=await res.json();
  if(!res.ok || ![0,200].includes(data.code)) throw Error(data.msg || '平台API失败：'+res.status);
  return data.data;
}
async function user() {
  const matches=(await api('userManage/pageList',{pageNo:1,pageSize:1000,preferredUsername:username})).filter(x=>x.preferredUsername===username);
  if(matches.length!==1 || !matches[0].enabled) throw Error('目标账号不存在、不唯一或已禁用');
  return matches[0];
}
function checkRole(role) {
  const resources=role.resourceList||[];
  // 当前平台创建角色时自动追加/inter-api/supos；其他额外授权一律不接管。
  if((role.denyResourceList||[]).length || resources.some(x=>!paths.concat('/inter-api/supos').includes(x.uri) || (x.methods||[]).length) || paths.some(p=>!resources.some(x=>x.uri===p))) {
    throw Error('同名角色权限与仓储入口不一致，请人工核对；未修改现有角色');
  }
}
(async()=>{
  const account=await user();
  if((account.roleList||[]).some(x=>x.roleName==='超级管理员')) throw Error('此工具仅配置普通仓储使用者');
  const matches=(await api('userManage/roleList')).filter(x=>x.roleName===roleName);
  if(matches.length>1) throw Error('存在多个同名角色');
  let role=matches[0];
  if(role) checkRole(role);
  if(!apply) {
    console.log(JSON.stringify({username,roleExists:!!role,assigned:!!role && (account.roleList||[]).some(x=>x.roleId===role.roleId),action:'Check'}));
    return;
  }
  if(!role) {
    await api('role',{id:roleId,name:roleName,allowResourceList:paths.map(uri=>({uri,methods:[]})),denyResourceList:[]});
    const created=(await api('userManage/roleList')).filter(x=>x.roleName===roleName);
    if(created.length!==1) throw Error('角色创建后回读不唯一');
    role=created[0]; checkRole(role);
  }
  const previous=(account.roleList||[]).map(x=>x.roleId);
  if(!previous.includes(role.roleId)) {
    // 此固定平台版本type=1为追加；不替换用户原有角色。
    await api('userManage/setRole',{userId:account.id,type:1,roleList:[{roleId:role.roleId,clientRole:true}]});
  }
  const actual=((await user()).roleList||[]).map(x=>x.roleId);
  if(!actual.includes(role.roleId) || previous.some(id=>!actual.includes(id))) throw Error('角色分配回读不匹配');
  console.log(JSON.stringify({username,role:roleName,assigned:true,changed:!previous.includes(role.roleId)}));
  console.log('账号须重新登录以取得新入口角色；应用默认只读，已有仓储角色与仓库范围配置保持不变。');
})().catch(e=>{console.error(e.message);process.exit(1)});
'@
docker exec -e "SPATIAL_ROLE_BACKEND=$BackendUrl" -e "SPATIAL_ROLE_USERNAME=$Username" -e "SPATIAL_ROLE_ACTION=$Action" -e "SPATIAL_ROLE_BASE=$BasePath" -e "SPATIAL_ROLE_MENU=$MenuPath" $RunnerContainer node -e $script
if($LASTEXITCODE -ne 0){throw '仓储访问角色配置失败'}
