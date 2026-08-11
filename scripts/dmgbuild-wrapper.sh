#!/bin/bash
# dmgbuild-compatible wrapper for Linux cross-compilation.
# electron-builder invokes: dmgbuild -s <settings.json> <volumeName> <output.dmg>
# dmgbuild itself requires macOS hdiutil, so on Linux we build an
# ISO9660/HFS hybrid image with genisoimage (macOS mounts this fine).
set -euo pipefail

SPEC=""
args=("$@")
i=0
pos=()
while [[ $i -lt ${#args[@]} ]]; do
  arg="${args[$i]}"
  if [[ "$arg" == "-s" ]]; then
    SPEC="${args[$((i+1))]}"
    i=$((i+2))
    continue
  fi
  pos+=("$arg")
  i=$((i+1))
done

if [[ -z "$SPEC" || ${#pos[@]} -lt 2 ]]; then
  echo "Usage: dmgbuild -s <settings.json> <volumeName> <output.dmg>" >&2
  exit 1
fi

VOLUME_NAME="${pos[-2]}"
OUTPUT="${pos[-1]}"

echo "[dmgbuild-wrapper] spec=$SPEC volume=$VOLUME_NAME out=$OUTPUT" >&2

NODE="${NODE_BIN:-node}"
WORK_STAGE="$(mktemp -d)"
trap 'rm -rf "$WORK_STAGE"' EXIT
STAGE_TMP="$WORK_STAGE/stage"
OUT_TMP="$WORK_STAGE/out.dmg"
mkdir -p "$STAGE_TMP"

"$NODE" -e '
  const fs = require("fs");
  const path = require("path");
  const { execFileSync } = require("child_process");
  const spec = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const root = process.argv[2];
  for (const c of spec.contents || []) {
    if (c.path == null) continue;
    const name = c.name || path.basename(c.path);
    const dst = path.join(root, name);
    if (c.type === "link") {
      fs.symlinkSync(c.path, dst);
      console.log("[dmgbuild-wrapper] link: " + dst + " -> " + c.path);
    } else {
      execFileSync("cp", ["-a", c.path, dst]);
      console.log("[dmgbuild-wrapper] file: " + dst);
    }
  }
' "$SPEC" "$STAGE_TMP"

# electron-builder passes the volume name as positional arg; the original
# wrapper used the version from the title to keep the HFS volume id short
# (ASCII, <= 32 chars). Extract a short ASCII-safe volume name from settings.title.
VOL_NAME="$( "$NODE" -e '
  try {
    const spec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const title = spec.title || process.argv[2] || "Dmg";
    // Prefer an embedded version like "1.2.3"; fall back to sanitized title (max 27 chars).
    const m = /(\d+(?:\.\d+)+)/.exec(title);
    if (m) { console.log(m[1]); process.exit(0); }
    const clean = title.replace(/[^\x20-\x7e]/g, "-").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    console.log(clean.slice(0, 27) || "Dmg");
  } catch {
    console.log(process.argv[2] || "Dmg");
  }
' "$SPEC" "$VOLUME_NAME" )"

echo "[dmgbuild-wrapper] iso volume id: $VOL_NAME" >&2

# ISO9660 + Rock Ridge + HFS hybrid. Do NOT use -f: the .app bundle contains
# symlinks (e.g. Electron Framework.framework/Versions/Current -> A); following
# them would inline the target content and roughly double the image size.
genisoimage \
  -quiet \
  -J \
  -r \
  -h \
  -V "$VOL_NAME" \
  -o "$OUT_TMP" \
  "$STAGE_TMP" >/dev/null 2>&1 || {
    echo "genisoimage failed (volume: $VOL_NAME)" >&2
    exit 1
  }

mv -f "$OUT_TMP" "$OUTPUT"
echo "[dmgbuild-wrapper] done: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))" >&2