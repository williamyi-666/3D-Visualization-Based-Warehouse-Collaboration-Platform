param([switch]$VerifyOnly,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($PSScriptRoot)
function Invoke-Docker { & docker @args; if($LASTEXITCODE -ne 0){throw "Docker操作失败：$($args[0])"} }
$manifest=Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw -Encoding utf8 | ConvertFrom-Json
if($manifest.format -ne 1 -or $manifest.edition -ne 'standalone'){throw '这不是独立部署离线包'}
foreach($file in $manifest.files){
 $path=[IO.Path]::GetFullPath((Join-Path $root $file.path))
 if(!$path.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '清单路径越界'}
 if(!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256){throw "文件校验失败：$($file.path)"}
}
Write-Output "离线包校验通过：$($manifest.version)"
if($VerifyOnly){return}
Invoke-Docker compose version | Out-Null
if((Invoke-Docker info --format '{{.OSType}}') -ne 'linux'){throw '请将Docker切换到Linux容器模式'}
$settings=Join-Path $root 'settings.env'
if(!(Test-Path -LiteralPath $settings)){Copy-Item -LiteralPath (Join-Path $root 'settings.example') -Destination $settings}
$oldImage=$env:SPATIAL_IMAGE
try {
 $env:SPATIAL_IMAGE=$manifest.image_id
 $composeArgs=@('compose','-f',(Join-Path $root 'docker/compose.offline.yml'),'--env-file',$settings)
 $config=(Invoke-Docker @composeArgs config --format json | ConvertFrom-Json)
 $service=$config.services.warehouse
 if($service.environment.SPATIAL_AUTH_PROVIDER -ne 'local' -or $service.environment.SPATIAL_MODE -ne 'standalone'){throw '独立包必须使用本地登录和独立库存'}
 if($config.volumes.inventory.name -eq $config.volumes.assets.name){throw '库存和模型资产必须使用两个不同的数据卷'}
 Invoke-Docker load --input (Join-Path $root 'warehouse-image.tar')
 $image=(Invoke-Docker image inspect $manifest.image_id | ConvertFrom-Json)[0]
 if(($image.Os+'/'+$image.Architecture) -ne $manifest.platform){throw '镜像平台不匹配'}
 $existing=@(Invoke-Docker ps -aq --filter "name=^/$($service.container_name)$")
 if($existing){
  $before=(Invoke-Docker inspect $service.container_name | ConvertFrom-Json)[0]
  if($before.Image -ne $manifest.image_id){
   $backup=Join-Path $root ('backups/upgrade-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
   # Docker生成的备份目录可能由root拥有，说明文件保存在调用者拥有的上层目录。
   New-Item -ItemType Directory -Path $backup | Out-Null
   & (Join-Path $root 'tools/manage-backup.ps1') -Action Backup -Container $service.container_name -BackupPath (Join-Path $backup 'data')
   Set-Content -LiteralPath (Join-Path $backup 'previous-image.txt') -Value $before.Image -Encoding ascii
   Copy-Item -LiteralPath $settings -Destination (Join-Path $backup 'settings.env')
  }
 }
 Invoke-Docker @composeArgs up -d --pull never --wait --wait-timeout 90
 $port=$service.ports[0].published
 $url="http://localhost:$port/"
 Write-Output "电脑端：$url"
 Write-Output "手机端：http://服务器局域网IP:$port/apps/web/prototype/mobile.html"
 Write-Output '首次请从电脑端创建管理员；已有账号、库存和模型保存在数据卷中。'
 if(!$NoBrowser -and $env:OS -eq 'Windows_NT'){Start-Process $url}
} finally {$env:SPATIAL_IMAGE=$oldImage}
