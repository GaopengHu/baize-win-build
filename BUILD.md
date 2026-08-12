# 白泽 (Baize) 构建文档

## 项目概述

- 项目名: 白泽 (baize)
- 版本: 3.3.1
- 基础框架: Electron 22.3.27 + Node.js 16 + React + Vite 7
- 包管理器: npm (npmRebuild: false)
- 产品名称: 白泽
- 授权: MIT

## 快速开始 — 一键构建

```bash
# 前置: 安装依赖 (postinstall 自动应用 patches)
npm install

# ─── Windows 7/8 安装包 (在 Linux 上交叉编译) ───
npm run build:win7

# ─── UOS 统信 / Kylin 麒麟 x86_64 (.deb) ───
npm run build:linux-deb

# ─── 飞腾 ARM64 (.deb) ───
npm run build:linux-arm64
```

每个命令自动处理: TypeScript 编译 → Vite 构建 → 预检查 → electron-builder 打包 → 产物验证。

## 目录结构

```
.
├── electron-builder.yml    # electron-builder 配置 (多平台)
├── package.json            # 项目配置
├── vite.config.ts          # Vite 构建配置
├── patches/                # patch-package 补丁
│   ├── app-builder-lib+26.8.1.patch
│   ├── @mariozechner+pi-ai+0.60.0.patch
│   └── @mariozechner+pi-tui+0.60.0.patch
├── scripts/
│   ├── after-pack.js                  # 构建后清理 (保留平台特定模块)
│   ├── build-win7.mjs                 # [一键] Windows 7/8 构建
│   ├── build-linux-deb.mjs            # [一键] Linux x86_64 .deb 构建
│   ├── build-linux-arm64.mjs          # [一键] Linux ARM64 .deb 构建
│   ├── download-win-better-sqlite3.mjs  # Win better-sqlite3 二进制下载
│   ├── download-node.js               # Node.js 运行时下载
│   ├── build-windows.js               # Win 构建辅助 (仅 Windows 主机)
│   ├── bundle-mcp.js                  # MCP 服务器打包
│   ├── build-windows-artifacts.js
│   ├── compress-dmg.js                # macOS DMG 压缩
│   ├── prepare-gui-tools.js
│   ├── prepare-python.js
│   ├── pre-build-check.js
│   ├── notarize.js
│   ├── start.ps1
│   └── deploy-local.sh
├── src/main/
│   ├── stream-shim.ts      # Node 16 全局 polyfill (TransformStream, fetch)
│   └── index.ts            # 主进程入口
└── release/                # 构建输出
    ├── 白泽-3.3.1-win-x64.exe
    └── 白泽-3.3.1-linux-amd64.deb
```

---

## 一、Windows 7/8 安装包构建

### 1.1 已知问题与修复

#### 问题 A: PE 损坏 (无效的 Win32 应用程序)

**根因**: `electron-builder` v26.8.1 的 `app-builder-lib` 通过 `resedit` 库向 PE 文件写入 asar integrity 资源时，破坏了 PE 的 `.rsrc` 段结构。Electron 41+ 的 LZMA 压缩 PE 有 14 个段，`resedit` 的 `NtExecutable.generate()` 生成的 PE 不符合规范。

**修复**: `patches/app-builder-lib+26.8.1.patch` — 完全跳过 `addWinAsarIntegrity` 逻辑。

```patch
- 执行 resedit 修改 PE → PE 损坏
+ 跳过 integrity 写入，仅输出 warning
```

验证方法:
```bash
# exe 应与原始 electron.exe 字节一致
cmp release/win-unpacked/白泽.exe node_modules/electron/dist/electron.exe
```

#### 问题 B: `better_sqlite3.node` 不是有效的 Win32 应用程序

**根因**: Linux 主机上 `npmRebuild: false` 导致 Linux `.node` 文件 (ELF) 被直接打包进 Windows 安装包。

