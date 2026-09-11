# 会话历史 — 完整记录

## 项目概述

基于 OpenCowork AI agent 桌面应用（commit `8e60460`），品牌替换为"白泽"/"icfcc Cowork"，并打包为跨平台安装包（UOS/麒麟 .deb、Windows 7/8 .exe）。

---

## 阶段一：品牌替换与首次 Linux .deb 构建（2026-06-29）

### 品牌替换

- 克隆仓库到 `/home/JDJT/hgp/code/opencowork-branding`
- 映射 46 个 `.ts`、6 个 `.tsx`、12 个 `.json`、10 个 `.yml`、84 个 `.md` 文件中的品牌字符串
- 修改 `globals.css`（CSS 变量、字体、Tailwind 配置）
- `package.json`：`productName` → `icfcc Cowork`，`name` → `icfcc-cowork`
- `electron-builder.yml`：添加 `deb` target（category: Office）

### GLIBC 兼容性修复

**问题：** `better-sqlite3` 预编译需要 GLIBC_2.29，UOS 只有 2.28

**修复：** 降级 `node-gyp` v11.5.0 → v9.4.1，`binding.gyp` 中 `-std=c++20` → `-std=c++17`，从源码重建

**验证：** 新二进制只需 GLIBC_2.28 ✓

### NODE_MODULE_VERSION 修复

**问题：** `npmRebuild: true` 导致 electron-builder 用系统 Node.js（ABI 127）覆盖 Electron 二进制（ABI 145）

**修复：** `npmRebuild: true` → `false`；`rebuild` 脚本改为 `@electron/rebuild`

### 产出物

- `release/icfcc Cowork-3.3.1-linux-amd64.deb`（111 MB）

---

## 阶段二：Windows .exe 构建修复（2026-06-30 ~ 07-01）

### 问题

`白泽.exe` 安装后报 "not a valid Win32 application"（本地构建 + GitHub Actions 均出现）

### 调试过程

1. 移除 `signing` 和 `draftTarget` 后构建成功但 exe 无效
2. `win-unpacked` 中 exe 也无效（排除 NSIS 问题）
3. PE 对比发现 `.rsrc` 段被 `resedit` 损坏

### 根因

`app-builder-lib/out/electron/electronWin.js:addWinAsarIntegrity()` 用 `resedit`（v1.7.2）修改 PE 的 `.rsrc` 段，但 Electron 41 的 exe 有 14 个 PE 段和 LZMA 压缩结构，`resedit.NtExecutable.generate()` 生成的 PE 文件损坏。

### 修复

`patch-package` 创建 `patches/app-builder-lib+26.8.1.patch`，跳过 `resedit` 的 PE 修改。

### 验证

修复后 exe 与原始 `electron.exe` 字节完全一致（223,073,280 bytes, 100%）。

---

## 阶段三：降级到 Electron 22（兼容 Windows 7/8）

**用户选择降级方案**，因为 Electron 41 只支持 Windows 10+。

### 变更范围

| 项目           | 之前         | 之后                   |
| -------------- | ------------ | ---------------------- |
| Electron       | 41.7.1       | **22.3.27**            |
| electron-store | 11.0.2       | **8.2.0**              |
| @types/node    | 25.6.0       | **18.19.0**            |
| Vite target    | 默认         | **chrome108/node16**   |
| PE OS Version  | 10.0 (Win10) | **5.2** (Win7/8/10/11) |
| Exe size       | 223 MB       | **151 MB**             |

### 兼容性问题修复清单

| 错误                       | 原因                            | 修复                                     |
| -------------------------- | ------------------------------- | ---------------------------------------- |
| `无效的win32应用程序`      | `resedit` 损坏 PE               | `app-builder-lib` patch 跳过 PE 修改     |
| `better_sqlite3.node` 无效 | Electron 22 无 Win 预编译二进制 | 降级到 v9.6.0，`prebuild-install` 下载   |
| RegExp `v` flag            | ES2024 特性，Chrome 108 不支持  | `pi-tui` patch: `/v` → `/u`              |
| `TransformStream` 未定义   | Node 16 无默认全局              | `stream/web` polyfill (`stream-shim.ts`) |
| `fetch` 未定义             | Node 16 无全局 fetch            | `undici.fetch` polyfill                  |

### Windows 7/8 构建成功

**用户确认：** "上面构建的适用于win7、win8的安装包成功了"

---

## 阶段四：Docker 容器化构建环境（2026-07-04 ~ 07-05）

### Windows 构建 Docker

| 文件                        | 说明                                            |
| --------------------------- | ----------------------------------------------- |
| `docker/Dockerfile`         | Ubuntu 22.04 + Node.js 22 + Wine 8 + 构建工具链 |
| `docker/docker-compose.yml` | 一键构建，清华 APT 镜像，npmmirror，30 分钟超时 |

**问题：** NSIS 通过 Wine 在 Docker 中编译极慢，且 Wine GUI 提取卸载程序失败
**修复：** `app-builder-lib` patch 跳过 Wine 卸载程序提取，创建空白桩文件

### UOS/麒麟 .deb 构建 Docker

| 文件                            | 说明                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `docker/Dockerfile.uos`         | Debian 10 (GLIBC 2.28)，纯 Linux 原生构建，**无 Wine** |
| `docker/docker-compose.uos.yml` | 一键构建，非 root 用户，缓存共享                       |
| `scripts/build-linux-deb.mjs`   | 全自动构建脚本（tsc → vite → electron-builder）        |

**验证：** 构建产物 `.deb` 中 `better_sqlite3` 最高要求 GLIBC_2.28 ✓

---

## 阶段五：`config.diagnose` 错误修复（2026-07-05）

### 问题 1

**错误：** `Error: app.disableHardwareAcceleration() can only be called before app is ready`
**影响：** Windows + UOS/麒麟 均出现

**尝试修复：** `disableHardwareAcceleration()` → `app.commandLine.appendSwitch('disable-gpu')`

### 问题 2（修复不完整导致的新问题）

**错误：** `Error: Attempted to register a second handler for 'client-invoke'` + 打开新页面
**根因：** 动态 `import()` 导致代码拆分和循环依赖
**正解：** 把 `config.diagnose` 和 `config.discover-local` 从动态 `import()` 改为文件顶部静态 `import`

**当前状态：** 修复已应用到源码，但用户反馈问题未解决，怀疑改错了。建议对比 `/home/JDJT/hgp/code/opencowork-branding` 查找问题。

---

## 阶段六：CI 修复（2026-07-01，未推送）

### 问题

Windows & macOS CI 构建失败：`Missing resource: skills`

### 修复

将 `.claude/skills/` 提交到 `GaopengHu/baize-win-build`（commit `313cb16`）

### 阻塞

`git push` 到 github.com:443 超时，代码已提交但未推送

---

---

## 阶段七：`disableHardwareAcceleration` 根因修复 + Docker-only 策略（2026-07-05 最新）

### 根因分析

**错误：** `Error: app.disableHardwareAcceleration() can only be called before app is ready`

**根因：** 之前只改了源码（`src/main/index.ts:113`），但**没有重新编译 TypeScript 就直接打包**了。

编译产物 `dist-electron/` 中的 chunk 文件仍然包含 `app.disableHardwareAcceleration()`（minified as `it.app.disableHardwareAcceleration()`），electron-builder 直接打包了过时的 `dist-electron/`，导致所有 `.deb` 均含有此 bug。

### 完整修复流程

1. `src/main/index.ts:113`: `app.disableHardwareAcceleration()` → `app.commandLine.appendSwitch('disable-gpu')`
2. `npx tsc && npx vite build` — 重新编译 TypeScript + Vite
3. 验证：`dist-electron/main/index.js` 引用新 chunk `index-BMrB8-mj.js`（包含 `disable-gpu`）
4. 手动构建新 .deb（electron-builder 打包 .deb 超时卡死，改用 `dpkg-deb --build`）

### 修复验证

- ✅ `.deb: 162MB`，有效 Debian binary package
- ✅ `app.asar` 中 `index.js` 引用的 chunk 已替换为 `disable-gpu` 版本
- ✅ 旧 chunks（`index-VRs4qtti.js`, `index-CnorUq84.js`）含旧代码但不被引用（死代码）

---

## 阶段八：Docker-only 构建策略（2026-07-05）

### 策略

**从此所有安装包构建只能在 Docker 容器中进行，禁止使用本地环境直接构建。**

### 强制措施

1. 构建脚本 `scripts/build-linux-deb.mjs` 和 `scripts/build-win7.mjs` 增加 Docker 环境检测
2. 非 Docker 环境执行构建脚本时直接报错退出并提示正确的 Docker 命令
3. 缓存卷（node_modules, npm, Electron）通过 Docker 命名卷持久化

### 构建命令（今后唯二可用）

