#!/usr/bin/env node
/**
 * 编译 better-sqlite3 为 Electron 22.3.27 (ABI 110) 可加载的 .node 文件。
 *
 * - 默认 --arch=arm64：在 x86_64 Docker 容器内用 aarch64 交叉工具链
 *   （飞腾 FT-2000 / 鲲鹏 920 / 腾锐 S2500 目标，Dockerfile.uos-arm 提供工具链）。
 * - --arch=x64：本机编译（UOS x64 构建用，替代原来内联的 node-gyp 命令）。
 *
 * Headers 策略（2026-09 实测结论）:
 * - electronjs.org 国内直连被 RST；npmmirror 的 electron 镜像有二进制
 *   但没有 node-*-headers.tar.gz（404），所以 --disturl 两种都走不通。
 * - 改用 --nodedir + Node 16 headers（npmmirror node 镜像，200 可下）。
 *   better-sqlite3 走 N-API（ABI 稳定），用同大版本 headers 编译即可。
 *
 * 用法:
 *   node scripts/cross-compile-better-sqlite3.mjs [--arch=arm64|x64]
 */

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ELECTRON_VERSION = process.env.ELECTRON_VERSION?.trim() || '22.3.27';
const ARCH = (process.argv.find((a) => a.startsWith('--arch=')) || '--arch=arm64')
  .split('=')[1];
if (ARCH !== 'arm64' && ARCH !== 'x64') {
  console.error(`[cross-compile] ERROR: unsupported --arch=${ARCH} (want arm64|x64)`);
  process.exit(1);
}
// Node 16 headers（与 Electron 22 内嵌 Node 同大版本；N-API ABI 稳定， patch 版本不敏感）
const NODE_HEADERS_VERSION = process.env.NODE_HEADERS_VERSION?.trim() || 'v16.20.2';
const NODE_HEADERS_MIRROR =
  process.env.NODE_HEADERS_MIRROR?.trim() || 'https://npmmirror.com/mirrors/node/';