**修复**: 降级 `better-sqlite3` 从 v12.8.0 → **v9.6.0** (API 兼容，有 `electron-v110-win32-x64` 预编译二进制)。在打包前下载 Windows PE 二进制替换 Linux 二进制。

`package.json`:
```json
"better-sqlite3": "9.6.0",
"prebuild:win": "node scripts/download-win-better-sqlite3.mjs"
```

`scripts/download-win-better-sqlite3.mjs`:
- 使用 `prebuild-install --runtime electron --target 22.3.27 --platform win32 --arch x64 --force` 下载 Windows 二进制
- 下载到 `node_modules/better-sqlite3/build/Release/better_sqlite3.node`
- 缓存在 `~/.npm/_prebuilds/` 目录

#### 问题 C: RegExp `v` flag 不支持

**根因**: Electron 22 (Chrome 108/Node 16) 不支持 RegExp `/v` flag (ES2024)。

**修复**: `patches/@mariozechner+pi-tui+0.60.0.patch` — 将 `/v` 替换为 `/u`，移除 `rgiEmojiRegex`。

#### 问题 D: `TransformStream` 未定义

**根因**: Node.js 16 不默认暴露 `TransformStream`、`ReadableStream`、`WritableStream`。

**修复**: `src/main/stream-shim.ts` — 通过 `require('stream/web')` 全局 polyfill。

#### 问题 E: `fetch` 未定义

**根因**: `undici` v7.24.4 要求 **Node.js >= 20.18.1**，但 Electron 22 只有 Node.js 16。

- `npm ls undici` → 依赖树: `openai` / `pi-tui` → `undici@7.24.4`
- `undici@7.24.4` package.json: `"engines": {"node": ">=20.18.1"}`
- `require("undici")` 在 Node 16 上运行时报错，被 `catch{}` 静默吞掉

**修复**: `src/main/stream-shim.ts` — 改用 `node-fetch` v2.7.0 (支持 Node.js 4+，且已是 `openai` 的间接依赖)。保留 `undici` 作为后备。

`electron-builder.yml` 补充 files 列表:
```yaml
- node_modules/node-fetch/**/*
- node_modules/whatwg-url/**/*
- node_modules/tr46/**/*
- node_modules/webidl-conversions/**/*
```

### 1.2 关键配置

#### `vite.config.ts`
```js
// main/preload 进程
target: 'node16',
external: ['electron', 'better-sqlite3', 'bufferutil', 'utf-8-validate']

// renderer 进程
target: 'chrome108'
```

#### `electron-builder.yml` (win 相关)
```yaml
npmRebuild: false                           # 防止 electron-builder 用系统 Node 覆盖二进制
signAndEditExecutable: false                # 无 Windows 签名证书
afterPack: ./scripts/after-pack.js          # 构建后清理
asarUnpack:
  - node_modules/better-sqlite3/**/*.node   # 原生模块必须 unpack
```

#### `package.json` (关键配置)
```json
"better-sqlite3": "9.6.0",
"@types/node": "18.19.0",
"electron": "22.3.27",
"electron-store": "8.2.0",
"main": "dist-electron/main/index.js"
```

### 1.3 构建步骤

**前置条件**:
- Linux x64 主机 (Debian/Ubuntu 推荐)
- Node.js >= 22 (项目构建工具链要求)
- npm >= 10

#### 一键构建 (推荐)

```bash
cd /path/to/baize

# 安装依赖 (自动应用 patches 和下载 Node 运行时)
npm install

# 一键构建 Windows 7/8 安装包
npm run build:win7
```

`scripts/build-win7.mjs` 自动完成:
1. 检查补丁完整性
2. 下载/替换 Windows `better_sqlite3.node` PE 二进制
3. TypeScript 编译 + Vite 构建
4. 预构建检查
5. `electron-builder --win --x64` 打包 (自动使用 NPMMIRROR 加速)
6. 验证产物 PE 头和大小

#### 分步执行

```bash
# 仅下载 Windows binary
npm run prebuild:win

# 仅打包 (假设已编译)
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win --x64
```