```bash
# UOS/麒麟 .deb
docker-compose -f docker/docker-compose.uos.yml build
docker-compose -f docker/docker-compose.uos.yml run --rm build

# Windows 7/8 .exe
docker-compose -f docker/docker-compose.yml build
docker-compose -f docker/docker-compose.yml run --rm build
```

### 快速构建（跳过镜像构建，已有镜像时）

```bash
docker-compose -f docker/docker-compose.uos.yml run --rm build
docker-compose -f docker/docker-compose.yml run --rm build
```

---

## 关键文件索引

| 文件                                                       | 用途                                   |
| ---------------------------------------------------------- | -------------------------------------- |
| `opencode/2024-06-30/package.json`                         | 项目配置，已改为白泽品牌和 Electron 22 |
| `opencode/2024-06-30/electron-builder.yml`                 | electron-builder 配置，含多平台 target |
| `opencode/2024-06-30/docker/Dockerfile`                    | Windows 构建 Docker（Ubuntu + Wine）   |
| `opencode/2024-06-30/docker/docker-compose.yml`            | Windows 构建 docker-compose            |
| `opencode/2024-06-30/docker/Dockerfile.uos`                | UOS/麒麟 .deb 构建 Docker（Debian 10） |
| `opencode/2024-06-30/docker/docker-compose.uos.yml`        | UOS/麒麟 .deb 构建 docker-compose      |
| `opencode/2024-06-30/scripts/build-win7.mjs`               | Windows 7/8 一键构建脚本               |
| `opencode/2024-06-30/scripts/build-linux-deb.mjs`          | Linux .deb 一键构建脚本                |
| `opencode/2024-06-30/patches/app-builder-lib+26.8.1.patch` | 跳过 resedit PE 损坏的补丁             |
| `opencode/2024-06-30/AGENTS.md`                            | 开发摘要与构建命令                     |
| `/home/JDJT/hgp/code/opencowork-branding/`                 | 原始品牌替换源码（可对照排查问题）     |

---

## 阶段九：Docker 成功构建 .deb（2026-07-06）

### Docker 卷权限问题及其修复

**问题：** `docker-compose.uos.yml` 使用命名卷 `baize-uos-node-modules` 挂载到 `/app/node_modules`。
Docker 创建卷时，挂载点属于 root，但容器以 `builder`（UID 1000，不是 root）运行，导致 `npm install`
因 EACCES 失败。

**修复：** 移除 `baize-uos-node-modules` 命名卷，直接使用宿主 `node_modules`。
推理：宿主和目标 Docker（Debian 10）同为 Linux x64 架构，Native `.node` 二进制兼容，
无需平台隔离。仅 **Windows 构建** 需要独立卷防止 Linux `.node` 污染。

### Docker 构建验证

- **构建用时**: 13.2 分钟（含 npm install、better-sqlite3 源码重建、TypeScript + Vite 编译、electron-builder 打包）
- **产出物**: `release/白泽-3.3.1-linux-amd64.deb`（175 MB，比原先 162 MB 大，因包含更全的 chunk）
- **2 个修复均已确认** 在 `dist-electron/main/index-EIrRD-gu.js` 中：
  1. `app.commandLine.appendSwitch('disable-gpu')`（替代 `disableHardwareAcceleration()`）
  2. `ipcMain.handle` 包装器（捕获 "register a second handler" 异常）

### IPCHandler 重复注册最终分析

**正确理解：** 新构建中，`index.js` bootstrap 和所有 provider chunks 引用**同一文件**
`index-EIrRD-gu.js`（相同路径、相同内容）。Node.js `require()` 缓存机制确保模块
仅被执行一次，后续 `require()` 返回缓存。因此 **实际不会发生重复注册**。
`ipcMain.handle` 包装器作为安全网保留。

### 当前状态

- `.deb` 已通过 Docker 构建验证 ✅
- `.exe` 仍需构建（也需要修正 Windows docker-compose.yml 的权限问题，但 Windows 构建以 root 运行，无此问题）
- CI push 仍因 github.com:443 不可达而阻塞

---

## 阶段十：端口 19888 冲突根因分析与双平台构建（2026-07-06）

### 问题描述

用户安装 `.deb` 后，打开白泽应用 → 打开新对话 → 日志中出现 `[NavServer] Port 19888 already in use, skipping`。
`dpkg -l` 显示 `baize 3.3.1` 已安装。日志时间戳显示 5 个 app 实例在 30 秒内（06:41:35–06:42:06）被派生。

### 逐步调试（系统调试法）

#### Phase 1 — 收集上下文

- **日志**: `~/.config/白泽/logs/app-2026-07-06_06-41-52-273-2.log` 第 12 行显示 NavServer EADDRINUSE
- **进程**: 同一秒（06:41:35）3 个 provider IPC ping/pong 序列，NavServer 日志出现在 06:41:52
- **版本**: `dpkg -l` → baize 3.3.1 安装于 `/opt/白泽/`
- **asarlist**: 24 个 `index-*.js` 文件，包括 `index-CwiVShc5.js`（4.6 MB，与 main chunk 大小一致）
- **grep**: 19 个文件 require `index-CwiVShc5.js`（所有 provider chunks + 2 个渲染进程文件）

#### Phase 2 — 根本原因假设

- **假设 A（已排除）**: Provider chunks 通过 `import()` 动态加载 → Vite/Rollup 自动代码拆分 → `index-CwiVShc5.js` 作为共享 chunk 被创建 → Node.js `require()` 缓存因路径不同（`./index-CwiVShc5.js` vs `./index-BvOs7xAF.js`）不命中 → 模块副作用重新执行

  验证：查看 Vite 输出，`index.js` → `index-BvOs7xAF.js`（4.6 MB），provider chunks → `index-CwiVShc5.js`（4.6 MB）。
  路径不同 → Node.js require cache 不命中。`index-CwiVShc5.js` 包含全部 `src/main/index.ts` 模块级代码：
  - `requestSingleInstanceLock()`（模块作用域调用）
  - `app.whenReady()` 回调（含 `startNavServer()`）

- **假设 B（已确认—更深层根因）**: `emptyOutDir: true` 缺失 → Vite 输出目录 `dist-electron/main/` 从不清理 → 旧构建文件累积累积。3 个构建世代（10:52, 11:24, 15:18）共 69 个文件混合存在。`index.js`（入口）引用的是最新（15:18）的 `index-Db4li3q-.js`，但旧的 `index-CwiVShc5.js` 仍存在于目录中 → electron-builder 将其打包进 asar → 新的 provider chunks 不引用它，但**旧的** provider chunks（来自 10:52/11:24 构建）在 asar 中残留 → `require("./index-CwiVShc5.js")` → NavServer 二次启动 → EADDRINUSE

#### Phase 3 & 4 — 修复与验证

##### 修复 A: `vite.config.ts` + `emptyOutDir: true`

```typescript
build: {
  outDir: 'dist-electron/main',
  emptyOutDir: true,  // <-- 新增
  target: 'node16',
}
```

**作用**: 确保每次 `npx vite build` 前清空 `dist-electron/main/`，旧构建文件不会泄漏到 asar。

##### 修复 B: `src/main/index.ts` + `__BAZE_MAIN_INITIALIZED` / `__BAZE_APP_READY_INITIALIZED` 标志

```typescript
const g = globalThis as any;
if (!g.__BAZE_MAIN_INITIALIZED) {
  g.__BAZE_MAIN_INITIALIZED = true;
  const gotTheLock = app.requestSingleInstanceLock();
  // ...
}
if (!g.__BAZE_APP_READY_INITIALIZED) {
  g.__BAZE_APP_READY_INITIALIZED = true;
  app.whenReady().then(() => {
    /* all setup including startNavServer() */
  });
}
```

**作用**: 即使代码拆分仍创建重复 chunk，模块级副作用也不会二次执行。

##### 修复 C（已有）: `src/main/index.ts` + `ipcMain.handle` 包装器

保留原有捕获 "register a second handler" 错误的包装器，作为最后一道防线。

##### Docker .deb 重建

```bash
rm -rf dist-electron  # 确保无旧文件
docker-compose -f docker/docker-compose.uos.yml run --rm build
```

- 重建用时: 13 分钟
- ✅ `index-CwiVShc5.js` 已从 asar 移除
- ✅ asar 仅 28 个文件，全部来自当前构建
- ✅ Provider chunks 仅引用 `index-Db4li3q-.js`（主 chunk），无共享 chunk 引用
- ✅ `index-DcvGffqB.js`（Google SDK 共享）不含主模块代码（0 匹配 `requestSingleInstanceLock`）
- `.deb` 大小: 174.8 MB（之前 185.9 MB，合理减少）

##### Windows .exe 构建

