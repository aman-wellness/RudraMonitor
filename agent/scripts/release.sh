#!/usr/bin/env bash
# release.sh — build a signed release, generate latest.json manifest, upload everything.
#
# Workflow:
#   1. Reads the version from agent/src-tauri/tauri.conf.json (you bump it before running)
#   2. Builds the agent with the signing private key (Tauri produces .sig files)
#   3. Reads each .sig + the bundle URL into a `latest.json` manifest
#   4. Uploads bundles + latest.json to the public `releases` bucket
#
# After upload, every deployed agent (with the matching pubkey) checks every 30 min
# and silently downloads + installs the new version.
#
# Required env:
#   SUPABASE_ACCESS_TOKEN          — for upload-release.sh
#   TAURI_SIGNING_PRIVATE_KEY      — full key string (or use _PATH below)
#   TAURI_SIGNING_PRIVATE_KEY_PATH — path to ~/.tauri/rudrans-update.key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD — empty if generated without password
#
# Usage:
#   ./scripts/release.sh
#
# Notes:
#   - Run from agent/ directory (where tauri.conf.json lives one level deep).
#   - On macOS we build .dmg; on Windows .msi via cross-compile or native build.
#   - This script handles whatever artifacts exist in the build output dir.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN not set" >&2; exit 1
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  echo "ERROR: set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH" >&2; exit 1
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# If a path was provided, read its contents into the env var Tauri actually uses.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
fi

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
PROJECT_REF="${SUPABASE_PROJECT_REF:-ttjazaxjhzvrzhptrpmd}"
PUBLIC_BASE="https://${PROJECT_REF}.supabase.co/storage/v1/object/public/releases"

echo "==> Building Rudrans Agent v${VERSION}"
npm run tauri build 2>&1 | tail -20

# Build artifacts location depends on platform
BUNDLE_DIR="src-tauri/target/release/bundle"
if [ ! -d "$BUNDLE_DIR" ]; then
  # cross-target case (e.g. Apple Silicon → x86_64-apple-darwin)
  BUNDLE_DIR=$(find src-tauri/target -type d -name bundle | head -1)
fi
echo "==> Looking for artifacts in $BUNDLE_DIR"

# Collect platform-specific update artifacts. Tauri produces:
#   macOS:   .app.tar.gz + .app.tar.gz.sig
#   Windows: .msi.zip    + .msi.zip.sig    (or .nsis.zip)
#   Linux:   .AppImage.tar.gz + .sig
declare -A PLATFORMS

push() {
  local platform="$1" archive="$2" sig_file="$3"
  if [ ! -f "$archive" ] || [ ! -f "$sig_file" ]; then return; fi
  local remote="$(basename "$archive")"
  bash scripts/upload-release.sh "$archive" "$remote"
  local sig="$(cat "$sig_file")"
  PLATFORMS[$platform]="{\"signature\":\"$sig\",\"url\":\"$PUBLIC_BASE/$remote\"}"
}

# macOS (universal or per-arch)
for f in "$BUNDLE_DIR/macos/"*.app.tar.gz; do
  [ -f "$f" ] && push "darwin-x86_64" "$f" "${f}.sig" && push "darwin-aarch64" "$f" "${f}.sig"
done
# Windows
for f in "$BUNDLE_DIR/msi/"*.msi.zip; do
  [ -f "$f" ] && push "windows-x86_64" "$f" "${f}.sig"
done
for f in "$BUNDLE_DIR/nsis/"*.nsis.zip; do
  [ -f "$f" ] && push "windows-x86_64" "$f" "${f}.sig"
done
# Linux
for f in "$BUNDLE_DIR/appimage/"*.AppImage.tar.gz; do
  [ -f "$f" ] && push "linux-x86_64" "$f" "${f}.sig"
done

# Build latest.json
PLATFORMS_JSON=""
for k in "${!PLATFORMS[@]}"; do
  if [ -n "$PLATFORMS_JSON" ]; then PLATFORMS_JSON+=','; fi
  PLATFORMS_JSON+="\"$k\":${PLATFORMS[$k]}"
done

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > /tmp/latest.json <<EOF
{
  "version": "${VERSION}",
  "notes": "Rudrans Agent v${VERSION}",
  "pub_date": "${PUB_DATE}",
  "platforms": { ${PLATFORMS_JSON} }
}
EOF

echo "==> Generated latest.json:"
cat /tmp/latest.json
echo

bash scripts/upload-release.sh /tmp/latest.json latest.json

echo
echo "✅ Release ${VERSION} live."
echo "   Manifest: ${PUBLIC_BASE}/latest.json"
echo "   Existing agents will pick this up within 30 minutes."
