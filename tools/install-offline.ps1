param([string]$SettingsFile,[switch]$VerifyOnly)
$ErrorActionPreference='Stop'
function Invoke-Docker { & docker @args; if($LASTEXITCODE -ne 0){throw 'Docker操作失败'} }
$root=[IO.Path]::GetFullPath($PSScriptRoot)
$manifest=Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw | ConvertFrom-Json
if($manifest.format -ne 1){throw '不支持的交付包格式'}
foreach($file in $manifest.files){
 $path=[IO.Path]::GetFullPath((Join-Path $root $file.path))
 if(!$path.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '清单路径越界'}
 if(!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256){throw "文件校验失败：$($file.path)"}
}
Write-Output "交付包校验通过：$($manifest.version) / $($manifest.platform)"
if($VerifyOnly){return}
if(!$SettingsFile){throw '安装须指定 -SettingsFile；仅校验文件可使用 -VerifyOnly'}
$settings=(Resolve-Path -LiteralPath $SettingsFile).Path
Invoke-Docker load --input (Join-Path $root 'warehouse-image.tar')
$image=(Invoke-Docker image inspect $manifest.image_id | ConvertFrom-Json)[0]
if(($image.Os+'/'+$image.Architecture) -ne $manifest.platform){throw '镜像平台不匹配'}
# 强制使用包中已校验的镜像；不从网络拉取可变标签，也不在目标机器构建。
$oldImage=$env:SPATIAL_IMAGE
try {
 $env:SPATIAL_IMAGE=$manifest.image_id
 & (Join-Path $root 'tools/deploy-supos.ps1') -Action Up -SettingsFile $settings
} finally {$env:SPATIAL_IMAGE=$oldImage}
Write-Output '应用安装完成；请按目标平台地址注册网关并配置Warehouse3D菜单。'