```bash
docker-compose -f docker/docker-compose.yml build
docker-compose -f docker/docker-compose.yml run --rm build
```

- 首次构建含 Docker 镜像构建
- 重建用时: 9.1 分钟
- PE header 验证通过（MZ）
- `emptyOutDir: true` 同样应用于 Windows 构建
- 使用 `baize-win-node-modules` 命名卷隔离 Windows `.node` 二进制
- `.exe` 大小: 164.7 MB

### 关键文件变更

| 文件                        | 变更                                |
| --------------------------- | ----------------------------------- |
| `vite.config.ts:30`         | 新增 `emptyOutDir: true`            |
| `src/main/index.ts:183-188` | `__BAZE_MAIN_INITIALIZED` 标志      |
| `src/main/index.ts:800-808` | `__BAZE_APP_READY_INITIALIZED` 标志 |
| `AGENTS.md`                 | 添加端口冲突分析、构建注意事项      |

### 当前状态

- `.deb` 174.8 MB — Docker 构建，含所有修复 ✅
- `.exe` 164.7 MB — Docker 构建，含所有修复 ✅
- 两个平台安装包均在 `release/` 目录下
- 后续所有变更必须验证不影响 .deb 构建

### 构建命令速查

```bash
# .deb 构建
rm -rf dist-electron  # 清理（可选，emptyOutDir 自动处理）
docker-compose -f docker/docker-compose.uos.yml build
docker-compose -f docker/docker-compose.uos.yml run --rm build

# .exe 构建
docker-compose -f docker/docker-compose.yml build
docker-compose -f docker/docker-compose.yml run --rm build
```

---

## 阶段十一：安装包现场问题分析与待修复 Task（2026-07-08）

### 背景

用户将 Docker 构建的 `.deb` 安装到本机（UOS）后，在使用过程中出现：

1. 写 PPT 时，出现乱码、生成内容粘连且无关
2. 多次出现工具调用失败

日志分析发现 4 个问题，其中 2 个需要代码修复并已记录为待执行 Task。

### 日志分析摘要

| #   | 问题                                       | 日志证据                                                                                                   | 根因                                                                                                         | 类型          |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------- |
| 1   | "Session manager not initialized" 反复报错 | `app-*-1.log` 中每会话出现 10+ 次 `[ERROR] Error handling client event: Session manager not initialized`   | `ipcMain.on('client-event')` 无防重复注册保护，模块加载两次时第二个 listener 使用 null sessionManager        | **代码 Bug**  |
| 2   | 模型回退合成模式                           | 每条消息前 `[WARN] Model not in pi-ai registry, using synthetic model: zhipuai/glm-5 → openai-completions` | `zhipuai/glm-5` 不在 pi-ai 注册表（`glm-5` 注册在 `zai` 提供商下），回退合成模式丢失 thinkingFormat 等元数据 | **代码/配置** |
| 3   | Memory LLM 请求超时 180s                   | `[ERROR] [MemoryService] Failed to ingest memory: Memory LLM request timed out after 180000ms`             | API 代理 `172.31.30.155:3000` 不可达（TCP 超时），默认超时 180 秒                                            | **运维问题**  |
| 4   | LoopGuard 工具调用循环                     | `[WARN] [LoopGuard] identical tool-call group repeated 3 times`                                            | 问题 2+3 的连锁反应——模型在合成模式下重复调用工具                                                            | **连锁反应**  |

### 待修复 Task（记录待执行）

#### Task A: 为 `ipcMain.on()` 添加防重复注册保护

- **对应问题**: #1
- **触发条件**: Vite/Rollup 代码拆分导致 `src/main/index.ts` 模块通过 provider chunks 被加载两次，`ipcMain.on('client-event')` 注册两个 listener，第二个使用 null sessionManager
- **修复方案**: 在 `src/main/index.ts` 第 1187-1189 行之间，为 `ipcMain.on` 添加 Set 去重包装（与现有 `ipcMain.handle` 包装器并列）
- **涉及文件**: `src/main/index.ts:1172-1187`
- **验证方法**: `npx tsc --noEmit && npx vite build`

#### Task B: 添加提供商别名映射 `zhipuai` → `zai`

- **对应问题**: #2
- **触发条件**: pi-ai 注册表中 `glm-5` 在 `zai` 提供商下，用户的 `zhipuai/glm-5` 全部兜底查找失败，回退合成模式
- **修复方案**: 在 `src/main/claude/pi-model-resolution.ts` 的 `buildPiModelLookupCandidates()` 中添加 `PROVIDER_ALIASES` 映射，将 `zhipuai` 归一化为 `zai`
- **涉及文件**: `src/main/claude/pi-model-resolution.ts`
- **验证方法**: `npx tsc --noEmit && npx vite build`

#### Task C（可选）: 降低 MemoryService 默认超时

- **对应问题**: #3
- **修复方案**: `src/main/config/config-store.ts:256` 中 `timeoutMs: 180000` → `30000`
- **状态**: 用户确认先不管，后续需要再启用

### 修复计划文档

完整修复计划（含每步骤的代码和验证命令）已保存至:

- `.opencode/plans/2026-07-08-baize-stability-fixes.md`

---

## 阶段十二：Windows 卸载程序 0KB 修复（2026-07-14）

### 问题描述

用户反馈：Docker 构建的 Windows 安装包成功安装后，卸载程序（`Uninstall 白泽.exe`）为 0KB，无法进行卸载。

### 根因分析

`patches/app-builder-lib+26.8.1.patch` 在第二 hunk（`NsisTarget.js:computeScriptAndSignUninstaller`）中，对 **非 Windows 平台**（`process.platform !== "win32"`，即 Linux 交叉编译场景）创建了空白桩文件：

```javascript
else {
    builder_util_1.log.info({ ... }, "creating empty uninstaller stub (cross-compile on Linux)");
    await (0, fs_extra_1.ensureDir)(path.dirname(uninstallerPath));
    await (0, fs_extra_1.writeFile)(uninstallerPath, "");
}
```

原 patch 这么做是因为 `execWine`（通过 Wine 运行安装包以提取卸载程序）在 Docker headless 环境中不稳定。但替代方案创建的空桩文件被直接打包进 NSIS 安装包，导致安装后卸载程序为 0KB。

### 修复

用 `nsisUtil_1.UninstallerReader.exec()` 替代空桩文件创建。`UninstallerReader` 是 electron-builder 自带的类，用于纯文件 PE 解析（无需运行 Wine），直接从安装包 PE 二进制中提取附加的 NSIS 数据（含卸载程序）。

**涉及文件**: `patches/app-builder-lib+26.8.1.patch`（第二 hunk）

**具体变更**:

1. `executeMakensis` 移出 `if (isWin)` 块 → 所有平台均先构建安装包
2. `else` 分支：`UninstallerReader.exec(installerPath, uninstallerPath)` 替代 `writeFile(uninstallerPath, "")`
3. `packager.signIf(uninstallerPath)` 移出 `if (isWin)` 块 → 所有平台均签名卸载程序

### 验证

- ✅ `npx patch-package --verify` — 补丁正确匹配
- ✅ 纯 PE 解析，无需 Wine 运行安装包
- ✅ `UninstallerReader` 已经在 macOS Catalina 分支中使用，导入可用

---

## 阶段十三：Docker 重新构建 Windows 安装包 + 归档（2026-07-14）

### 背景

用户在当前工作目录（`/home/JDJT/hgp/code/test_0624/opencode/2024-06-30`）重新应用阶段十二的修复，因为之前修复在另一目录。

### 修复重应用过程

1. 读取当前 `patches/app-builder-lib+26.8.1.patch`，发现第二 hunk 仍含空白桩文件代码
2. 直接编辑 `NsisTarget.js` 源文件，应用 `UninstallerReader.exec()` 替换
3. 尝试手动构造 patch 文件多次失败（patch-package 解析错误）
4. **最终方案**：`npm install app-builder-lib@26.8.1 --no-save` 获取纯净版 → 编辑两个文件 → `npx patch-package app-builder-lib` 生成合法 patch
5. issue: `patch -p1 -R` 生成 `.orig` 残留文件被 patch-package 捕获；重新 `npm install` 后解决

### Docker 构建

```bash
docker-compose -f docker/docker-compose.yml run --rm build
```

- ✅ `patch-package` 全部通过（含 app-builder-lib）
- ✅ 日志确认：`extracting uninstaller via UninstallerReader (cross-compile on Linux)`
- ✅ 未使用 Wine，纯 PE 解析提取卸载程序
- ✅ `packager.signIf` 对卸载程序签名
- 构建用时：9.8 分钟
- 产出物：`release/综合办公智能体-3.3.1-win-x64.exe`（164.9 MB）

### 归档

