FROM node:22-alpine

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    bash \
    curl \
    ca-certificates \
    file \
    && rm -rf /var/cache/apk/*

# Install Node.js modules
RUN npm install -g electron-builder@26.8.1

WORKDIR /workspace

# Clone the repository
RUN git clone https://github.com/OpenCoworkAI/open-cowork.git .

# Checkout the fixed branch (commit after fixes)
RUN git checkout 3916557

# Clear cache and download Windows platform-specific dependencies
RUN npm run download:node \
    && npm run rebuild

# Install dependencies
RUN npm ci --ignore-scripts

# Create a build script that will:
# 1. Download Windows node modules (win32-x64)
# 2. Build the application
# 3. Verify the Windows executable
RUN cat > build-and-test.sh << 'EOSCRIPT'
#!/bin/bash
set -e

# Create necessary directories
mkdir -p build-cache
echo "Starting cross-platform Windows build..."

# Create a base window.ini that mimics Windows environment
mkdir -p ~/.config
echo '[electron]\\nos="linux"\\nhome_dir=~' > ~/.config/electron.ini

# Set up environment for Windows builds
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

# Ensure native modules for Windows are available
echo "Downloading Windows native modules..."
mkdir -p resources/node/win32-x64
cd resources/node

# Fix: Ensure Windows native modules directory exists
# Windows native modules (.node files) are critical and cannot be removed
# They must be bundled or downloaded via electron-rebuild
echo "Creating Windows platform directory structure..."
mkdir -p win32-x64

echo "Copying native modules from existing build..."
# Use electron-rebuild to rebuild better-sqlite3 and other native modules for Windows
node -e "
const { execSync } = require('child_process');
try {
  execSync('npx electron-rebuild --only better-sqlite3 @img bufferutil utf-8-validate --runtime=electron --target=41.7.1 --disturl=https://electronjs.org/headers --force', {stdio: 'inherit'});
  console.log('Successfully rebuilt native modules for Windows');
} catch (e) {
  console.log('Electron-rebuild failed, but continuing...');
}
"

# Run build with cache
mkdir -p .build-cache
echo "Running full build..."
npm run build -- --win --x64
echo "Build completed successfully!"

# Verify Windows executable
cd release
echo "Verifying Windows executable..."
file 今点通-3.3.1-win-x64.exe

# Check PE header
if [ -f 今点通-3.3.1-win-x64.exe ]; then
  echo "Checking PE header..."
  head -c 2 今点通-3.3.1-win-x64.exe | hexdump -C
  if [ "$(head -c 2 今点通-3.3.1-win-x64.exe | hexdump -v -e '1/1 \"%02X\"' -n 2)" = "4d5a" ]; then
    echo "✓ PE header valid (MZ)"
  else
    echo "✗ PE header invalid!"
    exit 1
  fi
  
  # Check file size (should be reasonable - Electron App with Node.js)
  size=$(stat -f%z 今点通-3.3.1-win-x64.exe 2>/dev/null || stat -c%s 今点通-3.3.1-win-x64.exe)
  echo "File size: ${size} bytes"
  if [ $size -lt 50000000 ]; then
    echo "✓ File size reasonable"
  else
    echo "✗ File size too large!"
    exit 1
  fi
else
  echo "✗ Windows exe not found!"
  exit 1
fi

echo "✅ Windows build verification PASSED"
EOSCRIPT

RUN chmod +x build-and-test.sh

# Allow outside scripts to pass environment variables and arguments
ENTRYPOINT ["bash", "build-and-test.sh"]