#### 验证

```bash
# PE 头部
head -c 2 release/白泽-3.3.1-win-x64.exe | xxd   # → 4d5a (MZ)

# 大小
ls -lh release/白泽-3.3.1-win-x64.exe               # 110-140 MB

# asar 内 polyfill
asar list release/win-unpacked/resources/app.asar | grep -c node-fetch
asar list release/win-unpacked/resources/app.asar | grep -c undici
```

---

## 二、UOS (统信) / Kylin (麒麟) 构建

### 2.1 系统概述

UOS 统信和 Kylin 麒麟是国内基于 Debian 的 Linux 发行版:
- **UOS 统信**: 基于 Debian 10/11，桌面环境为 DDE (Deepin Desktop Environment)
- **Kylin 麒麟**: 基于 Debian 10/11 (服务器版) 或 Ubuntu (桌面版)

两者均使用 `deb` 包格式。electron-builder 已配置 `deb` 输出目标。

### 2.2 架构支持

| 架构 | 状态 | 说明 |
|------|------|------|
| x86_64 (amd64) | ✅ 已支持 | `electron-builder.yml` 中 `linux.target.arch: x64` |
| ARM64 (aarch64) | ⚠️ 需额外配置 | 飞腾 FT-2000/腾锐 S2500 等 CPU |
| LoongArch (龙芯) | ❌ 不支持 | Electron 官方无此架构预编译包 |

对于 x86_64 的 UOS/Kylin，直接使用现有的 `deb` 构建配置即可。
对于 ARM64 (飞腾)，需要额外配置和交叉编译。

### 2.3 x86_64 UOS/Kylin 构建步骤

#### 一键构建

```bash
cd /path/to/baize
npm install

# 一键构建 .deb 安装包
npm run build:linux-deb
```

`scripts/build-linux-deb.mjs` 自动完成:
1. 检测 GLIBC 版本，提示兼容性
2. 可选 `GLIBC_COMPAT=1` 模式从源码重编 `better-sqlite3` 以兼容 GLIBC 2.28
3. TypeScript 编译 + Vite 构建
4. 预构建检查
5. `electron-builder --linux deb --x64` 打包
6. 验证产物

> 若目标机器是 UOS 20 (GLIBC 2.28)，在构建主机上设置 `GLIBC_COMPAT=1`:
> ```bash
> GLIBC_COMPAT=1 npm run build:linux-deb
> ```
> 这将在构建前从源码重新编译 `better-sqlite3`，确保链接 GLIBC 2.28 兼容版本。

产物在 `release/白泽-3.3.1-linux-amd64.deb`。

若需要在 UOS/Kylin 上直接构建，确保安装以下依赖:

```bash
# UOS/Kylin 构建依赖 (在目标系统上执行)
sudo apt install -y \
  nodejs npm \
  build-essential \
  python3 \
  dpkg-dev \
  fakeroot

# UOS/Kylin 运行依赖 (用户机器上需要)
sudo apt install -y \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libasound2
```

### 2.4 GLIBC 兼容性

UOS/Kylin 的 GLIBC 版本通常较低:
- **UOS 20 (1050)**: GLIBC 2.28
- **Kylin V10**: GLIBC 2.28 ~ 2.31
- **Kylin V10 SP1+**: GLIBC 2.31+

#### better-sqlite3 GLIBC 兼容问题

`better-sqlite3` 的 npm prebuild 二进制可能链接了较高版本的 GLIBC (>2.31)，在 GLIBC 2.28 的 UOS 20 上会报错:
```
/lib/x86_64-linux-gnu/libc.so.6: version GLIBC_2.32 not found
```

解决方案: 在目标系统上从源码重新编译 `better-sqlite3`:

