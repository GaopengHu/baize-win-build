#!/bin/bash
#
# 今点通 .deb 安装后脚本（postinst），覆盖 electron-builder 的默认模板。
# 本脚本做三件事：
#   1. 保留默认模板的全部行为（update-alternatives / mime / desktop database /
#      AppArmor profile）
#   2. 若 kernel.unprivileged_userns_clone 为 0 → 改为 1（立即生效，并持久化到
#      /etc/sysctl.d/99-zhinengti-userns.conf；卸载时由 deb-after-remove.sh 清理）
#   3. 用「非 root 身份实测」重新判断 userns 是否真的可用，据此决定 chrome-sandbox
#      是否必须为 setuid(4755)：这是本次故障的真正根因修复

APP_EXEC="/opt/${sanitizedProductName}/${executable}"
SANDBOX_BIN="/opt/${sanitizedProductName}/chrome-sandbox"
APPARMOR_SRC="/opt/${sanitizedProductName}/resources/apparmor-profile"
USERSNS_LINK="/usr/bin/${executable}"

USERSNS_SYSCTL="/proc/sys/kernel/unprivileged_userns_clone"
MAX_USERNS_SYSCTL="/proc/sys/user/max_user_namespaces"
USERSNS_CONF="/etc/sysctl.d/99-zhinengti-userns.conf"

log() { echo "[今点通 postinst] $*"; }
warn() { echo "[今点通 postinst] 警告: $*" >&2; }

# 普通用户能否创建 user namespace。
# 必须以非 root 身份实测：root 有 CAP_SYS_ADMIN，测不出 sysctl=0 的机器（这正是
# 默认模板判断失效的原因）。
userns_available_for_users() {
  # (1) Debian/Ubuntu/UOS 补丁项：0 = 禁止非特权用户创建 user namespace
  if [ -r "$USERSNS_SYSCTL" ]; then
    [ "$(cat "$USERSNS_SYSCTL" 2>/dev/null)" = "1" ] || return 1
  fi
  # (2) 新内核的可调上限：0 = 全局禁用
  if [ -r "$MAX_USERNS_SYSCTL" ]; then
    [ "$(cat "$MAX_USERNS_SYSCTL" 2>/dev/null)" != "0" ] || return 1
  fi
  # (3) 降权到 nobody(65534) 再 unshare 实测。setpriv 通过 setresuid 切换 uid，
  #     capability 会被内核清空，等价于普通用户的真实场景。
  #     必须先用 `setpriv ... true` 自校验降权是否真的可用：setpriv 在非 root 环境
  #     下 setresuid 会失败并返回 127，若直接采信会把「工具不可用」误判成
  #     「userns 不可用」，从而在健康机器上多做一次无谓的 setuid 设置。
  if command -v setpriv >/dev/null 2>&1 && command -v unshare >/dev/null 2>&1 \
    && setpriv --reuid=65534 --regid=65534 --clear-groups true >/dev/null 2>&1; then
    setpriv --reuid=65534 --regid=65534 --clear-groups unshare --user true >/dev/null 2>&1
    return $?
  fi
  # (4) 退路：降权工具不可用（chroot、非 root 等）→ 以内核状态为准
  [ -L /proc/self/ns/user ]
}

# 按需把 kernel.unprivileged_userns_clone 由 0 改为 1。
# 成功返回 0；写不进去（安全策略锁定等）返回 1，由 SUID 沙箱兜底。
enable_unprivileged_userns() {
  if [ ! -e "$USERSNS_SYSCTL" ]; then
    log "内核未提供 kernel.unprivileged_userns_clone 开关（非 Debian 系补丁），跳过"
    return 0
  fi
  if [ "$(cat "$USERSNS_SYSCTL" 2>/dev/null)" != "0" ]; then
    return 0
  fi

  log "检测到 kernel.unprivileged_userns_clone=0，正在启用（Chromium 沙箱需要）"

  # 立即生效，不需要重启
  if sysctl -w kernel.unprivileged_userns_clone=1 >/dev/null 2>&1 \
    || echo 1 >"$USERSNS_SYSCTL" 2>/dev/null; then
    log "kernel.unprivileged_userns_clone 已临时置为 1"
  else
    warn "无法写入 $USERSNS_SYSCTL（可能被安全策略锁定），将改用 SUID 沙箱兜底"
    return 1
  fi

  # 持久化：独立配置文件，避免污染 /etc/sysctl.conf；前缀 99 保证在多数加固配置
  # 之后加载（同前缀时按文件名字典序，z 会覆盖掉 h/s 之类）。回滚 = 删除该文件。
  if [ -d /etc/sysctl.d ]; then
    if printf 'kernel.unprivileged_userns_clone=1\n' >"$USERSNS_CONF" 2>/dev/null; then
      log "已写入 $USERSNS_CONF（卸载时会自动清理）"
    else
      warn "无法写入 $USERSNS_CONF：本次开机有效，重启后失效"
    fi
  else
    warn "/etc/sysctl.d 不存在：本次开机有效，重启后失效"
  fi
  return 0
}

