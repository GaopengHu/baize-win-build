/**
 * Download the Windows prebuilt binary for better-sqlite3.
 *
 * Replaces node_modules/better-sqlite3/build/Release/better_sqlite3.node
 * with the Windows PE binary from GitHub Releases so that
 * cross-compiling on Linux produces a working Windows exe.
 *
 * Usage:
 *   node scripts/download-win-better-sqlite3.mjs
 *   WIN_BETTER_SQLITE3_BIN_DIR=… node scripts/download-win-better-sqlite3.mjs
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(
  process.env.WIN_BETTER_SQLITE3_BIN_DIR || ROOT,
  'node_modules', 'better-sqlite3', 'build', 'Release',
);
const OUT_FILE = resolve(OUT_DIR, 'better_sqlite3.node');

const CACHE = resolve(
  process.env.HOME || '/home', '.npm', '_prebuilds',
  'f8d5ad-better-sqlite3-v9.6.0-electron-v110-win32-x64.tar.gz',
);

async function main() {
  if (process.platform !== 'linux') {
    console.log(`[win-better-sqlite3] host=${process.platform}, not cross-compiling — skip`);
    process.exit(0);
  }

  // Skip if target file already exists and is a valid PE binary
  if (existsSync(OUT_FILE)) {
    const buf = readFileSync(OUT_FILE).subarray(0, 2);
    if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
      console.log(`[win-better-sqlite3] OK ${OUT_FILE} (already in place)`);
      return;
    }
    console.log(`[win-better-sqlite3] Existing .node is NOT a PE binary — replacing`);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // Use cached prebuild from npm _prebuilds if available
  if (existsSync(CACHE)) {
    console.log(`[win-better-sqlite3] Using cached ${CACHE}`);
    execSync(`tar -xzf "${CACHE}" --strip-components=2 -C "${OUT_DIR}"`, { stdio: 'inherit' });
  } else {
    console.log(`[win-better-sqlite3] Running prebuild-install to download win32 binary`);
    execSync(
      `npx prebuild-install --runtime electron --target 22.3.27 --platform win32 --arch x64 --force`,
      { cwd: resolve(OUT_DIR, '..', '..'), stdio: 'inherit' },
    );
  }

  if (!existsSync(OUT_FILE)) {
    console.error(`[win-better-sqlite3] FAIL: ${OUT_FILE} not found`);
    process.exit(1);
  }

  console.log(`[win-better-sqlite3] OK ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(`[win-better-sqlite3] FAIL: ${err.message}`);
  process.exit(1);
});
