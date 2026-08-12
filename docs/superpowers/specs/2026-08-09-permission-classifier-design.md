# 权限确认优化设计（2026-08-09）

## 背景与目标

当前应用对 `write` / `edit` / `bash` 工具的每次调用都会请求人工确认，导致频繁打断用户。目标：

1. 工作目录内（含子目录）的**普通**文件读写与命令执行**免确认**
2. 仅以下情况需要人工确认：
   - **高级权限**：sudo/提权、安装软件、系统级目录写入、危险命令
   - **删除**：目录内外一律确认
   - **工作目录之外**的文件操作
3. 弹窗新增「允许本会话全部操作」选项（仅覆盖目录外与普通 ask，**不豁免高级权限**）
4. 信任状态**仅当前会话生效**

## 决策记录（用户确认）

| 决策项 | 结论 |
|--------|------|
| 高级权限范围 | sudo + 安装 + 删除一律 + 危险命令 |
| 目录外边界 | 绝对按工作目录边界（含子目录） |
| 信任记忆 | 仅当前会话生效 |
| 弹窗选项 | 新增「允许本会话全部操作」按钮（排除高级权限）|
| 目录内删除 | 删除一律确认（即使目录内）|
| 平台 | 兼顾 Linux / macOS / Windows 命令 |
| 弹窗组件 | 复用现有 PermissionDialog，不新建组件 |

## 总体决策流程

```
工具调用 (bash/read/write/edit/glob/grep/...)
    │
    ▼
┌─────────────────────────┐
│  permission-classifier  │   新增模块
│  1. advanced? delete?   │   ──→ 直接弹窗（忽略会话 allow-all flag）
│  2. outside?（目录外）    │   ──→ 弹窗（除非 flag=true）
│  3. else normal          │   ──→ 应用规则判定
└─────────────────────────┘
    │
    ▼
┌─────────────────────────┐
│  规则判定 (decidePermission) │   现有逻辑保留
│  deny → 拒绝               │
│  allow → 放行               │
└─────────────────────────┘
```

三类必须弹窗的路径：

1. 危险 / 删除（**不**受「允许本会话全部操作」豁免）
2. 工作目录外文件
3. 规则显式配置为 `ask` / `deny`

## 模块设计

### 1. `src/main/utils/permission-classifier.ts`（新增）

- 输入：`(cwd: string | null, toolName: string, input: Record<string, unknown>)`
- 输出：`{ kind: 'advanced'|'delete'|'outside'|'normal', reason?: string }`
- 优先级：`advanced > delete > outside > normal`
- 平台判定：`process.platform`（`linux` / `darwin` / `win32`），但预置全平台表以便测试跨平台

#### 检测规则表

**① advanced（危险命令，命令级）**

