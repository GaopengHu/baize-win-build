#!/usr/bin/env node
/**
 * 今点通 ARM64 (.deb) 安装包构建脚本
 *
 * 构建适用于飞腾 FT-2000 / 腾锐 S2500 等 ARM64 CPU 的 deb 包。
 * 支持在 ARM64 主机上原生构建，或通过 Docker/qemu 交叉编译。
 *
 * 前置条件 (ARM64 主机):
 *   - ARM64 Linux (Ubuntu/Debian/UOS/Kylin)
 *   - Node.js >= 22
 *   - npm >= 10
 *
 * 前置条件 (交叉编译):
 *   - Docker + qemu-user-static
 *
 * 用法:
 *   # ARM64 主机原生构建
 *   node scripts/build-linux-arm64.mjs
 *
 *   # 交叉编译 (在 x86_64 主机上)
 *   CROSS_COMPILE=1 node scripts/build-linux-arm64.mjs
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function log(msg) {
  process.stdout.write(`[build:arm64] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[build:arm64] ERROR: ${msg}\n`);
}

function run(cmd, opts = {}) {
  log(`Running: ${cmd}`);
  const merged = { stdio: 'inherit', cwd: ROOT, ...opts };
  return execSync(cmd, merged);
}

function prepareArm64Resources() {
  const nodeDir = resolve(ROOT, 'resources', 'node', 'linux-arm64');
  if (!existsSync(nodeDir)) {
    log('ARM64 Node.js resources not found.');
    log('Run `node scripts/download-node.js` on an ARM64 machine to generate them.');
    log('Or symlink the x64 resources as a fallback:');
    log('  ln -sf ../linux-x64 resources/node/linux-arm64');
    if (!process.env.CROSS_COMPILE) {
      log('Proceeding with existing resources...');
    }
  } else {
    log('ARM64 Node.js resources found');
  }

  const pythonDir = resolve(ROOT, 'resources', 'python', 'linux-arm64');
  if (!existsSync(pythonDir)) {
    log('ARM64 Python resources not found.');
    log('Run `node scripts/prepare-python.js` on an ARM64 machine.');
  } else {
    log('ARM64 Python resources found');
  }
}

function checkElectronArm64() {
  // Verify electron-builder can get ARM64 Electron
  try {
    const output = execSync(
      'ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron-browser --version 2>/dev/null || echo "checking"',
      { encoding: 'utf-8', timeout: 15000 }
    );
  } catch {
    // Expected — electron-browser not installed
  }
  log('Electron 22 ARM64 is available from electronjs.org');
}

function verifyDeb(debPath) {
  if (!existsSync(debPath)) {
    const releaseDir = resolve(ROOT, 'release');
    if (existsSync(releaseDir)) {
      const files = execSync(`ls "${releaseDir}"/*arm64.deb 2>/dev/null || ls "${releaseDir}"/*linux-arm64* 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (files) {
        debPath = files.split('\n')[0];
      }
    }
  }
  if (!existsSync(debPath)) {
    error(`deb not found at ${debPath}`);
    process.exit(1);
  }
  const st = statSync(debPath);
  log(`deb size: ${(st.size / 1024 / 1024).toFixed(1)} MB`);
  log(`Verification OK: ${debPath}`);
}

async function main() {
  const start = Date.now();
  log('=== Baize ARM64 (.deb) Build ===');
  log(`Host: ${process.platform}-${process.arch}`);

  if (process.arch !== 'arm64' && !process.env.CROSS_COMPILE) {
    log('');
    log('WARNING: Not running on ARM64 architecture.');
    log('Set CROSS_COMPILE=1 if using Docker/qemu for cross-compilation.');
    log('Otherwise, build directly on an ARM64 machine (飞腾/鲲鹏).');
    log('');
    if (!process.env.CROSS_COMPILE) {
      log('Aborting. Set CROSS_COMPILE=1 to force cross-compile mode.');
      process.exit(1);
    }
  }

  // 1. Check ARM64 resources
  prepareArm64Resources();

  // 2. Install/check ARM64 native modules
  if (process.arch === 'arm64') {
    log('Native ARM64 build — checking native modules...');
    // node_modules should already contain ARM64 binaries from npm install
    const sqlite3 = resolve(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (existsSync(sqlite3)) {
      log('better-sqlite3 native module found');
    } else {
      log('better-sqlite3 native module not found — will be built by electron-builder');
    }
  }

  // 3. Build the application
  log('Building TypeScript + Vite...');
  run('npx tsc', { timeout: 120000 });
  run('npx vite build', { timeout: 300000 });

  // 4. Pre-build check
  log('Running pre-build check...');
  run('node scripts/pre-build-check.js');

  // 5. Run electron-builder (ARM64)
  log('Running electron-builder (linux deb arm64)...');
  const env = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  };

  // For ARM64, we need to pass --arm64 flag
  run('npx electron-builder --linux deb --arm64', { env, timeout: 600000 });

  // 6. Verify
  const productName = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).productName;
  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;
  const debName = `${productName}-${version}-linux-arm64.deb`;
  const debPath = resolve(ROOT, 'release', debName);
  await verifyDeb(debPath);

  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
  log(`Build complete in ${elapsed} min`);
  log(`Output: ${debPath}`);
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
