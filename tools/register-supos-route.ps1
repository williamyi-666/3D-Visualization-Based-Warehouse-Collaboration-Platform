param(
  [string]$RunnerContainer='opensupos-spatial',
  [string]$WarehouseUrl='http://opensupos-spatial:3000',
  [string]$KongAdminUrl='http://kong:8001',
  [ValidatePattern('^/[a-z][a-z0-9-]*$')][string]$BasePath='/warehouse'
)
$ErrorActionPreference='Stop'
foreach($address in @($WarehouseUrl,$KongAdminUrl)) {
  $uri=[uri]$address
  if($uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/'){throw '网关和应用地址必须是HTTP(S)服务来源，不含路径或账号'}
}
# 在本机 Open supOS 网关注册独立应用，不覆盖平台其他服务。
$script = @'
const kong=process.env.SPATIAL_KONG_ADMIN.replace(/\/$/, '')+'/';
const base=process.env.SPATIAL_GATEWAY_BASE;
const suffix=base==='/warehouse'?'':'-'+base.slice(1);
const service='spatial-inventory'+suffix,routeName='SpatialInventory'+suffix;
async function put(path, body) {
  const r = await fetch(kong + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  console.log(path, r.status);
}
(async () => {
  await put('services/'+service, { name: service, url: process.env.SPATIAL_WAREHOUSE_URL });
  await put('routes/'+routeName, { name: routeName, service: { name: service }, paths: [base], strip_path: true, response_buffering: false });
  await put('routes/'+routeName+'Sync', { name: routeName+'Sync', service: { name: service }, paths: ['~'+base+'-sync/?$'], methods: ['POST'], strip_path: true });
  const route = 'routes/'+routeName+'Sync/plugins';
  const existing = await (await fetch(kong + route)).json();
  // 仅该精确 POST 路由改用应用专用 Bearer 凭证；平台其他路由仍由 supOS 校验登录。
  for (const plugin of [
    { name: 'supos-auth-checker', config: { whitelist_paths: ['^'+base.replaceAll('-','')+'sync/?$'] } },
    { name: 'request-transformer', config: { replace: { uri: '/api/integration/snapshot' } } }
  ]) {
    const prior = existing.data.find(p => p.name === plugin.name);
    if (prior) await put('plugins/' + prior.id, { ...plugin, route: prior.route });
    else {
      const r = await fetch(kong + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plugin) });
      if (!r.ok) throw new Error(await r.text());
      console.log(plugin.name, r.status);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
'@
docker exec -e "SPATIAL_KONG_ADMIN=$KongAdminUrl" -e "SPATIAL_WAREHOUSE_URL=$WarehouseUrl" -e "SPATIAL_GATEWAY_BASE=$BasePath" $RunnerContainer node -e $script
if ($LASTEXITCODE -ne 0) { throw '仓储网关注册失败' }
# 平台菜单由“菜单配置”保存：编码 Warehouse3D，当前页打开，外部地址
# http://localhost:28088/warehouse/apps/web/prototype/index.html
