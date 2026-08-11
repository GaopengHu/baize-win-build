#!/usr/bin/env node

/**
 * Fixed after-pack hook for open-cowork project.
 *
 * Runs after the app is packed but before the installer is created.
 * Preserves essential platform-specific binaries for each target platform.
 * Handles Windows correctly, keeping win32-x64 binaries.
 */

const fs = require('fs');
const path = require('path');

/**
 * Map electron-builder arch names to package directory names for platform-specific modules.
 * Windows modules are in win32-x64, not x64.
 */
function getPlatformPackageDir(platform, arch) {
  // Windows uses win32-x64, not x64
  if (platform === 'win32') {
    // better-sqlite3, @img, bufferutil, utf-8-validate, etc.
    return `${platform}-${arch}`;
  }
  // Linux and macOS use x64 or x64/x86_64
  const linuxArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  return linuxArch;
}

/**
 * Remove entries from a directory, keeping only those in the whitelist.
 * Returns the count of removed items.
 */
function removeExcept(dir, whitelist) {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const whiteSet = new Set(whitelist.map(w => w.toLowerCase()));
  for (const entry of fs.readdirSync(dir)) {
    if (whiteSet.has(entry.toLowerCase())) continue;
    const fullPath = path.join(dir, entry);
    if (fs.lstatSync(fullPath).isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    removed++;
  }
  return removed;
}

/**
 * Recursively find directories matching a name pattern within a base path.
 */
function findDirs(basePath, dirName) {
  const results = [];
  if (!fs.existsSync(basePath)) return results;

  function walk(currentPath, depth) {
    if (depth > 8) return; // Prevent infinite recursion
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(currentPath, entry.name);
        if (entry.name === dirName) {
          results.push(fullPath);
        } else if (!entry.name.startsWith('.')) {
          walk(fullPath, depth + 1);
        }
      }
    } catch {
      // Permission errors, etc.
    }
  }

  walk(basePath, 0);
  return results;
}

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  const platform = electronPlatformName; // 'darwin', 'win32', 'linux'
  const archName = arch === 3 ? 'arm64' : arch === 1 ? 'x64' : 'ia32';

  console.log(`\n🧹 after-pack: cleaning ${platform}-${archName} build...`);

  let resourcesDir;
  if (platform === 'darwin') {
    // macOS
    const appName = `${context.packager.appInfo.productFilename}.app`;
    resourcesDir = path.join(appOutDir, appName, 'Contents', 'Resources');
  } else {
    resourcesDir = path.join(appOutDir, 'resources');
  }

  const appAsarUnpacked = path.join(resourcesDir, 'app.asar.unpacked');
  const nmUnpacked = path.join(appAsarUnpacked, 'node_modules');

  // --- 1. Remove platform-specific build artifacts ---

  // better-sqlite3: remove SQLite source and build intermediates
  const sqlitePkg = path.join(nmUnpacked, 'better-sqlite3');
  if (fs.existsSync(sqlitePkg)) {
    // deps/sqlite3/ contains the SQLite amalgamation source (~9.7MB)
    const depsDir = path.join(sqlitePkg, 'deps');
    if (fs.existsSync(depsDir)) {
      const depsSize = fs.statSync(depsDir).size;
      fs.rmSync(depsDir, { recursive: true, force: true });
      console.log(`  ✓ better-sqlite3: removed deps/ (${(depsSize / (1024 * 1024)).toFixed(1)} MB)`);
    }
    // build/Release/obj/ contains intermediate .o files (~9.6MB)
    const objDir = path.join(sqlitePkg, 'build', 'Release', 'obj');
    if (fs.existsSync(objDir)) {
      const objParentSize = fs.statSync(path.join(sqlitePkg, 'build', 'Release')).size;
      fs.rmSync(objDir, { recursive: true, force: true });
      console.log(`  ✓ better-sqlite3: removed build/Release/obj/ (${(objParentSize / (1024 * 1024)).toFixed(1)} MB)`);
    }
    // src/ contains C++ source files
    const srcDir = path.join(sqlitePkg, 'src');
    if (fs.existsSync(srcDir)) {
      fs.rmSync(srcDir, { recursive: true, force: true });
      console.log(`  ✓ better-sqlite3: removed src/`);
    }
    // macOS cross-compile: keep only the .node file matching target arch
    if (platform === 'darwin' && fs.existsSync(path.join(sqlitePkg, 'build'))) {
      const buildDir = path.join(sqlitePkg, 'build');
      const releaseNode = path.join(buildDir, 'Release', 'better_sqlite3.node');
      const archNode = path.join(buildDir, `darwin-${archName}`, 'Release', 'better_sqlite3.node');

      // Remove non-target platform dirs
      for (const sub of fs.readdirSync(buildDir)) {
        if (sub === 'Release') continue;
        if (sub.startsWith('darwin-')) {
          const subArch = sub.replace('darwin-', '');
          if (subArch !== archName) {
            const subDir = path.join(buildDir, sub);
            const rmSize = fs.statSync(subDir).size;
            fs.rmSync(subDir, { recursive: true, force: true });
            console.log(`  ✓ better-sqlite3: removed ${sub}/ (~${(rmSize / (1024 * 1024)).toFixed(1)} MB, not target arch ${archName})`);
          }
        }
      }

      // Ensure build/Release/ has the correct arch binary (bindings uses it first)
      if (fs.existsSync(archNode)) {
        const archNodeSize = fs.statSync(archNode).size;
        const releaseDir = path.dirname(releaseNode);
        if (!fs.existsSync(releaseDir)) {
          fs.mkdirSync(releaseDir, { recursive: true });
        }
        if (!fs.existsSync(releaseNode)) {
          fs.copyFileSync(archNode, releaseNode);
          console.log(`  ✓ better-sqlite3: copied ${archName} binary to build/Release/`);
        } else {
          const releaseNodeSize = fs.statSync(releaseNode).size;
          if (releaseNodeSize !== archNodeSize) {
            fs.copyFileSync(archNode, releaseNode);
            console.log(`  ✓ better-sqlite3: replaced build/Release/better_sqlite3.node with ${archName} binary`);
          }
        }
      }
    }
  }

  // koffi: remove non-target platform binaries but preserve Windows versions
  const koffiKeepDir = getPlatformPackageDir(platform, archName);
  const koffiBuildDirs = findDirs(nmUnpacked, 'koffi');

  for (const koffiPkg of koffiBuildDirs) {
    const buildKoffiDir = path.join(koffiPkg, 'build', 'koffi');
    if (fs.existsSync(buildKoffiDir)) {
      const removed = removeExcept(buildKoffiDir, [koffiKeepDir]);
      if (removed > 0) {
        console.log(`  ✓ koffi: kept ${koffiKeepDir}, removed ${removed} other platform dirs`);
      }
    }
    for (const sub of ['src', 'vendor', 'doc']) {
      const subPath = path.join(koffiPkg, sub);
      if (fs.existsSync(subPath)) {
        fs.rmSync(subPath, { recursive: true, force: true });
        console.log(`  ✓ koffi: removed ${sub}/`);
      }
    }
  }

  // bufferutil / utf-8-validate: remove non-target platform prebuilds
  for (const pkg of ['bufferutil', 'utf-8-validate']) {
    const pkgPath = path.join(nmUnpacked, pkg);
    if (!fs.existsSync(pkgPath)) continue;
    const prebuildsDir = path.join(pkgPath, 'prebuilds');
    if (!fs.existsSync(prebuildsDir)) continue;
    const keepDir = getPlatformPackageDir(platform, archName);
    const removed = removeExcept(prebuildsDir, [keepDir]);
    if (removed > 0) {
      console.log(`  ✓ ${pkg}: kept ${keepDir}, removed ${removed} other prebuild dirs`);
    }
  }

  // ngrok: remove binary (~28MB, it downloads on-demand anyway)
  const ngrokPkg = path.join(nmUnpacked, 'ngrok');
  if (fs.existsSync(ngrokPkg)) {
    const ngrokBin = path.join(ngrokPkg, 'bin');
    if (fs.existsSync(ngrokBin)) {
      fs.rmSync(ngrokBin, { recursive: true, force: true });
      console.log(`  ✓ ngrok: removed bin/ (~28MB)`);
    }
  }

  // Electron locales: keep only en, zh_CN, zh_TW
  if (platform === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    const frameworkDir = path.join(
      appOutDir, appName, 'Contents', 'Frameworks',
      'Electron Framework.framework', 'Versions', 'A', 'Resources'
    );
    if (fs.existsSync(frameworkDir)) {
      const KEEP_LOCALES = new Set(['en.lproj', 'zh_CN.lproj', 'zh_TW.lproj', 'Base.lproj']);
      let removedLocales = 0;
      for (const entry of fs.readdirSync(frameworkDir)) {
        if (!entry.endsWith('.lproj')) continue;
        if (KEEP_LOCALES.has(entry)) continue;
        fs.rmSync(path.join(frameworkDir, entry), { recursive: true, force: true });
        removedLocales++;
      }
      if (removedLocales > 0) {
        console.log(`  ✓ Electron locales: removed ${removedLocales} .lproj dirs (kept en, zh_CN, zh_TW)`);
      }
    }
  }

  // --- 2. Windows: embed icon into the .exe + preserve native modules ---

  if (platform === 'win32') {
    // Embed icon into the main .exe using resedit (pure JS).
    // signAndEditExecutable: false prevents electron-builder from using rcedit
    // (which crashes under Wine on Linux cross-compilation).
    try {
      const { NtExecutable, NtExecutableResource } = require('pe-library');
      const ResEdit = require('resedit');

      const exeName = `${context.packager.appInfo.productFilename}.exe`;
      const exePath = path.join(appOutDir, exeName);
      const icoRelPath = context.packager.config.win?.icon || 'resources/icon.ico';
      const icoPath = path.resolve(context.packager.projectDir, icoRelPath);

      if (fs.existsSync(exePath) && fs.existsSync(icoPath)) {
        const exeOrigSize = fs.statSync(exePath).size;
        console.log(`  🖼 Embedding icon into ${exeName}...`);

        const exeBin = fs.readFileSync(exePath);
        const exe = NtExecutable.from(exeBin, { ignoreCert: true });
        const res = NtExecutableResource.from(exe);

        const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
        const iconItems = iconFile.icons.map((item) => item.data);

        // RT_GROUP_ICON = 14, RT_ICON = 3
        const GROUP_ICON_TYPE = 14;
        const iconGroupEntries = res.entries.filter((e) => e.type === GROUP_ICON_TYPE);

        if (iconGroupEntries.length === 0) {
          // No existing icon group: create one with default ID 1 (Electron standard)
          ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
            res.entries, 1, 1033, iconItems
          );
          res.outputResource(exe);
          const newBinary = Buffer.from(exe.generate());
          const origMode = fs.statSync(exePath).mode;
          fs.writeFileSync(exePath, newBinary);
          fs.chmodSync(exePath, origMode);
          console.log(`  ✓ Icon embedded: created new icon group (ID=1, lang=1033)`);
        } else {
          for (const entry of iconGroupEntries) {
            ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
              res.entries, entry.id, entry.lang, iconItems
            );
          }
          res.outputResource(exe);
          const newBinary = Buffer.from(exe.generate());
          const origMode = fs.statSync(exePath).mode;
          fs.writeFileSync(exePath, newBinary);
          fs.chmodSync(exePath, origMode);
          const savedBytes = exeOrigSize - newBinary.length;
          console.log(`  ✓ Icon embedded: replaced ${iconGroupEntries.length} icon group(s)` +
            (savedBytes !== 0 ? ` (size change: ${savedBytes >= 0 ? '-' : '+'}${Math.abs(savedBytes)} bytes)` : ''));
        }
      } else {
        if (!fs.existsSync(exePath)) console.log(`  ⚠ exe not found at ${exePath}`);
        if (!fs.existsSync(icoPath)) console.log(`  ⚠ icon file not found at ${icoPath}`);
      }
    } catch (err) {
      console.error(`  ⚠ Failed to embed Windows icon: ${err.message}`);
    }

    // Preserve Windows native modules
    const winNodeDir = path.join(resourcesDir, 'node');
    console.log(`  ✓ Windows: preserving native modules in ${path.basename(winNodeDir)}`);

    // Find and report all .node files to ensure they're there
    const nodeFiles = [];
    const scanDir = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            scanDir(path.join(dir, entry.name));
          } else if (entry.name.endsWith('.node')) {
            nodeFiles.push(path.join(dir, entry.name));
          }
        }
      } catch (e) {
        // Ignore permission errors
      }
    };

    if (fs.existsSync(winNodeDir)) {
      scanDir(winNodeDir);
      console.log(`  ✓ Found ${nodeFiles.length} .node native modules in Windows resources`);
    } else {
      console.log(`  ⚠ Windows native modules directory not found at ${winNodeDir}`);
    }

    // Workaround: pre-populate elevate.exe for NSIS build step
    const nsisElevateExe = '/home/builder/.cache/electron-builder/nsis/nsis-3.0.4.1-nsis-3.0.4.1/elevate.exe';
    const resourcesDirPath = path.join(appOutDir, 'resources');
    if (fs.existsSync(nsisElevateExe)) {
      try {
        fs.copyFileSync(nsisElevateExe, path.join(resourcesDirPath, 'elevate.exe'));
        console.log(`  ✓ NSIS elevate.exe pre-populated in resources`);
      } catch (e) {
        console.log(`  ⚠ Failed to pre-populate elevate.exe: ${e.message}`);
      }
    }
  }

  console.log(`✅ after-pack cleanup complete for ${platform}-${archName}\n`);
};