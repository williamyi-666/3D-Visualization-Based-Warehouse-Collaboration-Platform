#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
task_env="$task_root/.env.knowledge"
command -v docker >/dev/null 2>&1 || { echo '请先安装并启动 Docker。'; exit 1; }
if [ ! -f "$task_env" ]; then
  umask 077
  task_key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'SPATIAL_KNOWLEDGE_KEY=%s\nSPATIAL_KNOWLEDGE_ID=warehouse\nSPATIAL_KNOWLEDGE_BIND=127.0.0.1\nSPATIAL_KNOWLEDGE_PORT=38210\n' "$task_key" > "$task_env"
fi
if [ -f "$task_root/images/spatial-knowledge-20261021.1.tar.gz" ]; then
  docker load -i "$task_root/images/spatial-knowledge-20261021.1.tar.gz"
  docker compose --env-file "$task_env" -f "$task_root/docker/compose.knowledge.yml" up -d --no-build
else
  docker compose --env-file "$task_env" -f "$task_root/docker/compose.knowledge.yml" up -d --build
fi
echo '知识服务已启动。默认检索接口：http://127.0.0.1:38210/retrieval'
echo '密钥保存在包目录 .env.knowledge，仅在后台配置，勿提交到代码仓库。'
echo '资料接口 /documents 采用相同 Bearer 密钥；仓储本地模式可直接在页面中管理资料。'