```bash
# 在 UOS/Kylin 目标系统上执行
cd /path/to/baize

# 使用目标系统的 Node.js 重新编译
npx electron-rebuild --only better-sqlite3 \
  --runtime=electron --target=22.3.27 \
  --disturl=https://electronjs.org/headers

# 或直接使用 node-gyp
cd node_modules/better-sqlite3
npx node-gyp rebuild --runtime=electron --target=22.3.27 --arch=x64
```

### 2.5 ARM64 (飞腾) 构建指南

`electron-builder.yml` 的 `linux` 部分已使用 `${arch}` 动态变量，自动适配 x64/arm64。

**前置条件**:
- ARM64 Linux 主机 (飞腾/鲲鹏) — 原生构建
- 或 Docker + qemu-user-static — 交叉编译

#### 一键构建

```bash
# ARM64 主机原生构建
npm install
npm run build:linux-arm64

# 或 x86_64 主机交叉编译
CROSS_COMPILE=1 npm run build:linux-arm64
```

`scripts/build-linux-arm64.mjs` 自动:
1. 检查运行架构 (`arm64` 或 `CROSS_COMPILE=1`)
2. 检查 ARM64 资源准备情况
3. TypeScript + Vite 构建
4. `electron-builder --linux deb --arm64` 打包
5. 验证产物

> **注意**: ARM64 构建需要:
> - `npm install` 在 ARM64 机器上执行，确保 `@img/sharp-libvips-linux-arm64` 等平台特定包正确安装
> - `resources/node/linux-arm64` — 需在 ARM64 机器上通过 `node scripts/download-node.js` 生成
> - `resources/python/linux-arm64` — 需在 ARM64 机器上通过 `npm run prepare:python:all` 生成

---

## 三、补丁管理

所有补丁使用 `patch-package` 管理，`npm install` / `npm run postinstall` 时自动应用。

### 补丁列表

| 补丁文件 | 问题 | 修复内容 |
|----------|------|----------|
| `app-builder-lib+26.8.1.patch` | PE 损坏 | 跳过 `addWinAsarIntegrity` |
| `@mariozechner+pi-ai+0.60.0.patch` | 未知 | 上游兼容性修复 |
| `@mariozechner+pi-tui+0.60.0.patch` | RegExp `v` flag | 替换 `/v` → `/u`，移除 `rgiEmojiRegex` |

### 创建新补丁

```bash
# 1. 修改 node_modules 中的文件
vim node_modules/some-package/file.js

# 2. 生成补丁
npx patch-package some-package

# 3. 补丁文件创建在 patches/ 目录
# 4. 提交补丁文件到 git
```

---

## 四、常见问题排查

### Q: 安装后提示"不是有效的 Win32 应用程序"
- 检查 exe PE 头: `head -c 2 白泽.exe | xxd` → 应为 `4d5a`
- 检查补丁是否应用: `patches/app-builder-lib+26.8.1.patch`
- 验证 exe 与原始 electron.exe 一致: `cmp 白泽.exe node_modules/electron/dist/electron.exe`

### Q: 报错 `fetch is not defined`
- 检查 `node_modules/node-fetch` 是否在 asar 中: `asar list app.asar | grep node-fetch`
- 检查 electron-builder.yml 的 files 列表是否包含 `node_modules/node-fetch/**/*`
- 检查 `dist-electron/main/index.js` 引用的 bundle 中是否有 `require("node-fetch")`

### Q: 报错 `TransformStream is not defined`
- 检查 `stream/web` 是否在 Node 16 中可用
- 检查 `src/main/stream-shim.ts` 的第一行 import 是否正确
- 检查 `index.ts` 的第一行是否为 `import './stream-shim'`

### Q: 报错 `RegExp /v flag not supported`
- 检查 `patches/@mariozechner+pi-tui+0.60.0.patch` 是否已应用
- 在 `node_modules/@mariozechner/pi-tui/` 中搜索 `/v` flag

### Q: 构建时 electron-builder 重新编译原生模块
- 检查 `electron-builder.yml` 中的 `npmRebuild: false`
- 检查 package.json 中是否有 `rebuild` 脚本在 postinstall 中运行
