#!/bin/sh
# 在包目录运行 sh install.sh；无需安装 Node.js 或 PowerShell。
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root"
sha256sum -c SHA256SUMS
if [ "${1:-}" = '--verify-only' ]; then exit 0; fi
docker compose version >/dev/null
test "$(docker info --format '{{.OSType}}')" = linux
test -f settings.env || cp settings.example settings.env
SPATIAL_IMAGE=$(cat image.ref)
export SPATIAL_IMAGE
docker load -i warehouse-image.tar
# 校验镜像架构后再执行部署，不访问镜像仓库。
test "$(docker image inspect "$SPATIAL_IMAGE" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
container=$(docker compose -f docker/compose.offline.yml --env-file settings.env config --format json | docker run --rm -i --network none "$SPATIAL_IMAGE" node -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>console.log(JSON.parse(s).services.warehouse.container_name));')
if docker inspect "$container" >/dev/null 2>&1; then
 old_image=$(docker inspect "$container" --format '{{.Image}}')
 if [ "$old_image" != "$SPATIAL_IMAGE" ]; then
  backup="$root/backups/upgrade-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  inventory=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
  assets=$(docker inspect "$container" --format '{{range .Mounts}}{{if eq .Destination "/uploads"}}{{.Name}}{{end}}{{end}}')
  test -n "$inventory" && test -n "$assets" && test "$inventory" != "$assets"
  was_running=$(docker inspect "$container" --format '{{.State.Running}}')
  if [ "$was_running" = true ]; then docker stop "$container" >/dev/null; fi
  trap 'if [ "$was_running" = true ]; then docker start "$container" >/dev/null; fi' EXIT HUP INT TERM
  docker run --rm --network none --mount "type=bind,source=$root/tools/backup-data.mjs,target=/tool.mjs,readonly" --mount "type=volume,source=$inventory,target=/source" --mount "type=volume,source=$assets,target=/assets,readonly" --mount "type=bind,source=$backup,target=/backups" "$old_image" node /tool.mjs backup /backups/data
  printf '%s\n' "$old_image" > "$backup/previous-image.txt"
  cp settings.env "$backup/settings.env"
  if [ "$was_running" = true ]; then docker start "$container" >/dev/null; fi
  trap - EXIT HUP INT TERM
  printf '升级备份：%s\n' "$backup"
 fi
fi
docker compose -f docker/compose.offline.yml --env-file settings.env up -d --pull never --wait --wait-timeout 90
port=$(docker compose -f docker/compose.offline.yml --env-file settings.env config --format json | docker run --rm -i --network none "$SPATIAL_IMAGE" node -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>console.log(JSON.parse(s).services.warehouse.ports[0].published));')
printf '电脑端：http://localhost:%s/\n手机端：http://服务器局域网IP:%s/apps/web/prototype/mobile.html\n首次请从电脑端创建管理员。\n' "$port" "$port"
