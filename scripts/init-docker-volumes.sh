#!/bin/sh
# 初始化 Docker named volumes 权限，确保 builder 用户（UID 1000）可写
# 首次构建或重建 volume 后运行一次即可

set -e

echo "=== 初始化 Docker 构建 Volume 权限 ==="
echo ""

# Windows 构建 volume
WIN_VOLUMES="baize-win-node-modules baize-npm-cache baize-npm-prebuilds baize-electron-cache baize-builder-cache"

# macOS 构建 volume
MAC_VOLUMES="zhinengti-mac-node-modules zhinengti-npm-cache zhinengti-npm-prebuilds zhinengti-electron-cache zhinengti-builder-cache"

for vol in $WIN_VOLUMES $MAC_VOLUMES; do
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    echo "修复: $vol"
    docker run --rm -v "$vol":/data alpine chown -R 1000:1000 /data
  else
    echo "跳过（不存在）: $vol"
  fi
done

echo ""
echo "=== 初始化完成 ==="
echo "所有 volume 已设置为 UID 1000:1000 权限"