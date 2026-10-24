param(
  [ValidateSet('Check','Up','Stop')][string]$Action='Check',
  [string]$SettingsFile,
  [switch]$Build
)
$ErrorActionPreference='Stop'
function Invoke-Docker { & docker @args; if($LASTEXITCODE -ne 0){throw "Docker命令失败：$($args[0])"} }
$composeFile=Join-Path $PSScriptRoot '../docker/compose.supos.yml'
$composeArgs=@('compose','-f',$composeFile)
if($SettingsFile){$composeArgs+=@('--env-file',(Resolve-Path -LiteralPath $SettingsFile).Path)}
$config=(Invoke-Docker @composeArgs config --format json | ConvertFrom-Json)
$service=$config.services.warehouse
if($service.environment.SPATIAL_MODE -notin @('integration','standalone')){throw '库存模式必须是integration或standalone'}
if($service.environment.SPATIAL_BASE_PATH -notmatch '^/[a-z][a-z0-9-]*$'){throw '应用子路径须为小写字母、数字及横线组成的单段路径'}
$origin=[uri]$service.environment.SPATIAL_PUBLIC_ORIGIN
if($origin.Scheme -notin @('http','https') -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $origin.UserInfo){throw 'SPATIAL_PUBLIC_ORIGIN必须是完整HTTP(S)来源，不含路径或账号'}
Invoke-Docker network inspect $config.networks.platform.name | Out-Null
if($config.volumes.inventory.name -eq $config.volumes.assets.name){throw '数据库和上传资产必须使用不同数据卷'}
if($config.name -ne 'opensupos-spatial' -and !$config.volumes.inventory.external -and ($config.volumes.inventory.name -eq 'opensupos-spatial_inventory' -or $config.volumes.assets.name -eq 'opensupos-spatial_assets')){throw '独立实例必须显式指定自己的数据卷，不能沿用原实例默认卷'}
foreach($volume in @($config.volumes.inventory,$config.volumes.assets)) {
  if($volume.external){Invoke-Docker volume inspect $volume.name | Out-Null}
}
if($Action -eq 'Up') {
  $upArgs=@('up','-d','--wait','--wait-timeout','60')
  if($Build){$upArgs+='--build'}
  Invoke-Docker @composeArgs @upArgs
} elseif($Action -eq 'Stop') {Invoke-Docker @composeArgs stop}
Write-Output "配置：$($config.name)；容器：$($service.container_name)；数据卷：$($config.volumes.inventory.name)；资产卷：$($config.volumes.assets.name)"
if($Action -ne 'Stop'){Write-Output "应用入口：$($origin.GetLeftPart([System.UriPartial]::Authority))$($service.environment.SPATIAL_BASE_PATH)/apps/web/prototype/index.html（需先注册平台网关与菜单）"}
