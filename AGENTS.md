# AGENTS.md — OpenCowork 品牌替换构建项目

## 项目位置
- 项目根目录: `/home/JDJT/hgp/code/opencowork-branding`
- 基于 opencowork commit `8e60460`

## 已完成的工作

### 品牌替换
- 映射 46 个 `.ts`、6 个 `.tsx`、12 个 `.json`、10 个 `.yml`、84 个 `.md` 文件中的品牌字符串
- 修改 `globals.css` 中的 CSS 变量、字体和 Tailwind 配置
- 更新 `package.json`：`productName` → `icfcc Cowork`，`name` → `icfcc-cowork`，`author` → `icfcc <dev@icfcc.com>`
- 修改 `electron-builder.yml`：添加 `deb` 目标（category: Office），productName → "icfcc Cowork"

### Linux (.deb) 构建 — 已完成并验证
- TypeScript 编译成功
- Vite 前端构建成功
- GLIBC 兼容性修复：`better-sqlite3` 从源码重新编译（GLIBC_2.28 兼容）
- NODE_MODULE_VERSION 修复：`npmRebuild: false` 防止 electron-builder 用系统 Node.js 覆盖预编译二进制
- `.deb` 包产出: `release/icfcc Cowork-3.3.1-linux-amd64.deb`（111 MB）
- 发布产物: `release/icfcc Cowork-3.3.1-linux-amd64.deb`、`release/latest-linux.yml`

### Windows (.exe) 构建问题 — 当前会话工作

#### 问题
Windows 安装包 `白泽-3.3.1-win-x64.exe` 安装后，`白泽.exe` 无法运行，报错 "not a valid Win32 application"。

#### 调试过程
1. 移除 `signing` 和 `draftTarget` 配置后 Windows 构建成功
2. 确认 `win-6878-unpacked` 目录中的 `白泽.exe` 也是无效的（问题不在 NSIS 打包阶段）
3. 原始 `electron.exe` 和 deployed `白泽.exe` 在 Wine 下运行行为相同（均正常运行），但在实际 Windows 上原始 exe 可以但 deployed exe 不行
4. 用 `python3-readpe` 对比 PE 结构，发现 `.rsrc` 段被修改（`resedit` 库添加 asar integrity 资源时破坏了资源表结构）

#### 根因
`app-builder-lib` 的 `electronWin.js:addWinAsarIntegrity()` 函数使用 `resedit` npm 包（v1.7.2）来修改 PE 文件的 `.rsrc` 段，添加 `INTEGRITY/ELECTRONASAR` 资源。但 Electron 41 的 exe 有 14 个 PE 段和 LZMA 压缩的复杂结构，`resedit` 的 `NtExecutable.generate()` 生成的 PE 文件不符合规范，导致 Windows 拒绝加载。

关键代码路径: `electronWin.js:34-35` — `resource.outputResource(executable)` + `executable.generate()` 损坏 PE。

#### 临时修复
修改 `electronWin.js` 中的 `addWinAsarIntegrity` 函数，跳过 `resedit` 的 PE 修改操作：
- 修复后 `白泽.exe` 与原始 `electron.exe` 字节完全一致（223,073,280 bytes，100% 相同）

#### 未完成的工作
- [ ] 永久修复方案（postinstall 脚本或 patch-package 使修复在 `npm install` 后不丢失）
- [ ] 在实际 Windows 上验证修复后的 exe 能正常运行
- [ ] 考虑向 electron-builder 上游报告 resedit 兼容性问题

## 构建命令

```bash
cd /home/JDJT/hgp/code/opencowork-branding

# Linux deb
npm run build:mcp && npx tsc && npx vite build && npx electron-builder --linux deb

# Windows exe
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win --x64
```

## 关键配置
- `npmRebuild: false` — 防止 electron-builder 用系统 Node.js 覆盖预编译二进制
- `signAndEditExecutable: false` — 跳过签名（无 Windows 证书）
- `electron-builder.yml` — 主配置文件，productName = "icfcc Cowork"，NSIS installer

## 关键文件
- `node_modules/app-builder-lib/out/electron/electronWin.js` — 已打补丁的 asar integrity 处理函数
- `electron-builder.yml` — 构建配置
- `package.json` — 项目配置和脚本
- `scripts/after-pack.js` — 清理 koffi/better-sqlite3/ngrok 平台特定文件
- `patches/` — （待创建）patch-package 补丁目录

## 使用的工具
- 使用 npmmirror.com ELECTRON_MIRROR 加速 Electron 下载（中国镜像）
- electron-builder v26.8.1
- Electron v41.7.1
- Wine 4.0（仅在 Linux 上做基本验证）
- python3-readpe 用于 PE 结构分析
