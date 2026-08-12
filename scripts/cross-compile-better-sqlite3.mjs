#!/usr/bin/env node
/**
 * 交叉编译 better-sqlite3 为 ARM64 (飞腾 FT-2000 / 鲲鹏 920 / 腾锐 S2500) 版本。
 *
 * 在 x86_64 Docker 构建容器内，使用 aarch64-linux-gnu 交叉编译工具链
 * 将 better-sqlite3 编译为 ARM64 Electron 22.3.27 (ABI 110) 可加载的 .node 文件。
 *
 * 前置条件（由 Dockerfile.uos-arm 提供）:
 *   - gcc-8-aarch64-linux-gnu / g++-8-aarch64-linux-gnu
 *   - binutils-aarch64-linux-gnu / libc6-dev-arm64-cross 等
 *
 * Electron headers 通过 --disturl 下载（架构无关，仅 ~260KB，速度快）。
 *
 * 用法:
 *   node scripts/cross-compile-better-sqlite3.mjs
 */

import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ELECTRON_VERSION = '22.3.27';
const HEADERS_DISTURL = 'https://electronjs.org/headers';
const OUT_FILE = resolve(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

function log(msg) {
  process.stdout.write(`[cross-compile] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[cross-compile] ERROR: ${msg}\n`);
}

function main() {
  // 1. 检查工具链
  const tc = ['aarch64-linux-gnu-gcc', 'aarch64-linux-gnu-g++', 'aarch64-linux-gnu-ar', 'aarch64-linux-gnu-strip'];
  const missing = tc.filter((t) => {
    try {
      execSync(`which ${t}`, { stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    error(`交叉编译工具链缺失: ${missing.join(', ')}`);
    error('请确认 .build-cache/debs-arm64/ 中有 .deb 包并重新构建镜像: docker-compose -f docker/docker-compose.uos-arm.yml build');
    process.exit(1);
  }
  log('交叉编译工具链 OK');

  // 2. 清理旧产物（命名卷或宿主 node_modules 中可能有 x64 的 .node）
  execSync(`rm -rf ${resolve(ROOT, 'node_modules', 'better-sqlite3', 'build')}`, { stdio: 'inherit' });

  // 3. 交叉编译（headers 通过 --disturl 下载，架构无关）
  log(`开始交叉编译 better-sqlite3 (Electron ${ELECTRON_VERSION} ARM64)...`);
  const env = {
    ...process.env,
    CC: 'aarch64-linux-gnu-gcc',
    CXX: 'aarch64-linux-gnu-g++',
    AR: 'aarch64-linux-gnu-ar',
    LD: 'aarch64-linux-gnu-ld',
    STRIP: 'aarch64-linux-gnu-strip',
    CROSS_COMPILE: '1',
  };
  try {
    execSync(
      `npx node-gyp rebuild --runtime=electron --target=${ELECTRON_VERSION} --arch=arm64 --disturl=${HEADERS_DISTURL} --jobs=4`,
      { env, cwd: resolve(ROOT, 'node_modules', 'better-sqlite3'), stdio: 'inherit', timeout: 1800000 },
    );
  } catch (e) {
    error(`交叉编译失败: ${e.message}`);
    process.exit(1);
  }

  // 4. 验证产物架构
  if (!existsSync(OUT_FILE)) {
    error(`编译产物不存在: ${OUT_FILE}`);
    process.exit(1);
  }
  let isArm64 = false;
  try {
    const fileOut = execSync(`file "${OUT_FILE}"`, { encoding: 'utf-8' }).toString();
    log(`产物: ${fileOut.trim()}`);
    isArm64 = /ARM aarch64/i.test(fileOut);
  } catch {
    // file 命令不可用，直接解析 ELF header（平台无关）
    // e_ident[4] = ELF class (2 = 64-bit)；e_machine (offset 18) = 0xB7 (AArch64)
    const buf = readFileSync(OUT_FILE);
    const elfClass = buf[4];
    const machine = buf.readUInt16LE(18);
    isArm64 = elfClass === 2 && machine === 0xb7;
    log(`产物(ELF解析): class=${elfClass === 2 ? '64-bit' : '32-bit'}, machine=0x${machine.toString(16)} (0xb7=AArch64)`);
  }
  if (!isArm64) {
    error('产物不是 ARM64 格式，交叉编译异常！');
    process.exit(1);
  }

  log('ARM64 better-sqlite3 交叉编译完成');
}

try {
  main();
} catch (e) {
  error(e.message);
  process.exit(1);
}