# 按最终可用的沙箱方式设置 chrome-sandbox 权限
configure_chrome_sandbox() {
  if [ ! -e "$SANDBOX_BIN" ]; then
    warn "未找到 $SANDBOX_BIN，跳过沙箱权限设置"
    return 0
  fi

  if userns_available_for_users; then
    chmod 0755 "$SANDBOX_BIN" 2>/dev/null || true
    log "非特权 user namespace 可用 → chrome-sandbox 保持 0755（namespace 沙箱）"
    return 0
  fi

  # userns 不可用 → 必须走 SUID 沙箱
  chown root:root "$SANDBOX_BIN" 2>/dev/null || true
  chmod 4755 "$SANDBOX_BIN" 2>/dev/null || true
  if [ -u "$SANDBOX_BIN" ]; then
    log "非特权 user namespace 不可用 → chrome-sandbox 已设为 $(stat -c '%a %U:%G' "$SANDBOX_BIN" 2>/dev/null)（SUID 沙箱）"
  else
    warn "chrome-sandbox 无法设为 setuid，应用可能仍无法启动；请在启动命令追加 --no-sandbox"
  fi

  # 最后一个坑：文件系统以 nosuid 挂载时 setuid 位会被忽略
  if command -v findmnt >/dev/null 2>&1; then
    if findmnt -no OPTIONS --target "$SANDBOX_BIN" 2>/dev/null | grep -q nosuid; then
      warn "所在文件系统以 nosuid 挂载，SUID 沙箱会被忽略；请在启动命令追加 --no-sandbox"
    fi
  fi
  return 0
}

main() {
  # --- 1. 保留默认模板行为：注册 /usr/bin/${executable} ---
  if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L "$USERSNS_LINK" -a -e "$USERSNS_LINK" -a "`readlink "$USERSNS_LINK"`" != "/etc/alternatives/${executable}" ]; then
      rm -f "$USERSNS_LINK"
    fi
    update-alternatives --install "$USERSNS_LINK" '${executable}' "$APP_EXEC" 100 || ln -sf "$APP_EXEC" "$USERSNS_LINK"
  else
    ln -sf "$APP_EXEC" "$USERSNS_LINK"
  fi

  # --- 2. Chromium 沙箱修复（UOS/Debian 默认 kernel.unprivileged_userns_clone=0）---
  enable_unprivileged_userns || true
  configure_chrome_sandbox || true

  # --- 3. 保留默认模板行为：mime / desktop database / AppArmor ---
  if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
  fi

  if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
  fi

  # Install apparmor profile. (Ubuntu 24+)
  # 只有当设备上的 AppArmor 支持随包 profile 时才安装（保持对不支持 abi/4.0 的
  # 旧版本的兼容，那些系统不装 profile 也能正常运行）。
  if apparmor_status --enabled >/dev/null 2>&1; then
    APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
    if apparmor_parser --skip-kernel-load --debug "$APPARMOR_SRC" >/dev/null 2>&1; then
      cp -f "$APPARMOR_SRC" "$APPARMOR_PROFILE_TARGET"

      # 在 chroot 环境里更新当前 profile 没有意义
      if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
        # Extra flags taken from dh_apparmor:
        # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
        # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
        apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
      fi
    else
      echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
    fi
  fi
}

# ZHINENGTI_POSTINST_LIB_ONLY=1 时只加载函数定义（便于本地自测），不执行安装动作。
if [ "${ZHINENGTI_POSTINST_LIB_ONLY:-0}" = "1" ]; then
  :
else
  main
  exit 0
fi
