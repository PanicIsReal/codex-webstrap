#!/usr/bin/env bash
set -euo pipefail

URL="https://persistent.oaistatic.com/codex-app-prod/Codex.dmg"
WORK_DIR="${HOME}/.codex-relay/reverse"
FORCE="0"
DOWNLOAD_ONLY="0"

usage() {
  cat <<'USAGE'
Usage:
  reverse-codex-dmg.sh [options]

Options:
  --url <url>           DMG URL (default: OpenAI Codex DMG production URL)
  --work-dir <path>     Working directory (default: ~/.codex-relay/reverse)
  --force               Re-run extraction even when identity matches cache
  --download-only       Download + identify DMG, skip mount/extract
  -h, --help            Show this help

Outputs under work dir:
  codex.dmg
  app.asar
  extracted/
  state.json
USAGE
}

require_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "Missing value for ${flag}" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      require_value "$1" "${2:-}"
      URL="$2"
      shift 2
      ;;
    --work-dir)
      require_value "$1" "${2:-}"
      WORK_DIR="$2"
      shift 2
      ;;
    --force)
      FORCE="1"
      shift
      ;;
    --download-only)
      DOWNLOAD_ONLY="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script currently supports macOS only (requires hdiutil)." >&2
  exit 1
fi

for cmd in curl hdiutil shasum node awk sed; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

mkdir -p "$WORK_DIR"

HEADERS_FILE="${WORK_DIR}/headers.txt"
DMG_FILE="${WORK_DIR}/codex.dmg"
ASAR_FILE="${WORK_DIR}/app.asar"
EXTRACTED_DIR="${WORK_DIR}/extracted"
STATE_FILE="${WORK_DIR}/state.json"

fetch_headers() {
  if curl -fsSIL "$URL" >"$HEADERS_FILE"; then
    return 0
  fi
  curl -fsS -D "$HEADERS_FILE" -o /dev/null -r 0-0 "$URL"
}

header_value() {
  local key="$1"
  awk -v k="$key" '
    BEGIN { IGNORECASE=1 }
    $0 ~ "^" k ":" {
      line=$0
      sub(/\r$/, "", line)
      sub(/^[^:]+:[[:space:]]*/, "", line)
      print line
      exit
    }
  ' "$HEADERS_FILE"
}

state_value() {
  local key="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    return 0
  fi
  node -e 'const fs=require("node:fs"); const file=process.argv[1]; const key=process.argv[2]; try { const data=JSON.parse(fs.readFileSync(file,"utf8")); const value=data && data[key]; if (value != null) process.stdout.write(String(value)); } catch {}' "$STATE_FILE" "$key"
}

write_state() {
  local identity="$1"
  local identity_source="$2"
  local sha256="$3"
  local etag="$4"
  local last_modified="$5"
  local content_length="$6"
  local extracted="$7"
  node -e 'const fs=require("node:fs"); const file=process.argv[1]; const payload={identity:process.argv[2],identitySource:process.argv[3],sha256:process.argv[4],etag:process.argv[5],lastModified:process.argv[6],contentLength:process.argv[7],extracted:process.argv[8]==="1",updatedAt:new Date().toISOString()}; fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", {mode:0o600});' \
    "$STATE_FILE" "$identity" "$identity_source" "$sha256" "$etag" "$last_modified" "$content_length" "$extracted"
}

echo "[reverse-codex-dmg] Fetching remote headers..."
fetch_headers

ETAG="$(header_value "etag" | sed 's/^"//; s/"$//')"
LAST_MODIFIED="$(header_value "last-modified")"
CONTENT_LENGTH="$(header_value "content-length")"
VERSION_ID="$(header_value "x-amz-version-id")"

REMOTE_IDENTITY=""
IDENTITY_SOURCE=""
if [[ -n "$VERSION_ID" ]]; then
  REMOTE_IDENTITY="$VERSION_ID"
  IDENTITY_SOURCE="x-amz-version-id"
elif [[ -n "$ETAG" ]]; then
  REMOTE_IDENTITY="$ETAG"
  IDENTITY_SOURCE="etag"
elif [[ -n "$LAST_MODIFIED" || -n "$CONTENT_LENGTH" ]]; then
  REMOTE_IDENTITY="${LAST_MODIFIED}|${CONTENT_LENGTH}"
  IDENTITY_SOURCE="last-modified+content-length"
