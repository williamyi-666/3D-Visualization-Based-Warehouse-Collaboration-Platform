#!/bin/sh
# 用法：sh build.sh /path/to/extracted-source
# 仅构建评审镜像，不启动服务、不挂载业务数据、不替换候选实例。
set -eu
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=$(CDPATH= cd -- "${1:?请传入解压后的源码目录}" && pwd)
test -f "$source_dir/docker/Dockerfile.supos"
test -f "$source_dir/apps/api/package-lock.json"
(cd "$bundle" && sha256sum -c SHA256SUMS)
docker load -i "$bundle/node24-fixed-base.tar"
expected=sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
actual=$(docker image inspect node:24-bookworm-slim --format '{{.Id}}')
test "$actual" = "$expected"
context=$(mktemp -d /tmp/warehouse-review-build.XXXXXX)
trap 'rm -rf -- "$context"' EXIT HUP INT TERM
# 在临时副本注入内容缓存，不改变评审源码与原始Dockerfile。
(cd "$source_dir" && tar --exclude=.git --exclude=node_modules --exclude=releases --exclude=tools/out --exclude=.offline-npm-cache -cf - .) | (cd "$context" && tar -xf -)
tar -xzf "$bundle/rc14-offline-build-inputs.tar.gz" -C "$context"
review_image=${REVIEW_IMAGE:-spatial-inventory:review-rebuild}
docker build --network=none --pull=false -f "$context/Dockerfile.offline-check" -t "$review_image" "$context"
docker image inspect "$review_image" --format '{{.Id}}'
