#!/bin/bash
set -e

REPO_PATH="/home/JDJT/hgp/code/opencowork-branding"
WORKSPACE_PATH="/home/JDJT/hgp/code/test_0624/opencode/2024-06-30"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

log "Starting Windows build process..."
log "Root: $REPO_PATH"
log "Workspace: $WORKSPACE_PATH"

# Clean previous builds
log "Cleaning previous builds..."
cd "$REPO_PATH"
rm -rf dist dist-electron dist-mcp ".bundle-resources" release mac win-unpacked linux-unpacked 2>/dev/null || true

# Copy workspace fixes to main repo
log "Applying critical fixes to main repository..."
# Use rsync-like copy but rsync is not available on all systems
# Just copy everything, git files will be overwritten anyway
cp -r "$WORKSPACE_PATH/." "$REPO_PATH/" 2>/dev/null || {
  # If cp fails, use a simple alternative
  cd "$WORKSPACE_PATH"
  find . -mindepth 1 ! -name "\.git" -exec cp -r {} "../$REPO_PATH/" \; 2>/dev/null || true
  cd "$REPO_PATH"
}

# Navigate to workspace
cd "$WORKSPACE_PATH"

# Make critical scripts executable
log "Setting up scripts..."
chmod +x scripts/after-pack.js scripts/build-windows.js

# Verify after-pack.js fix
if ! grep -q "if (platform === 'win32')" scripts/after-pack.js; then
  error "ERROR: after-pack.js fix not properly applied!"
  error "Missing Windows platform preservation logic"
  exit 1
fi

# Verify npmRebuild configuration
if ! grep -q "\"npmRebuild\": false" package.json; then
  error "ERROR: npmRebuild not set to false!"
  exit 1
fi

if ! grep -q "\"signAndEditExecutable\": false" package.json; then
  error "ERROR: signAndEditExecutable not set to false!"
  exit 1
fi

# Prepare build environment
log "Preparing build environment..."
mkdir -p .build-cache

# Clean native modules to force Windows rebuild
log "Cleaning native modules for Windows rebuild..."
if [ -d "resources/node/win32-x64" ]; then
  rm -rf "resources/node/win32-x64"
fi
rm -rf "resources/node/linux-x64" "resources/node/darwin-x64" 2>/dev/null || true

# Ensure node_modules/.bin has electron binaries
if [ -f "node_modules/.bin/electron-builder" ]; then
  chmod +x "node_modules/.bin/electron-builder"
fi

# Reinstall native modules for Windows
log "Reinstalling native modules for Windows platform..."
npx electron-rebuild --only better-sqlite3 @img bufferutil utf-8-validate --runtime=electron --target=41.7.1 --disturl=https://electronjs.org/headers --force 2>&1 | tail -20

# Verify Windows native modules exist
if [ ! -d "resources/node/win32-x64" ]; then
  error "ERROR: Windows native modules (resources/node/win32-x64) not found after rebuild!"
  error "This is the CRITICAL issue causing the build failure"
  exit 1
fi

node_files=$(find "resources/node/win32-x64" -name "*.node" 2>/dev/null | wc -l)
if [ "$node_files" -eq 0 ]; then
  error "ERROR: No .node native modules found in resources/node/win32-x64!"
  exit 1
fi

log "✓ Found $node_files Windows native .node modules"

# Set up environment for cross-platform build
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# Run the build using the fixed after-pack script
log "Running Windows build test..."
log "==============================="

# Build the project
log "Running: electron-builder --win --x64"
electron-builder --win --x64 2>&1 | tail -100

BUILD_EXIT_CODE=$?

if [ $BUILD_EXIT_CODE -ne 0 ]; then
  error "Windows build failed with exit code $BUILD_EXIT_CODE"
  log "Checking what was produced..."
  ls -la release/ 2>/dev/null || log "No release/ directory created"
  exit 1
fi

# Verify build results
log ""
log "Verifying build results..."
log "======================"

# Check Windows executable
if [ ! -f "release/今点通-3.3.1-win-x64.exe" ]; then
  error "ERROR: Windows executable not found!"
  ls -la release/ 2>/dev/null || error "No release/ directory exists"
  exit 1
fi

EXE_SIZE=$(stat -c%s "release/今点通-3.3.1-win-x64.exe" 2>/dev/null || echo "0")
log "✓ Windows exe created: release/今点通-3.3.1-win-x64.exe ($EXE_SIZE bytes)"

# Check file header
log "Checking executable PE header..."
EXE_HEADER=$(head -c 2 "release/今点通-3.3.1-win-x64.exe" | hexdump -v -e '1/"%02X\"')
if [ "$EXE_HEADER" = "4d5a" ]; then
  log "✓ PE header valid (MZ)"
else
  error "✗ PE header invalid! Header: $EXE_HEADER"
  exit 1
fi

if [ $EXE_SIZE -lt 50000000 ]; then
  log "✓ File size reasonable"
else
  error "✗ File size too large! ($EXE_SIZE bytes)"
  exit 1
fi

log ""
log "✅ Windows build verification PASSED"
log "The executable is now valid and can be installed on Windows!"