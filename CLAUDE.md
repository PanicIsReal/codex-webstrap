# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

codex-webstrapper is a macOS bridge that serves the Codex desktop app's Electron-based UI in a standard browser. It extracts assets from the installed Codex.app bundle, injects a shim that emulates `window.electronBridge`, and routes renderer messages over WebSocket to local backend processes (codex app-server via stdio JSON-RPC, UDS IPC, terminal sessions).

## Commands

```bash
# Install dependencies
npm install

# Run the server (from local checkout)
./bin/codex-webstrap.sh --port 8080 --bind 127.0.0.1

# Run the server (global install)
codex-webstrapper --port 8080 --bind 127.0.0.1

# Auto-open browser with auth URL
codex-webstrapper --open

# Copy auth URL to clipboard (for pasting into remote browser)
codex-webstrapper open --copy

# Open auth URL in default browser
codex-webstrapper open

# Run tests
npm test

# Set log level for debugging
CODEX_WEBSTRAP_LOG_LEVEL=debug ./bin/codex-webstrap.sh
```

## Architecture

### Request Flow

Browser → HTTP server (auth-gated) → serves patched index.html + static assets from extracted asar cache. Browser-side shim (`bridge-shim.js`) connects WebSocket to `/__webstrapper/bridge`. All renderer↔backend communication flows through bridge envelopes over this single WebSocket.

### Key Source Files

- **`src/server.mjs`** — Main entry point. Creates HTTP server, WebSocket server, orchestrates startup (token, assets, app-server, UDS client), wires routing.
- **`src/bridge-shim.js`** — Client-side IIFE injected into `<head>`. Provides `window.electronBridge` with `sendMessageFromView`, `subscribeToWorkerMessages`, `showContextMenu`, clipboard shims, Sentry/Statsig request interception. This is plain browser JS (no modules).
- **`src/message-router.mjs`** — Central dispatch for all bridge messages. Contains `MessageRouter` class and `TerminalRegistry`. Routes messages across three buckets: `FULL_HANDLING_BUCKET` (forwarded to app-server), `BROWSER_EQUIVALENT_BUCKET` (handled in-browser), `GRACEFUL_UNSUPPORTED_BUCKET` (returns error to renderer). Also manages terminal lifecycle (bun-pty > python-pty > pipe fallback) and worker thread bridging.
- **`src/app-server.mjs`** — Manages the `codex app-server` child process over stdio. Implements JSON-RPC request/response with timeout tracking. Auto-reconnects.
- **`src/assets.mjs`** — Discovers Codex.app bundle, extracts `app.asar` to versioned cache dir (`~/.cache/codex-webstrap/assets/<buildKey>/`), patches index.html to inject shim `<script>` tag.
- **`src/ipc-uds.mjs`** — Unix domain socket IPC client with length-prefixed framing. Connects to Codex desktop's shared IPC bus for cross-client broadcasts.
- **`src/auth.mjs`** — Token-based auth with `cw_session` HttpOnly cookie. Token persisted at `~/.codex-webstrap/token`.
- **`src/bun-pty-bridge.mjs`** — Subprocess bridge for bun-pty terminal emulation. Spawned as a child process by TerminalRegistry; communicates via JSON-over-stdio.

### Message Routing Buckets

The `message-router.mjs` classifies incoming view messages into three categories:
1. **FULL_HANDLING** — Forwarded to app-server JSON-RPC (fetch, mcp, terminal, persisted-atom, shared-object, thread operations, worker requests)
2. **BROWSER_EQUIVALENT** — Handled directly in bridge-shim.js or router (open-in-browser, show-diff, navigate-in-new-editor-tab)
3. **GRACEFUL_UNSUPPORTED** — Desktop-only features that return structured errors (install-wsl, open-extension-settings, etc.)

### Terminal Architecture

TerminalRegistry tries backends in priority order: bun-pty (full PTY via subprocess bridge) → python-pty (pty via python3 script) → plain pipe (spawn with stdio pipes). Terminal sessions are multiplexed across WebSocket clients via session IDs.

## Key Conventions

- All server source is ESM (`.mjs` extension, `"type": "module"` in package.json). The bridge shim is plain `.js` (IIFE, no imports).
- Structured JSON logging to stdout (info/debug/trace) and stderr (warn/error) via `createLogger()` in `util.mjs`.
- No build step — source is served/executed directly by Node.js 20+.
- The `bin/codex-webstrap.sh` shell script resolves symlinks, normalizes env vars, and `exec`s into `node src/server.mjs`.
- Auth token file and runtime metadata live under `~/.codex-webstrap/`.
- Extracted assets are cached at `~/.cache/codex-webstrap/assets/<version>/` with a `.extract-complete.json` sentinel.

## Environment Variables

- `CODEX_WEBSTRAP_PORT`, `CODEX_WEBSTRAP_BIND` — Server address (defaults: 8080, 127.0.0.1)
- `CODEX_WEBSTRAP_TOKEN_FILE` — Path to auth token (default: `~/.codex-webstrap/token`)
- `CODEX_WEBSTRAP_CODEX_APP` — Path to Codex.app bundle (default: `/Applications/Codex.app`)
- `CODEX_WEBSTRAP_INTERNAL_WS_PORT` — Internal WS port for app-server (default: 38080)
- `CODEX_CLI_PATH` — Override path to the codex CLI binary
- `CODEX_WEBSTRAP_LOG_LEVEL` — Log verbosity (trace/debug/info/warn/error)

## Debugging Tips

- `GET /__webstrapper/healthz` returns JSON with app-server state, UDS readiness, and build key.
- `window.__codexWebstrapMainMessages` in browser console contains recent bridge message history (last 200).
- `window.__codexWebstrapLastBridgeError` shows the last bridge error received.
- The bridge shim suppresses Sentry IPC errors, Statsig registry calls, and specific Radix dialog warnings to reduce console noise.