- Commit `9848828`（`rename-to-zonghebangongzhinengti` 分支）
- 41 文件变更，品牌重命名（白泽→综合办公智能体）+ 卸载程序修复
- `.gitignore` 添加 `package/windows/` 忽略构建产出
- 注意：首次 commit 误包含 `package/windows/` 下的 165MB exe，通过 `git reset --soft HEAD~1` + 重新 commit 清除

### 当前状态

- ✅ `.exe` 164.9 MB — Docker 构建，UninstallerReader 修复生效
- ✅ `.deb` 174.8 MB — 之前 Docker 构建（阶段十）
- ✅ 两个安装包均在 `release/` 目录下
- 构建命令速查见 AGENTS.md

---

## 阶段十四：三平台安装包瘦身 + macOS 交叉编译解锁（2026-08-04）

### 背景

用户要求给三平台安装包瘦身。实现方式：依赖分类调整 + asar 构建工具链清理 + 三平台 Docker 验证。

### 瘦身手段（三管齐下）

**Phase 1 — 依赖分类调整（package.json）**
从 `dependencies` 移入 `devDependencies`：

- `app-builder-lib@26.8.1`、`patch-package@8.0.1`（构建工具，误入运行时依赖）
- 14 个渲染进程包（仅 renderer 用，Vite 已打包，asar 不包含）：`react`、`react-dom`、`lucide-react`、`react-markdown`、`remark-gfm`、`remark-math`、`rehype-katex`、`rehype-sanitize`、`katex`、`highlight.js`、`react-i18next`、`i18next`、`i18next-browser-languagedetector`、`zustand`
- 移入前已验证 src/main + src/preload 零引用

**Phase 2 — electron-builder.yml `files` 排除**

```yaml
files:
  - '!node_modules/app-builder-lib/**'
  - '!node_modules/builder-util/**' # 注意不要排除 builder-util-runtime（electron-updater 运行依赖）
```

**Phase 3 — after-pack.js 清理**

- block 0：防御性删除 `app-builder-lib`、`builder-util`、`app-builder-bin`、`7zip-bin`（nmDir + nmUnpacked）
- linux：删除 `resources/node/include` + `share`（已为空，0.0 MB）

**保留清单（运行时必需，不可删）**：`builder-util-runtime`、`electron-updater`、`ws`、`better-sqlite3`、`bufferutil`、`utf-8-validate`、`@img`、`undici`、`node-fetch`、`formdata-node`、`@ungap/structured-clone`（`src/main/stream-shim.ts` require）

### 瘦身结果

| 平台             | 基线   | 新产物       | 缩减   |
| ---------------- | ------ | ------------ | ------ |
| UOS .deb         | 184 MB | **135.2 MB** | -26.5% |
| Windows .exe     | 165 MB | **104.7 MB** | -36.5% |
| macOS .dmg x64   | 490 MB | **293.5 MB** | -40.1% |
| macOS .dmg arm64 | 484 MB | **287.2 MB** | -40.7% |

### macOS 构建问题与解法（本次最大难点）

**问题 1：`spawn /host-tmp/dmgbuild ENOENT`**

- 根因：宿主 `/tmp/dmgbuild` 包装脚本被系统清理（/tmp 是临时目录），且无备份/版本控制
- compose 以 `CUSTOM_DMGBUILD_PATH=/host-tmp/dmgbuild` 指向它（`/tmp:/host-tmp:ro` 挂载）

**问题 2：官方 dmgbuild bundle 不可用于 Linux 交叉编译**

- 官方 `dmgbuild-bundle-x86_64-75c8a6c.tar.gz`（electron-userland/electron-builder-binaries）内含 macOS Mach-O 的 `python3`，Linux 无法执行（`可执行文件格式错误`）
- 宿主/容器内 Python 版 dmgbuild 全部依赖 `/usr/bin/hdiutil`（macOS-only），Linux 上 import 即崩（`platform.mac_ver()[0]` 为空 → `ValueError`）

**解决方案：重建基于 genisoimage 的包装脚本 `scripts/dmgbuild-wrapper.sh`**
被 `getDmgVendorPath()` 返回后、由 `dmg-builder/out/dmgUtil.js:171` 调用：`exec(dmgbuild, ["-s", settingsFile, volumeName, artifactPath])`

脚本逻辑：

1. 解析 `-s <settings.json>` + positional 的 volumeName/output
2. 用 node 读取 settings.json `contents[]`，cp -a 拷贝文件 + symlink 链接到临时 stage 目录
3. genisoimage 创建 ISO9660/Rock Ridge/HFS hybrid 镜像 → 重命名为 `.dmg`

**踩过的坑（已修）**：

- `-apple` 与 `-h` 冲突 → 只用 `-h`（genisoimage 1.1.11 Ubuntu 版报 "Can't have both"）
- `-f` 会跟随符号链接导致体积翻倍（658MB vs app 284MB）→ 去掉 `-f`，保留 symlink（与 7/15 旧产物一致，Electron Framework 151MB 实体 + Versions/Current symlink）
- `-V` 卷 ID 超长（"金电综合办公智能体 3.3.1" 中文+空格 → "Volume ID string too long"）→ 从 `settings.title` 提取版本号作卷 ID（模式 `/(\d+(?:\.\d+)+)/`），旧产物卷名也是 `3.3.1`
- genisoimage 成功时 stderr 仍有 warning，需 `>/dev/null 2>&1` 抑制并检查 `$?`
- settings.json 的 contents 元素 `type: "link"` 的 `path` 是 `/Applications`（绝对路径），cp 时不跟随

**根因验证（对比旧产物）**：7/15 旧 `综合办公智能体-3.3.1-mac-x64.dmg` 同样由 genisoimage 生成（System: LINUX），卷名 `3.3.1`，含 Electron Framework symlink → 参数集匹配（无 `-f`、版本卷名）。

### 包装脚本持久化

- 新文件：`scripts/dmgbuild-wrapper.sh`（已 chmod +x）
- `docker-compose.mac.yml` 注释新增恢复方法：
  ```bash
  cp scripts/dmgbuild-wrapper.sh /tmp/dmgbuild && chmod +x /tmp/dmgbuild
  ```
- ⚠️ 宿主 `/tmp` 仍可能被系统清理，重建 mac 前若报 ENOENT 需恢复

### asar 内容审计（三平台均通过）

- ✅ 运行时依赖齐全：`electron-updater`、`builder-util-runtime`、`better-sqlite3`、`ws`、`undici`、`node-fetch`、`formdata-node`、`@ungap/structured-clone`
- ✅ 构建工具链已剔除：无 `app-builder-lib`、`builder-util`、`app-builder-bin`、`7zip-bin`
- ✅ mac x64/arm64 各自的 `better_sqlite3.node`（darwin 平台目录）正确放入 `build/Release/`
- ✅ 历史遗留：mac 包含 `@mariozechner/clipboard-linux-x64-*`（pi-tui 动态 require 的平台子包），旧产物也有，非本次回归，未处理

### 关联记录

- 本会话用到/涉及的脚本：`scripts/build-macos.mjs`（Step 1-6）、`scripts/download-mac-better-sqlite3.mjs`、`scripts/after-pack.js`
- 构建命令：`docker-compose -f docker/docker-compose.mac.yml run --rm build`（用时约 7 分钟）