| 类别 | Linux(UOS) | macOS | Windows |
|------|-----------|-------|---------|
| 提权 | `sudo`、`su -` | `sudo`、`sudo -s` | `runas`、`runas /user:Administrator`、`gsudo`、PowerShell `Start-Process -Verb RunAs` |
| 安装 | `apt install`、`apt-get install`、`yum install`、`dnf install`、`pip/pip3 install`、`npm install`、`gem install`、`cargo install` | `brew install`、`pip/pip3 install`、`npm install`、`gem install` | `winget install`、`choco install`、`scoop install`、`pip install`、`npm install -g`、PowerShell `Install-Package`、`msiexec /i`、`setup.exe` |
| 系统目录 | `/etc/`、`/usr/`、`/var/`、`/boot/`、`/sbin/` | `/etc/`、`/usr/`、`/var/`、`/System/`、`/Applications/` | `C:\Windows\`、`C:\Program Files\`、`C:\ProgramData\`、`HKLM\`（注册表写入）|
| 危险命令 | `mkfs`、`fdisk`、`dd if=`、`shutdown`、`reboot`、`chmod -R`、`chown -R`、`curl 管道 sh`、`wget 管道 sh` | 同左 + `diskutil eraseDisk`、`osascript`（System Events 自动化）| `format`、`diskpart`、`shutdown /s`、`reg delete`、`taskkill /f /im`、PowerShell `Remove-Item -Recurse -Force`、`Stop-Process -Force`、`Invoke-Expression`(IEX)、`curl 管道 sh` |

> 注意：以上为完整检测表，无占位符残留。

**② 删除（永远弹窗）**

| Linux/macOS | Windows (cmd) | Windows (PowerShell) |
|-------------|---------------|----------------------|
| `rm`、`rmdir`、`rm -rf`、`rm -r`、`unlink`、`trash`、`find ... -delete` | `del`、`del /s`、`rmdir`、`rmdir /s /q`、`deltree`、`erase`、`del /f /q` | `Remove-Item`、`Remove-Item -Recurse -Force`、`del`、`rd`、`rm`（别名）|

**③ 目录外(`outside`)**

- 判定工具：`read`/`write`/`edit`/`glob`/`grep`/`bash`（若 input 含 `path`、`file_path`、`cwd`、`command` 中的路径参数）
- 路径规范化：`path.resolve()`，然后做「是否在 cwd（或其子目录）」判定
- 符号链接：`fs.realpath` 解析后比较（失败回退字符串前缀）
- Windows：`path.win32`、大小写不敏感、反斜杠归一、UNC 支持、展开 `%USERPROFILE%`
- 处理 `..` 穿越、`~` 展开（`~` 展开为 os.homedir）

### 2. `agent-runner.ts` 集成（修改）

`installPermissionHook` 的 `beforeToolCall` 内，调用 `classifyPermission` 取代/包装现有 `decidePermission`：

```
const { kind, reason } = classifyPermission(sessionCwd, toolName, input);
if (kind === 'advanced' || kind === 'delete') {
    // 无条件弹窗（不受 allowAll 豁免）
    return await requestPermissionDialog(...);
}
if (kind === 'outside') {
    if (sessionAllowAll.get(sessionId)) return allow;
    return await requestPermissionDialog(...);
}
// normal → 现决 permission rules（decide）
```

- `sessionCwd` 从 SessionManager 传入（`session.cwd`）
- 保留了 `deny` 规则的最高优先级：即便 kind=normal 但规则 deny → 拒绝

### 3. `SessionManager` 变更

- 新增 `private sessionAllowAll = new Map<string, boolean>()`
- `setSessionAllowAll(sessionId, true/false)`
- `hasSessionAllowAll(sessionId)`
- 清理：删除/结束会话时同时 `sessionAllowAll.delete(sessionId)`，与 `forgetSessionPermissions` 同步

### 4. 弹窗（PermissionDialog，不新建）

- 四按钮布局动态：`advanced`/`delete` 只显示「允许一次」「始终允许」「拒绝」三按钮
- `outside`/`normal`（规则 ask）显示四按钮，含「允许本会话全部操作」
- 新增告警文案与 icon（按 kind：advanced=红/delete=黄/outside=中性）
- 传参：`permission.request` payload 增加 `kind` 字段；新按钮 → `permission.response` payload 增加 `allowAll: true`

## 默认规则变更

`permission-rules-store.ts` 与 renderer `store/index.ts` 的默认 rules：

| 工具 | 原 | 新 |
|------|----|----|
| read/glob/grep/find/ls | allow | allow（不变）|
| write/edit/bash | ask | **normal 情形自动 allow（cwd 内）** |

- 目录内普通操作不再弹窗（classifier 判定 normal 后规则 allow）
- `deny` 与用户自定义 `ask` 规则优先

## 错误处理

1. 路径解析异常 → 保守按 `outside` 弹窗，不静默放行
2. 无效/孤儿路径 → 保守判定（不因文件不存在而放行）
3. `realpath` 失败 → 回退字符串前缀比较
4. classifier 抛异常 → 捕获并回退 `normal`（日志记录，不阻塞工具链）
5. Windows 路径：`win32` 归一 + toLowerCase
6. `allowAll` flag 永不豁免 advanced/delete（测试锁定）

## 测试计划

- `src/tests/permission-classifier.test.ts`
  - 三平台命令表逐项命中
  - 删除：rm/Remove-Item/del 等
  - 路径 cwd 内/子目录/外/穿越 `..`/符号链接/Windows 盘符大小写/UNC
  - 优先级：advanced+outside → advanced
- `agent-runner` 集成测试：
  - normal → 免弹窗放行
  - advanced/delete → 弹窗、allowAll 不豁免
  - outside + allowAll → 放行；无 flag → 弹窗
  - deny 规则优先级
- 前端 PermissionDialog 测试：三个分支（3 按钮 / 4 按钮）渲染

## 涉及文件

- `src/main/utils/permission-classifier.ts`（新增）
- `src/main/claude/agent-runner.ts`（hook 集成）
- `src/main/session/session-manager.ts`（sessionAllowAll）
- `src/main/index.ts`（IPC: permission.response 增加 allowAll）
- `src/renderer/components/PermissionDialog.tsx`（弹窗新按钮/告警）
- `src/renderer/store/index.ts`（默认 rules 变更）
- `src/main/config/permission-rules-store.ts`（默认 rules 同步）
- i18n（zh/en 新增文案）
- 测试文件若干