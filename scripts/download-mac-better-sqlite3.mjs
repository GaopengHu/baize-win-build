#!/usr/bin/env node

import { existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PLATFORMS = [
  { platform: 'darwin', arch: 'x64', name: 'Intel' },
  { platform: 'darwin', arch: 'arm64', name: 'Apple Silicon' },
];

function log(msg) {
  console.log(`[mac-better-sqlite3] ${msg}`);
}

function installFromTarball(tarball, outDir, label) {
  if (!existsSync(tarball)) return false;
  const size = parseInt(execSync(`stat -c%s "${tarball}"`, { encoding: 'utf-8' }).trim());
  if (size === 0) return false;
  log(`Installing from local tarball: ${tarball} (${(size/1024).toFixed(0)} KB)`);
  // Clean old nested structure in case named volume has stale files
  if (existsSync(outDir)) {
    execSync(`rm -rf "${outDir}"`, { stdio: 'ignore' });
  }
  mkdirSync(outDir, { recursive: true });
  execSync(`tar xzf "${tarball}" -C "${outDir}" --strip-components=2`, { stdio: 'inherit' });
  log(`OK (${label}): ${outDir}/better_sqlite3.node`);
  return true;
}

function tryPrebuildInstall(pkgDir, platform, arch, outDir) {
  log(`Trying prebuild-install for ${platform}-${arch}...`);
  try {
    execSync(
      `npx prebuild-install --runtime electron --target 22.3.27 --platform ${platform} --arch ${arch} --force`,
      { cwd: pkgDir, stdio: 'inherit', timeout: 300000 },
    );
    const archOutFile = resolve(outDir, 'better_sqlite3.node');
    return existsSync(archOutFile);
  } catch (err) {
    log(`prebuild-install failed: ${err.message}`);
    return false;
  }
}

function downloadFromMirror(pkgDir, platform, arch, outDir) {
  const version = '9.6.0';
  const abi = '110';
  const tarball = `better-sqlite3-v${version}-electron-v${abi}-${platform}-${arch}.tar.gz`;
  const localPaths = [`/host-tmp/${tarball}`, `/tmp/${tarball}`];
  for (const p of localPaths) {
    if (installFromTarball(p, outDir, 'host-cache')) return true;
  }

  const urls = [
    `https://npmmirror.com/mirrors/better-sqlite3/v${version}/${tarball}`,
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${tarball}`,
  ];

  for (const url of urls) {
    const tmp = `/tmp/${tarball}`;
    log(`Downloading: ${url}`);
    try {
      execSync(`curl -fsSL -o "${tmp}" "${url}" --connect-timeout 10 --max-time 300`, { stdio: 'inherit', timeout: 360000 });
      if (installFromTarball(tmp, outDir, 'curl')) {
        execSync(`rm -f "${tmp}"`, { stdio: 'ignore' });
        return true;
      }
    } catch {
      log(`Failed: ${url}`);
    }
    execSync(`rm -f "${tmp}"`, { stdio: 'ignore' });
  }
  return false;
}

async function main() {
  if (process.platform !== 'linux') {
    log(`host=${process.platform}, not cross-compiling — skip`);
    process.exit(0);
  }

  const pkgDir = resolve(ROOT, 'node_modules', 'better-sqlite3');

  for (const { platform, arch, name } of PLATFORMS) {
    const outDir = resolve(pkgDir, 'build', `${platform}-${arch}`, 'Release');
    mkdirSync(outDir, { recursive: true });

    log(`Getting better-sqlite3 for ${name} (${platform}-${arch})...`);

    if (tryPrebuildInstall(pkgDir, platform, arch, outDir)) {
      log(`OK (prebuild-install): ${name}`);
      continue;
    }

    if (downloadFromMirror(pkgDir, platform, arch, outDir)) {
      log(`OK (curl mirror): ${name}`);
      continue;
    }

    log(`FAIL: All download methods failed for ${name}`);
    process.exit(1);
  }

  log('All macOS better-sqlite3 binaries downloaded successfully');
}

main().catch((err) => {
  console.error(`[mac-better-sqlite3] FAIL: ${err.message}`);
  process.exit(1);
});
