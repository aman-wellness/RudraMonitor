#!/usr/bin/env bash
# Upload a built agent artifact (.pkg / .msi / .deb / .dmg) to the Supabase Storage
# `releases` public bucket so the dashboard's Setup page download buttons can serve it.
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_xxx ./scripts/upload-release.sh <artifact-path> [remote-name]
#
# Example:
#   SUPABASE_ACCESS_TOKEN=sbp_xxx ./scripts/upload-release.sh \
#       dist-mac/Rudrans-Agent-0.1.0.pkg Rudrans-Agent-macOS-0.1.0.pkg
#
# Looks up the project's service_role key via the management API (so we don't have
# to keep it in env / git), then PUTs the file at the canonical public URL.
#
# Env required:
#   SUPABASE_ACCESS_TOKEN  — personal access token (sbp_…) from supabase.com/dashboard/account/tokens
# Env optional:
#   SUPABASE_PROJECT_REF   — defaults to ttjazaxjhzvrzhptrpmd
#   BUCKET                 — defaults to releases

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-ttjazaxjhzvrzhptrpmd}"
BUCKET="${BUCKET:-releases}"
ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"

if [ -z "${ACCESS_TOKEN}" ]; then
  echo "ERROR: set SUPABASE_ACCESS_TOKEN (sbp_… from supabase.com/dashboard/account/tokens)" >&2
  exit 1
fi
if [ $# -lt 1 ]; then
  echo "Usage: $0 <artifact-path> [remote-name]" >&2
  exit 1
fi

LOCAL_PATH="$1"
REMOTE_NAME="${2:-$(basename "$LOCAL_PATH")}"

if [ ! -f "$LOCAL_PATH" ]; then
  echo "ERROR: file not found: $LOCAL_PATH" >&2
  exit 1
fi

echo "==> resolving service_role key for project ${PROJECT_REF}"
SR_KEY=$(curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(k['api_key'] for k in d if k['name']=='service_role'))")

if [ -z "${SR_KEY}" ]; then
  echo "ERROR: could not resolve service_role key" >&2
  exit 1
fi

UPLOAD_URL="https://${PROJECT_REF}.supabase.co/storage/v1/object/${BUCKET}/${REMOTE_NAME}"
PUBLIC_URL="https://${PROJECT_REF}.supabase.co/storage/v1/object/public/${BUCKET}/${REMOTE_NAME}"

SIZE_HUMAN=$(ls -lh "$LOCAL_PATH" | awk '{print $5}')
echo "==> uploading ${LOCAL_PATH} (${SIZE_HUMAN}) → ${BUCKET}/${REMOTE_NAME}"

# Try POST first (new object). If the object already exists, PUT (replace) handles upsert.
HTTP_CODE=$(curl -s -o /tmp/upload-resp.json -w "%{http_code}" \
  -X POST "${UPLOAD_URL}" \
  -H "Authorization: Bearer ${SR_KEY}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${LOCAL_PATH}")

if [ "${HTTP_CODE}" = "409" ] || [ "${HTTP_CODE}" = "400" ]; then
  echo "==> object exists, replacing via PUT"
  HTTP_CODE=$(curl -s -o /tmp/upload-resp.json -w "%{http_code}" \
    -X PUT "${UPLOAD_URL}" \
    -H "Authorization: Bearer ${SR_KEY}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@${LOCAL_PATH}")
fi

if [ "${HTTP_CODE}" != "200" ] && [ "${HTTP_CODE}" != "201" ]; then
  echo "ERROR: upload failed (HTTP ${HTTP_CODE})" >&2
  cat /tmp/upload-resp.json >&2
  exit 1
fi

echo
echo "Done."
echo "  Public URL: ${PUBLIC_URL}"
