#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT="${CODEX_WEBSTRAP_PORT:-8080}"
BIND="${CODEX_WEBSTRAP_BIND:-127.0.0.1}"
OPEN_FLAG="0"
TOKEN_FILE="${CODEX_WEBSTRAP_TOKEN_FILE:-}"
CODEX_APP="${CODEX_WEBSTRAP_CODEX_APP:-}"
INTERNAL_WS_PORT="${CODEX_WEBSTRAP_INTERNAL_WS_PORT:-38080}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="$2"
      shift 2
      ;;
    --bind)
      BIND="$2"
      shift 2
      ;;
    --open)
      OPEN_FLAG="1"
      shift
      ;;
    --token-file)
      TOKEN_FILE="$2"
      shift 2
      ;;
    --codex-app)
      CODEX_APP="$2"
      shift 2
      ;;
    --help|-h)
      cat <<USAGE
Usage: $(basename "$0") [--port <n>] [--bind <ip>] [--open] [--token-file <path>] [--codex-app <path>]

Env overrides:
  CODEX_WEBSTRAP_PORT
  CODEX_WEBSTRAP_BIND
  CODEX_WEBSTRAP_TOKEN_FILE
  CODEX_WEBSTRAP_CODEX_APP
  CODEX_WEBSTRAP_INTERNAL_WS_PORT
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

export CODEX_WEBSTRAP_PORT="$PORT"
export CODEX_WEBSTRAP_BIND="$BIND"
export CODEX_WEBSTRAP_TOKEN_FILE="$TOKEN_FILE"
export CODEX_WEBSTRAP_CODEX_APP="$CODEX_APP"
export CODEX_WEBSTRAP_INTERNAL_WS_PORT="$INTERNAL_WS_PORT"
export CODEX_WEBSTRAP_OPEN="$OPEN_FLAG"

exec node "${ROOT_DIR}/src/server.mjs"
