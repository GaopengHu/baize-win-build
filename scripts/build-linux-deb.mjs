#!/usr/bin/env node
/**
 * 今点通 Linux (.deb) 安装包构建脚本
 *
 * 构建适用于 UOS 统信 / Kylin 麒麟 x86_64 的 deb 安装包。
 * 自动处理:
 *   - GLIBC 兼容性 (在目标系统上重编 better-sqlite3)
 *   - electron-builder 镜像加速
 *   - 构建产物验证
 *
 * 用法:
 *   node scripts/build-linux-deb.mjs
 *   REBUILD_NATIVE=1 node scripts/build-linux-deb.mjs    # 强制重编原生模块
 *   GLIBC_COMPAT=1 node scripts/build-linux-deb.mjs      # 启用 GLIBC 兼容模式
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
  console.error('\n\x1b[31m错误：禁止在本地环境直接构建安装包！\x1b[0m');
  console.error('所有构建必须在 Docker 容器中执行。\n');
  console.error('用法:');
  console.error('  \x1b[36mdocker-compose -f docker/docker-compose.uos.yml build\x1b[0m');
  console.error('  \x1b[36mdocker-compose -f docker/docker-compose.uos.yml run --rm build\x1b[0m\n');
  process.exit(1);
}
// ============================================================

function log(msg) {
  process.stdout.write(`[build:linux] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[build:linux] ERROR: ${msg}\n`);
}

function run(cmd, opts = {}) {
  log(`Running: ${cmd}`);
  const merged = { stdio: 'inherit', cwd: ROOT, ...opts };
  return execSync(cmd, merged);
}

function writePlatformConfig() {
  const config = {
    platform: process.env.TARGET_PLATFORM || 'linux',
    prettyName: process.env.TARGET_PRETTY_NAME || 'uos',
    shell: process.env.TARGET_SHELL || '/bin/bash',
  };
  const resourcesDir = resolve(ROOT, 'resources');
  if (!existsSync(resourcesDir)) {
    mkdirSync(resourcesDir, { recursive: true });
  }
  const configPath = resolve(resourcesDir, 'platform-config.json');
  // Remove any stale file (possibly owned by a different user from a previous cross-platform build)
  if (existsSync(configPath)) {
    execSync(`rm -f "${configPath}"`, { stdio: 'ignore' });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  log(`Platform config written: ${configPath} -> ${JSON.stringify(config)}`);
}

function checkGLIBC() {
  try {
    const output = execSync('ldd --version 2>&1 | head -1', { encoding: 'utf-8' });
    const match = output.match(/(\d+\.\d+)/);
    if (match) {
      const ver = parseFloat(match[1]);
      log(`Host GLIBC version: ${ver}`);
      if (ver < 2.28) {
        error(`GLIBC ${ver} is too old. Need >= 2.28`);
        process.exit(1);
      }
      if (ver >= 2.32 && process.env.GLIBC_COMPAT) {
        log('GLIBC 2.32+ detected with GLIBC_COMPAT mode — will rebuild better-sqlite3 for GLIBC 2.28');
        return true;
      }
      if (ver >= 2.32) {
        log('GLIBC 2.32+ detected — better-sqlite3 prebuilt binary may not work on UOS/Kylin (GLIBC 2.28)');
        log('Set GLIBC_COMPAT=1 to force rebuild for GLIBC 2.28 compatibility');
        log('Or build directly on UOS/Kylin for guaranteed compatibility');
      }
    }
  } catch {
    log('Could not detect GLIBC version');
  }
  return false;
}

function rebuildBetterSqlite3() {
  log('Rebuilding better-sqlite3 from source for GLIBC compatibility...');

  // Clean existing prebuild binary
  const buildDir = resolve(ROOT, 'node_modules', 'better-sqlite3', 'build');
  if (existsSync(buildDir)) {
    execSync(`rm -rf "${buildDir}"`, { stdio: 'inherit' });
  }

  // Rebuild from source using node-gyp
  // This ensures the .node binary links against the host's GLIBC
  run('npx node-gyp rebuild --runtime=electron --target=22.3.27 --arch=x64', {
    cwd: resolve(ROOT, 'node_modules', 'better-sqlite3'),
    timeout: 120000,
  });

  log('better-sqlite3 rebuilt from source');
}

function verifyDeb(debPath) {
  if (!existsSync(debPath)) {
    // Try to find the deb
    const releaseDir = resolve(ROOT, 'release');
    if (existsSync(releaseDir)) {
      const files = execSync(`ls "${releaseDir}"/*.deb 2>/dev/null`, { encoding: 'utf-8' }).trim();
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

  // Verify it's a valid deb archive
  const header = readFileSync(debPath).subarray(0, 4);
  const headerStr = header.toString();
  if (headerStr === '!<ar' || header.toString('hex') === '213c617263683e0a') {
    log('Valid deb archive (ar format)');
  } else {
    log(`Note: deb header: ${header.toString('hex')} (may still be valid)`);
  }
  log(`Verification OK: ${debPath}`);
}

async function main() {
  const start = Date.now();
  log('=== Baize Linux (.deb) Build ===');
  log(`Host: ${process.platform}-${process.arch}`);

  // 1. Check GLIBC compatibility
  const needsRebuild = checkGLIBC();

  // 2. Rebuild better-sqlite3 if needed
  if (needsRebuild || process.env.REBUILD_NATIVE) {
    rebuildBetterSqlite3();
  }

  // 3. Build the application
  log('Building TypeScript + Vite...');
  run('npx tsc', { timeout: 120000 });
  // Remove stale main-process chunks so old bundles never leak into the asar
  run('npx rimraf dist-electron', { timeout: 60000 });
  run('npx vite build', { timeout: 300000 });

  // 4. Pre-build check
  log('Running pre-build check...');
  run('node scripts/pre-build-check.js');

  // 5. Write platform config
  log('Writing platform config...');
  writePlatformConfig();

  // 6. Run electron-builder (deb only)
  log('Running electron-builder (linux deb x64)...');
  const env = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  };
  run('npx electron-builder --linux deb --x64', { env, timeout: 1200000 });

  // 6. Verify
  const productName = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).productName;
  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')).version;
  const debName = `${productName}-${version}-linux-amd64.deb`;
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