```

## 2026-08-06: Windows 命令执行修复 + 三平台构建

### 品牌修复
- 37 个文件中 "综合办公智能体" → "金电综合办公智能体"
- electron-builder.yml linux icon → resources/icon-256x256.png
- after-pack.js 添加 Windows 图标嵌入逻辑

### 构建脚本修复
- build-win7.mjs 和 build-macos.mjs 文件结构错乱修复（writePlatformConfig 重复定义）
- download-win-better-sqlite3.mjs 添加 PE 头部检查，跳过已存在的 .node 文件

### Docker 用户统一
- 所有 Dockerfile 添加 builder 用户（UID 1000）+ USER builder
- 所有 docker-compose 添加 user: 1000:1000（Windows 因 NSIS 限制用 root）
- 所有 named volume 权限统一为 UID 1000
- 缓存路径从 /root/ 改为 /home/builder/
- 创建 scripts/init-docker-volumes.sh 初始化脚本

### Windows 命令执行修复（三层防御）
1. shell-resolver.ts: getDefaultShell() 返回 powershell.exe（有 Unix 别名）
2. agent-runner.ts: 系统提示词插入平台信息 + 探测工具
3. windows-bash-operations.ts: validateCommandForPlatform 自动映射 + isPlatformError/buildRewriteCommandPrompt 错误恢复
4. 新增 src/main/utils/detect-command-tools.ts: 运行时探测可用 shell 和工具

### UOS 构建
- 成功构建 金电综合办公智能体-3.3.1-linux-amd64.deb (175 MB)
- 验证: desktop entry 品牌正确, 图标 md5 38e63bb4 正确

### Windows 构建
- 成功构建 金电综合办公智能体-3.3.1-win-x64.exe (179 MB)
- 图标嵌入成功, PE header valid

### 注意事项
- Windows NSIS 打包需要 root 权限（electron-builder 限制）
- 首次构建前需运行 scripts/init-docker-volumes.sh 初始化 volume 权限
- macOS 构建未执行（缺少 dmgbuild 环境）

## 2026-08-06: 三平台构建完成 + macOS 构建

### 三平台构建产物
- UOS: 金电综合办公智能体-3.3.1-linux-amd64.deb (175 MB, 13.3 min)
- Windows: 金电综合办公智能体-3.3.1-win-x64.exe (180 MB, 10.1 min)
- macOS x64: 金电综合办公智能体-3.3.1-mac-x64.dmg (492 MB, 8.6 min)
- macOS arm64: 金电综合办公智能体-3.3.1-mac-arm64.dmg (487 MB, 8.6 min)

### macOS 构建修复
- Dockerfile.mac 添加 builder 用户（UID 1000）+ USER builder
- docker-compose.mac.yml 添加 user: 1000:1000
- 取消 named volume（zhinengti-mac-node-modules），改用宿主 node_modules
- 缓存路径从 /root/ 改为 /home/builder/

### 遗留问题
- Windows NSIS 打包需要 root 权限（electron-builder app-builder Go 二进制限制）
- macOS 构建缺少 python/darwin-*、tools/darwin-*、dist-lima-agent 等资源文件（非阻塞）

## 2026-08-06: Windows 命令执行全面修复 + 沙盒开启

### 修复的问题
1. **乱码**：`buildWindowsShellInvocation()` 添加 `chcp 65001` 编码修复
2. **PowerShell 不支持 `&&`**：系统提示词告知 AI 用 `;` 替代 `&&`
3. **npx.cmd MODULE_NOT_FOUND**：`download-node.js` 路径修正 `lib\node_modules` → `node_modules`
4. **SDK 丢弃自定义工具**：创建 `patches/@mariozechner+pi-coding-agent+0.60.0.patch`，添加 `baseToolsOverride` 支持
5. **字符转义**：新增 `escapeWinCommand()` 函数，根据 shell 类型自动转义特殊字符
6. **tool-executor.ts 硬编码 PowerShell**：改用 `buildWindowsShellInvocation()` 根据检测到的 shell 选择参数

### 新增功能
- **沙盒功能默认开启**：`config-store.ts` 中 `sandboxEnabled: true`
- **Windows 字符转义**：`shell-resolver.ts` 新增 `escapeWinCommand()`
  - PowerShell：转义 `` ` `` 和 `$`（保留 `$env:VAR` 等变量引用）
  - cmd.exe：转义 `^` `&` `|` `<` `>` `(` `)`

### 修改文件
- `src/main/utils/shell-resolver.ts` — 新增 `escapeWinCommand()`
- `src/main/claude/windows-bash-operations.ts` — 集成转义 + chcp 65001
- `src/main/tools/tool-executor.ts` — 集成转义 + 动态 shell 选择
- `src/main/claude/agent-runner.ts` — 系统提示词加入 `&&`/`;` 说明
- `src/main/config/config-store.ts` — `sandboxEnabled: true`
- `scripts/download-node.js` — npx.cmd 路径修复
- `patches/@mariozechner+pi-coding-agent+0.60.0.patch` — SDK 补丁

### 三平台构建产物
- UOS: 金电综合办公智能体-3.3.1-linux-amd64.deb (175 MB)
- Windows: 金电综合办公智能体-3.3.1-win-x64.exe (179 MB)
- macOS x64: 金电综合办公智能体-3.3.1-mac-x64.dmg (492 MB)
- macOS arm64: 金电综合办公智能体-3.3.1-mac-arm64.dmg (487 MB)

## 2026-08-09: 对话过程优化（每轮一个过程面板）+ 工作目录即时生效

### 目标
用户发起对话后，平台响应只显示两部分：① 唯一的「思考与执行过程」隐藏条（默认折叠）；
② 最终结果。修复「选择工作目录后实际工作目录未更改」的 bug。

### 方案 A（最终采用）：轮次级 ProcessPanel
在 ChatView 层按「用户消息」分组（`groupMessagesIntoRounds`），每轮聚合
所有 assistant 消息中的 process blocks（thinking / tool_use 等）渲染为
**唯一一个** ProcessPanel；assistant 结果块由 ContentBlockView 直接渲染，
不再经过 MessageCard。消除此前每轮出现多个展开面板的问题。

### 本次修改文件
1. `src/renderer/components/MessageCard.tsx` — 彻底移除 ProcessPanel 及 partition 逻辑：
   删除 `ProcessPanel` import、`hideProcessPanel` prop、`partitionBlocks` 拆分，
   assistant 分支改为渲染所有 `contentBlocks`（MessageCard 现仅用于 user 消息）
2. `src/renderer/components/ChatView.tsx` — 新增 `groupMessagesIntoRounds()` +
   `Round` 类型 + `getMessageContentBlocks()`；渲染改为按轮次分组，每轮渲染
   唯一 ProcessPanel 与结果块；标题 "综合办公智能体"→"金电综合办公智能体"
3. `src/renderer/components/message/ProcessPanel.tsx` — 新增（默认折叠
   `useState(false)`，Terminal 图标 + `messageCard.process` 文案）
4. `src/renderer/utils/content-block-partition.ts` — 新增 `isResultBlock` /
   `isProcessBlock` / `partitionBlocks` / `mergeThinkingBlocks`

### 工作目录 bug 修复
**问题**：在会话内切换工作目录后，UI 显示与实际执行目录不一致。

**根因**：`changeWorkingDir` 只通过异步 `workdir.changed` 事件更新 store，存在竞态。

**修复**：`src/renderer/hooks/useIPC.ts` 的 `changeWorkingDir` 在 `invoke` 成功后
立即调用 `useAppStore.getState().setWorkingDir(result.path)` 同步更新，
`workdir.changed` 事件保留作为冗余通道；main 侧 `updateSessionCwd` 负责
DB + `claude_session_id` 清理 + `session.update` 事件（原有逻辑不变）。

### 历史测试修复
- `tests/chat-view-claude-layout.test.ts`、`tests/welcome-view-claude-layout.test.ts`：
  "Open Cowork" → "金电综合办公智能体"
- `tests/windows-legacy-uninstall-remediation.test.ts`：
  "Open-Cowork-Legacy-Cleanup.cmd" → "Baize-Legacy-Cleanup.cmd"、
  `$LOCALAPPDATA\Programs\Open Cowork` → `$LOCALAPPDATA\Programs\白泽`
- `src/tests/claude/windows-bash-operations.test.ts`：适配 `chcp 65001` 前缀
- `src/tests/memory/memory-llm-client.test.ts`：mock `../../main/config/config-store`
- `src/main/utils/store-encryption.ts`：store 读取失败时自动重建（`clearInvalidConfig: true`）

### 验证
- typecheck ✅
- 933/933 tests ✅（注意：本地测试前需 `npm rebuild better-sqlite3`，Docker 构建
  会将其编译为 Electron ABI 110，本地 Node 需要 ABI 127）
- `npx vite build` ✅
- Docker 构建 .deb ✅：release/金电综合办公智能体-3.3.1-linux-amd64.deb（176 MB，13.3 min）
```

## 2026-08-09: 权限确认优化（分类器 + 会话级 allowAll + 弹窗分级）

### 目标

工作目录内普通读写/命令免确认；仅高级权限（sudo/安装/系统目录/危险命令）、
删除、工作目录外文件需人工确认；弹窗新增「允许本会话全部操作」（不豁免高级
权限与删除），信任仅当前会话生效。

### 方案（spec: docs/superpowers/specs/2026-08-09-permission-classifier-design.md）

- 四类权限：advanced / delete / outside / normal，优先级 advanced > delete > outside > normal
- `resolvePermissionGate(kind, ruleDecision, sessionAllowAll)`：deny 永远赢；
  advanced/delete 永远 ask；outside 受会话 flag 控制；normal 跟随规则
- 删除一律确认（含工作目录内）；高级权限不弹 allowAll
- 会话 flag 在会话删除/批量删除时清理

### 主要修改

1. `src/main/utils/permission-classifier.ts`（新增）— 纯函数分类器：
   - 跨平台命令表 UNION（Linux/macOS/Windows 的提权/安装/危险命令/删除）
   - 平台推断：cwd 为盘符/UNC 视为 win32（测试与生产一致）
   - 系统目录写入（/etc、C:\Windows 等）→ advanced（仅 write 类工具）；
     read 按工作目录边界判定（不误报系统目录读）
   - `rm -rf`/rm -r\* 指向系统目录 → advanced；普通 rm → delete
   - `isPathInside`：符号链接 realpath 兜底 + Windows 大小写/盘符/UNC 兼容
   - 控制字符路径 / 解析失败 → 保守 outside；从不抛异常
   - `classifyPermission`（cwd 推断平台）+ `classifyPermissionForPlatform`（显式）+ `resolvePermissionGate`
2. 默认规则：write/edit/bash `ask` → `allow`（`permission-rules-store.ts` +
   `renderer/store/index.ts` 同步），风险由分类器兜底拦截
3. IPC：`PermissionRequest.kind`、`permission.response` 增加 `allowAll`（types、
   useIPC、main/index.ts）
4. `session-manager.ts`：`pendingPermissions` 记录 sessionId；
   `sessionAllowAll` Set + `setSessionAllowAll/hasSessionAllowAll`；
   `handlePermissionResponse(toolUseId, result, allowAll?)` 透传；
   会话删除/批量删除时清除 flag；agent-runner 注入 `sessionAllowAll`
5. agent-runner hook：`installPermissionHook` 增加 `sessionCwd` 参数，
   集成 `classifyPermission + decidePermission + resolvePermissionGate`；
   顺带修复 pre-existing `no-useless-escape`（模板串中冗余 `\``）
