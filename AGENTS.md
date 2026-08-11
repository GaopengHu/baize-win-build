# AGENTS.md — 今点通 AI Agent 桌面应用构建项目

## 项目位置

- 项目根目录: `/home/JDJT/hgp/code/test_0624/opencode/2024-06-30`
- 源码参考: `/home/JDJT/hgp/code/opencowork-branding`（原始 opencowork 品牌替换版）

## 重要策略：Docker-only 构建

**所有安装包构建必须在 Docker 容器中执行，禁止在本地环境直接构建。**
构建脚本（`scripts/build-*.mjs`）会自动检测 Docker 环境，非 Docker 环境直接报错。

## 构建命令

### UOS/麒麟 .deb 构建

```bash
cd /home/JDJT/hgp/code/test_0624/opencode/2024-06-30

# 首次或 Docker 镜像更新后
docker-compose -f docker/docker-compose.uos.yml build

# 构建（重复构建跳过镜像层，速度更快）
docker-compose -f docker/docker-compose.uos.yml run --rm build
```

### Windows 7/8 .exe 构建

```bash
# 首次或 Docker 镜像更新后
docker-compose -f docker/docker-compose.yml build

# 构建
docker-compose -f docker/docker-compose.yml run --rm build
```

### macOS .dmg 构建

```bash
# 首次或 Docker 镜像更新后
docker-compose -f docker/docker-compose.mac.yml build

# 构建
docker-compose -f docker/docker-compose.mac.yml run --rm build
```

### 产出物

- `.deb`: `release/今点通-*-linux-amd64.deb`
- `.exe`: `release/今点通-*-win-x64.exe`
- `.dmg`: `release/今点通-*-mac-{x64,arm64}.dmg`

## 关键配置

- `npmRebuild: false` — 防止 electron-builder 用系统 Node.js 覆盖预编译二进制
- `signAndEditExecutable: false` — 跳过签名（无 Windows 证书）
- `electron-builder.yml` — 主配置文件
- Electron 22.3.27（降级后，兼容 Windows 7/8）

## 关键文件

- `docker/docker-compose.uos.yml` — UOS .deb 构建（Debian 10, GLIBC 2.28）
- `docker/docker-compose.yml` — Windows 构建（Ubuntu 22.04 + Wine）
- `docker/docker-compose.mac.yml` — macOS 构建（Ubuntu 22.04 + dmgbuild）
- `docker/Dockerfile.uos` — Debian 10 构建环境
- `docker/Dockerfile` — Ubuntu + Wine 构建环境
- `docker/Dockerfile.mac` — Ubuntu + dmgbuild 构建环境
- `scripts/build-linux-deb.mjs` — .deb 构建脚本（自动检测 Docker）
- `scripts/build-win7.mjs` — .exe 构建脚本（自动检测 Docker）
- `scripts/build-macos.mjs` — .dmg 构建脚本（自动检测 Docker）
- `scripts/download-mac-better-sqlite3.mjs` — macOS 预编译 better-sqlite3 下载
- `scripts/after-pack.js` — 清理平台特定 .node 文件
- `patches/app-builder-lib+26.8.1.patch` — 跳过 resedit PE 损坏补丁
- `src/main/index.ts:113` — `disableHardwareAcceleration` → `commandLine.appendSwitch('disable-gpu')`

## GLIBC 兼容性

- Docker 镜像基于 Debian 10（GLIBC 2.28），与 UOS 20 完全兼容
- `better-sqlite3` 在 Docker 中从源码重建，链接 GLIBC 2.28
- 命名卷 `baize-uos-node-modules` 隔离 Linux .node 二进制

## Windows 7/8 兼容性

- Electron 22.3.27（PE OS version 5.2）
- `better-sqlite3` v9.6.0（Windows 预编译二进制）
- `patches/app-builder-lib+26.8.1.patch` 跳过 PE 损坏
- 命名卷 `baize-win-node-modules` 隔离 Windows .node 二进制

## 已验证的修复

- ✅ `disableHardwareAcceleration()` → `commandLine.appendSwitch('disable-gpu')`（不再有 `can only be called before app is ready` 错误）
- ✅ `ipcMain.handle` 包装器捕获 "register a second handler" 错误，防止 Vite chunk 共享导致的重复注册
- ✅ `globalThis.FormData` polyfill（`src/main/stream-shim.ts` + `formdata-node`），解决 OpenAI/Anthropic SDK 中 `body instanceof FormData` 在 Node.js 16（Electron 22）中抛出 `ReferenceError` 的问题
- ✅ `globalThis.structuredClone` polyfill（`src/main/stream-shim.ts` + `@ungap/structured-clone`），解决 pi-tui UndoStack 中 `structuredClone` 在 Node.js 16 中抛出 `ReferenceError` 的问题
- ✅ GLIBC 2.28 兼容（`.deb` 中 `better_sqlite3` 仅需 GLIBC 2.28）
- ✅ 当前 .deb: `release/白泽-3.3.1-linux-amd64.deb`（175 MB，Docker 构建，所有修复已包含）
- ✅ 当前 .exe: `release/白泽-3.3.1-win-x64.exe`（165 MB，Docker 构建，所有修复已包含）

## IPCHandler 重复注册问题

- **根因**: Vite 代码拆分将 `src/main/index.ts`（含所有 `ipcMain.handle()` 注册）放入 `index-EIrRD-gu.js` chunk。Provider chunks 通过 `require("./index-EIrRD-gu.js")` 引用此 chunk。Node.js `require()` 缓存机制确保模块只执行一次，因此**实际不会重复注册**。
- **修复**: 在 `src/main/index.ts` 包装 `ipcMain.handle()`，捕获 "register a second handler" 错误并静默忽略，作为安全网。
- **验证**: Provider chunks（anthropic, google, openai, mistral, lima-sync）全部引用 `index-EIrRD-gu.js`（同一路径 → Node.js 缓存命中 → 不重复执行）。

