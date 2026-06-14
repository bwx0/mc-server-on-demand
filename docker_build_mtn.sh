#!/usr/bin/env bash
set -euo pipefail

# Maintenance/recovery image (SSH + Python + nginx). Used by the admin-only
# "恢复镜像（维护）" option. Set this tag as MAINTENANCE_IMAGE in your .env.
IMAGE="crpi-krmhngvf3bx1meh2.cn-guangzhou.personal.cr.aliyuncs.com/hub-wx/myhub:mtn"
DOCKERFILE="maintenance/Dockerfile"
CONTEXT="maintenance"

cd "$(dirname "$0")"

echo "Building image: ${IMAGE}"
docker build -f "${DOCKERFILE}" -t "${IMAGE}" "${CONTEXT}"

echo "Pushing image: ${IMAGE}"
docker push "${IMAGE}"

echo "Done: ${IMAGE}"
