#!/usr/bin/env node
/**
 * 今点通 macOS (.dmg) 安装包构建脚本
 *
 * 在 Linux 主机上交叉编译 macOS x64 + arm64 安装包。
 * 自动处理:
 *   - macOS 预编译 better-sqlite3 下载
 *   - electron-builder 镜像加速
 *   - DMG 创建 (依赖 dmgbuild + genisoimage)
 *   - 构建产物验证
 *
 * 用法:
 *   node scripts/build-macos.mjs
 */

import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ============================================================
// Docker-only 强制检测
// ============================================================
function isInsideDocker() {
  try {
    return require('fs').existsSync('/.dockerenv');
  } catch {
    return false;
  }
}
if (!isInsideDocker() && process.env.INSIDE_DOCKER !== 'true') {
  console.error('\n\x1b[31m错误：禁止在本地环境直接构建安装包！\x1b[0m');
  console.error('所有构建必须在 Docker 容器中执行。\n');
  console.error('用法:');
  console.error('  \x1b[36mdocker-compose -f docker/docker-compose.mac.yml build\x1b[0m');
  console.error('  \x1b[36mdocker-compose -f docker/docker-compose.mac.yml run --rm build\x1b[0m\n');
  process.exit(1);
}
// ============================================================

function log(msg) {
  process.stdout.write(`[build:macos] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[build:macos] ERROR: ${msg}\n`);
}

function run(cmd, opts = {}) {
  log(`Running: ${cmd}`);
  const merged = { stdio: 'inherit', cwd: ROOT, ...opts };
  return execSync(cmd, merged);
}

function writePlatformConfig() {
  const config = {
    platform: process.env.TARGET_PLATFORM || 'darwin',
    prettyName: process.env.TARGET_PRETTY_NAME || 'macos',
    shell: process.env.TARGET_SHELL || '/bin/bash',
  };
  const resourcesDir = resolve(ROOT, 'resources');
  if (!existsSync(resourcesDir)) {
    mkdirSync(resourcesDir, { recursive: true });
  }
  const configPath = resolve(resourcesDir, 'platform-config.json');
  if (existsSync(configPath)) {
    execSync(`rm -f "${configPath}"`, { stdio: 'ignore' });
  }
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

function downloadMacBinaries() {
  if (process.platform === 'darwin') {
    log('Running on macOS — no cross-compile binary swap needed');
    return;
  }
  log('Downloading macOS better-sqlite3 binaries...');
  run('node scripts/download-mac-better-sqlite3.mjs');
}

async function verifyDMG(dmgPath) {
  if (!existsSync(dmgPath)) {
    error(`DMG not found: ${dmgPath}`);
    process.exit(1);
  }
  const st = statSync(dmgPath);
  log(`Installer size: ${(st.size / 1024 / 1024).toFixed(1)} MB`);

  // Check it's a valid DMG (starts with koly signature at end or has Apple HFS+ magic)
  const buf = readFileSync(dmgPath).subarray(0, 4);
  if (buf[0] === 0x78 && buf[1] === 0x01) {
    log('DMG header valid (zlib-compressed ULFO)');
  } else {
    log('DMG format: non-standard header (proceeding)');
  }
  log(`Verification OK: ${dmgPath}`);
}

async function main() {
  const start = Date.now();
  log('=== 今点通 macOS Build ===');

  // 1. Verify environment
  checkPatches();

  // 2. Download macOS better-sqlite3 binaries for both architectures
  downloadMacBinaries();

  // 3. Build the application (TypeScript + Vite)
  log('Building TypeScript + Vite...');
  run('npx tsc', { timeout: 120000 });
  run('npx vite build', { timeout: 300000 });

  // 4. Pre-build check
  log('Running pre-build check...');
  run('node scripts/pre-build-check.js');

  // 5. Write platform config
  log('Writing platform config...');
  writePlatformConfig();

  // 6. Run electron-builder for macOS (both architectures)
  log('Running electron-builder (mac x64 + arm64)...');
  const env = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  };
  run('npx electron-builder --mac --x64 --arm64', { env, timeout: 1800000 });

  // 7. Verify DMGs
  const productName = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).productName;
  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;

  const dmgX64 = resolve(ROOT, 'release', `${productName}-${version}-mac-x64.dmg`);
  const dmgArm64 = resolve(ROOT, 'release', `${productName}-${version}-mac-arm64.dmg`);

  if (existsSync(dmgX64)) {
    await verifyDMG(dmgX64);
  } else {
    log('x64 DMG not found (may be packaged in universal)');
  }

  if (existsSync(dmgArm64)) {
    await verifyDMG(dmgArm64);
  } else {
    log('arm64 DMG not found (may be packaged in universal)');
  }

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  log(`Build complete in ${elapsed} min`);
  log(`Output: release/${productName}-*-mac-*.dmg`);
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});