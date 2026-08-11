#!/bin/bash
# Verify Windows build output before deploying to actual Windows
# Checks PE structure, byte identity, fuses, and resources

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNPACKED_DIR="$PROJECT_DIR/release/win-unpacked"
ELECTRON_CACHE="/home/JDJT/.cache/electron"

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }

echo "=== Windows Build Verification ==="
echo ""

# 1. Find the deployed exe
DEPLOYED_EXE=$(find "$UNPACKED_DIR" -name "*.exe" ! -path "*/node_modules/*" ! -name "elevate.exe" ! -name "node.exe" 2>/dev/null | head -1)
if [ -z "$DEPLOYED_EXE" ]; then
    fail "No deployed exe found in $UNPACKED_DIR"
fi
pass "Found deployed exe: $(basename "$DEPLOYED_EXE") ($(stat -c%s "$DEPLOYED_EXE") bytes)"

# 2. Find original electron.exe
ORIG_EXE=$(find "$ELECTRON_CACHE" -name "electron*win32*x64.zip" 2>/dev/null | head -1)
if [ -z "$ORIG_EXE" ]; then
    warn "No cached Electron zip found, skipping byte comparison"
else
    TMPDIR=$(mktemp -d)
    unzip -q -o "$ORIG_EXE" "electron.exe" -d "$TMPDIR" 2>/dev/null
    ORIG_ELECTRON="$TMPDIR/electron.exe"
    
    if [ -f "$ORIG_ELECTRON" ]; then
        if cmp -s "$DEPLOYED_EXE" "$ORIG_ELECTRON"; then
            pass "Deployed exe is byte-identical to original electron.exe"
        else
            DIFF_COUNT=$(cmp -l "$DEPLOYED_EXE" "$ORIG_ELECTRON" | wc -l)
            warn "Deployed exe DIFFERS from original by $DIFF_COUNT bytes"
        fi
    else
        warn "Could not extract electron.exe from zip"
    fi
    rm -rf "$TMPDIR"
fi

# 3. Check PE header
MZ=$(xxd -l 2 -p "$DEPLOYED_EXE")
if [ "$MZ" = "4d5a" ]; then
    pass "PE header valid (MZ signature)"
else
    fail "Invalid PE header: $MZ"
fi

# 4. Check fuses
python3 -c "
data = open('$DEPLOYED_EXE', 'rb').read()
sentinel = b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
idx = data.find(sentinel)
if idx == -1:
    print('FAIL: Sentinel not found - not an Electron exe')
    exit(1)

length = data[idx + len(sentinel) + 1]
fuses = [data[idx + len(sentinel) + 2 + i] for i in range(length)]

fuse_names = [
    'RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable',
    'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation',
    'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot',
    'GrantFileProtocolExtraPrivileges'
]

def state_str(v):
    return {48: 'DISABLED', 49: 'ENABLED', 114: 'REMOVED', 144: 'INHERIT'}.get(v, f'UNKNOWN(0x{v:02x})')

all_ok = True
for i, name in enumerate(fuse_names):
    if i < len(fuses):
        s = state_str(fuses[i])
        status = 'OK' if fuses[i] in (48, 49, 114) else 'WARN'
        print(f'  {\"✓\" if status == \"OK\" else \"⚠\"} {name}: {s}')
        if status == 'WARN': all_ok = False

print(f'Fuses check: {\"PASS\" if all_ok else \"WARN\"} (length={length})')
"

# 5. Check for ELECTRONASAR resource
if python3 -c "
data = open('$DEPLOYED_EXE', 'rb').read()
if b'ELECTRONASAR' in data:
    print('WARN: ELECTIONASAR integrity resource found in exe (not expected)')
else:
    print('OK: No ELECTIONASAR integrity resource (expected with fix)')
" 2>&1; then
    :
fi

# 6. Check bundled node.exe
NODE_EXE=$(find "$UNPACKED_DIR" -name "node.exe" 2>/dev/null | head -1)
if [ -n "$NODE_EXE" ] && file "$NODE_EXE" | grep -q "PE32"; then
    pass "Bundled node.exe is a valid PE: $(file "$NODE_EXE" | sed 's/.*: //')"
else
    warn "No valid node.exe bundled in resources"
fi

# 7. Check file size is reasonable
SIZE=$(stat -c%s "$DEPLOYED_EXE" 2>/dev/null || echo "0")
if [ "$SIZE" -gt 100000000 ]; then
    pass "File size reasonable: $(numfmt --to=iec $SIZE)"
else
    warn "File size seems small: $SIZE bytes"
fi

# 8. Check resources exist
if [ -d "$UNPACKED_DIR/resources" ]; then
    RES_COUNT=$(find "$UNPACKED_DIR/resources" -maxdepth 1 -type f 2>/dev/null | wc -l)
    ASAR_SIZE=$(stat -c%s "$UNPACKED_DIR/resources/app.asar" 2>/dev/null || echo "0")
    if [ "$ASAR_SIZE" -gt 10000000 ]; then
        pass "app.asar present: $(numfmt --to=iec $ASAR_SIZE)"
    else
        warn "app.asar missing or too small"
    fi
else
    warn "resources/ directory missing"
fi

echo ""
echo "=== Verification Summary ==="
echo "  Exe: $(basename "$DEPLOYED_EXE")"
echo "  Size: $(numfmt --to=iec $(stat -c%s "$DEPLOYED_EXE"))"
echo "  Type: $(file "$DEPLOYED_EXE" | sed 's/.*: //')"
echo ""
echo "To test on Windows:"
echo "  1. Copy the NSIS installer: $PROJECT_DIR/release/"
echo "  2. Or test the unpacked exe directly: $DEPLOYED_EXE"
echo ""
