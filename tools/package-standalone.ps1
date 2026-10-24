param(
 [Parameter(Mandatory=$true)][string]$Version,
 [Parameter(Mandatory=$true)][string]$Image,
 [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
function Invoke-Docker { & docker @args; if($LASTEXITCODE -ne 0){throw "Docker操作失败：$($args[0])"} }
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $out){throw '输出目录已存在，请选择新目录'}
if(git -C $repo status --porcelain){throw '请在固定、干净的源码副本中打包'}
$revision=git -C $repo rev-parse HEAD
if($LASTEXITCODE -ne 0){throw '缺少固定源码提交'}
$imageInfo=(Invoke-Docker image inspect $Image | ConvertFrom-Json)[0]
if(($imageInfo.Os+'/'+$imageInfo.Architecture) -ne 'linux/amd64'){throw '当前包仅支持linux/amd64'}
$paths=git -C $repo ls-files -- apps packages package.json package-lock.json tools/collect-licenses.mjs tools/mock-inventory.mjs tools/supos-status.mjs tools/backup-data.mjs tools/uns-candidate-check.mjs tools/uns-recovery-check.mjs tools/uns-warehouse-check.mjs tools/uns-warehouse-live-check.mjs
$hashes=@{}
foreach($path in $paths){$hashes[$path]=(Get-FileHash -LiteralPath (Join-Path $repo $path) -Algorithm SHA256).Hash.ToLowerInvariant()}
$verify='const fs=require("fs"),crypto=require("crypto");const files=JSON.parse(fs.readFileSync(0,"utf8"));const bad=Object.entries(files).filter(([p,h])=>!fs.existsSync(p)||crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==h);if(bad.length){console.error("镜像与源码不一致："+bad.map(x=>x[0]).join(","));process.exit(1)}console.log("镜像源码一致："+Object.keys(files).length+"项");'
($hashes | ConvertTo-Json -Compress) | docker run --rm -i --network none $imageInfo.Id node -e $verify
if($LASTEXITCODE -ne 0){throw '拒绝交付：镜像源码不一致'}
New-Item -ItemType Directory -Path $out | Out-Null
foreach($folder in @('tools','docker','third-party','third-party/base')){New-Item -ItemType Directory -Path (Join-Path $out $folder) | Out-Null}
Copy-Item -LiteralPath (Join-Path $repo 'docker/compose.offline.yml') -Destination (Join-Path $out 'docker/compose.offline.yml')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-standalone.ps1') -Destination (Join-Path $out 'install.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-standalone.sh') -Destination (Join-Path $out 'install.sh')
foreach($name in @('manage-backup.ps1','backup-data.mjs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $out "tools/$name")}
# Windows自带PowerShell按BOM识别中文脚本，包内统一编码。
foreach($name in @('install.ps1','tools/manage-backup.ps1')){
 $file=Join-Path $out $name
 [IO.File]::WriteAllText($file,[IO.File]::ReadAllText($file),[Text.UTF8Encoding]::new($true))
}
$cid=Invoke-Docker create $imageInfo.Id
try {
 Invoke-Docker cp "${cid}:/app/third-party/." (Join-Path $out 'third-party')
 Invoke-Docker cp "${cid}:/usr/local/LICENSE" (Join-Path $out 'third-party/Node-LICENSE')
 Invoke-Docker cp "${cid}:/usr/share/common-licenses" (Join-Path $out 'third-party/common-licenses')
 Invoke-Docker cp "${cid}:/usr/share/doc" (Join-Path $out 'third-party/base/debian-doc')
} finally {Invoke-Docker rm $cid | Out-Null}
$packages=Invoke-Docker run --rm --network none $imageInfo.Id dpkg-query -W '-f=${Package}\t${Version}\t${Architecture}\n'
Set-Content -LiteralPath (Join-Path $out 'third-party/base/debian-packages.tsv') -Value $packages -Encoding utf8
Invoke-Docker save --output (Join-Path $out 'warehouse-image.tar') $imageInfo.Id
Set-Content -LiteralPath (Join-Path $out 'image.ref') -Value $imageInfo.Id -Encoding ascii
@'
# 独立仓储，不依赖open supOS；修改端口后重新运行安装入口。
SPATIAL_PROJECT_NAME=warehouse-offline
SPATIAL_BIND_ADDRESS=0.0.0.0
SPATIAL_PORT=38100
SPATIAL_INVENTORY_VOLUME=warehouse-offline_inventory
SPATIAL_ASSETS_VOLUME=warehouse-offline_assets
'@ | Set-Content -LiteralPath (Join-Path $out 'settings.example') -Encoding utf8NoBOM
@'
@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
'@ | Set-Content -LiteralPath (Join-Path $out '启动仓储.cmd') -Encoding ascii
@'
3D可视化仓储协同平台：独立部署离线版

无需open supOS、平台账号、云服务或互联网连接。
目标机须已安装Docker与Docker Compose v2；Windows Docker Desktop使用Linux容器模式。本包为linux/amd64。

Windows：启动Docker后双击“启动仓储.cmd”。
Linux：在包目录运行 sh install.sh。
只检查文件：Windows powershell -File install.ps1 -VerifyOnly；Linux sh install.sh --verify-only。

安装入口自动校验文件、导入固定镜像、创建配置、启动应用并等待健康检查。运行期间不会下载依赖。
电脑：http://localhost:38100/
手机：http://服务器局域网IP:38100/apps/web/prototype/mobile.html
首次从电脑端创建管理员（密码至少8位），再由管理员创建操作员/只读账号。电脑和手机使用同一套账号，可同时登录。
手机与服务器在同一局域网；如无法连接，请允许服务器防火墙的38100端口。无需在手机安装APP。

settings.env首次自动从settings.example创建；可修改端口、监听地址和独立数据卷名。
默认监听局域网；只在本机使用时将SPATIAL_BIND_ADDRESS改为127.0.0.1。
库存、账号及流水在inventory卷；上传模型在assets卷。包内不含原有账号密码或业务数据。
重复启动保留数据；跨镜像升级先自动成套备份。不要用docker compose down -v删除数据卷。
备份在包目录backups/upgrade-日期时间/data中，上层previous-image.txt记录原镜像。升级前保留旧包及settings.env；回退使用旧包和原卷。
需要恢复到新卷时使用tools/manage-backup.ps1；保留原卷直到核验数据和模型。

包含电脑3D、Blender模型、布局、货品查询、入出移库、盘点、库存流水、导入导出、手机3D作业与多端自动刷新。
离线指不需要互联网；多设备协同仍需连接同一台局域网服务器。断开服务器时不能提交库存作业。
手机HTTP访问可查询和手工办理作业；摄像头扫码/拍照需额外配置设备信任的HTTPS证书。
ERP仍是可选的接口集成，包内不包含具体企业接口或凭证；本版默认维护独立库存。

Linux安装不需要Node.js/PowerShell；Windows安装不需要Node.js。Docker本身需预先准备。
源码快照、镜像ID及文件哈希记录在release.json；包内保留第三方许可。
'@ | Set-Content -LiteralPath (Join-Path $out 'INSTALL.txt') -Encoding utf8
$files=@(Get-ChildItem -LiteralPath $out -File -Recurse | Sort-Object FullName | ForEach-Object {
 @{path=$_.FullName.Substring($out.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$_.Length}
})
@{format=1;edition='standalone';version=$Version;source_commit=$revision;source_files=$hashes;image_id=$imageInfo.Id;platform='linux/amd64';created_at=[DateTime]::UtcNow.ToString('o');scope='独立仓储离线包；不依赖open supOS；不包含业务数据、账号或凭证';files=$files} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $out 'release.json') -Encoding utf8
$checksum=@(Get-ChildItem -LiteralPath $out -File -Recurse | Sort-Object FullName | ForEach-Object {
 (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()+'  '+$_.FullName.Substring($out.Length+1).Replace('\','/')
})
$checksum | Set-Content -LiteralPath (Join-Path $out 'SHA256SUMS') -Encoding utf8NoBOM
Write-Output "独立离线包已生成：$out"
