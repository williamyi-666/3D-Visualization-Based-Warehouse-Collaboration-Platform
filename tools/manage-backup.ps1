param(
  [ValidateSet('Backup','Verify','Restore')][string]$Action='Backup',
  [Parameter(Mandatory=$true)][string]$BackupPath,
  [string]$Container='opensupos-spatial',
  [string]$TargetPrefix
)
$ErrorActionPreference='Stop'
function Invoke-Docker { & docker @args; if($LASTEXITCODE -ne 0){throw "Docker命令失败：$($args[0])"} }
$scriptPath=Join-Path $PSScriptRoot 'backup-data.mjs'
$backupFull=[IO.Path]::GetFullPath($BackupPath)
$containerInfo=(Invoke-Docker inspect $Container | ConvertFrom-Json)[0]
$image=$containerInfo.Image
$mountScript="type=bind,source=$scriptPath,target=/tool.mjs,readonly"
if($Action -eq 'Backup') {
  if(Test-Path -LiteralPath $backupFull){throw '备份目录已存在，请使用新目录'}
  $parentPath=Split-Path -Parent $backupFull
  New-Item -ItemType Directory -Force -Path $parentPath | Out-Null
  $leaf=Split-Path -Leaf $backupFull
  $dataMount=$containerInfo.Mounts | Where-Object Destination -eq '/data'
  $assetMount=$containerInfo.Mounts | Where-Object Destination -eq '/uploads'
  if($dataMount.Type -ne 'volume' -or $assetMount.Type -ne 'volume'){throw '此工具要求/data和/uploads使用Docker命名卷'}
  $wasRunning=$containerInfo.State.Running
  try {
    if($wasRunning){Invoke-Docker stop $Container | Out-Null}
    Invoke-Docker run --rm --network none --mount $mountScript --mount "type=volume,source=$($dataMount.Name),target=/source" --mount "type=volume,source=$($assetMount.Name),target=/assets,readonly" --mount "type=bind,source=$parentPath,target=/backups" $image node /tool.mjs backup "/backups/$leaf"
  } finally {if($wasRunning){Invoke-Docker start $Container | Out-Null}}
  Write-Output "成套备份：$backupFull"
} else {
  if(!(Test-Path -LiteralPath $backupFull -PathType Container)){throw '备份目录不存在'}
  $mountBackup="type=bind,source=$backupFull,target=/backup,readonly"
  Invoke-Docker run --rm --network none --mount $mountScript --mount $mountBackup $image node /tool.mjs verify /backup
  if($Action -eq 'Restore') {
    if($TargetPrefix -notmatch '^[a-z][a-z0-9-]{2,60}$'){throw '恢复必须指定TargetPrefix：小写字母开头，3至61位字母数字或横线'}
    $dataVolume="$TargetPrefix-inventory"; $assetVolume="$TargetPrefix-assets"
    $existing=@(Invoke-Docker volume ls --format '{{.Name}}')
    if($existing -contains $dataVolume -or $existing -contains $assetVolume){throw '恢复卷已存在；必须选择全新的TargetPrefix，禁止覆盖现有数据'}
    Invoke-Docker volume create $dataVolume | Out-Null
    Invoke-Docker volume create $assetVolume | Out-Null
    Invoke-Docker run --rm --network none --mount $mountScript --mount $mountBackup --mount "type=volume,source=$dataVolume,target=/restored/data" --mount "type=volume,source=$assetVolume,target=/restored/uploads" $image node /tool.mjs restore /backup /restored/data /restored/uploads
    Write-Output "已恢复到独立卷：$dataVolume 和 $assetVolume；尚未切换运行服务。"
  }
}