fi

PREV_IDENTITY="$(state_value identity)"
PREV_EXTRACTED="$(state_value extracted)"

if [[ "$FORCE" != "1" && -n "$REMOTE_IDENTITY" && "$REMOTE_IDENTITY" == "$PREV_IDENTITY" && -d "$EXTRACTED_DIR" && "$PREV_EXTRACTED" == "true" ]]; then
  echo "[reverse-codex-dmg] Cached identity match (${IDENTITY_SOURCE}); skipping download/extract."
  exit 0
fi

echo "[reverse-codex-dmg] Downloading DMG..."
curl -fL --retry 3 --retry-delay 2 "$URL" -o "$DMG_FILE"

SHA256="$(shasum -a 256 "$DMG_FILE" | awk '{print $1}')"
if [[ -z "$REMOTE_IDENTITY" ]]; then
  REMOTE_IDENTITY="$SHA256"
  IDENTITY_SOURCE="sha256-fallback"
fi

if [[ "$FORCE" != "1" && "$REMOTE_IDENTITY" == "$PREV_IDENTITY" && -d "$EXTRACTED_DIR" && "$PREV_EXTRACTED" == "true" ]]; then
  echo "[reverse-codex-dmg] Identity unchanged after download; extraction already present."
  write_state "$REMOTE_IDENTITY" "$IDENTITY_SOURCE" "$SHA256" "$ETAG" "$LAST_MODIFIED" "$CONTENT_LENGTH" "1"
  exit 0
fi

if [[ "$DOWNLOAD_ONLY" == "1" ]]; then
  echo "[reverse-codex-dmg] Download-only mode; skipping extraction."
  write_state "$REMOTE_IDENTITY" "$IDENTITY_SOURCE" "$SHA256" "$ETAG" "$LAST_MODIFIED" "$CONTENT_LENGTH" "0"
  exit 0
fi

MOUNT_POINT=""
cleanup() {
  if [[ -n "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "[reverse-codex-dmg] Mounting DMG..."
MOUNT_POINT="$(hdiutil attach "$DMG_FILE" -nobrowse -readonly | awk '/\/Volumes\// {print substr($0, index($0, "/Volumes/")); exit}')"
if [[ -z "$MOUNT_POINT" ]]; then
  echo "Failed to determine mounted volume path." >&2
  exit 1
fi

ASAR_SOURCE="$(find "$MOUNT_POINT" -type f -path "*/Codex.app/Contents/Resources/app.asar" -print -quit)"
if [[ -z "$ASAR_SOURCE" ]]; then
  echo "app.asar not found inside mounted DMG." >&2
  exit 1
fi

echo "[reverse-codex-dmg] Copying app.asar..."
cp "$ASAR_SOURCE" "$ASAR_FILE"
ASAR_UNPACKED_SOURCE="$(dirname "$ASAR_SOURCE")/app.asar.unpacked"
ASAR_UNPACKED_TARGET="${ASAR_FILE}.unpacked"
if [[ -d "$ASAR_UNPACKED_SOURCE" ]]; then
  rm -rf "$ASAR_UNPACKED_TARGET"
  cp -R "$ASAR_UNPACKED_SOURCE" "$ASAR_UNPACKED_TARGET"
fi

EXTRACT_TMP="${WORK_DIR}/extracted.tmp"
rm -rf "$EXTRACT_TMP"
mkdir -p "$EXTRACT_TMP"

echo "[reverse-codex-dmg] Extracting app.asar..."
node --input-type=module -e 'import {extractAll} from "@electron/asar"; const src=process.argv[1]; const out=process.argv[2]; await extractAll(src, out);' "$ASAR_FILE" "$EXTRACT_TMP"

rm -rf "$EXTRACTED_DIR"
mv "$EXTRACT_TMP" "$EXTRACTED_DIR"

write_state "$REMOTE_IDENTITY" "$IDENTITY_SOURCE" "$SHA256" "$ETAG" "$LAST_MODIFIED" "$CONTENT_LENGTH" "1"
echo "[reverse-codex-dmg] Completed."
echo "  identity: ${REMOTE_IDENTITY}"
echo "  source:   ${IDENTITY_SOURCE}"
echo "  sha256:   ${SHA256}"
echo "  output:   ${EXTRACTED_DIR}"
