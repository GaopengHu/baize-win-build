#!/usr/bin/env node
/**
 * 为 Electron 重编 better-sqlite3 的封装脚本（npm run rebuild / postinstall 使用）。
 *
 * 背景：better-sqlite3 是 V8 原生模块（非 N-API），.node 二进制必须匹配
 * Electron 22 的 NODE_MODULE_VERSION=110，且链接的 GLIBC 不能高于运行环境。
 *
 * 问题：
 *   - @electron/rebuild 默认会下载官方预编译二进制；该预编译包依赖
 *     GLIBC 2.29，在 UOS/Deepin（GLIBC 2.28）等系统上无法 dlopen。
 *   - 本机系统 Node 可能是 Node 22（ABI 127），直接 node-gyp 会产出错误 ABI。
 *   - @electron/rebuild 自带的 node-gyp 需要 Python >= 3.8（gyp-next 用了海象运算符），
 *     而部分国产系统默认 python3 是 3.7。
 *
 * 策略：
 *   - Linux 且宿主 GLIBC < 2.29 时，强制 --build-from-source，用 Electron headers
 *     在本机编译（链接宿主 GLIBC，ABI 110）。
 *   - 自动探测 Python >= 3.8（候选 python3.13..3.8 / python3 / python），
 *     通过 PYTHON 环境变量传给 node-gyp。
 *   - 编译后在 Electron 运行时可加载性验证（仅 Linux）。
 *   - 其他平台（Windows / macOS）保持原行为：下载预编译二进制。
 *
 * 用法:
 *   node scripts/rebuild-better-sqlite3.mjs
 *   BUILD_FROM_SOURCE=1 node scripts/rebuild-better-sqlite3.mjs   # 强制源码编译
 *   ELECTRON_VERSION=22.3.27 node scripts/rebuild-better-sqlite3.mjs
 */

import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ELECTRON_VERSION = process.env.ELECTRON_VERSION?.trim() || '22.3.27';
const TARGET_MODULE = 'better-sqlite3';
// 官方预编译包要求的最低 GLIBC；低于此值必须源码编译。
const PREBUILT_MIN_GLIBC = 2.29;

function log(msg) {
  process.stdout.write(`[rebuild:sqlite] ${msg}\n`);
}

function error(msg) {
  process.stderr.write(`[rebuild:sqlite] ERROR: ${msg}\n`);
}

/** 读取宿主 GLIBC 版本（如 2.28）；非 Linux 或读取失败返回 null。 */
function hostGLIBC() {
  if (process.platform !== 'linux') return null;
  try {
    const out = execSync('ldd --version 2>&1 | head -1', { encoding: 'utf-8' });
    const m = out.match(/(\d+\.\d+)/);
    return m ? parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

/** 返回 python 解释器的 (major, minor) 或 null。 */
function pythonVersion(cmd) {
  try {
    const out = execFileSync(cmd, ['--version'], { encoding: 'utf-8' }).trim();
    const m = out.match(/Python (\d+)\.(\d+)/);
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

/** 找出可用的 Python >= 3.8；返回可执行名或 null。 */
function findPython() {
  const candidates = [
    process.env.PYTHON,
    'python3.13',
    'python3.12',
    'python3.11',
    'python3.10',
    'python3.9',
    'python3.8',
    'python3',
    'python',
  ].filter(Boolean);
  for (const cmd of candidates) {
    const v = pythonVersion(cmd);
    if (v && v.major === 3 && v.minor >= 8) return cmd;
  }
  return null;
}

/** 用 Electron 运行时（ELECTRON_RUN_AS_NODE）实际加载 .node，验证 ABI/GLIBC。 */
function verifyLoadable() {
  if (process.platform !== 'linux') return;
  const electronBin = resolve(ROOT, 'node_modules', '.bin', 'electron');
  if (!existsSync(electronBin)) {
    log('electron 二进制不存在，跳过加载验证');
    return;
  }
  const modulePath = resolve(ROOT, 'node_modules', TARGET_MODULE);
  const probe = resolve(tmpdir(), `baze-sqlite-verify-${process.pid}.cjs`);
  writeFileSync(
    probe,
    `const Database = require(${JSON.stringify(modulePath)});\n` +
      `const db = new Database(':memory:');\n` +
      `db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)');\n` +
      `db.close();\nconsole.log('[rebuild:sqlite] Load verification OK');\n`,
  );
  try {
    execSync(`"${electronBin}" "${probe}"`, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
    });
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // ignore cleanup errors
    }
  }
}

function main() {
  let buildFromSource = process.env.BUILD_FROM_SOURCE === '1';

  if (process.platform === 'linux') {
    const glibc = hostGLIBC();
    if (glibc !== null) {
      log(`宿主 GLIBC ${glibc}`);
      if (glibc < PREBUILT_MIN_GLIBC) {
        log(
          `GLIBC ${glibc} < ${PREBUILT_MIN_GLIBC}：官方预编译包不兼容，改用源码编译`,
        );
        buildFromSource = true;
      }
    } else {
      log('无法探测 GLIBC，按默认（预编译）流程');
    }
  }

  const args = [
    '@electron/rebuild',
    '-v',
    ELECTRON_VERSION,
    '--only',
    TARGET_MODULE,
    '--force',
  ];
  if (buildFromSource) args.push('--build-from-source');

  const env = { ...process.env };
  if (buildFromSource) {
    const python = findPython();
    if (!python) {
      error(
        '源码编译需要 Python >= 3.8，但未找到可用解释器。请安装 python3.8+ 后重试。',
      );
      process.exit(1);
    }
    env.PYTHON = python;
    log(`使用 Python: ${python}`);
  }

  log(`Running: npx ${args.join(' ')}`);
  execSync(`npx ${args.join(' ')}`, { cwd: ROOT, env, stdio: 'inherit' });

  verifyLoadable();
  log('完成');
}

try {
  main();
} catch (e) {
  error(e.message);
  process.exit(1);
}
