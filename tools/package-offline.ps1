param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9][a-z0-9.-]{0,60}$')][string]$Version,
 [Parameter(Mandatory=$true)][string]$OutputDirectory,
 [string]$Container='opensupos-spatial'
)
$ErrorActionPreference='Stop'
function Invoke-Docker { & docker @args; if($LASTEXITCODE -ne 0){throw "Docker操作失败：$($args[0])"} }
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $out){throw '输出目录已存在，请选择新目录'}
$instance=(Invoke-Docker inspect $Container | ConvertFrom-Json)[0]
$image=(Invoke-Docker image inspect $instance.Image | ConvertFrom-Json)[0]
$revision=git -C $repo rev-parse HEAD
if($LASTEXITCODE -ne 0){throw '打包需要已提交的Git源码'}
$changes=git -C $repo status --porcelain
if($LASTEXITCODE -ne 0 -or $changes){throw '请先提交或整理工作区，再生成可追溯交付包'}
$sourcePaths=git -C $repo ls-files -- apps packages package.json package-lock.json tools/collect-licenses.mjs tools/mock-inventory.mjs tools/supos-status.mjs tools/backup-data.mjs tools/uns-candidate-check.mjs tools/uns-recovery-check.mjs tools/uns-warehouse-check.mjs tools/uns-warehouse-live-check.mjs
if($LASTEXITCODE -ne 0){throw '无法取得源码清单'}
$sourceHashes=@{}
foreach($path in $sourcePaths){$sourceHashes[$path]=(Get-FileHash -LiteralPath (Join-Path $repo $path) -Algorithm SHA256).Hash.ToLower()}
$verifySource='const fs=require("fs"),crypto=require("crypto");const files=JSON.parse(fs.readFileSync(0,"utf8"));const bad=Object.entries(files).filter(([p,h])=>!fs.existsSync(p)||crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")!==h);if(bad.length){console.error("镜像与源码不一致："+bad.map(x=>x[0]).join(","));process.exit(1)}console.log("镜像源码校验通过："+Object.keys(files).length+"项");'
($sourceHashes | ConvertTo-Json -Compress) | docker exec -i $Container node -e $verifySource
if($LASTEXITCODE -ne 0){throw '拒绝打包：请先用当前源码重建并启动应用容器'}
New-Item -ItemType Directory -Path $out | Out-Null
foreach($folder in @('tools','docker','docs','third-party','third-party/base')){New-Item -ItemType Directory -Path (Join-Path $out $folder) | Out-Null}
foreach($file in @('deploy-supos.ps1','register-supos-route.ps1','configure-supos-viewer.ps1','manage-backup.ps1','backup-data.mjs','send-inventory.mjs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination (Join-Path $out "tools/$file")}
Copy-Item -LiteralPath (Join-Path $repo 'docs/openapi.yaml') -Destination (Join-Path $out 'docs/openapi.yaml')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-offline.ps1') -Destination (Join-Path $out 'install.ps1')
$compose=Get-Content -LiteralPath (Join-Path $repo 'docker/compose.supos.yml') -Raw
$compose=$compose -replace '(?m)^    build:\r?\n      context: \.\.\r?\n      dockerfile: docker/Dockerfile.supos\r?\n',''
if($compose -match '(?m)^    build:'){throw '未成功移除构建配置'}
$compose=$compose.Replace('opensupos-spatial-warehouse:latest',"spatial-inventory:$Version")
Set-Content -Encoding utf8 -LiteralPath (Join-Path $out 'docker/compose.supos.yml') -Value $compose
$template=Get-Content -LiteralPath (Join-Path $repo 'docker/supos.settings.example') -Raw
Set-Content -Encoding utf8 -LiteralPath (Join-Path $out 'docker/supos.settings.example') -Value $template.Replace('opensupos-spatial-warehouse:latest',"spatial-inventory:$Version")
Invoke-Docker cp "${Container}:/app/third-party/." (Join-Path $out 'third-party')
Invoke-Docker cp "${Container}:/usr/local/LICENSE" (Join-Path $out 'third-party/base/Node-LICENSE')
Invoke-Docker cp "${Container}:/usr/share/doc" (Join-Path $out 'third-party/base/debian-doc')
Invoke-Docker cp "${Container}:/usr/share/common-licenses" (Join-Path $out 'third-party/base/common-licenses')
$packages=Invoke-Docker exec $Container dpkg-query -W '-f=${Package}\t${Version}\t${Architecture}\n'
Set-Content -Encoding utf8 -LiteralPath (Join-Path $out 'third-party/base/debian-packages.tsv') -Value $packages
Invoke-Docker tag $instance.Image "spatial-inventory:$Version"
Invoke-Docker save --output (Join-Path $out 'warehouse-image.tar') "spatial-inventory:$Version"
$instructions=@'
3D可视化仓储协同平台：离线试用安装

本包仅包含应用，目标机需已有Docker Compose及Open supOS，并能运行linux/amd64容器。
本机已验证平台后端1.0.11-T19、前端1.0.11-T16；其他版本需联调。
以下命令在包目录的PowerShell 7中执行（Windows/Linux均需已安装docker命令）；Linux使用pwsh启动：

1. 校验包：./install.ps1 -VerifyOnly
2. 复制配置：Copy-Item ./docker/supos.settings.example ./.env.supos
3. 编辑.env.supos：填写实际平台网络、平台访问来源、身份服务地址及独立数据卷名。
   不同实例须使用不同项目、容器和卷名；SPATIAL_MODE=integration由ERP/WMS提供库存，standalone由本应用记账。新独立库存请使用新卷，禁止直接切换已有集成库。
4. 检查配置：./tools/deploy-supos.ps1 -Action Check -SettingsFile ./.env.supos
5. 安装镜像：./install.ps1 -SettingsFile ./.env.supos
6. 在目标平台网络中注册网关（将命令中的容器名及Kong内部地址替换为实际值）：
   ./tools/register-supos-route.ps1 -RunnerContainer opensupos-spatial -WarehouseUrl http://opensupos-spatial:3000 -KongAdminUrl http://kong:8001
   第二实例须设置不同SPATIAL_BASE_PATH，并在上述命令传相同-BasePath（例如/warehouse-rc），以生成独立网关服务与路由。
7. 平台管理员创建Warehouse3D菜单，页面地址填写 /warehouse/apps/web/prototype/index.html。
   同步管理入口：/warehouse/apps/web/prototype/sync.html；宿主示例：/warehouse/apps/web/prototype/host-example.html。
8. 平台管理员先创建普通使用者账号，再在目标平台内部网络中分配仓储访问角色（替换实际用户名及容器/后端地址）：
   ./tools/configure-supos-viewer.ps1 -Action Check -Username warehouse_viewer_test -RunnerContainer opensupos-spatial -BackendUrl http://backend:8080
   ./tools/configure-supos-viewer.ps1 -Action Apply -Username warehouse_viewer_test -RunnerContainer opensupos-spatial -BackendUrl http://backend:8080
   自定义入口须同时传-BasePath和-MenuPath，例如-BasePath /warehouse-rc -MenuPath /Warehouse3DRc；工具创建独立角色，不修改旧实例角色。
   此步骤保留原有角色，追加“仓储只读访问”；不会创建账号或修改密码。用户重新登录后从Warehouse3D进入。
   内置“一般用户”不可修改且默认未授权仓储路径。普通身份进入应用后仍只读；同名自定义角色权限冲突时工具停止。

升级前停机成套备份：./tools/manage-backup.ps1 -Action Backup -Container opensupos-spatial -BackupPath ./warehouse-backups/upgrade-001
恢复到新卷：./tools/manage-backup.ps1 -Action Restore -Container opensupos-spatial -BackupPath ./warehouse-backups/upgrade-001 -TargetPrefix warehouse-restore-001
校验恢复后在配置中填写新卷名并设置SPATIAL_EXTERNAL_VOLUMES=true，再安装/启动。
回退使用保留的旧包和旧配置；不要删除旧卷，不使用down -v。自动备份位于数据卷内，不能替代异机备份。

安装过程不下载npm依赖，不包含平台、业务数据或正式商店上架批准。
外部ERP联调：docs/openapi.yaml描述同步契约。可在装有Node.js 22或更高版本的联调机执行：
node tools/send-inventory.mjs --file snapshot.json
默认只检查基本格式；实际发送须设置环境变量SPATIAL_SYNC_TOKEN，并追加--url 应用根地址 --send。
凭证由平台管理员在应用同步管理中创建并绑定来源。全量快照会替换该来源全部库存，空rows清空该来源；先使用隔离联调实例。
工具不包含具体ERP字段适配，也不自动重试或改版本；真实ERP接通须另行联调。
release.json记录源码提交、镜像ID与文件哈希；哈希用于完整性检查，不等同发布者数字签名。
'@
Set-Content -Encoding utf8 -LiteralPath (Join-Path $out 'INSTALL.txt') -Value $instructions
$files=@(Get-ChildItem -LiteralPath $out -File -Recurse | Sort-Object FullName | ForEach-Object {
 @{path=$_.FullName.Substring($out.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower();bytes=$_.Length}
})
$manifest=@{format=1;version=$Version;source_commit=$revision;source_files=$sourceHashes;image_id=$instance.Image;platform=($image.Os+'/'+$image.Architecture);created_at=[DateTime]::UtcNow.ToString('o');scope='应用离线试用包；目标机须已有Docker Compose和Open supOS；不包含平台、业务数据或正式上架批准';files=$files}
$manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -LiteralPath (Join-Path $out 'release.json')
Write-Output "交付包已生成：$out；文件数$($files.Count)"
