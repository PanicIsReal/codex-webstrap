# codex-webstrap

![Frosted Sidebar Demo](assets/frosted-sidebar.gif)

`codex-webstrap` is a macOS wrapper that lets you run the Codex desktop client UI in a browser while keeping backend execution local.

This started as a personal project to remotely access the Codex desktop experience; it is open sourced so others can use and improve it.

## What It Is


https://github.com/user-attachments/assets/24e023ee-6a74-448c-892d-9fc1964bd10c


Codex desktop is not a pure web app. The renderer expects Electron preload APIs, IPC, local process control, worker threads, and desktop-only integrations.

`codex-webstrap` makes browser access possible by:

1. Serving Codex's bundled web assets.
2. Injecting a browser shim that emulates key `electronBridge` preload methods.
3. Bridging renderer messages over WebSocket to local backend handlers.
4. Forwarding app protocol traffic to local `codex app-server` and UDS IPC where available.

Default endpoint: `http://127.0.0.1:8080`

## Architecture

### Core Components

- `bin/codex-webstrap.sh`
  - CLI entrypoint and env/arg normalization.
- `src/server.mjs`
  - HTTP + WS host, auth gating, startup orchestration.
- `src/auth.mjs`
  - Persistent token bootstrap + `cw_session` cookie sessions.
- `src/assets.mjs`
  - Discovers Codex app bundle, extracts/caches `app.asar` assets, patches `index.html`.
- `src/bridge-shim.js`
  - Browser-side Electron preload compatibility layer (`window.electronBridge`).
- `src/ipc-uds.mjs`
  - Framed UDS client (`length-prefix + JSON`) for `codex-ipc`.
- `src/app-server.mjs`
  - Local `codex app-server` process manager over stdio JSON-RPC.
- `src/message-router.mjs`
  - Message dispatch, terminal lifecycle, worker bridge, unsupported fallbacks.

### Runtime Flow

1. Wrapper starts Node server and loads config.
2. Auth token is created/read from token file.
3. Codex app assets are extracted to a versioned cache directory.
4. Patched `index.html` is served with shim injection.
5. Browser opens `/`, shim connects to `ws://<host>/__webstrapper/bridge`.
6. Renderer messages are routed to:
   - app-server JSON-RPC (`thread/*`, turns, config, etc.)
   - UDS broadcast forwarding where relevant
   - terminal sessions (`spawn`, `write`, `close`)
   - git worker bridge path
7. Results are sent back as bridge envelopes and posted to the renderer via `window.postMessage`.

## Why This Is Not "Native Web"

Codex desktop behavior depends on Electron/main-process features unavailable to normal browser JavaScript, including:

- preload-only bridge APIs
- local privileged process orchestration
- desktop IPC channels
- local worker/protocol assumptions

This project provides near-parity by emulation/bridging, not by removing those dependencies.

## API Surface

### CLI

```bash
codex-webstrapper [--bind <ip>] [--port <n>] [--config-file <path>] [--auth-mode <off|basic|token>] [--auth-password <value>] [--auth-password-file <path>] [--profile-switching] [--profile-strategy <fixed|round-robin|random>] [--profile-fixed <id-or-label>] [--launch-codex <never|auto>]
codex-webstrapper open [--bind <ip>] [--port <n>] [--token-file <path>] [--config-file <path>] [--copy]
```

### Environment Overrides

- `CODEX_RELAY_CONFIG_FILE`
- `CODEX_RELAY_BIND`
- `CODEX_RELAY_PORT`
- `CODEX_RELAY_TOKEN_FILE`
- `CODEX_RELAY_CODEX_APP`
- `CODEX_RELAY_INTERNAL_WS_PORT`
- `CODEX_RELAY_AUTH_MODE`
- `CODEX_RELAY_AUTH_USERNAME`
- `CODEX_RELAY_AUTH_PASSWORD`
- `CODEX_RELAY_AUTH_PASSWORD_FILE`
- `CODEX_RELAY_LAUNCH_CODEX`
- `CODEX_RELAY_PROFILE_SWITCHING`
- `CODEX_RELAY_PROFILE_STRATEGY`
- `CODEX_RELAY_PROFILE_FIXED`
- `CODEX_RELAY_PROFILES_DIR`
- `CODEX_RELAY_HOST_AUTH_FILE`
- `CODEX_RELAY_PROFILE_STATE_FILE`
- `CODEX_RELAY_GLOBAL_STATE_FILE`

Legacy `CODEX_WEBSTRAP_*` env vars are still accepted for bind/port/token/app path.

### HTTP Endpoints

- `GET /`
- `GET /__webstrapper/shim.js`
- `GET /__webstrapper/healthz`
- `GET /__webstrapper/auth?token=...`
- `GET|POST /__webstrapper/login` (basic auth mode)
- `GET /__webstrapper/profiles`
- `POST /__webstrapper/profiles/switch`

### WebSocket Endpoint

- `GET /__webstrapper/bridge`

### Bridge Envelope Types

- `view-message`
- `main-message`
- `worker-message`
- `worker-event`
- `bridge-error`
- `bridge-ready`

## Setup

### Prerequisites

