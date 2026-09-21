#!/usr/bin/env node
/**
 * 今点通 Windows 7/8 安装包构建脚本
 *
 * 在 Linux 主机上交叉编译 Windows x86_64 安装包。
 * 自动处理:
 *   - better-sqlite3 Windows PE 二进制下载/替换
 *   - electron-builder 镜像加速
 *   - 构建产物验证
 *
 * 用法:
 *   node scripts/build-win7.mjs
 *   CACHE_ROOT=/path/to/cache node scripts/build-win7.mjs   # 自定义缓存
 */

import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ============================================================
// Docker-only 强制检测
// 禁止在本地环境直接运行构建脚本，所有构建必须在 Docker 容器中进行
// ============================================================
function isInsideDocker() {
  try {
    return require('fs').existsSync('/.dockerenv');
  } catch {
    return false;
  }
}
if (!isInsideDocker() && process.env.INSIDE_DOCKER !== 'true') {
  console.error('\n\x1b[31m错误：禁止在本地环境直接构建安装包！x1b[0m');
  console.error('所有构建必须在 Docker 容器中执行。\n');
  console.error('用法:');
  console.error('  \x1b[36mdocker-compose -f docker/docker-compose.yml build\x1b[0m');
  console.error('  \x1b[36mdocker-compose -f docker/docker-compose.yml run --rm build\x1b[0m\n');
  process.exit(1);
}
// ============================================================

function log(msg) {
  process.stdout.write(`[build:win7] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[build:win7] ERROR: ${msg}\n`);
}

function run(cmd, opts = {}) {
  log(`Running: ${cmd}`);
  const merged = { stdio: 'inherit', cwd: ROOT, ...opts };
  return execSync(cmd, merged);
}

function writePlatformConfig() {
  const config = {
    platform: process.env.TARGET_PLATFORM || 'win32',
    prettyName: process.env.TARGET_PRETTY_NAME || 'windows',
    shell: process.env.TARGET_SHELL || 'powershell.exe',
  };
  const resourcesDir = resolve(ROOT, 'resources');
  if (!existsSync(resourcesDir)) {
    mkdirSync(resourcesDir, { recursive: true });
  }
  const configPath = resolve(resourcesDir, 'platform-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`Platform config written: ${configPath} -> ${JSON.stringify(config)}`);
}

function checkPatches() {
  const patches = [
    'app-builder-lib+26.8.1.patch',
    '@mariozechner+pi-tui+0.60.0.patch',
    '@mariozechner+pi-ai+0.60.0.patch',
  ];
  for (const p of patches) {
    if (!existsSync(resolve(ROOT, 'patches', p))) {
      error(`Missing patch: ${p}. Run 'npm install' first.`);
      process.exit(1);
    }
  }
  log('All patches present');
}

function downloadWinBinary() {
  if (process.platform === 'win32') {
    log('Running on Windows — no cross-compile binary swap needed');
    return;
  }
  const outFile = resolve(
    ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'
  );
  if (existsSync(outFile)) {
    const buf = readFileSync(outFile);
    if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
      log('Windows better_sqlite3.node already in place');
      return;
    }
    log('Existing .node is NOT a PE binary — replacing');
  }
  log('Downloading Windows better-sqlite3 binary...');
  run('node scripts/download-win-better-sqlite3.mjs');
}

async function verifyExe(exePath) {
  if (!existsSync(exePath)) {
    error(`Installer not found: ${exePath}`);
    process.exit(1);
  }
  const st = statSync(exePath);
  log(`Installer size: ${(st.size / 1024 / 1024).toFixed(1)} MB`);

  const buf = readFileSync(exePath).subarray(0, 2);
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    log('PE header valid (MZ)');
  } else {
    error(`Invalid PE header: ${buf.toString('hex')}`);
    process.exit(1);
  }
  log(`Verification OK: ${exePath}`);
}

async function main() {
  const start = Date.now();
  log('=== 今点通 Windows 7/8 Build ===');

  // 1. Verify environment
  checkPatches();

  // 2. Download Windows better-sqlite3 binary
  downloadWinBinary();

  // 3. Build the application (TypeScript + Vite)
  log('Building TypeScript + Vite...');
  // Use the local tsc binary directly to avoid npx's /bin/sh spawn and any
  // network resolution delays inside the container.
  run('node node_modules/typescript/bin/tsc', { timeout: 900000 });
  // Vite builds both the renderer and Electron main/preload bundles. On
  // Docker Desktop with a bind-mounted workspace, the main bundle can take
  // longer than five minutes while transforming dependencies.
  // Remove stale main-process chunks so old bundles never leak into the asar
  run('npx rimraf dist-electron', { timeout: 60000 });
  run('npx vite build', { timeout: 900000 });

  // 4. Pre-build check — build-win7.mjs always targets Windows, even when the
  // container host platform is linux. Force the target so the Node-binary /
  // agent checks validate win32 resources instead of the host platform.
  process.env.TARGET_PLATFORM = process.env.TARGET_PLATFORM || 'win32';
  process.env.TARGET_PRETTY_NAME = process.env.TARGET_PRETTY_NAME || 'windows';
  process.env.TARGET_SHELL = process.env.TARGET_SHELL || 'powershell.exe';
  log('Running pre-build check...');
  run('node scripts/pre-build-check.js');

  // 5. Write platform config
  log('Writing platform config...');
  writePlatformConfig();

  // 6. Run electron-builder
  log('Running electron-builder (win x64)...');
  const env = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
    // Build for the Windows target even when the pre-build check ran under
    // the container platform (linux) — otherwise the Node/binary checks
    // validate the wrong platform and electron-builder gets no target hint.
    TARGET_PLATFORM: process.env.TARGET_PLATFORM || 'win32',
    TARGET_PRETTY_NAME: process.env.TARGET_PRETTY_NAME || 'windows',
    TARGET_SHELL: process.env.TARGET_SHELL || 'powershell.exe',
  };
  // Docker Desktop bind mount 文件 I/O 慢 + 依赖树重复包多，打包/asar/NSIS 阶段
  // 实测可超过 30 分钟，超时放宽到 90 分钟。
  run('npx electron-builder --win --x64', { env, timeout: 5400000 });

  // 7. Verify
  const productName = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).productName;
  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;
  const exeName = `${productName}-${version}-win-x64.exe`;
  const exePath = resolve(ROOT, 'release', exeName);
  await verifyExe(exePath);

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  log(`Build complete in ${elapsed} min`);
  log(`Output: ${exePath}`);
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});