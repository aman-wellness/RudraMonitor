#!/usr/bin/env bash
# Downloads upstream RustDesk releases, extracts the per-platform runtime
# tree, zips it, and uploads each to Supabase Storage at
# rustdesk/rustdesk-<target>.zip. CI's build-agent.yml then fetches these
# zips and extracts them into the agent's bundle resources before
# `tauri build`.
#
# Why zip-of-app-tree instead of a single binary: RustDesk's macOS app
# is a Flutter bundle (124KB launcher + a sibling Frameworks/ dir with
# the actual ~30MB dylib). Same shape on Linux (43KB launcher in
# /usr/bin loading from /usr/share/rustdesk/) and Windows (NSIS-installed
# tree). A standalone binary would crash on launch with "dylib not found".
#
# Required env:
#   SUPABASE_SERVICE_ROLE_KEY  — write to the `rustdesk` Storage bucket.
#
# Usage: scripts/package-rustdesk.sh [version]
#   version defaults to the upstream "latest" tag.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION=$(curl -sS https://api.github.com/repos/rustdesk/rustdesk/releases/latest \
    | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
fi
echo "▶ packaging RustDesk v$VERSION"

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY env var required" >&2
  exit 1
fi
STORAGE_URL="${SUPABASE_STORAGE_URL:-https://api.rudrans.com/storage/v1/object}"

WORK="$(mktemp -d -t rustdesk-pkg.XXXXXX)"
trap 'rm -rf "$WORK"; for m in /tmp/rd-pkg-mnt-*; do hdiutil detach "$m" -quiet 2>/dev/null || true; done' EXIT

upload() {
  local file="$1" remote="$2"
  local url="${STORAGE_URL}/rustdesk/${remote}"
  local http
  http=$(curl -sS -o /tmp/up.json -w '%{http_code}' \
    -X POST "$url" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$file")
  if [ "$http" = "409" ] || [ "$http" = "400" ]; then
    http=$(curl -sS -o /tmp/up.json -w '%{http_code}' \
      -X PUT "$url" \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$file")
  fi
  if [ "$http" = "200" ] || [ "$http" = "201" ]; then
    echo "  ✓ $remote ($(du -h "$file" | cut -f1))"
  else
    echo "  ✗ $remote failed: HTTP $http"; cat /tmp/up.json; return 1
  fi
}

# ---------- macOS arm64 + x64 ----------
for arch in aarch64:arm64 x86_64:x64; do
  upstream="${arch%%:*}"
  out="${arch##*:}"
  echo "▶ macOS-$out"
  dmg="$WORK/rd-mac-$out.dmg"
  curl -sSLo "$dmg" "https://github.com/rustdesk/rustdesk/releases/download/$VERSION/rustdesk-$VERSION-$upstream.dmg"
  mnt="/tmp/rd-pkg-mnt-$out"
  mkdir -p "$mnt"
  hdiutil attach "$dmg" -nobrowse -quiet -mountpoint "$mnt"
  stage="$WORK/stage-macos-$out"
  mkdir -p "$stage"
  cp -R "$mnt/RustDesk.app" "$stage/"
  hdiutil detach "$mnt" -quiet
  zip="$WORK/rustdesk-macos-$out.zip"
  (cd "$stage" && zip -qry "$zip" RustDesk.app)
  upload "$zip" "rustdesk-macos-$out.zip"
done

# ---------- Linux x64 ----------
echo "▶ Linux-x64"
deb="$WORK/rd-linux.deb"
curl -sSLo "$deb" "https://github.com/rustdesk/rustdesk/releases/download/$VERSION/rustdesk-$VERSION-x86_64.deb"
stage="$WORK/stage-linux-x64"
mkdir -p "$stage"
(cd "$stage" && ar x "$deb" && tar -xJf data.tar.xz)
# Layout we want inside the zip:
#   rustdesk/rustdesk            ← launcher (was usr/share/rustdesk/rustdesk)
#   rustdesk/lib/                ← libs sibling to launcher
#   rustdesk/...                 ← all other RustDesk runtime assets
linroot="$WORK/rustdesk-linux-x64/rustdesk"
mkdir -p "$linroot"
cp -R "$stage"/usr/share/rustdesk/* "$linroot/"
chmod +x "$linroot/rustdesk"
zip="$WORK/rustdesk-linux-x64.zip"
(cd "$WORK/rustdesk-linux-x64" && zip -qry "$zip" rustdesk)
upload "$zip" "rustdesk-linux-x64.zip"

# ---------- Windows x64 ----------
# The upstream rustdesk-<ver>-x86_64.exe is a portable PE binary (not an
# NSIS installer like the agent's). The Rust dylib is statically linked,
# so the exe stands alone — no sibling assets required.
echo "▶ Windows-x64"
exe="$WORK/rd-win.exe"
curl -sSLo "$exe" "https://github.com/rustdesk/rustdesk/releases/download/$VERSION/rustdesk-$VERSION-x86_64.exe"
winroot="$WORK/rustdesk-windows-x64/rustdesk"
mkdir -p "$winroot"
cp "$exe" "$winroot/rustdesk.exe"
zip="$WORK/rustdesk-windows-x64.zip"
(cd "$WORK/rustdesk-windows-x64" && zip -qry "$zip" rustdesk)
upload "$zip" "rustdesk-windows-x64.zip"

echo "✅ all 4 platforms packaged + uploaded"
