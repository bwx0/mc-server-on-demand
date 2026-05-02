#!/usr/bin/env bash
set -euo pipefail

IMAGE="crpi-krmhngvf3bx1meh2.cn-guangzhou.personal.cr.aliyuncs.com/hub-wx/myhub:latest"
DOCKERFILE="runtime/Dockerfile"
CONTEXT="runtime"

cd "$(dirname "$0")"

echo "Building image: ${IMAGE}"
docker build -f "${DOCKERFILE}" -t "${IMAGE}" "${CONTEXT}"

echo "Pushing image: ${IMAGE}"
docker push "${IMAGE}"

echo "Done: ${IMAGE}"
