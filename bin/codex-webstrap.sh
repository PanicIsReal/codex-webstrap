#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE_PATH" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  [[ "$SOURCE_PATH" != /* ]] && SOURCE_PATH="$SOURCE_DIR/$SOURCE_PATH"
done

SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT="${CODEX_WEBSTRAP_PORT:-8080}"
BIND="${CODEX_WEBSTRAP_BIND:-127.0.0.1}"
OPEN_FLAG="0"
TOKEN_FILE="${CODEX_WEBSTRAP_TOKEN_FILE:-}"
CODEX_APP="${CODEX_WEBSTRAP_CODEX_APP:-}"
INTERNAL_WS_PORT="${CODEX_WEBSTRAP_INTERNAL_WS_PORT:-38080}"
COPY_FLAG="0"
COMMAND="serve"

DEFAULT_TOKEN_FILE="${HOME}/.codex-webstrap/token"
if [[ -z "$TOKEN_FILE" ]]; then
  TOKEN_FILE="$DEFAULT_TOKEN_FILE"
fi

print_usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [--port <n>] [--bind <ip>] [--open] [--token-file <path>] [--codex-app <path>]
  $(basename "$0") open [--port <n>] [--bind <ip>] [--token-file <path>] [--copy]

Commands:
  open              Build the full auth URL and open it in the browser.

Options for open:
  --copy            Copy full auth URL to clipboard with pbcopy instead of launching browser.

Env overrides:
  CODEX_WEBSTRAP_PORT
  CODEX_WEBSTRAP_BIND
  CODEX_WEBSTRAP_TOKEN_FILE
  CODEX_WEBSTRAP_CODEX_APP
  CODEX_WEBSTRAP_INTERNAL_WS_PORT
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

if [[ $# -gt 0 ]]; then
  case "$1" in
    open)
      COMMAND="open"
      shift
      ;;
    --help|-h|help)
      print_usage
      exit 0
      ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      require_value "$1" "${2:-}"
      PORT="$2"
      shift 2
      ;;
    --bind)
      require_value "$1" "${2:-}"
      BIND="$2"
      shift 2
      ;;
    --token-file)
      require_value "$1" "${2:-}"
      TOKEN_FILE="$2"
      shift 2
      ;;
    --copy)
      COPY_FLAG="1"
      shift
      ;;
    --open)
      OPEN_FLAG="1"
      shift
      ;;
    --codex-app)
      require_value "$1" "${2:-}"
      CODEX_APP="$2"
      shift 2
      ;;
    --help|-h|help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$COMMAND" != "open" && "$COPY_FLAG" == "1" ]]; then
  echo "--copy can only be used with the 'open' command" >&2
  exit 1
fi

if [[ "$COMMAND" == "open" ]]; then
  if [[ ! -f "$TOKEN_FILE" ]]; then
    echo "Token file not found: $TOKEN_FILE" >&2
    exit 1
  fi

  TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
  if [[ -z "$TOKEN" ]]; then
    echo "Token file is empty: $TOKEN_FILE" >&2
    exit 1
  fi

  ENCODED_TOKEN="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$TOKEN")"
  AUTH_URL="http://${BIND}:${PORT}/__webstrapper/auth?token=${ENCODED_TOKEN}"

  if [[ "$COPY_FLAG" == "1" ]]; then
    if ! command -v pbcopy >/dev/null 2>&1; then
      echo "pbcopy not found in PATH" >&2
      exit 1
    fi
    printf '%s' "$AUTH_URL" | pbcopy
    printf 'Copied auth URL to clipboard.\n'
    printf '%s\n' "$AUTH_URL"
  else
    open "$AUTH_URL"
    printf 'Opened auth URL in browser.\n'
    printf '%s\n' "$AUTH_URL"
  fi
  exit 0
fi

export CODEX_WEBSTRAP_PORT="$PORT"
export CODEX_WEBSTRAP_BIND="$BIND"
export CODEX_WEBSTRAP_TOKEN_FILE="$TOKEN_FILE"
export CODEX_WEBSTRAP_CODEX_APP="$CODEX_APP"
export CODEX_WEBSTRAP_INTERNAL_WS_PORT="$INTERNAL_WS_PORT"
export CODEX_WEBSTRAP_OPEN="$OPEN_FLAG"

exec node "${ROOT_DIR}/src/server.mjs"
