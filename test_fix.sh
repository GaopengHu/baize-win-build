#!/bin/bash
set -e

REPO_PATH="/home/JDJT/hgp/code/opencowork-branding"
TEST_REPO_PATH="/home/JDJT/hgp/code/test_0624/opencode/2024-06-30"

# Create build cache directory
mkdir -p $TEST_REPO_PATH/build-cache

# Copy the fix to test
if [ -d "$REPO_PATH" ] && [ "$REPO_PATH" != "$TEST_REPO_PATH" ]; then
  echo "Creating test copy from original repository..."
  cp -r $REPO_PATH/. $TEST_REPO_PATH/ --exclude=.git
fi

# Go to test repo
cd $TEST_REPO_PATH

# Clean any previous builds
if [ -d "dist" ]; then
  rm -rf dist
fi
if [ -d "dist-electron" ]; then
  rm -rf dist-electron
fi
if [ -d "dist-mcp" ]; then
  rm -rf dist-mcp
fi
if [ -d "release" ]; then
  rm -rf release
fi

# Clean node build artifacts
if [ -d "node_modules/.bin" ]; then
  ls node_modules/.bin | grep -E "(electron|electron-builder|electron-rebuild)" | xargs rm -f 2>/dev/null || true
fi

# Make critical scripts executable
chmod +x scripts/after-pack.js
chmod +x scripts/build-windows.js

# Check if we need to rebuild native modules for Windows
if [ ! -d "resources/node/win32-x64" ]; then
  echo "Building native modules for Windows platform..."
  # Clean up existing native modules to force rebuild
  rm -rf resources/node/linux-x64 resources/node/darwin-x64 2>/dev/null || true
  
  # Run rebuild with architecture-specific settings
  npx electron-rebuild --only better-sqlite3 @img bufferutil utf-8-validate --runtime=electron --target=41.7.1 --disturl=https://electronjs.org/headers --force --force 2>&1 | tail -30
fi

# Verify Windows native modules exist
if [ ! -d "resources/node/win32-x64" ]; then
  echo "ERROR: Windows native modules (win32-x64) still missing after rebuild!"
  echo "This is the root cause of the build failure."
  exit 1
fi

# List native modules
nodefiles=""
if [ -d "resources/node/win32-x64" ]; then
  nodefiles=$(find resources/node/win32-x64 -name "*.node" 2>/dev/null)
  echo "Found Windows native modules (.node files):"
  for f in $nodefiles; do
    echo "  - $(basename $f)"
  done
else
  echo "ERROR: resources/node/win32-x64 is empty or missing!"
  exit 1
fi

# Set up environment for cross-platform build
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# Run the build script
echo "Running Windows build..."
echo "======================================"

# Build the project
echo "Running: electron-builder --win --x64"
echo "Environment: npmRebuild=$(grep 'npmRebuild:' package.json), signAndEditExecutable=$(grep 'signAndEditExecutable:' package.json)"

electron-builder --win --x64 2>&1 | tail -100

# Check results
echo ""
echo "Checking build results..."
echo "===================================="

# Check what was produced
if [ -f "release/白泽-3.3.1-win-x64.exe" ]; then
  exe_size=$(stat -c%s "release/白泽-3.3.1-win-x64.exe" 2>/dev/null || echo "0")
  echo "✓ Windows exe created: release/白泽-3.3.1-win-x64.exe (${exe_size} bytes)"
  
  # Try to run file command to check if it's a valid PE executable
  if command -v file >/dev/null 2>&1; then
    file_result=$(file "release/白泽-3.3.1-win-x64.exe" 2>/dev/null || echo "unknown")
    echo "File type: $file_result"
  fi
else
  echo "ERROR: release/白泽-3.3.1-win-x64.exe not found!"
  echo "Build failed."
  exit 1
fi

echo ""
echo "Build verification complete!"