- macOS
- Node.js 20+
- Installed Codex app bundle at `/Applications/Codex.app` (or pass `--codex-app`)

By default, webstrapper runs the app-server via the bundled desktop CLI at:
- `/Applications/Codex.app/Contents/Resources/codex`

Optional override:
- `CODEX_CLI_PATH=/custom/codex`

### Install

```bash
npm install
```

Global CLI install:

```bash
npm install -g codex-webstrapper
```

### Run

With global install:

```bash
codex-webstrapper --port 8080 --bind 127.0.0.1
```

From local checkout:

```bash
./bin/codex-webstrap.sh --port 8080 --bind 127.0.0.1
```

Config file defaults:

- Path: `~/.codex-relay/config.json`
- Precedence: defaults < config file < env vars < CLI flags

Auth mode defaults to `off`, and bind defaults to `127.0.0.1`.

Optional auto-open:

```bash
codex-webstrapper --open
```

Generate/open the full auth URL from your persisted token:

```bash
codex-webstrapper open
```

Copy the full auth URL (including token) to macOS clipboard:

```bash
codex-webstrapper open --copy
```

## Authentication Model

Modes:

1. `off` (default)
   - No login required.
2. `basic`
   - Password login at `/__webstrapper/login`.
   - Requires `--auth-password` or `--auth-password-file`.
3. `token`
   - Token bootstrap at `/__webstrapper/auth?token=...`.

Token details:

1. On first run, a random token is persisted at `~/.codex-relay/token` (default path).
2. In token mode, authenticate once via:

```bash
open "http://127.0.0.1:8080/__webstrapper/auth?token=$(cat ~/.codex-relay/token)"
```

Or use:

```bash
codex-webstrapper open
```

4. Server sets `cw_session` cookie (`HttpOnly`, `SameSite=Lax`, scoped to `/`).
5. UI and bridge endpoints require a valid session unless mode is `off`.

## Multi Auth Switching

- Optional profile switching can reuse profiles from `~/.codex/profiles/*.json` (Codex Profiles-compatible layout).
- Strategies:
  - `fixed`: always use selected `--profile-fixed` (id or label).
  - `round-robin`: rotate profiles per switch.
  - `random`: pick a random profile.
- Safety lock:
  - Switching is blocked when native `Codex` desktop process is running, to avoid concurrent writes to `~/.codex/auth.json`.

## Security Risks and Recommendations

This project can expose powerful local capabilities if misconfigured. Treat it as sensitive software.

### Primary Risks

- Remote users with valid session can operate Codex UI features and local workflows.
- Token bootstrap URL can be leaked via shell history, logs, screenshots, or shared links.
- Binding to non-local interfaces increases attack surface.
- No built-in TLS termination. Plain HTTP should not be exposed directly to the public internet.

### Recommended Safe Usage

- Keep default bind: `127.0.0.1` unless remote access is required.
- If remote access is needed, use a private overlay network (for example Tailscale/WireGuard) and not public port-forwarding.
- Do not share token values in chat, screenshots, logs, issue reports, or commit history.
- Rotate token file if exposure is suspected:

```bash
rm -f ~/.codex-relay/token
```

Then restart wrapper to generate a new token.

- Consider external TLS/auth proxy if you must serve beyond localhost.

## Functional Coverage Notes

Implemented coverage includes:

- core message routing (`ready`, `fetch`, `mcp-*`, `terminal-*`, `persisted-atom-*`, `shared-object-*`)
- thread lifecycle actions including archive/unarchive pathing
- worker message support (including git worker bridge)
- browser equivalents for desktop-only UX events (open links, diff/plan summaries)
- graceful unsupported handling for non-web-native desktop actions

Unknown message types produce structured `bridge-error` responses and do not crash the session.

## Development

### Run Tests

```bash
npm test
```

### Reverse New DMG Builds

```bash
./scripts/reverse-codex-dmg.sh --work-dir /tmp/codex-dmg-re
```

The script caches remote identity in `state.json` and skips re-extract when the DMG version is unchanged. If remote headers are missing, it falls back to DMG SHA-256 identity.

### Worktree Bootstrap

Bootstrap env/secrets from another worktree checkout:

```bash
./scripts/worktree-bootstrap.sh --dry-run
./scripts/worktree-bootstrap.sh --mode symlink
```

Core paths are configured via:

- `scripts/worktree-secrets.manifest`

Codex setup-script compatible command:

```bash
./scripts/worktree-bootstrap.sh --mode symlink --overwrite backup --extras on --install on --checks on
```

### Typical Troubleshooting

- `401 unauthorized`
  - In `token` mode, authenticate via `/__webstrapper/auth?token=...`.
  - In `basic` mode, open `/__webstrapper/login`.
- UI loads but actions fail
  - Check `GET /__webstrapper/healthz` for app-server/UDS readiness.
- Codex app not found
  - Pass `--codex-app /path/to/Codex.app`.
- Profile switch returns `blocked`
  - Native Codex desktop is running; close it before switching profiles.
- `codex` CLI spawn failures
  - Ensure the bundled CLI exists in your Codex app install, or set `CODEX_CLI_PATH`.

## License

MIT. See `LICENSE.md`.