// headers 解包目录放在 node-gyp 缓存卷下，跨构建复用（compose 已挂载该卷）。
// 注意 tar 包顶层目录是 node-<ver>/，HEADERS_DIR 必须含这层，否则 marker 对不上。
const HEADERS_ROOT = join(homedir(), '.cache', 'node-gyp', 'node-headers');
const HEADERS_DIR = join(HEADERS_ROOT, `node-${NODE_HEADERS_VERSION}`);
const NODE_GYP_MAX_ATTEMPTS = 3;
const OUT_FILE = resolve(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

function log(msg) {
  process.stdout.write(`[cross-compile] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[cross-compile] ERROR: ${msg}\n`);
}

function ensureNodeHeaders() {
  const marker = join(HEADERS_DIR, 'include', 'node', 'node_api.h');
  if (existsSync(marker)) {
    log(`Node headers 复用: ${HEADERS_DIR}`);
    return;
  }
  mkdirSync(HEADERS_ROOT, { recursive: true });
  const tarball = `node-${NODE_HEADERS_VERSION}-headers.tar.gz`;
  const url = `${NODE_HEADERS_MIRROR.replace(/\/+$/, '')}/${NODE_HEADERS_VERSION}/${tarball}`;
  const dest = join(HEADERS_ROOT, tarball);
  log(`下载 Node headers: ${url}`);
  execSync(`curl -fsSL --retry 3 --max-time 120 -o "${dest}" "${url}"`, { stdio: 'inherit' });
  mkdirSync(HEADERS_DIR, { recursive: true });
  execSync(`tar -xzf "${dest}" -C "${HEADERS_ROOT}"`, { stdio: 'inherit' });
  if (!existsSync(marker)) {
    throw new Error(`headers 解包异常，缺少 ${marker}`);
  }
  log(`Node headers 就绪: ${HEADERS_DIR}`);
}

function main() {
  // 1. 检查工具链（arm64 需要交叉编译器，x64 用本机 gcc）
  const tc =
    ARCH === 'arm64'
      ? ['aarch64-linux-gnu-gcc', 'aarch64-linux-gnu-g++', 'aarch64-linux-gnu-ar', 'aarch64-linux-gnu-strip']
      : ['gcc', 'g++'];
  const missing = tc.filter((t) => {
    try {
      execSync(`which ${t}`, { stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    error(`编译工具链缺失: ${missing.join(', ')}`);
    if (ARCH === 'arm64') {
      error('请确认 .build-cache/debs-arm64/ 中有 .deb 包并重新构建镜像: docker-compose -f docker/docker-compose.uos-arm.yml build');
    }
    process.exit(1);
  }
  log('编译工具链 OK');

  // 2. 准备 headers（走 --nodedir，不再依赖 --disturl 下载）
  ensureNodeHeaders();

  // 3. 清理旧产物（命名卷或宿主 node_modules 中可能有其他架构的 .node）
  execSync(`rm -rf ${resolve(ROOT, 'node_modules', 'better-sqlite3', 'build')}`, { stdio: 'inherit' });

  // 4. 编译
  log(`开始编译 better-sqlite3 (Electron ${ELECTRON_VERSION} ${ARCH})...`);
  const env = { ...process.env };
  if (ARCH === 'arm64') {
    env.CC = 'aarch64-linux-gnu-gcc';
    env.CXX = 'aarch64-linux-gnu-g++';
    env.AR = 'aarch64-linux-gnu-ar';
    env.LD = 'aarch64-linux-gnu-ld';
    env.STRIP = 'aarch64-linux-gnu-strip';
    env.CROSS_COMPILE = '1';
  }
  try {
    let lastError = null;
    for (let attempt = 1; attempt <= NODE_GYP_MAX_ATTEMPTS; attempt += 1) {
      try {
        if (attempt > 1) log(`重试编译（第 ${attempt}/${NODE_GYP_MAX_ATTEMPTS} 次）...`);
        execSync(
          `npx node-gyp rebuild --runtime=electron --target=${ELECTRON_VERSION} --arch=${ARCH} --nodedir=${HEADERS_DIR} --jobs=4`,
          { env, cwd: resolve(ROOT, 'node_modules', 'better-sqlite3'), stdio: 'inherit', timeout: 1800000 },
        );
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        try {
          execSync(`rm -rf ${resolve(ROOT, 'node_modules', 'better-sqlite3', 'build')}`, { stdio: 'ignore' });
        } catch {
          // ignore cleanup errors
        }
      }
    }
    if (lastError) throw lastError;
  } catch (e) {
    error(`编译失败: ${e.message}`);
    process.exit(1);
  }

  // 5. 验证产物架构
  if (!existsSync(OUT_FILE)) {
    error(`编译产物不存在: ${OUT_FILE}`);
    process.exit(1);
  }
  const wantArm64 = ARCH === 'arm64';
  let ok = false;
  let desc = '';
  try {
    const fileOut = execSync(`file "${OUT_FILE}"`, { encoding: 'utf-8' }).toString();
    desc = fileOut.trim();
    ok = wantArm64 ? /ARM aarch64/i.test(fileOut) : /x86-64/i.test(fileOut);
  } catch {
    // file 命令不可用，直接解析 ELF header（平台无关）
    // e_ident[4] = ELF class (2 = 64-bit)；e_machine (offset 18): 0xB7 = AArch64, 0x3E = x86-64
    const buf = readFileSync(OUT_FILE);
    const elfClass = buf[4];
    const machine = buf.readUInt16LE(18);
    ok = elfClass === 2 && (wantArm64 ? machine === 0xb7 : machine === 0x3e);
    desc = `ELF解析: class=${elfClass === 2 ? '64-bit' : '32-bit'}, machine=0x${machine.toString(16)}`;
  }
  log(`产物: ${desc}`);
  if (!ok) {
    error(`产物不是 ${ARCH} 格式，编译异常！`);
    process.exit(1);
  }

  log(`better-sqlite3 ${ARCH} 编译完成`);
}

try {
  main();
} catch (e) {
  error(e.message);
  process.exit(1);
}
