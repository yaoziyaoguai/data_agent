#!/bin/sh
set -eu

uid="$(id -u milvus)"
gid="$(id -g milvus)"
marker="/var/lib/milvus/.milvus-volume-owner-${uid}-${gid}"
if [ ! -e "$marker" ]; then
  chown -R "$uid:$gid" /var/lib/milvus
  touch "$marker"
  chown "$uid:$gid" "$marker"
fi

# 文件型 secret 仍受宿主 0600 权限约束；仅初始化容器读取后交给正式用户。
cp -R /milvus/configs/. /prepared-config/
cp /run/secrets/milvus_config /prepared-config/user.yaml
chmod 600 /prepared-config/user.yaml
chown -R "$uid:$gid" /prepared-config
