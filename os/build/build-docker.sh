#!/usr/bin/env bash
# ============================================================
# 在 Docker 中构建 MinerOS（无需本机装 Debian 环境）
# 用法: ./build-docker.sh
# 需要：Docker Desktop / Docker Engine（Linux 容器）
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$HERE/../.." && pwd)"
IMAGE="mineros-builder:1.0"

docker info >/dev/null 2>&1 || { echo "Docker 未运行"; exit 1; }

echo "== 构建构建器镜像 =="
docker build -q -t "$IMAGE" -f - "$PROJECT_DIR" <<'DOCKERFILE'
FROM debian:12
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      live-build debootstrap xorriso mtools dosfstools squashfs-tools \
      syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin \
      rsync curl wget gnupg xz-utils zstd parted ca-certificates \
      python3 sudo && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /work
DOCKERFILE

echo "== 运行构建 =="
docker run --rm --privileged \
  -v "$PROJECT_DIR":/work \
  -w /work \
  "$IMAGE" \
  bash os/build/build.sh "$@"

echo ""
echo "产物在 os/dist/ 目录"