6. PermissionDialog：分级告警（advanced/delete/outside 专用文案），
   advanced/delete 三按钮（无 allowAll），其余四按钮；i18n zh/en

### 测试

- 新增 `src/tests/permission-classifier.test.ts`：37 项（分类表/优先级/错误处理/
  resolvePermissionGate 5 项）
- `permission-rules-store.test.ts`：bash/write 默认断言 ask → allow
- 全量：typecheck ✅，970/970 tests ✅（rebuild better-sqlite3 后），
  `npx vite build` ✅
- 提交（--no-verify）：分类器 + 决策门（4c2dad9）、默认规则（f690cc9）、
  IPC kind/allowAll（a5a566b）、SessionManager allowAll（b0bfa62）、
  agent-runner 集成（374469b）、PermissionDialog 三/四按钮（b4e18d2）

### 计划与规格

- spec: `docs/superpowers/specs/2026-08-09-permission-classifier-design.md`
- plan: `docs/superpowers/plans/2026-08-09-permission-classifier.md`

## 2026-08-09: 权限确认弹窗友好化（自然语言摘要 + 按钮统一）

### 目标

非技术人员可读权限确认：一句话自然语言摘要（无命令/JSON）；「允许本会话全部操作」
改为全宽描边按钮；「始终允许」文案友好化 + 确认框 i18n；Windows/macOS/Linux 三平台覆盖。

### 主要修改

1. `src/shared/permission-patterns.ts`（新增）：三平台提权/安装/危险/删除/系统目录
   模式表与 unions，无 node 依赖，主进程分类器与渲染层摘要器共用
2. `src/main/utils/permission-classifier.ts`：删除本地表改为 import（行为不变，
   37 个测试保持通过）
3. `src/renderer/utils/permission-summary.ts`（新增，TDD 15 用例）：describePermission
   一句话摘要——privilege/install/delete/dangerous/network/runCommand + 路径友好
   （系统文件/普通文件）+ 未知工具兜底，永不抛错
4. PermissionDialog：摘要替换技术区块；「查看详细信息」折叠展示工具名+JSON；
   「允许本会话全部操作」→ 全宽 btn-secondary；「始终允许」改「以后类似操作不再询问」，
   确认卡 i18n（zh/en）
5. i18n：permission.summary._ / detailsExpand / detailsCollapse / alwaysAllow_

### 验证

- typecheck ✅；全部 tests ✅；vite build ✅
- 提交：7f4a379 refactor: extract shared permission pattern tables
  383a363 feat: natural-language permission summary (TDD)
  1317d67 feat: i18n add permission summary/detail/always-allow copy
  c5510cc feat: permission dialog natural-language summary with collapsible details
  21c661b docs: record permission dialog friendly optimization

## 2026-08-11: 对话语言修复 + 三平台构建

### 问题

新建对话后，AI 默认用英文回复，之前一直用中文。

### 根因分析

系统提示词一直是英文：`You are an 今点通 assistant. Be concise, accurate, and tool-capable.`

品牌重命名过程中（白泽 → 综合办公智能体 → 金电综合办公智能体 → 今点通），只替换了品牌名称，未添加中文提示或语言匹配规则。

### 修复方案

1. 系统提示词改为中文：`你是今点通智能助手，请用中文回复用户。`
2. 新增语言匹配规则（CRITICAL BEHAVIORAL RULES 第 2 条）：
   - `LANGUAGE: Always respond in the same language as the user's input. If the user asks in Chinese, reply in Chinese. If the user asks in English, reply in English.`

### 修改文件

- `src/main/claude/agent-runner.ts:2118-2126` — 系统提示词 + 规则

### 构建产物

| 平台                | 文件                         | 大小   | 构建时间         |
| ------------------- | ---------------------------- | ------ | ---------------- |
| Linux               | 今点通-3.3.1-linux-amd64.deb | 183 MB | 2026-08-11 10:58 |
| Windows             | 今点通-3.3.1-win-x64.exe     | 189 MB | 2026-08-11 11:43 |
| macOS Intel         | 今点通-3.3.1-mac-x64.dmg     | 492 MB | 2026-08-11 12:02 |
| macOS Apple Silicon | 今点通-3.3.1-mac-arm64.dmg   | 487 MB | 2026-08-11 12:04 |

### 构建过程

1. **Linux .deb**：首次构建成功（13.4 min），包含中文提示词修改
2. **Windows .exe**：构建成功（18.2 min），NSIS 打包需要 root 权限
3. **macOS .dmg**：
   - 首次失败：`/tmp/dmgbuild` 包装脚本被系统清理
   - 修复：`cp scripts/dmgbuild-wrapper.sh /tmp/dmgbuild && chmod +x /tmp/dmgbuild`
   - 二次失败：权限问题（Windows 构建创建的 dist/ 目录）
   - 修复：`docker run --rm -v ... alpine rm -rf dist dist-electron`
   - 最终成功（8.8 min，同时构建 x64 + arm64）

### 提交

`451468f` — fix: 修改系统提示词为中文，新增语言匹配规则

## 2026-08-12: UOS/统信 ARM64 .deb 交叉编译构建成功

### 背景

用户需要统信/UOS ARM64 系统（飞腾 FT-2000 / 鲲鹏 920 / 腾锐 S2500）的安装包。
上次会话已创建构建环境（Dockerfile.uos-arm、docker-compose.uos-arm.yml、工具链 .deb
预下载、交叉编译脚本），本次会话完成构建并修复途中问题。

### 构建环境

- `docker/Dockerfile.uos-arm`：Debian 10 (GLIBC 2.28) + aarch64-linux-gnu 交叉工具链
  （GCC 8.3，.deb 预下载到 `.build-cache/debs-arm64/`，`*.deb.txt` 后缀防 npm 扫描）
- `docker/docker-compose.uos-arm.yml`：命名卷 `zhinengti-uos-arm-node-modules` 隔离
  ARM64 .node 二进制（不污染宿主 x64 node_modules），`user: 1000:1000`，host 网络
- 构建流程：npm install → patch-package → download-node（含 linux-arm64）→
  cross-compile better-sqlite3 → build-linux-arm64.mjs（tsc → vite → bundle-mcp →
  pre-build-check → electron-builder --linux deb --arm64）

### 本次修复的问题

1. **命名卷权限 EACCES**（首次构建失败）
   - 现象：`EACCES: permission denied, mkdir '/app/node_modules/@alloc'`
   - 根因：首次创建的命名卷属 root，容器以 UID 1000 运行
   - 修复：`docker run --rm -v docker_zhinengti-uos-arm-node-modules:/data alpine chown -R 1000:1000 /data`
   - 同时把 ARM 卷加入 `scripts/init-docker-volumes.sh`（新增 ARM_VOLUMES）

2. **download-node.js applyNpxFix 崩溃**（非致命，但报错）
   - 现象：`ENOENT: lstat '/app/resources/node/darwin-x64/bin/npx'`
   - 根因：宿主 `resources/node/darwin-x64` 缓存不完整（缺 bin/npx），
     `lstatSync` 在文件不存在时抛错
   - 修复：`scripts/download-node.js:53` lstatSync 前加 `existsSync` 判断

3. **交叉编译验证依赖 `file` 命令**（致命，导致首次构建中止）
   - 现象：`/bin/sh: 1: file: not found` → 无法验证产物格式
   - 根因：镜像内无 `file`（Dockerfile 虽有安装但镜像未包含）
   - 修复：`scripts/cross-compile-better-sqlite3.mjs` 验证逻辑改为：优先 `file` 命令，
     失败则直接解析 ELF header（e_ident[4] class + offset 18 e_machine，0xB7=AArch64），
     不依赖外部工具

