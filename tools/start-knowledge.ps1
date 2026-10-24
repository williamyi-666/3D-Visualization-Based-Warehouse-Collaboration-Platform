$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskEnvPath = Join-Path $taskRoot '.env.knowledge'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw '请先安装并启动 Docker Desktop。' }
if (-not (Test-Path -LiteralPath $taskEnvPath)) {
  $taskBytes = New-Object byte[] 32
  $taskRandom = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $taskRandom.GetBytes($taskBytes)
  $taskRandom.Dispose()
  $taskKey = [Convert]::ToBase64String($taskBytes)
  [System.IO.File]::WriteAllText($taskEnvPath, "SPATIAL_KNOWLEDGE_KEY=$taskKey`nSPATIAL_KNOWLEDGE_ID=warehouse`nSPATIAL_KNOWLEDGE_BIND=127.0.0.1`nSPATIAL_KNOWLEDGE_PORT=38210`n", (New-Object System.Text.UTF8Encoding $false))
}
$taskImage = Join-Path $taskRoot 'images/spatial-knowledge-20261021.1.tar.gz'
if (Test-Path -LiteralPath $taskImage) {
  & docker load -i $taskImage
  if ($LASTEXITCODE -ne 0) { throw '知识服务镜像加载失败。' }
  & docker compose --env-file $taskEnvPath -f (Join-Path $taskRoot 'docker/compose.knowledge.yml') up -d --no-build
} else {
  & docker compose --env-file $taskEnvPath -f (Join-Path $taskRoot 'docker/compose.knowledge.yml') up -d --build
}
if ($LASTEXITCODE -ne 0) { throw '知识服务启动失败，请检查 Docker 提示。' }
Write-Output '知识服务已启动。默认检索接口：http://127.0.0.1:38210/retrieval'
Write-Output '密钥保存在包目录 .env.knowledge，仅在后台配置，勿提交到代码仓库。'
Write-Output '资料管理接口为 /documents，使用相同 Bearer 密钥；正常仓储本地模式可直接在页面中管理资料。'
