#!/bin/bash
#
# 今点通 .deb 卸载后脚本（postrm），在 electron-builder 默认模板基础上增加：
# 清理 postinst 写入的 kernel.unprivileged_userns_clone 持久化配置，避免卸载后
# 在客户机上残留全局内核参数改动。
#
# 说明：只删除我们自己的 /etc/sysctl.d/99-zhinengti-userns.conf，不回写 0
# （避免覆盖管理员/其他软件的其他配置）。临时值在重启后恢复系统默认。
#
# !! 同样受 electron-builder 宏替换约束：除 ${executable} 外，变量请用 $VAR 形式。

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# 清理安装时写入的非特权 user namespace 配置
USERSNS_CONF='/etc/sysctl.d/99-zhinengti-userns.conf'
if [ -f "$USERSNS_CONF" ]; then
  rm -f "$USERSNS_CONF"
  echo "[今点通 postrm] 已移除 $USERSNS_CONF（重启后 kernel.unprivileged_userns_clone 恢复系统默认值）"
fi

exit 0