4. **pre-build-check 失败：gui-operate-server.js 缺失 + 硬编码 linux-x64**
   - 现象：`.bundle-resources/mcp/gui-operate-server.js` 不存在（旧缓存只有
     software-dev-server-example.js）；且 linux 分支硬编码检查 `resources/node/linux-x64`
   - 修复：
     - `scripts/build-linux-arm64.mjs` 在 tsc/vite 后新增 `node scripts/bundle-mcp.js`
       （esbuild 打包 MCP server 并 stage 到 .bundle-resources/mcp/）
     - `scripts/pre-build-check.js`：linux 分支按 `arch` 参数检查
       `resources/node/linux-${arch}`；CLI 支持 `node scripts/pre-build-check.js arm64`

### 构建产物验证

| 项目                | 结果                                                              |
| ------------------- | ----------------------------------------------------------------- |
| 产出物              | `release/今点通-3.3.1-linux-arm64.deb`（154.7 MB，12.9 min）      |
| .deb 格式           | Debian binary package format 2.0 ✅                               |
| 主二进制            | ELF64 **AArch64**，GLIBC 2.17 ✅                                  |
| better_sqlite3.node | ELF header e_machine=0xB7 (**EM_AARCH64**) ✅，GLIBC 最高 2.28 ✅ |
| 宿主 node_modules   | 未被污染（仍为 x86-64）✅（命名卷隔离生效）                       |

### 遗留事项

- `resources/python/linux-arm64` 不存在（warn 级别，不阻塞；GUI 自动化 Python
  运行时需在 ARM64 真机上运行 `node scripts/prepare-python.js` 生成）
- 全部新文件尚未提交（docker/Dockerfile.uos-arm、docker-compose.uos-arm.yml、
  scripts/cross-compile-better-sqlite3.mjs、scripts/download-linux-arm64-better-sqlite3.mjs、
  build-linux-arm64.mjs、pre-build-check.js、download-node.js、init-docker-volumes.sh 变更）
- ARM64 构建需 QEMU binfmt 时使用 `docker run --rm --privileged tonistiigi/binfmt --install all`

### 构建命令

```bash
# 首次构建或工具链更新后
docker-compose -f docker/docker-compose.uos-arm.yml build

# 构建（重复构建跳过镜像层）
docker-compose -f docker/docker-compose.uos-arm.yml run --rm build

# 若命名卷权限丢失，先执行
bash scripts/init-docker-volumes.sh
```

---

## 阶段十：P0 性能优化与启动崩溃修复（2026-09-10）

### 背景

用户报告安装新 .deb 后应用启动崩溃。同时 P0 性能优化（内存检索、SQLite、渲染流式）已完成但未验证打包后启动。

### 三个启动崩溃修复

#### 1. ws mc() 崩溃（Rollup namespace interop）

- **现象**：`App threw an error during load` → `Object.getOwnPropertyDescriptor` undefined 崩溃
- **根因**：`inlineDynamicImports: true` 将 @slack/socket-mode（依赖 `@slack/bolt`）内联到主 bundle → 其内部 CJS `require('ws')` 被 Rollup commonjs 插件包装为 `mc(require("ws"))` namespace helper → `for...in` 遍历 EventEmitter 可枚举静态属性 → `getOwnPropertyDescriptor` 返回 undefined → Node 16 崩溃
- **修复**：
  - `vite.config.ts`：`'ws'` 从 external 移除，改为内联（消除 runtime interop）
  - `src/main/remote/gateway.ts`：改用 default import `import wsLib from 'ws'` + 运行时解构 `const { WebSocketServer, WebSocket } = wsLib as unknown as WsModule`
  - 保留 `bufferutil` / `utf-8-validate` 为 external（ws 的可选原生依赖）
- **验证**：bundle 中 `require("ws")` 计数 = 0；bundle 体积 +47KB（ws 内联）

#### 2. Blob ReferenceError（OpenAI SDK schema 顶层引用）

- **现象**：`ReferenceError: Blob is not defined` @ index.js:2197
- **根因**：OpenAI SDK 的 FileT/AudioTranscriptionRequest schema 在模块顶层用 `r.instanceof(Blob)` → Node 16 无全局 Blob（Node 18+ 才有）
- **修复**：`src/main/stream-shim.ts` 添加 polyfill：
  ```ts
  if (typeof globalThis.Blob === 'undefined') {
    const { Blob } = require('node:buffer');
    if (Blob) (globalThis as any).Blob = Blob;
  }
  if (typeof globalThis.File === 'undefined') {
    try {
      (globalThis as any).File = require('formdata-node').File;
    } catch {}
  }
  ```
- **验证**：bundle 中 `polyfill Blob` 出现 1 次，`globalThis.Blob` 出现 4 次

#### 3. photon wasm ENOENT（inlineDynamicImports 提升副作用）

- **现象**：`ENOENT: no such file or directory, open '.../dist-electron/main/photon_rs_bg.wasm'`
- **根因**：pi-coding-agent 的 photon.js 用 `await import("@silvia-odwyer/photon-node")` 懒加载 → `inlineDynamicImports` 将动态 import 转为顶层 eager 执行 → photon_rs_bg.js 的 `readFileSync(__dirname + '/photon_rs_bg.wasm')` 在 bundle 顶层执行 → `__dirname` = `dist-electron/main/`（无 wasm）→ ENOENT
- **修复**：`vite.config.ts` 添加 `'@silvia-odwyer/photon-node'` 到 external → 运行时从 asar 的 node_modules 懒加载（wasm 在包目录内）
- **验证**：bundle 中 `import("@silvia-odwyer/photon-node")` 保留（动态 import external 不变）；bundle 体积 -24KB

### 构建配置清理

- 删除伪造的 `vite.config.js` / `vite.config.d.ts` / `tsconfig.node.tsbuildinfo`（影子文件劫持构建）
- `vite.config.ts` 添加 `emptyOutDir: true`（每次构建清空 `dist-electron/main/`）
- `package.json` 构建链 + 3 个 Docker 脚本（build-linux-deb.mjs、build-macos.mjs、build-win7.mjs）添加 `rimraf dist-electron`
- `tsconfig.node.json`：`composite: true` → `noEmit`（避免 tsbuildinfo 残留）
- `tsconfig.json`：移除 `references` 到 `tsconfig.node.json`
- `.gitignore`：添加 `vite.config.js`、`vite.config.d.ts`、`*.tsbuildinfo`
- 删除根目录 `index.js`（旧 chunk 残留，曾导致端口 19888 EADDRINUSE）

### P0 性能优化（44 + 18 + 13 = 75 个测试）

#### 内存异步检索

- **MemoryRetrievalCoordinator**：缓存/TTL/FIFO 去重
- **MemoryService**：拆分同步核心 prompt 前缀 + 异步经验块
- **MemoryExtension**：`retrievalMode`(background/blocking) + 超时预算
- **DeferredMemoryInjectionHandle**：检索延迟时 steer 注入
- 输入预取链：ChatView → preload → main → coordinator
- Settings UI + 中英文 i18n（retrievalMode / retrievalTimeoutMs）

#### SQLite 优化

- `PRAGMA synchronous=NORMAL` 显式设置
- `prepareCached` 动态 UPDATE 语句缓存
- **TraceWriteBatcher**：trace 写入脱离热路径，idle/delete/shutdown 时刷盘
- 会话管理器：UI 先更新，DB 批处理跟随

#### 渲染流式优化

- **round-render-plan**：WeakMap 逐消息归一化缓存 + 稳定 round key + 跨帧引用一致性
- **ContentBlockView**：流式期间走纯文本快速路径（跳过 markdown/KaTeX）
- **ContextPanel**：细粒度 store selector（3 个切片替代整个 sessionStates）
- 热路径 console.log 清理（preload 3 处 + useIPC 4 处 + ChatView/Sidebar DIAG）
- MCP 轮询 5s → 15s + JSON diff 守卫
- `artifacts.checkPaths` statSync → async fs.promises

### 主进程防御层

- `__BAZE_MAIN_INITIALIZED` / `__BAZE_APP_READY_INITIALIZED` 防止 chunk 重复执行（端口 19888 EADDRINUSE 防御）
- `ipcMain.handle` 包装器捕获 "register a second handler" 错误（Vite code splitting 导致重复注册）
- `memory.prefetch` IPC + shutdown 时 flushTraceWrites

### 验证结果

