#!/usr/bin/env bash
# Generates a 1024x1024 emerald-on-dark PNG using ImageMagick if no icon exists yet.
# Run from agent/ directory: bash scripts/generate-placeholder-icon.sh
# Replace with a real branded icon before shipping to users.

set -euo pipefail

ICON_DIR="src-tauri/icons"
SOURCE="${ICON_DIR}/icon.png"

mkdir -p "${ICON_DIR}"

if [[ -f "${SOURCE}" && "${1:-}" != "--force" ]]; then
  echo "Icon already exists at ${SOURCE}. Use --force to overwrite."
  exit 0
fi

if ! command -v magick >/dev/null 2>&1 && ! command -v convert >/dev/null 2>&1; then
  echo "ImageMagick (magick / convert) is required."
  echo "Install with: brew install imagemagick"
  exit 1
fi

CMD=$(command -v magick || command -v convert)

"${CMD}" -size 1024x1024 xc:'#0d1117' \
  -fill '#34d399' -draw 'circle 512,512 512,140' \
  -fill '#0d1117' -font Helvetica-Bold -pointsize 600 -gravity center -annotate +0+30 'TF' \
  "${SOURCE}"

echo "Wrote placeholder icon → ${SOURCE}"
echo "Now run: npx tauri icon ${SOURCE}"
