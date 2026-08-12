/**
 * Download Windows prebuilt binary for better-sqlite3.
 *
 * On Linux cross-compiling to Windows, the native .node file in
 * node_modules is a Linux ELF binary.  Replace it with the correct
 * Windows PE binary from GitHub Releases so the resulting exe loads
 * better_sqlite3.node without "not a valid Win32 application".
 *
 * Usage:  node scripts/download-win-better-sqlite3.js
 */

import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { get } from 'https';
import { extract } from 'tar';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PKG = 'better-sqlite3';
const VERSION = '9.6.0';
const ABI = '110'; // Electron 22 (Node 16) → v110 per node-abi
const PLATFORM = 'win32';
const ARCH = 'x64';

const TGZ = `${PKG}-v${VERSION}-electron-v${ABI}-${PLATFORM}-${ARCH}.tar.gz`;
const URL = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/${TGZ}`;
const OUT_DIR = join(ROOT, 'node_modules', PKG, 'build', 'Release');
const OUT_FILE = join(OUT_DIR, `${PKG}.node`);

async function main() {
  if (process.platform !== 'linux') {
    console.log(`[download-win-better-sqlite3] Not cross-compiling (host=${process.platform}), skipping`);
    process.exit(0);
  }

  if (existsSync(OUT_FILE)) {
    const { execFileSync } = await import('child_process');
    try {
      const out = execFileSync('file', [OUT_FILE], { encoding: 'utf8' });
      if (out.includes('PE32') || out.includes('PE32+')) {
        console.log(`[download-win-better-sqlite3] Windows binary already present at ${OUT_FILE}`);
        process.exit(0);
      }
    } catch { /* fall through — re-download */ }
  }

  console.log(`[download-win-better-sqlite3] Downloading ${URL}`);

  mkdirSync(OUT_DIR, { recursive: true });

  const tmpFile = join(OUT_DIR, `${TGZ}.tmp`);

  await new Promise((resolve, reject) => {
    const file = createWriteStream(tmpFile);
    get(URL, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${URL}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { reject(err); });
  });

  await extract({
    file: tmpFile,
    cwd: OUT_DIR,
  });

  if (!existsSync(OUT_FILE)) {
    console.error(`[download-win-better-sqlite3] ERROR: ${OUT_FILE} not found after extraction`);
    process.exit(1);
  }

  console.log(`[download-win-better-sqlite3] ✓ ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('[download-win-better-sqlite3] Failed:', err.message);
  process.exit(1);
});
