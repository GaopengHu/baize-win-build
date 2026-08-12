#!/usr/bin/env node
/**
 * Download the Linux ARM64 prebuilt binary for better-sqlite3.
 *
 * Replaces node_modules/better-sqlite3/build/Release/better_sqlite3.node
 * with the ARM64 binary from npmmirror mirror for cross-compilation.
 *
 * Usage:
 *   node scripts/download-linux-arm64-better-sqlite3.mjs
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release');
const OUT_FILE = resolve(OUT_DIR, 'better_sqlite3.node');

const VERSION = 'v9.6.0';
const TARBALL = `better-sqlite3-${VERSION}-electron-v110-linux-arm64.tar.gz`;
const MIRROR_URLS = [
  `https://cdn.npmmirror.com/binaries/better-sqlite3/${VERSION}/${TARBALL}`,
  `https://npmmirror.com/mirrors/better-sqlite3/${VERSION}/${TARBALL}`,
  `https://github.com/WiseLibs/better-sqlite3/releases/download/${VERSION}/${TARBALL}`,
];
const CACHE = resolve(process.env.HOME || '/home', '.npm', '_prebuilds', TARBALL);

async function main() {
  if (process.arch !== 'x64' || process.platform !== 'linux') {
    console.log(`[linux-arm64-better-sqlite3] host=${process.platform}-${process.arch}, skip`);
    process.exit(0);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  let tarballPath = null;

  // 1. Try cache
  if (existsSync(CACHE)) {
    console.log(`[linux-arm64-better-sqlite3] Using cached: ${CACHE}`);
    tarballPath = CACHE;
  }

  // 2. Try curl from mirror URLs
  for (const url of MIRROR_URLS) {
    if (tarballPath) break;
    const tmp = `/tmp/${TARBALL}`;
    console.log(`[linux-arm64-better-sqlite3] Downloading: ${url}`);
    try {
      execSync(`curl -fsSL "${url}" -o "${tmp}"`, { stdio: 'inherit', timeout: 300000 });
      if (existsSync(tmp)) {
        tarballPath = tmp;
      }
    } catch (e) {
      console.log(`[linux-arm64-better-sqlite3] curl failed: ${e.message}`);
    }
  }

  if (!tarballPath) {
    console.error('[linux-arm64-better-sqlite3] Failed to download ARM64 binary');
    process.exit(1);
  }

  // Extract tarball to output directory
  const tmpDir = `/tmp/better-sqlite3-arm64`;
  execSync(`rm -rf ${tmpDir} && mkdir -p ${tmpDir}`, { stdio: 'inherit' });
  execSync(`tar xzf "${tarballPath}" -C "${tmpDir}"`, { stdio: 'inherit' });

  // Find the .node file
  const nodeFile = resolve(tmpDir, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(nodeFile)) {
    console.error(`[linux-arm64-better-sqlite3] .node file not found in tarball`);
    process.exit(1);
  }

  copyFileSync(nodeFile, OUT_FILE);
  console.log(`[linux-arm64-better-sqlite3] OK ${OUT_FILE}`);
  execSync(`rm -rf ${tmpDir}`, { stdio: 'ignore' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});