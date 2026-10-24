param(
  [ValidateSet('Sync','Install','Status')][string]$Action='Sync',
  [Parameter(Mandatory=$true)][string]$ConfigFile
)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigFile -Raw -Encoding utf8 | ConvertFrom-Json
$root=[IO.Path]::GetFullPath($config.destination).TrimEnd('\')
if($root.Length -lt 12 -or $root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')){throw '请使用独立的备份子目录'}
$statusFile=Join-Path $root 'backup-status.json'
if($Action -eq 'Status'){if(Test-Path -LiteralPath $statusFile){Get-Content -LiteralPath $statusFile -Raw};return}
New-Item -ItemType Directory -Force -Path $root | Out-Null
if($Action -eq 'Install'){
  # 备份包含账号及业务数据，只允许管理员、SYSTEM 和当前用户访问。
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)F" | Out-Null
  if($LASTEXITCODE -ne 0){throw '备份目录权限设置失败'}
  $installedScript=Join-Path $root 'backup-to-host.ps1'
  [IO.File]::WriteAllText($installedScript,[IO.File]::ReadAllText($PSCommandPath),[Text.UTF8Encoding]::new($true))
  $installedConfig=Join-Path $root 'settings.json'
  [IO.File]::WriteAllText($installedConfig,($config | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $exe=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $taskAction=New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$installedScript+'" -ConfigFile "'+$installedConfig+'"')
  $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(30) -RepetitionInterval (New-TimeSpan -Minutes 30)
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  # 使用现有SSH密钥所属账号，S4U无需保存Windows密码，注销后也能执行。
  $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
  Register-ScheduledTask -TaskName $config.taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description '复制仓储成套备份到独立主机磁盘，校验通过后保留最近28份。' -Force | Out-Null
  Write-Output "已安装自动备份任务：$($config.taskName)"
  return
}

$lock=New-Object Threading.Mutex($false,'Global\SpatialInventoryHostBackup')
if(!$lock.WaitOne(0)){$lock.Dispose();throw '另一个备份任务正在运行'}
$state=@{last_success_at=$null;last_checked_at=$null;last_result='none';error=$null}
if(Test-Path -LiteralPath $statusFile){$previous=Get-Content -LiteralPath $statusFile -Raw -Encoding utf8 | ConvertFrom-Json;foreach($property in $previous.PSObject.Properties){$state[$property.Name]=$property.Value}}
function Save-State {
  $temporary=$statusFile+'.tmp'
  [IO.File]::WriteAllText($temporary,($state | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $statusFile -Force
}
function Verify-Bundle([string]$bundleRoot){
  $manifest=Get-Content -LiteralPath (Join-Path $bundleRoot 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
  if($manifest.format -ne 1 -or !$manifest.files.'spatial.db'){throw '备份清单不完整'}
  $properties=@($manifest.files.PSObject.Properties)
  $files=@(Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | Where-Object Name -ne 'manifest.json')
  if($files.Count -ne $properties.Count){throw '备份文件数量不一致'}
  foreach($property in $properties){
    $path=[IO.Path]::GetFullPath((Join-Path $bundleRoot $property.Name))
    if(!$path.StartsWith($bundleRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw '备份清单路径越界'}
    if(!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $property.Value){throw "备份校验失败：$($property.Name)"}
  }
  return $manifest
}
try {
  $address=@(Get-VMNetworkAdapter -VMName $config.vmName | Select-Object -ExpandProperty IPAddresses | Where-Object {$_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notmatch '^(127|169\.254)\.'})[0]
  if(!$address){throw '仓储虚拟机未运行或尚未取得地址'}
  # 用独立SSH配置保存带空格的路径，兼容计划任务使用的Windows PowerShell 5。
  $sshConfig=Join-Path $root 'ssh_config'
  $sshLines=@('Host *','  BatchMode yes','  ConnectTimeout 10','  StrictHostKeyChecking yes',('  HostKeyAlias '+$config.hostKeyAlias),('  UserKnownHostsFile "'+$config.knownHosts.Replace('\','/')+'"'),('  IdentityFile "'+$config.keyFile.Replace('\','/')+'"'))
  [IO.File]::WriteAllLines($sshConfig,$sshLines,[Text.UTF8Encoding]::new($false))
  $sshOptions=@('-F',$sshConfig)
  $target=$config.user+'@'+$address
  $container=$config.container;$remoteRoot=$config.remoteExportDirectory
  if($container -notmatch '^[a-zA-Z0-9_.-]+$' -or $remoteRoot -notmatch '^/home/[a-zA-Z0-9_./-]+$'){throw '备份导出配置无效'}
  function Remote([string]$script){
    $errorFile=Join-Path $root 'ssh-error.log'
    $previousPreference=$ErrorActionPreference
    try{$ErrorActionPreference='Continue';$result=$script | & ssh.exe @sshOptions $target "tr -d '\r' | bash" 2> $errorFile;$code=$LASTEXITCODE}finally{$ErrorActionPreference=$previousPreference}
    if($code -ne 0){throw ('虚拟机备份命令失败：'+([IO.File]::ReadAllText($errorFile)).Trim())}
    return $result
  }
  # 只读取已完成、校验通过的快照；不从正在写入的数据库直接拷贝。
  $meta=Remote @"
set -euo pipefail
docker exec -e NODE_NO_WARNINGS=1 $container node --input-type=module -e 'import fs from "node:fs";import {verifyBackup} from "/app/tools/backup-data.mjs";const state=JSON.parse(fs.readFileSync("/data/backup-status.json","utf8"));if(!/^bundle-[0-9TZ.a-f-]+$/.test(state.bundle||""))throw Error("没有可导出的成功备份");verifyBackup("/data/backup/"+state.bundle);console.log(JSON.stringify({bundle:state.bundle}));'
docker inspect $container --format '{{.Image}}'
"@
  $bundle=($meta[0] | ConvertFrom-Json).bundle;$imageId=$meta[1]
  if($bundle -notmatch '^bundle-[0-9TZ.a-f-]+$' -or $imageId -notmatch '^sha256:[a-f0-9]{64}$'){throw '备份来源返回无效标识'}
  $destination=Join-Path $root $bundle;$images=Join-Path $root 'images';New-Item -ItemType Directory -Force -Path $images | Out-Null
  $imageName='image-'+$imageId.Substring(7)+'.tar.gz';$imagePath=Join-Path $images $imageName
  $copyBundle=!(Test-Path -LiteralPath $destination);$copyImage=!(Test-Path -LiteralPath ($imagePath+'.sha256'))
  if(!$copyBundle){$null=Verify-Bundle $destination}
  if(!$copyImage){$expected=(Get-Content -LiteralPath ($imagePath+'.sha256') -Raw).Trim();if(!(Test-Path -LiteralPath $imagePath) -or (Get-FileHash -LiteralPath $imagePath -Algorithm SHA256).Hash -ne $expected){throw '主机运行镜像校验失败'}}
  $remote=Remote @"
set -euo pipefail
umask 077
mkdir -p '$remoteRoot'
docker inspect $container > '$remoteRoot/$bundle.container.json'
if [ '$copyBundle' = 'True' ]; then
 docker exec $container tar -C /data/backup -czf - '$bundle' > '$remoteRoot/$bundle.tar.gz.tmp'
 mv '$remoteRoot/$bundle.tar.gz.tmp' '$remoteRoot/$bundle.tar.gz'
fi
if [ '$copyImage' = 'True' ]; then
 docker save '$imageId' | gzip -1 > '$remoteRoot/$imageName.tmp'
 mv '$remoteRoot/$imageName.tmp' '$remoteRoot/$imageName'
 sha256sum '$remoteRoot/$imageName' | cut -d' ' -f1
fi
"@
  if($copyImage){
    & scp.exe @sshOptions ($target+':'+$remoteRoot+'/'+$imageName) ($imagePath+'.partial');if($LASTEXITCODE -ne 0){throw '运行镜像复制失败'}
    $expected=(@($remote)[-1]).Trim()
    if($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath ($imagePath+'.partial') -Algorithm SHA256).Hash -ne $expected){throw '运行镜像传输校验失败'}
    Move-Item -LiteralPath ($imagePath+'.partial') -Destination $imagePath -Force
    [IO.File]::WriteAllText(($imagePath+'.sha256'),$expected,[Text.UTF8Encoding]::new($false))
  }
  if($copyBundle){
    $incoming=Join-Path $root ('.incoming-'+[guid]::NewGuid().ToString());New-Item -ItemType Directory -Path $incoming | Out-Null
    $archive=Join-Path $incoming 'bundle.tar.gz'
    & scp.exe @sshOptions ($target+':'+$remoteRoot+'/'+$bundle+'.tar.gz') $archive;if($LASTEXITCODE -ne 0){throw '成套备份复制失败'}
    $entries=& tar.exe -tzf $archive;if($LASTEXITCODE -ne 0){throw '备份压缩文件损坏'}
    foreach($entry in $entries){if($entry -notlike ($bundle+'/*') -and $entry -ne $bundle){throw '备份归档根目录无效'};if($entry -match '(^|/)\.\.(/|$)'){throw '备份归档路径越界'}}
    & tar.exe -xzf $archive -C $incoming;if($LASTEXITCODE -ne 0){throw '备份解压失败'}
    $unpacked=Join-Path $incoming $bundle;$null=Verify-Bundle $unpacked
    Move-Item -LiteralPath $unpacked -Destination $destination
    # 只清理本次在指定备份根目录内生成的临时目录。
    $resolved=[IO.Path]::GetFullPath($incoming)
    if(!$resolved.StartsWith($root+'\.incoming-',[StringComparison]::OrdinalIgnoreCase)){throw '临时目录越界'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
  # 配置可能包含集成凭证，只写入受限备份目录，不回显到日志或源码目录。
  $containerFile=Join-Path $root ($bundle+'.container.json')
  & scp.exe @sshOptions ($target+':'+$remoteRoot+'/'+$bundle+'.container.json') ($containerFile+'.partial');if($LASTEXITCODE -ne 0){throw '部署配置复制失败'}
  $containerInfo=Get-Content -LiteralPath ($containerFile+'.partial') -Raw -Encoding utf8 | ConvertFrom-Json
  if(@($containerInfo)[0].Image -ne $imageId){throw '备份期间部署镜像发生变化，请重试'}
  Move-Item -LiteralPath ($containerFile+'.partial') -Destination $containerFile -Force
  # 部署信息放在快照目录之外，不改变原始成套备份的文件清单。
  [IO.File]::WriteAllText((Join-Path $root ($bundle+'.deployment.json')),(@{image_id=$imageId;image_archive=('images/'+$imageName);container=$container;container_config=($bundle+'.container.json')} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  $bundles=@(Get-ChildItem -LiteralPath $root -Directory | Where-Object {$_.Name -match '^bundle-[0-9TZ.a-f-]+$'} | Sort-Object Name -Descending)
  foreach($old in @($bundles | Select-Object -Skip $config.keep)){
    $null=Verify-Bundle $old.FullName
    $resolved=[IO.Path]::GetFullPath($old.FullName)
    if(!$resolved.StartsWith($root+'\bundle-',[StringComparison]::OrdinalIgnoreCase)){throw '备份清理路径越界'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $root ($old.Name+'.deployment.json')) -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $root ($old.Name+'.container.json')) -ErrorAction SilentlyContinue
  }
  $null=Remote "set -eu; rm -f -- '$remoteRoot/$bundle.tar.gz' '$remoteRoot/$imageName' '$remoteRoot/$bundle.container.json'"
  $state.last_success_at=[DateTime]::UtcNow.ToString('o');$state.last_checked_at=$state.last_success_at;$state.last_result='success';$state.error=$null;$state.bundle=$bundle;$state.image_id=$imageId;$state.new_copy=$copyBundle;Save-State
  Write-Output "主机备份校验通过：$destination"
} catch {
  $state.last_checked_at=[DateTime]::UtcNow.ToString('o');$state.last_result='failed';$state.error=$_.Exception.Message;Save-State
  throw
} finally {$lock.ReleaseMutex();$lock.Dispose()}
