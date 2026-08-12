#!/bin/bash
set -e

echo "Testing build fix...")
echo "=========================="

# Clean any existing builds
if [ -d "dist" ]; then
  echo "Removing existing dist/..."
  rm -rf dist
fi
if [ -d "dist-electron" ]; then
  echo "Removing existing dist-electron/..."
  rm -rf dist-electron
fi

# Check if Windows native modules exist
if [ ! -d "resources/node/win32-x64" ]; then
  echo "WARNING: resources/node/win32-x64 does not exist!"
  echo "This is needed for Windows native modules."
  echo "Running electron-rebuild to generate Windows binaries..."
  
  # Try to rebuild for Windows
  mkdir -p resources/node
  # Check what native modules need to be rebuilt for Windows
  npx electron-rebuild --only better-sqlite3 @img bufferutil utf-8-validate --runtime=electron --target=41.7.1 --disturl=https://electronjs.org/headers --force 2>&1 | head -30
fi

# Check what we have
echo "Checking available native modules:"
if [ -d "resources/node/win32-x64" ]; then
  echo "  resources/node/win32-x64 exists"
  find resources/node/win32-x64 -name "*.node" 2>/dev/null | head -5
else
  echo "  resources/node/win32-x64 does not exist"
fi

# Try to build for Windows
echo ""
echo "Attempting Windows build test..."

echo "Running: npm run build -- --win --x64"

echo "Before build:
- npmRebuild: $(grep 'npmRebuild:' package.json)
- signAndEditExecutable: $(grep 'signAndEditExecutable:' package.json)
- afterPack script: $(ls -la scripts/after-pack.js)"

# Try a simple build test (just checking if it works)
mkdir -p .build-cache
echo "Building with clean environment..."

# Set minimal environment
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# Build
try {
  # Make after-pack.js executable
  chmod +x scripts/after-pack.js
  
  # Try the build
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run build -- --win --x64 2>&1 | tail -50
} catch {
  echo "Build failed!"
  exit 1
}

echo ""
echo "Checking results..."
ls -la release/ 今点通-3.3.1-win-x64.exe 2>/dev/null || echo "release/今点通-3.3.1-win-x64.exe not found"