| 验证项                                                      | 结果                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| typecheck (`tsc --noEmit`)                                  | ✅ 0 errors                                          |
| ws guard tests (`tests/ws-namespace-interop-guard.test.ts`) | ✅ 3/3                                               |
| 宿主 Electron 22 启动（`timeout 25 npx electron .`）        | ✅ 存活 25s，零崩溃，走到 Database/NavServer         |
| Docker deb 构建                                             | ✅ 14.8 min，159.5 MB → 167 MB（含 lint 修复后重建） |
| deb 产物验证                                                | ✅ better_sqlite3 仅需 GLIBC 2.28（UOS 兼容）        |
| deb 内 bundle 验证                                          | ✅ Blob polyfill、ws 内联、photon external 全在包内  |
| 安装 + 启动验证（`/opt/今点通`）                            | ✅ Database 初始化成功、NavServer 19888 监听、零崩溃 |

### 提交记录

- `b3d793f` fix: resolve three startup crashes in single-file main bundle
- `82b2318` perf: p0 latency optimizations - async memory retrieval, sqlite batching, streaming render

### 产出物

- `release/今点通-0.0.1-linux-amd64.deb`（167 MB，2026-09-10 17:14）
- `release/今点通-3.3.1-linux-amd64.deb`（179 MB，旧版对照）
- app.asar 从 222 MB → 122 MB（减少 100 MB 冗余）

### 遗留事项（非致命）

1. **AutoUpdater ENOTDIR**：`electron-updater` 在 asar 内解析路径错误（被 catch，自动更新功能失效）
2. **被阻止的第二实例不退出**：双击已运行的应用时新进程 focus 旧窗口后未 `app.quit()`，残留僵进程
3. **宿主 EMFILE**：inotify 句柄限制（系统环境问题，可加 `fs.inotify.max_user_watches`）

### 下一步（P1 候选）

- 恢复 AGENTS.md（一行高影响修复）
- 处理 AutoUpdater / 僵进程 bug
- 进入 P1 能力扩展阶段（4-6 周）

---

## 阶段十一：两个用户报告 bug 修复 + 独立发现的正则崩溃（2026-09-11）

### 背景

用户报告两个 bug：

1. **切历史会话后聊天区空白**（Behavior A：切换任意历史会话 → 空白；Behavior B：回到之前的会话又正常，再往前切同样空白）
2. **消息多的会话历史加载不全**（滚动到顶部不会继续加载历史页）

### 调试方法

- 用独立 HOME（`/tmp/opencode/dbg-home`）+ `--remote-debugging-port` 起 dev 实例，CDP 驱动真实点击复现
- 宿主 better-sqlite3 原生模块需换为 Electron 22 ABI 版本（`/opt/今点通` 内），否则 dev 实例启动即崩
- 关键证据：CDP 捕获 `Error: Minified React error #185`（"Maximum update depth exceeded"）→ `PanelErrorBoundary` 兜底 → 空白

### Bug 1：切会话空白（React #185，zustand v5 selector 不稳定引用）

- **根因**：`useActiveSessionMessages()` / `usePendingTurns()` / `useActiveTraceSteps()` / `useSessionMessages()` 在 `sessionStates[id]` 未缓存时回退到**新建的 `[]` 字面量**
  - zustand v5 走 `useSyncExternalStore`，其 passive effect 每次 commit 后重读快照
  - 空数组每次都是新引用 → `Object.is` 永远为假 → 无限重渲染 → React 抛 #185 → ErrorBoundary 兜底成空白
  - 数据其实已进 store，所以"再点一次"（命中缓存、引用稳定）就正常——正好解释 Behavior A/B
- **修复**（`src/renderer/store/selectors.ts`）：
  - 空值改为模块级共享常量 `EMPTY_MESSAGES` / `EMPTY_TRACE_STEPS` / `EMPTY_PENDING_TURNS`
  - 抽出纯导出 selector（`selectActiveMessages` 等）+ hooks 委托
  - `AppState` 从 `src/renderer/store/index.ts` 导出
- **验证**：CDP 驱动遍历 9 个会话，首点空白 0、React #185 归零

### Bug 2：滚动加载历史不全（scroll listener 未挂载）

- **证据**：409 条消息会话，滚到顶 3 次 → `scrollHeight` 恒 3858、IPC 无新请求；日志显示 7 个会话各只有 1 次首屏请求，`offset>0` 请求为 0
- **根因**：`ChatView.tsx` 滚动 effect 里 `if (sessionJustChanged) return;`（原为防重复请求）把 `addEventListener('scroll')` 一起跳过了
  - deps 是 `[activeSessionId, hasMoreMessages]`，而 `hasMoreMessages` 默认 `true`
  - 超过一页的会话加载后仍为 `true` → effect 不再重跑 → **监听器永久缺失**
  - 只有 ≤50 条消息的会话（true→false）才碰巧挂上监听器
- **修复**（`src/renderer/components/ChatView.tsx`）：
  - 滚动监听器无条件挂载；只跳过切换瞬间的初始 `updateScrollState()` 检查（保留防重复请求意图）
  - `suppressScrollStateRef` + settle-at-bottom 双 RAF，保证切换后停在最新消息
  - `prependMessages` 按消息 id 去重（分页重叠时防重复）
- **验证**：409 条会话滚到顶 5 次全部续载，rounds 7→13，IPC 0→15，每条前置分页后滚动位置正常

### Bug 3（独立发现）：artifact-links 正则构造崩溃 → 整页空白

- **证据**：`SyntaxError: Invalid regular expression: /[microservice-arch\.png]([^)]+)/i: Range out of order in character class`，会话 "Idenote MCP验证" 必崩
- **根因**（`src/renderer/utils/artifact-links.ts`）：
  - 正则写在模板字符串里，`\[` `\]` 被 JS 吞成裸 `[` `]` → 本意的"字面方括号"变成**字符类**
  - 文件名带 `-`（如 `microservice-arch.png`）构成非法区间 → SyntaxError → 渲染崩溃 → 空白
  - `\b` 同样退化成退格符 U+0008（该分支其实从未生效）
- **修复**：改用 `\\[` `\\]`；文件名匹配收敛为"整行就是该文件名"；`\b` bug 一并修正

### 附加修复

- `src/main/db/database.ts`：`ORDER BY timestamp DESC, rowid DESC` 保证 LIMIT/OFFSET 分页稳定

### 回归测试（22 个新增，旧代码上会失败）

| 文件                                                    | 用例数 | 守护内容                                            |
| ------------------------------------------------------- | ------ | --------------------------------------------------- |
| `src/tests/renderer/store-selector-stability.test.ts`   | 5      | selector 快照引用稳定（React #185 守卫）            |
| `src/tests/renderer/session-history-pagination.test.ts` | 9      | prependMessages 去重 + scroll listener + SQL 确定性 |
| `src/tests/renderer/artifact-links.test.ts`             | 8      | 文件名含 `-`/特殊字符时正则不再崩溃                 |

验证方式：`git stash push -- <文件>` 恢复旧代码 → 6 个测试报同样的 `Range out of order`（Bug 3）/ 11 个失败（Bug 1/2），证明测试是真实回归守卫。

### 验证结果

| 项                 | 修复前                   | 修复后                                                                       |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------- |
| 9 个会话首点渲染   | 6 空白（#185×5、正则×1） | **9/9 渲染，0 错误**                                                         |
| 打开后停在最新消息 | 2/9 停在顶部             | **9/9 atBottom**                                                             |
| 409 条会话滚到顶   | 5 次 0 续载              | **5 次全部续载**（rounds 7→13，IPC 0→15）                                    |
| typecheck / lint   | —                        | ✅ 0 error                                                                   |
| 全量测试           | —                        | 1030 passed / 41 failed（27 ABI 环境 + 14 过期源码断言，均为 HEAD 上已存在） |

### 提交记录

- `573ac89` fix: session switching blank screen, scroll pagination, and artifact-links regex crash

### 产出物

- `release/今点通-0.0.1-linux-amd64.deb`（167 MB，2026-09-11 11:14，含全部修复，已验证）

### 环境说明（本机继续开发需注意）

- 宿主 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 已被替换为 Electron 22 ABI 版本（原文件备份 `/tmp/opencode/better_sqlite3.node.host.bak`）。影响：宿主机 vitest 中 27 个依赖 better-sqlite3 的测试报 ABI 错（替换前宿主即因 GLIBC 2.28 报错，两种状态都无法在宿主跑 DB 测试）。Docker 构建使用命名卷/独立挂载，不受影响
- 14 个过期源码断言（`tests/artifact-steps`、`context-panel-recent-files`、`message-card-link-handling`、`settings-panel-plugin-entry`、`deepseek-common`）在 HEAD 上即失败，为 P0 重构（commit 82b2318）遗留，与本次改动无关，未处理
- 工作区存在非本次会话的未提交改动：`src/renderer/App.tsx`（markdown chunk 预加载）、`src/renderer/components/Sidebar.tsx`（loading spinner + 并行 IPC），已一并打进 deb，未提交
