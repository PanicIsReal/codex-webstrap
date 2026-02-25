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

DEFAULT_CONFIG_FILE="${HOME}/.codex-relay/config.json"
DEFAULT_TOKEN_FILE="${HOME}/.codex-relay/token"

print_usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [server options...]
  $(basename "$0") open [--port <n>] [--bind <ip>] [--token-file <path>] [--config-file <path>] [--copy]

Commands:
  open              Build a login URL from current auth mode and open it in the browser.

Examples:
  $(basename "$0") --bind 127.0.0.1 --port 8080 --auth-mode off
  $(basename "$0") --auth-mode basic --auth-password-file ~/.codex-relay/password.txt
  $(basename "$0") open --copy

Config + env precedence is handled by src/server.mjs:
  defaults < ~/.codex-relay/config.json < env < CLI flags
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

COMMAND="serve"
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

if [[ "$COMMAND" == "serve" ]]; then
  exec node "${ROOT_DIR}/src/server.mjs" "$@"
fi

PORT="${CODEX_RELAY_PORT:-${CODEX_WEBSTRAP_PORT:-8080}}"
BIND="${CODEX_RELAY_BIND:-${CODEX_WEBSTRAP_BIND:-127.0.0.1}}"
TOKEN_FILE="${CODEX_RELAY_TOKEN_FILE:-${CODEX_WEBSTRAP_TOKEN_FILE:-}}"
CONFIG_FILE="${CODEX_RELAY_CONFIG_FILE:-${CODEX_RELAY_CONFIG:-$DEFAULT_CONFIG_FILE}}"
AUTH_MODE=""
COPY_FLAG="0"
PORT_SET="0"
BIND_SET="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      require_value "$1" "${2:-}"
      PORT="$2"
      PORT_SET="1"
      shift 2
      ;;
    --bind)
      require_value "$1" "${2:-}"
      BIND="$2"
      BIND_SET="1"
      shift 2
      ;;
    --token-file)
      require_value "$1" "${2:-}"
      TOKEN_FILE="$2"
      shift 2
      ;;
    --config|--config-file)
      require_value "$1" "${2:-}"
      CONFIG_FILE="$2"
      shift 2
      ;;
    --auth-mode)
      require_value "$1" "${2:-}"
      AUTH_MODE="$2"
      shift 2
      ;;
    --copy)
      COPY_FLAG="1"
      shift
      ;;
    --help|-h|help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown argument for open: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_VALUES="$(node -e 'const fs=require("node:fs"); const p=process.argv[1]; try { const data=JSON.parse(fs.readFileSync(p,"utf8")); const server=data.server && typeof data.server==="object" ? data.server : {}; const auth=data.auth && typeof data.auth==="object" ? data.auth : {}; const bind=(data.bind ?? server.bind ?? "").toString(); const port=(data.port ?? server.port ?? "").toString(); const token=(data.tokenFile ?? server.tokenFile ?? auth.tokenFile ?? "").toString(); const mode=(data.authMode ?? auth.mode ?? "").toString(); process.stdout.write(`${bind}\n${port}\n${token}\n${mode}\n`); } catch { process.exit(1); }' "$CONFIG_FILE" 2>/dev/null || true)"
  if [[ -n "$CONFIG_VALUES" ]]; then
    CFG_BIND="$(printf '%s' "$CONFIG_VALUES" | sed -n '1p')"
    CFG_PORT="$(printf '%s' "$CONFIG_VALUES" | sed -n '2p')"
    CFG_TOKEN_FILE="$(printf '%s' "$CONFIG_VALUES" | sed -n '3p')"
    CFG_AUTH_MODE="$(printf '%s' "$CONFIG_VALUES" | sed -n '4p')"
    if [[ "$BIND_SET" == "0" && -n "$CFG_BIND" ]]; then
      BIND="$CFG_BIND"
    fi
    if [[ "$PORT_SET" == "0" && -n "$CFG_PORT" ]]; then
      PORT="$CFG_PORT"
    fi
    if [[ -z "$TOKEN_FILE" && -n "$CFG_TOKEN_FILE" ]]; then
      TOKEN_FILE="$CFG_TOKEN_FILE"
    fi
    if [[ -z "$AUTH_MODE" && -n "$CFG_AUTH_MODE" ]]; then
      AUTH_MODE="$CFG_AUTH_MODE"
    fi
  fi
fi

if [[ -z "$TOKEN_FILE" ]]; then
  TOKEN_FILE="$DEFAULT_TOKEN_FILE"
fi

RUNTIME_FILE="${TOKEN_FILE}.runtime"
if [[ -f "$RUNTIME_FILE" ]]; then
  RUNTIME_VALUES="$(node -e 'const fs=require("node:fs"); const p=process.argv[1]; try { const data=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(`${(data.bind||"")}\n${(data.port||"")}\n${(data.authMode||"")}\n`); } catch { process.exit(1); }' "$RUNTIME_FILE" 2>/dev/null || true)"
  if [[ -n "$RUNTIME_VALUES" ]]; then
    RUNTIME_BIND="$(printf '%s' "$RUNTIME_VALUES" | sed -n '1p')"
    RUNTIME_PORT="$(printf '%s' "$RUNTIME_VALUES" | sed -n '2p')"
    RUNTIME_AUTH_MODE="$(printf '%s' "$RUNTIME_VALUES" | sed -n '3p')"
    if [[ "$BIND_SET" == "0" && -n "$RUNTIME_BIND" ]]; then
      BIND="$RUNTIME_BIND"
    fi
    if [[ "$PORT_SET" == "0" && -n "$RUNTIME_PORT" ]]; then
      PORT="$RUNTIME_PORT"
    fi
    if [[ -z "$AUTH_MODE" && -n "$RUNTIME_AUTH_MODE" ]]; then
      AUTH_MODE="$RUNTIME_AUTH_MODE"
    fi
  fi
fi

if [[ -z "$AUTH_MODE" ]]; then
  AUTH_MODE="off"
fi
AUTH_MODE="$(printf '%s' "$AUTH_MODE" | tr '[:upper:]' '[:lower:]')"

TARGET_URL="http://${BIND}:${PORT}/"
case "$AUTH_MODE" in
  basic)
    TARGET_URL="http://${BIND}:${PORT}/__webstrapper/login"
    ;;
  token)
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
    TARGET_URL="http://${BIND}:${PORT}/__webstrapper/auth?token=${ENCODED_TOKEN}"
    ;;
  off)
    TARGET_URL="http://${BIND}:${PORT}/"
    ;;
  *)
    TARGET_URL="http://${BIND}:${PORT}/"
    ;;
esac

if [[ "$COPY_FLAG" == "1" ]]; then
  if ! command -v pbcopy >/dev/null 2>&1; then
    echo "pbcopy not found in PATH" >&2
    exit 1
  fi
  printf '%s' "$TARGET_URL" | pbcopy >/dev/null 2>&1
  printf 'Copied URL to clipboard.\n'
else
  open "$TARGET_URL"
  printf 'Opened URL in browser.\n'
  printf '%s\n' "$TARGET_URL"
fi