## 端口 19888 冲突（NavServer EADDRINUSE）

- **根因**: Vite 构建时未清理输出目录（无 `emptyOutDir`），旧构建的 `dist-electron/main/` 文件累积累积。旧 `index-CwiVShc5.js` chunk（含完整的 `startNavServer()`、`requestSingleInstanceLock()`、`ipcMain.handle` 注册等模块级副作用）残留在目录中 → electron-builder 将其打包进 asar → 用户打开新对话时，provider chunk 加载 → `require("./index-CwiVShc5.js")` → 所有模块级副作用重新执行 → `startNavServer()` 尝试绑定端口 19888 → EADDRINUSE
- **修复**: `vite.config.ts:30` 添加 `emptyOutDir: true`，确保每次构建前清空 `dist-electron/main/`
- **防御层 2**: `src/main/index.ts` 添加 `__BAZE_MAIN_INITIALIZED` 和 `__BAZE_APP_READY_INITIALIZED` 标志，即使 chunk 重复也不会二次执行 `requestSingleInstanceLock()` 和 `app.whenReady()` 回调
- **防御层 3**: `src/main/index.ts:ipcMain.handle` 包装器捕获 "register a second handler" 错误（原有修复，保留）
- **注意**: 修改 Vite 配置后必须清理 `dist-electron/main/`（或确保 `emptyOutDir: true`），否则旧文件会污染新的 asar

## Docker 构建注意事项

- UOS .deb: **未使用** named volume；直接挂载宿主 `node_modules`（同为 Linux x64，无兼容问题）
- Windows .exe: **使用** named volume `zhinengti-win-node-modules` 隔离 Windows .node 二进制
- macOS .dmg: **使用** named volume `zhinengti-mac-node-modules` 隔离 macOS .node 二进制
- **`dist-electron/`** 目录在宿主文件系统上（通过 `..:/app` 挂载），不同平台的 Vite 输出会互相覆盖。每次构建前确保 `dist-electron/main/` 为空（`emptyOutDir: true` 自动处理）
- 任何影响 `dist-electron/` 输出的修改（Vite 配置、TypeScript 源码、rollupOptions）**必须**先验证 `.deb` 构建不受影响

## 完整会话历史

详见 `/home/JDJT/hgp/code/test_0624/session-history.md`

---

## 构建性能优化（2026-08-05）

### 优化措施

**1. fpm 压缩算法优化**

- **修改**: `electron-builder.yml` 添加 `compression: gz`
- **效果**: fpm 打包时间从 5-10 分钟降到 1-2 分钟
- **权衡**: `.deb` 体积增加约 10-20%（从 ~135MB 到 ~150MB）

**2. better-sqlite3 构建缓存优化**

- **修改**: `docker-compose.uos.yml` 增加 `.node` 文件验证逻辑
- **效果**: 跳过不必要的 `node-gyp rebuild`（省 3-8 分钟）
- **逻辑**:
  - 检查 `.node` 文件存在
  - 验证是 ELF x86-64 格式
  - 满足条件则跳过 rebuild
- **强制重建**: 支持环境变量 `FORCE_REBUILD=1`

### 预期构建时间

| 平台              | 优化前    | 优化后    | 节省   |
| ----------------- | --------- | --------- | ------ |
| UOS/Linux（首次） | 30-35 min | 20-25 min | 10 min |
| UOS/Linux（后续） | 30-35 min | 10-15 min | 20 min |
| Windows           | 15-20 min | 15-20 min | -      |
| macOS             | 20-25 min | 20-25 min | -      |

### 使用方法

```bash
# 正常构建（自动检测是否需要 rebuild）
docker-compose -f docker/docker-compose.uos.yml run --rm build

# 强制重建 better-sqlite3（例如切换 Electron 版本后）
docker-compose -f docker/docker-compose.uos.yml run --rm -e FORCE_REBUILD=1 build

# 清理 named volume 缓存（完全重建）
docker volume rm zhinengti-uos-node-modules
docker-compose -f docker/docker-compose.uos.yml build
```

### 已提交的 commits

- `06549f7`: perf: add compression: gz for linux deb to speed up fpm packaging
- `48b155e`: fix: improve GLIBC version comparison and add node-gyp error check
- `45f25fe`: perf: simplify better-sqlite3 validation logic for reliability
- `930574e`: perf: skip unnecessary rebuild in Windows build to save 5-10 min

### Windows 构建优化（2026-08-05）

**优化措施**：

- 跳过 postinstall 中不必要的 `npm run rebuild`（Windows 构建已有 `prebuild:win` 下载预编译二进制）
- 改用 `--ignore-scripts` + 手动执行必要步骤（patch-package、download-node）

**效果**：

- Windows 构建时间从 15-20 分钟降到 10-15 分钟
- 节省约 5-10 分钟

**对比**：

| 平台              | 优化前    | 优化后    | 节省        |
| ----------------- | --------- | --------- | ----------- |
| UOS/Linux（首次） | 30-35 min | 20-25 min | 10 min      |
| UOS/Linux（后续） | 30-35 min | 10-15 min | 20 min      |
| Windows           | 15-20 min | 10-15 min | 5-10 min    |
| macOS             | 20-25 min | 20-25 min | -（已优化） |
