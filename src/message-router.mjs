import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { createLogger, randomId, safeJsonParse, toErrorMessage } from "./util.mjs";

export const FULL_HANDLING_BUCKET = [
  "ready",
  "fetch",
  "cancel-fetch",
  "fetch-stream",
  "cancel-fetch-stream",
  "mcp-request",
  "mcp-response",
  "mcp-notification",
  "terminal-create",
  "terminal-attach",
  "terminal-write",
  "terminal-resize",
  "terminal-close",
  "persisted-atom-sync-request",
  "persisted-atom-update",
  "persisted-atom-reset",
  "shared-object-subscribe",
  "shared-object-set",
  "shared-object-unsubscribe",
  "thread-archived",
  "thread-unarchived",
  "archive-thread",
  "unarchive-thread",
  "thread-stream-state-changed",
  "thread-overlay-proxy-start-turn-request",
  "thread-overlay-proxy-start-turn-response",
  "thread-overlay-proxy-interrupt-request",
  "thread-overlay-proxy-interrupt-response",
  "worker-request",
  "worker-request-cancel",
  "set-telemetry-user",
  "view-focused"
];

export const BROWSER_EQUIVALENT_BUCKET = [
  "open-in-browser",
  "show-diff",
  "show-plan-summary",
  "navigate-in-new-editor-tab"
];

export const GRACEFUL_UNSUPPORTED_BUCKET = [
  "install-wsl",
  "install-app-update",
  "open-extension-settings",
  "open-vscode-command",
  "open-keyboard-shortcuts",
  "open-debug-window",
  "electron-request-microphone-permission"
];

const NATIVE_UNSUPPORTED = new Set(GRACEFUL_UNSUPPORTED_BUCKET);
const IPC_BROADCAST_FORWARD_METHODS = new Set([
  "thread-archived",
  "thread-unarchived",
  "thread-title-updated",
  "pinned-threads-updated",
  "automation-runs-updated",
  "custom-prompts-updated",
  "active-workspace-roots-updated",
  "workspace-root-options-updated"
]);

class TerminalRegistry {
  constructor(sendToWs, logger) {
    this.sendToWs = sendToWs;
    this.logger = logger;
    this.sessions = new Map();
  }

  createOrAttach(ws, message) {
    const sessionId = message.sessionId || randomId(8);
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.listeners.add(ws);
      this.sendToWs(ws, { type: "terminal-attached", sessionId });
      return;
    }

    const shell = process.env.SHELL || "/bin/zsh";
    const command = Array.isArray(message.command) && message.command.length > 0
      ? message.command
      : [shell];

    const [bin, ...args] = command;
    const proc = spawn(bin, args, {
      cwd: message.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(message.env || {})
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const session = {
      sessionId,
      proc,
      listeners: new Set([ws])
    };

    this.sessions.set(sessionId, session);

    this.sendToWs(ws, { type: "terminal-attached", sessionId });
    this.sendToWs(ws, {
      type: "terminal-init-log",
      sessionId,
      log: "Terminal attached via codex-webstrapper\r\n"
    });

    proc.stdout?.on("data", (chunk) => {
      this._broadcast(sessionId, {
        type: "terminal-data",
        sessionId,
        data: chunk.toString("utf8")
      });
    });

    proc.stderr?.on("data", (chunk) => {
      this._broadcast(sessionId, {
        type: "terminal-data",
        sessionId,
        data: chunk.toString("utf8")
      });
    });

    proc.on("error", (error) => {
      this._broadcast(sessionId, {
        type: "terminal-error",
        sessionId,
        message: toErrorMessage(error)
      });
    });

    proc.on("exit", (code, signal) => {
      this._broadcast(sessionId, {
        type: "terminal-exit",
        sessionId,
        code,
        signal
      });
      this.sessions.delete(sessionId);
    });
  }

  write(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.proc.stdin || session.proc.stdin.destroyed) {
      return;
    }
    session.proc.stdin.write(data);
  }

  resize(sessionId) {
    if (!this.sessions.has(sessionId)) {
      return;
    }
    this.logger.debug("Terminal resize ignored (non-PTY mode)", { sessionId });
  }

  close(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (!session.proc.killed) {
      session.proc.kill();
    }
    this.sessions.delete(sessionId);
  }

  removeListener(ws) {
    for (const [sessionId, session] of this.sessions.entries()) {
      session.listeners.delete(ws);
      if (session.listeners.size === 0) {
        this.close(sessionId);
      }
    }
  }

  dispose() {
    for (const sessionId of this.sessions.keys()) {
      this.close(sessionId);
    }
  }

  _broadcast(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    for (const listener of session.listeners) {
      this.sendToWs(listener, message);
    }
  }
}

class GitWorkerBridge {
  constructor({ workerPath, sendWorkerEvent, logger }) {
    this.workerPath = workerPath;
    this.sendWorkerEvent = sendWorkerEvent;
    this.logger = logger;
    this.worker = null;
    this.pendingByRequestId = new Map();
  }

  async isAvailable() {
    if (!this.workerPath) {
      return false;
    }

    try {
      await fs.access(this.workerPath);
      return true;
    } catch {
      return false;
    }
  }

  async postMessage(ws, payload) {
    if (!(await this.isAvailable())) {
      this.sendWorkerEvent(ws, "git", {
        type: "worker-response",
        workerId: "git",
        response: {
          id: payload?.request?.id || payload?.id,
          ok: false,
          error: "git worker unavailable"
        }
      });
      return;
    }

    this._ensureWorker();

    if (payload.type === "worker-request" && payload.request?.id) {
      this.pendingByRequestId.set(payload.request.id, ws);
    }

    if (payload.type === "worker-request-cancel" && payload.id) {
      this.pendingByRequestId.delete(payload.id);
    }

    this.worker.postMessage(payload);
  }

  removeClient(ws) {
    for (const [requestId, owner] of this.pendingByRequestId.entries()) {
      if (owner === ws) {
        this.pendingByRequestId.delete(requestId);
      }
    }
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingByRequestId.clear();
  }

  _ensureWorker() {
    if (this.worker) {
      return;
    }

    this.worker = new Worker(this.workerPath, {
      workerData: {
        workerId: "git",
        sentryInitOptions: {},
        maxLogLevel: "info",
        sentryRewriteFramesRoot: process.cwd()
      }
    });

    this.worker.on("message", (message) => {
      if (message?.type === "worker-response" && message?.response?.id) {
        const owner = this.pendingByRequestId.get(message.response.id);
        if (owner) {
          this.pendingByRequestId.delete(message.response.id);
          this.sendWorkerEvent(owner, "git", message);
          return;
        }
      }

      // Broadcast unknown worker events to all connected clients.
      this.sendWorkerEvent(null, "git", message);
    });

    this.worker.on("error", (error) => {
      this.logger.warn("Git worker error", { error: toErrorMessage(error) });
    });

    this.worker.on("exit", (code) => {
      this.logger.warn("Git worker exited", { code });
      this.worker = null;
    });
  }
}

export class MessageRouter {
  constructor({ appServer, udsClient, workerPath, hostConfig, logger, globalStatePath }) {
    this.logger = logger || createLogger("router");
    this.appServer = appServer;
    this.udsClient = udsClient;
    this.hostConfig = hostConfig || {
      id: "local",
      display_name: "Codex",
      kind: "local"
    };

    this.clients = new Set();
    this.fetchControllers = new Map();
    this.persistedAtomState = new Map();
    this.sharedObjects = new Map();
    this.sharedObjectSubscribers = new Map();
    this.lastAccountRead = null;
    this.defaultWorkspaceRoot = process.cwd();
    this.workspaceRootOptions = {
      roots: [this.defaultWorkspaceRoot],
      labels: {}
    };
    this.activeWorkspaceRoots = [this.defaultWorkspaceRoot];
    this.userSelectedActiveWorkspaceRoots = false;
    this.globalStatePath = globalStatePath || path.join(os.homedir(), ".codex", ".codex-global-state.json");
    this.globalState = {};
    this.globalStateWriteTimer = null;
    this._loadPersistedGlobalState();
    this._persistWorkspaceState({ writeToDisk: false });
    this.sharedObjects.set("host_config", this.hostConfig);

    this.terminals = new TerminalRegistry((ws, payload) => {
      this.sendMainMessage(ws, payload);
    }, this.logger);

    this.gitWorker = new GitWorkerBridge({
      workerPath,
      sendWorkerEvent: (ws, workerId, payload) => {
        if (ws) {
          this.sendWorkerEvent(ws, workerId, payload);
          return;
        }
        this.broadcastWorkerEvent(workerId, payload);
      },
      logger: this.logger
    });

    this._wireBackends();
  }

  _wireBackends() {
    if (this.appServer) {
      this.appServer.on("initialized", () => {
        this.broadcastMainMessage({
          type: "codex-app-server-initialized"
        });
      });

      this.appServer.on("notification", (notification) => {
        this.broadcastMainMessage({
          type: "mcp-notification",
          method: notification?.method,
          params: notification?.params ?? {}
        });
      });

      this.appServer.on("request", (request) => {
        this.broadcastMainMessage({ type: "mcp-request", request });
      });

      this.appServer.on("connection-changed", (state) => {
        this.broadcastMainMessage({
          type: "codex-app-server-connection-changed",
          state: state.connected ? "connected" : "disconnected",
          transport: state.transportKind
        });
      });
    }

    if (this.udsClient) {
      this.udsClient.on("broadcast", (message) => {
        if (!IPC_BROADCAST_FORWARD_METHODS.has(message.method)) {
          return;
        }
        this.broadcastMainMessage({
          type: "ipc-broadcast",
          method: message.method,
          sourceClientId: message.sourceClientId,
          version: message.version,
          params: message.params
        });
      });
    }
  }

  registerClient(ws) {
    this.clients.add(ws);

    this.sendBridgeEnvelope(ws, {
      type: "bridge-ready",
      payload: {
        ts: Date.now()
      }
    });

    if (this.appServer) {
      const state = this.appServer.getState();
      this.sendMainMessage(ws, {
        type: "codex-app-server-connection-changed",
        state: state.connected ? "connected" : "disconnected",
        transport: state.transportKind
      });
      if (state.initialized) {
        this.sendMainMessage(ws, {
          type: "codex-app-server-initialized"
        });
      }
    }
  }

  unregisterClient(ws) {
    this.clients.delete(ws);
    this.terminals.removeListener(ws);
    this.gitWorker.removeClient(ws);

    for (const subscribers of this.sharedObjectSubscribers.values()) {
      subscribers.delete(ws);
    }
  }

  dispose() {
    if (this.globalStateWriteTimer) {
      clearTimeout(this.globalStateWriteTimer);
      this.globalStateWriteTimer = null;
      void this._writeGlobalStateToDisk();
    }

    this.terminals.dispose();
    this.gitWorker.dispose();

    for (const controller of this.fetchControllers.values()) {
      controller.abort();
    }
    this.fetchControllers.clear();
  }

  async handleEnvelope(ws, envelope) {
    if (!envelope || typeof envelope !== "object") {
      this.sendBridgeError(ws, "invalid_envelope", "Envelope must be a JSON object.");
      return;
    }

    switch (envelope.type) {
      case "view-message": {
        await this._handleViewMessage(ws, envelope.payload);
        return;
      }
      case "worker-message": {
        const workerId = envelope.workerId || envelope.payload?.workerId || "git";
        await this._handleWorkerMessage(ws, workerId, envelope.payload);
        return;
      }
      default: {
        this.sendBridgeError(ws, "unsupported_envelope_type", `Unsupported envelope type: ${envelope.type}`);
      }
    }
  }

  async _handleViewMessage(ws, message) {
    if (!message || typeof message !== "object") {
      this.sendBridgeError(ws, "invalid_view_message", "View payload must be an object.");
      return;
    }

    const type = message.type;

    if (!type) {
      this.sendBridgeError(ws, "missing_message_type", "View payload is missing `type`.");
      return;
    }

    try {
      this.logger.debug("renderer-message", {
        type
      });
      switch (type) {
        case "ready":
          this._handleReady(ws);
          return;
        case "electron-window-focus-request":
          this.sendMainMessage(ws, {
            type: "electron-window-focus-changed",
            isFocused: true
          });
          return;
        case "log-message":
          this.logger.debug("renderer-log-message", {
            level: message.level || "info",
            message: typeof message.message === "string" ? message.message.slice(0, 500) : null
          });
          return;
        case "fetch":
          await this._handleFetch(ws, message);
          return;
        case "cancel-fetch":
          this._handleCancelFetch(message);
          return;
        case "fetch-stream":
          this.sendMainMessage(ws, {
            type: "fetch-stream-error",
            requestId: message.requestId,
            error: "Streaming fetch is not implemented in webstrapper."
          });
          return;
        case "cancel-fetch-stream":
          return;
        case "mcp-request":
          await this._forwardToAppServer(ws, message.request || message.payload || message);
          return;
        case "mcp-response":
          await this._forwardToAppServer(ws, message.response || message.payload || message);
          return;
        case "mcp-notification":
          await this._forwardToAppServer(ws, message.notification || message.payload || message);
          return;
        case "terminal-create":
        case "terminal-attach":
          this.terminals.createOrAttach(ws, message);
          return;
        case "terminal-write":
          this.terminals.write(message.sessionId, message.data || "");
          return;
        case "terminal-resize":
          this.terminals.resize(message.sessionId);
          return;
        case "terminal-close":
          this.terminals.close(message.sessionId);
          return;
        case "persisted-atom-sync-request":
          this.sendMainMessage(ws, {
            type: "persisted-atom-sync",
            state: Object.fromEntries(this.persistedAtomState.entries())
          });
          return;
        case "persisted-atom-update":
          if (message.key) {
            this.persistedAtomState.set(message.key, message.value);
            this.broadcastMainMessage({
              type: "persisted-atom-updated",
              key: message.key,
              value: message.value
            });
            this._scheduleGlobalStateWrite();
          }
          return;
        case "persisted-atom-reset":
          if (message.key) {
            this.persistedAtomState.delete(message.key);
            this.broadcastMainMessage({
              type: "persisted-atom-updated",
              key: message.key,
              value: null
            });
            this._scheduleGlobalStateWrite();
          }
          return;
        case "shared-object-subscribe":
          this._subscribeSharedObject(ws, message.key);
          return;
        case "shared-object-set":
          this._setSharedObject(message.key, message.value);
          return;
        case "shared-object-unsubscribe":
          this._unsubscribeSharedObject(ws, message.key);
          return;
        case "archive-thread":
          await this._archiveThread(ws, message);
          return;
        case "unarchive-thread":
          await this._unarchiveThread(ws, message);
          return;
        case "thread-archived":
        case "thread-unarchived":
        case "thread-stream-state-changed":
        case "thread-overlay-proxy-start-turn-response":
        case "thread-overlay-proxy-interrupt-response":
        case "set-telemetry-user":
        case "view-focused":
          return;
        case "thread-overlay-proxy-start-turn-request":
          await this._handleThreadOverlayStartTurn(ws, message);
          return;
        case "thread-overlay-proxy-interrupt-request":
          await this._handleThreadOverlayInterrupt(ws, message);
          return;
        case "electron-onboarding-skip-workspace":
          this.workspaceRootOptions = {
            ...this.workspaceRootOptions,
            roots: [this.defaultWorkspaceRoot]
          };
          this.activeWorkspaceRoots = [this.defaultWorkspaceRoot];
          this.userSelectedActiveWorkspaceRoots = false;
          this._persistWorkspaceState();
          this.broadcastMainMessage({
            type: "workspace-root-options-updated",
            options: this.workspaceRootOptions.roots
          });
          this.broadcastMainMessage({
            type: "active-workspace-roots-updated",
            roots: this.activeWorkspaceRoots
          });
          this.sendMainMessage(ws, {
            type: "electron-onboarding-skip-workspace-result",
            success: true,
            error: null
          });
          return;
        case "electron-update-workspace-root-options":
          if (Array.isArray(message.roots)) {
            const normalizedRoots = [...new Set(
              message.roots
                .map((root) => this._normalizeWorkspaceRoot(root))
                .filter(Boolean)
            )];
            this.workspaceRootOptions = {
              ...this.workspaceRootOptions,
              roots: normalizedRoots
            };
            this._persistWorkspaceState();
            this.broadcastMainMessage({
              type: "workspace-root-options-updated",
              options: this.workspaceRootOptions.roots
            });
          }
          return;
        case "electron-set-active-workspace-root":
          {
            const normalizedRoot = this._normalizeWorkspaceRoot(message.root);
            if (!normalizedRoot) {
              return;
            }
            this.activeWorkspaceRoots = [normalizedRoot];
            this.userSelectedActiveWorkspaceRoots = true;
            this._persistWorkspaceState();
            this.broadcastMainMessage({
              type: "active-workspace-roots-updated",
              roots: this.activeWorkspaceRoots
            });
          }
          return;
        case "worker-request":
        case "worker-request-cancel":
          await this._handleWorkerMessage(ws, message.workerId || "git", message);
          return;
        case "open-in-browser":
          this._openInBrowser(ws, message);
          return;
        case "show-diff":
          this.sendMainMessage(ws, {
            type: "toggle-diff-panel",
            open: true
          });
          return;
        case "show-plan-summary":
        case "navigate-in-new-editor-tab":
          // Matches desktop host behavior: these are no-ops.
          return;
        case "electron-set-badge-count":
        case "power-save-blocker-set":
        case "desktop-notification-show":
        case "desktop-notification-hide":
        case "show-context-menu":
        case "inbox-item-set-read-state":
        case "codex-app-server-restart":
        case "open-thread-overlay":
        case "electron-set-window-mode":
        case "electron-pick-workspace-root-option":
        case "electron-app-state-snapshot-trigger":
        case "update-diff-if-open":
          // Electron-only side effects that are safe to ignore in browser mode.
          return;
      default:
          if (NATIVE_UNSUPPORTED.has(type)) {
            this.logger.warn("Unsupported native action in browser mode", {
              type
            });
            this.sendBridgeError(ws, "unsupported_native_action", `${type} is not available in browser mode.`);
            return;
          }

          this.logger.warn("Unsupported renderer message type", {
            type,
            keys: Object.keys(message)
          });
          this.sendBridgeError(ws, "unsupported_message_type", `Unsupported renderer message type: ${type}`);
      }
    } catch (error) {
      this.logger.warn("Message handling error", {
        type,
        error: toErrorMessage(error)
      });
      this.sendBridgeError(ws, "message_handler_error", toErrorMessage(error));
    }
  }

  _handleReady(ws) {
    this.sendMainMessage(ws, {
      type: "shared-object-updated",
      key: "host_config",
      value: this.sharedObjects.get("host_config")
    });

    this.sendMainMessage(ws, {
      type: "active-workspace-roots-updated",
      roots: this.activeWorkspaceRoots
    });

    this.sendMainMessage(ws, {
      type: "workspace-root-options-updated",
      options: this.workspaceRootOptions.roots
    });

    this.sendMainMessage(ws, {
      type: "persisted-atom-sync",
      state: Object.fromEntries(this.persistedAtomState.entries())
    });

    this.sendMainMessage(ws, {
      type: "custom-prompts-updated",
      prompts: []
    });

    this.sendMainMessage(ws, {
      type: "app-update-ready-changed",
      isUpdateReady: false
    });
  }

  async _handleFetch(ws, message) {
    const requestId = message.requestId || randomId(8);
    this.logger.debug("renderer-fetch", {
      requestId,
      method: message.method || "GET",
      url: message.url || null,
      body: typeof message.body === "string" ? message.body.slice(0, 400) : null
    });

    if (await this._handleVirtualFetch(ws, requestId, message)) {
      return;
    }

    const resolvedUrl = this._resolveFetchUrl(message.url);
    if (!resolvedUrl) {
      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "error",
        status: 0,
        error: `Unsupported fetch URL: ${String(message.url)}`
      });
      this.logger.warn("renderer-fetch-failed", {
        requestId,
        url: message.url || null,
        error: "unsupported_fetch_url"
      });
      return;
    }

    const controller = new AbortController();
    this.fetchControllers.set(requestId, controller);

    try {
      const response = await fetch(resolvedUrl, {
        method: message.method || "GET",
        headers: message.headers || {},
        body: message.body,
        signal: controller.signal
      });

      const body = await response.text();
      const headers = {};
      for (const [key, value] of response.headers.entries()) {
        headers[key] = value;
      }

      let bodyJsonString = body;
      try {
        JSON.parse(bodyJsonString);
      } catch {
        bodyJsonString = JSON.stringify(body);
      }

      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "success",
        status: response.status,
        headers,
        bodyJsonString
      });
      this.logger.debug("renderer-fetch-response", {
        requestId,
        status: response.status,
        ok: response.ok,
        url: response.url || resolvedUrl
      });
    } catch (error) {
      this.sendMainMessage(ws, {
        type: "fetch-response",
        requestId,
        responseType: "error",
        status: 0,
        error: toErrorMessage(error)
      });
      this.logger.warn("renderer-fetch-failed", {
        requestId,
        url: resolvedUrl,
        error: toErrorMessage(error)
      });
    } finally {
      this.fetchControllers.delete(requestId);
    }
  }

  _resolveFetchUrl(url) {
    if (typeof url !== "string" || url.length === 0) {
      return null;
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return url;
    }
    if (url.startsWith("/")) {
      return `https://chatgpt.com${url}`;
    }
    return null;
  }

  async _handleVirtualFetch(ws, requestId, message) {
    if (typeof message.url !== "string") {
      return false;
    }

    if (message.url.startsWith("sentry-ipc://")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 204,
        payload: ""
      });
      this.logger.debug("renderer-fetch-response", {
        requestId,
        status: 204,
        ok: true,
        sentryIpc: true
      });
      return true;
    }

    if (message.url.startsWith("vscode://codex/")) {
      const body = safeJsonParse(typeof message.body === "string" ? message.body : "{}") || {};
      const params = body?.params ?? body ?? {};

      let endpoint = "";
      try {
        endpoint = new URL(message.url).pathname.replace(/^\/+/, "");
      } catch {
        endpoint = "";
      }

      let payload = {};
      let status = 200;
      switch (endpoint) {
        case "get-global-state": {
          const key = params?.key;
          if (key === "active-workspace-roots") {
            payload = {
              value: this.activeWorkspaceRoots
            };
            break;
          }
          if (key === "electron-saved-workspace-roots") {
            payload = {
              value: this.workspaceRootOptions
            };
            break;
          }
          if (key === "electron-workspace-root-labels") {
            payload = {
              value: this.workspaceRootOptions.labels
            };
            break;
          }
          const hasGlobalStateValue = typeof key === "string"
            && Object.prototype.hasOwnProperty.call(this.globalState, key);
          payload = {
            value: key
              ? hasGlobalStateValue
                ? this.globalState[key]
                : this.persistedAtomState.get(key) ?? null
              : null
          };
          break;
        }
        case "set-global-state": {
          const key = params?.key;
          const value = params?.value;
          if (typeof key === "string" && key.length > 0) {
            const isActiveWorkspaceRoots = key === "active-workspace-roots";
            const isSavedWorkspaceRoots = key === "electron-saved-workspace-roots";
            const isWorkspaceLabels = key === "electron-workspace-root-labels";

            if (value == null) {
              this.persistedAtomState.delete(key);
              delete this.globalState[key];
            } else {
              this.persistedAtomState.set(key, value);
              this.globalState[key] = value;
            }

            if (isActiveWorkspaceRoots && Array.isArray(value)) {
              this.activeWorkspaceRoots = [...new Set(
                value
                  .map((root) => this._normalizeWorkspaceRoot(root))
                  .filter(Boolean)
              )];
              this.userSelectedActiveWorkspaceRoots = true;
            } else if (isSavedWorkspaceRoots && value && typeof value === "object") {
              const roots = Array.isArray(value.roots)
                ? [...new Set(
                  value.roots
                    .map((root) => this._normalizeWorkspaceRoot(root))
                    .filter(Boolean)
                )]
                : [];
              const labels = value.labels && typeof value.labels === "object" ? value.labels : {};
              if (roots.length > 0) {
                this.workspaceRootOptions = { roots, labels };
              }
            } else if (isWorkspaceLabels && value && typeof value === "object") {
              this.workspaceRootOptions = {
                ...this.workspaceRootOptions,
                labels: value
              };
            }

            if (isActiveWorkspaceRoots || isSavedWorkspaceRoots || isWorkspaceLabels) {
              this._persistWorkspaceState();
            } else {
              this._scheduleGlobalStateWrite();
            }
          }
          payload = { ok: true };
          break;
        }
        case "list-pinned-threads":
          payload = { threadIds: [] };
          break;
        case "set-thread-pinned":
          payload = { ok: true };
          break;
        case "extension-info":
          payload = {
            name: "codex-webstrapper",
            version: "0.1.0",
            platform: process.platform,
            uiKind: "desktop"
          };
          break;
        case "is-copilot-api-available":
          payload = { isAvailable: false };
          break;
        case "account-info":
          payload = {
            userId: this.lastAccountRead?.userId ?? null,
            accountId: this.lastAccountRead?.accountId ?? null,
            email: this.lastAccountRead?.account?.email ?? null,
            plan: this.lastAccountRead?.account?.planType ?? null,
            account: this.lastAccountRead?.account ?? null,
            requiresOpenaiAuth: this.lastAccountRead?.requiresOpenaiAuth ?? true
          };
          break;
        case "os-info":
          payload = { platform: process.platform };
          break;
        case "ide-context":
          payload = {
            ideContext: {
              workspaceRoot: params?.workspaceRoot ?? null,
              roots: typeof params?.workspaceRoot === "string" && params.workspaceRoot.length > 0
                ? [params.workspaceRoot]
                : [],
              openFiles: [],
              activeEditor: null
            },
            roots: []
          };
          break;
        case "get-copilot-api-proxy-info":
          payload = null;
          break;
        case "mcp-codex-config":
          payload = { config: {} };
          break;
        case "developer-instructions":
          payload = {
            instructions: typeof params?.baseInstructions === "string" ? params.baseInstructions : null
          };
          break;
        case "local-environments":
          payload = [];
          break;
        case "has-custom-cli-executable":
          payload = { hasCustomCliExecutable: false };
          break;
        case "generate-thread-title": {
          const prompt = typeof params?.prompt === "string" ? params.prompt.trim() : "";
          payload = {
            title: prompt.length > 0
              ? prompt
                .replace(/\s+/g, " ")
                .split(" ")
                .slice(0, 8)
                .join(" ")
                .slice(0, 80)
              : "Update thread"
          };
          break;
        }
        case "active-workspace-roots":
          payload = { roots: this.activeWorkspaceRoots };
          break;
        case "workspace-root-options":
          payload = this.workspaceRootOptions;
          break;
        case "git-origins": {
          const dirs = Array.isArray(params?.dirs) ? params.dirs.filter((dir) => typeof dir === "string" && dir.length > 0) : [];
          payload = {
            origins: await Promise.all(dirs.map((dir) => this._resolveGitOrigin(dir)))
          };
          break;
        }
        case "git-push": {
          payload = await this._handleGitPush(params);
          status = payload.ok ? 200 : 500;
          break;
        }
        case "git-merge-base": {
          const gitRoot = typeof params?.gitRoot === "string" && params.gitRoot.length > 0
            ? params.gitRoot
            : process.cwd();
          const baseBranch = typeof params?.baseBranch === "string" ? params.baseBranch.trim() : "";
          payload = await this._resolveGitMergeBase({ gitRoot, baseBranch });
          break;
        }
        case "list-pending-automation-run-threads":
          payload = { threadIds: [] };
          break;
        case "inbox-items":
          payload = { items: [] };
          break;
        case "pending-automation-runs":
          payload = { runs: [] };
          break;
        case "list-automations":
          payload = { items: [] };
          break;
        case "open-in-targets":
          payload = { preferredTarget: null, targets: [], availableTargets: [] };
          break;
        case "codex-home":
          payload = { codexHome: null };
          break;
        case "locale-info":
          payload = { ideLocale: null, systemLocale: null };
          break;
        case "get-configuration":
          payload = { value: null };
          break;
        case "set-configuration":
          payload = { ok: true };
          break;
        case "recommended-skills":
          payload = { skills: [] };
          break;
        case "third-party-notices":
          payload = { notices: [] };
          break;
        case "gh-cli-status":
          payload = await this._resolveGhCliStatus();
          break;
        case "gh-pr-status": {
          const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
            ? params.cwd
            : process.cwd();
          const headBranch = typeof params?.headBranch === "string" ? params.headBranch.trim() : "";
          payload = await this._resolveGhPrStatus({ cwd, headBranch });
          break;
        }
        case "paths-exist": {
          const paths = Array.isArray(params?.paths) ? params.paths.filter((p) => typeof p === "string") : [];
          payload = { existingPaths: paths };
          break;
        }
        default:
          this.logger.warn("Unhandled vscode fetch endpoint", { endpoint });
          payload = {};
      }

      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status,
        payload
      });
      return true;
    }

    if (message.url === "/wham/accounts/check") {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {
          account_ordering: [],
          accounts: []
        }
      });
      return true;
    }

    if (message.url === "/wham/usage") {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {}
      });
      return true;
    }

    if (message.url.startsWith("/wham/tasks/list")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: { items: [] }
      });
      return true;
    }

    if (message.url === "/wham/environments") {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: []
      });
      return true;
    }

    if (message.url.startsWith("/wham/tasks/")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {}
      });
      return true;
    }

    if (message.url.includes("/accounts/") && message.url.endsWith("/settings")) {
      this._sendFetchJson(ws, {
        requestId,
        url: message.url,
        status: 200,
        payload: {}
      });
      return true;
    }

    return false;
  }

  async _resolveGitOrigin(dir) {
    const normalizedDir = this._normalizeWorkspaceRoot(dir) || dir;
    const fallback = {
      dir: normalizedDir,
      root: normalizedDir,
      commonDir: normalizedDir,
      originUrl: null
    };

    const rootResult = await this._runCommand("git", ["-C", normalizedDir, "rev-parse", "--show-toplevel"], {
      timeoutMs: 5_000
    });
    if (!rootResult.ok || !rootResult.stdout) {
      return fallback;
    }

    const root = this._normalizeWorkspaceRoot(rootResult.stdout) || normalizedDir;

    const commonDirResult = await this._runCommand("git", ["-C", normalizedDir, "rev-parse", "--git-common-dir"], {
      timeoutMs: 5_000
    });
    const commonDir = commonDirResult.ok && commonDirResult.stdout
      ? path.resolve(normalizedDir, commonDirResult.stdout)
      : root;

    const originResult = await this._runCommand("git", ["-C", normalizedDir, "remote", "get-url", "origin"], {
      timeoutMs: 5_000,
      allowNonZero: true
    });

    return {
      dir: normalizedDir,
      root,
      commonDir,
      originUrl: originResult.ok && originResult.stdout ? originResult.stdout : null
    };
  }

  async _resolveGhCliStatus() {
    const ghVersion = await this._runCommand("gh", ["--version"], {
      timeoutMs: 3_000,
      allowNonZero: true
    });

    if (!ghVersion.ok) {
      return {
        isInstalled: false,
        isAuthenticated: false
      };
    }

    const auth = await this._runCommand("gh", ["auth", "status", "--hostname", "github.com"], {
      timeoutMs: 4_000,
      allowNonZero: true
    });

    return {
      isInstalled: true,
      isAuthenticated: auth.ok
    };
  }

  async _resolveGhPrStatus({ cwd, headBranch }) {
    if (!headBranch) {
      return {
        status: "success",
        hasOpenPr: false,
        url: null,
        number: null
      };
    }

    const ghStatus = await this._resolveGhCliStatus();
    if (!ghStatus.isInstalled || !ghStatus.isAuthenticated) {
      return {
        status: "error",
        hasOpenPr: false,
        url: null,
        number: null,
        error: "gh cli unavailable or unauthenticated"
      };
    }

    const listResult = await this._runCommand(
      "gh",
      ["pr", "list", "--state", "open", "--head", headBranch, "--json", "number,url", "--limit", "1"],
      {
        timeoutMs: 8_000,
        allowNonZero: true,
        cwd
      }
    );

    if (!listResult.ok) {
      return {
        status: "error",
        hasOpenPr: false,
        url: null,
        number: null,
        error: listResult.error || "failed to query open pull requests"
      };
    }

    const parsed = safeJsonParse(listResult.stdout);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        status: "success",
        hasOpenPr: false,
        url: null,
        number: null
      };
    }

    const first = parsed[0] && typeof parsed[0] === "object" ? parsed[0] : {};
    const number = Number.isInteger(first.number) ? first.number : null;
    const url = typeof first.url === "string" && first.url.length > 0 ? first.url : null;

    return {
      status: "success",
      hasOpenPr: true,
      url,
      number
    };
  }

  async _resolveGitMergeBase({ gitRoot, baseBranch }) {
    if (!baseBranch) {
      return {
        mergeBaseSha: null
      };
    }

    const result = await this._runCommand(
      "git",
      ["-C", gitRoot, "merge-base", "HEAD", baseBranch],
      {
        timeoutMs: 5_000,
        allowNonZero: true
      }
    );

    return {
      mergeBaseSha: result.ok && result.stdout ? result.stdout : null
    };
  }

  async _handleGitPush(params) {
    const cwd = typeof params?.cwd === "string" && params.cwd.length > 0
      ? params.cwd
      : process.cwd();
    const remote = typeof params?.remote === "string" && params.remote.trim().length > 0
      ? params.remote.trim()
      : null;
    const branch = typeof params?.branch === "string" && params.branch.trim().length > 0
      ? params.branch.trim()
      : null;

    const args = ["-C", cwd, "push"];
    if (params?.force === true || params?.forceWithLease === true) {
      args.push("--force-with-lease");
    }
    if (params?.setUpstream === true) {
      args.push("--set-upstream");
    }
    if (remote) {
      args.push(remote);
    }
    if (branch) {
      args.push(branch);
    }

    const result = await this._runCommand("git", args, {
      cwd,
      timeoutMs: 120_000,
      allowNonZero: true
    });

    if (result.ok) {
      return {
        ok: true,
        code: result.code,
        stdout: result.stdout || "",
        stderr: result.stderr || ""
      };
    }

    return {
      ok: false,
      code: result.code,
      error: result.error || result.stderr || "git push failed",
      stdout: result.stdout || "",
      stderr: result.stderr || ""
    };
  }

  async _runCommand(command, args, { timeoutMs = 5_000, allowNonZero = false, cwd = process.cwd() } = {}) {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        finish({
          ok: false,
          code: null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: toErrorMessage(error)
        });
      });

      child.on("exit", (code) => {
        const success = code === 0;
        finish({
          ok: success,
          code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: success || allowNonZero ? null : stderr.trim() || `exit code ${String(code)}`
        });
      });

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish({
          ok: false,
          code: null,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          error: `command timed out after ${timeoutMs}ms`
        });
      }, timeoutMs);
    });
  }

  _sendFetchJson(ws, { requestId, url, status = 200, payload = {} }) {
    const bodyJsonString = JSON.stringify(payload);
    this.sendMainMessage(ws, {
      type: "fetch-response",
      requestId,
      responseType: "success",
      status,
      headers: { "content-type": "application/json" },
      bodyJsonString
    });
    this.logger.debug("renderer-fetch-response", {
      requestId,
      status,
      ok: status >= 200 && status < 300,
      url
    });
  }

  _handleCancelFetch(message) {
    const controller = this.fetchControllers.get(message.requestId);
    if (!controller) {
      return;
    }
    controller.abort();
    this.fetchControllers.delete(message.requestId);
  }

  async _forwardToAppServer(ws, payload) {
    if (!this.appServer) {
      this.sendBridgeError(ws, "app_server_unavailable", "App-server backend is unavailable.");
      return;
    }

    this.logger.debug("mcp-forward-request", {
      id: payload?.id ?? null,
      method: payload?.method ?? null
    });
    const response = await this.appServer.sendRaw(payload);

    if (payload?.method === "account/read" && response?.result) {
      this.lastAccountRead = response.result;
    }

    if (payload?.method === "thread/list" && response?.result) {
      response.result = this._filterThreadListResult(response.result);
    }

    if (response && payload && payload.id != null) {
      this.logger.debug("mcp-forward-response", {
        id: response.id ?? payload.id,
        hasResult: response.result != null,
        hasError: response.error != null
      });
      this.sendMainMessage(ws, {
        type: "mcp-response",
        message: {
          id: response.id ?? payload.id,
          result: response.result,
          error: response.error
        }
      });
    }
  }

  _normalizeWorkspaceRoot(root) {
    if (typeof root !== "string") {
      return null;
    }
    const trimmed = root.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.replace(/\/+$/, "");
  }

  _loadPersistedGlobalState() {
    if (!this.globalStatePath) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.globalStatePath, "utf8"));
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    this.globalState = parsed;

    const persistedAtoms = parsed["electron-persisted-atom-state"];
    if (persistedAtoms && typeof persistedAtoms === "object" && !Array.isArray(persistedAtoms)) {
      for (const [key, value] of Object.entries(persistedAtoms)) {
        this.persistedAtomState.set(key, value);
      }
    }

    const rawSavedRoots = parsed["electron-saved-workspace-roots"];
    const rawActiveRoots = parsed["active-workspace-roots"];
    const rawLabels = parsed["electron-workspace-root-labels"];

    let savedRoots = [];
    if (Array.isArray(rawSavedRoots)) {
      savedRoots = rawSavedRoots;
    } else if (rawSavedRoots && typeof rawSavedRoots === "object" && Array.isArray(rawSavedRoots.roots)) {
      savedRoots = rawSavedRoots.roots;
    }

    const normalizedSavedRoots = [...new Set(
      savedRoots
        .map((root) => this._normalizeWorkspaceRoot(root))
        .filter(Boolean)
    )];

    if (normalizedSavedRoots.length > 0) {
      const labels = rawLabels && typeof rawLabels === "object"
        ? rawLabels
        : rawSavedRoots && typeof rawSavedRoots === "object" && rawSavedRoots.labels && typeof rawSavedRoots.labels === "object"
          ? rawSavedRoots.labels
          : {};
      this.workspaceRootOptions = {
        roots: normalizedSavedRoots,
        labels
      };
    }

    if (Array.isArray(rawActiveRoots)) {
      const normalizedActiveRoots = [...new Set(
        rawActiveRoots
          .map((root) => this._normalizeWorkspaceRoot(root))
          .filter(Boolean)
      )];
      if (normalizedActiveRoots.length > 0) {
        this.activeWorkspaceRoots = normalizedActiveRoots;
        this.userSelectedActiveWorkspaceRoots = true;
      }
    }
  }

  _isCwdInRoot(cwd, root) {
    if (cwd === root) {
      return true;
    }
    return cwd.startsWith(`${root}/`);
  }

  _filterThreadListResult(result) {
    if (!result || !Array.isArray(result.data)) {
      return result;
    }

    const normalizedWorkspaceRoots = Array.isArray(this.workspaceRootOptions?.roots)
      ? this.workspaceRootOptions.roots
        .map((root) => this._normalizeWorkspaceRoot(root))
        .filter(Boolean)
      : [];

    // Desktop effectively scopes sidebar data to known/saved roots, not only the
    // currently active root. Using saved roots prevents global clutter while still
    // allowing threads to appear under every configured project folder.
    if (normalizedWorkspaceRoots.length === 0) {
      return result;
    }

    const filteredData = result.data.filter((item) => {
      const cwd = this._normalizeWorkspaceRoot(item?.cwd);
      if (!cwd) {
        return false;
      }

      return normalizedWorkspaceRoots.some((root) => this._isCwdInRoot(cwd, root));
    });

    if (filteredData.length === result.data.length) {
      return result;
    }

    return {
      ...result,
      data: filteredData
    };
  }

  _persistWorkspaceState({ writeToDisk = true } = {}) {
    const labels = this.workspaceRootOptions.labels || {};
    const roots = [...this.workspaceRootOptions.roots];
    const activeRoots = [...this.activeWorkspaceRoots];

    this.globalState["active-workspace-roots"] = activeRoots;
    this.globalState["electron-saved-workspace-roots"] = roots;
    this.globalState["electron-workspace-root-labels"] = labels;

    this.persistedAtomState.set("active-workspace-roots", this.activeWorkspaceRoots);
    this.persistedAtomState.set("electron-saved-workspace-roots", this.workspaceRootOptions);
    this.persistedAtomState.set("electron-workspace-root-labels", labels);

    if (writeToDisk) {
      this._scheduleGlobalStateWrite();
    }
  }

  _scheduleGlobalStateWrite() {
    if (!this.globalStatePath) {
      return;
    }

    if (this.globalStateWriteTimer) {
      clearTimeout(this.globalStateWriteTimer);
    }

    this.globalStateWriteTimer = setTimeout(() => {
      this.globalStateWriteTimer = null;
      void this._writeGlobalStateToDisk();
    }, 50);

    if (typeof this.globalStateWriteTimer?.unref === "function") {
      this.globalStateWriteTimer.unref();
    }
  }

  _buildGlobalStatePayload() {
    const persistedAtomState = {};
    for (const [key, value] of this.persistedAtomState.entries()) {
      if (
        key === "active-workspace-roots"
        || key === "electron-saved-workspace-roots"
        || key === "electron-workspace-root-labels"
      ) {
        continue;
      }
      persistedAtomState[key] = value;
    }

    return {
      ...this.globalState,
      "active-workspace-roots": this.activeWorkspaceRoots,
      "electron-saved-workspace-roots": this.workspaceRootOptions.roots,
      "electron-workspace-root-labels": this.workspaceRootOptions.labels || {},
      "electron-persisted-atom-state": persistedAtomState
    };
  }

  async _writeGlobalStateToDisk() {
    if (!this.globalStatePath) {
      return;
    }

    try {
      const payload = this._buildGlobalStatePayload();
      await fs.mkdir(path.dirname(this.globalStatePath), { recursive: true });
      await fs.writeFile(this.globalStatePath, JSON.stringify(payload));
    } catch (error) {
      this.logger.warn("Failed to persist global state", {
        path: this.globalStatePath,
        error: toErrorMessage(error)
      });
    }
  }

  _subscribeSharedObject(ws, key) {
    if (!key) {
      return;
    }

    let subscribers = this.sharedObjectSubscribers.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.sharedObjectSubscribers.set(key, subscribers);
    }
    subscribers.add(ws);

    this.sendMainMessage(ws, {
      type: "shared-object-updated",
      key,
      value: this.sharedObjects.get(key)
    });
  }

  _unsubscribeSharedObject(ws, key) {
    if (!key) {
      return;
    }

    const subscribers = this.sharedObjectSubscribers.get(key);
    if (!subscribers) {
      return;
    }

    subscribers.delete(ws);
    if (subscribers.size === 0) {
      this.sharedObjectSubscribers.delete(key);
    }
  }

  _setSharedObject(key, value) {
    if (!key) {
      return;
    }

    this.sharedObjects.set(key, value);
    const subscribers = this.sharedObjectSubscribers.get(key);
    if (!subscribers) {
      return;
    }

    for (const ws of subscribers) {
      this.sendMainMessage(ws, {
        type: "shared-object-updated",
        key,
        value
      });
    }
  }

  async _archiveThread(ws, message) {
    // Renderer handles the real archive operation via `thread/archive`.
    // This event is a pre-archive signal and must not invoke archive again.
    void ws;
    void message;
  }

  async _unarchiveThread(ws, message) {
    // Renderer handles the real unarchive operation via `thread/unarchive`.
    // This event is a pre-unarchive signal and must not invoke unarchive again.
    void ws;
    void message;
  }

  async _handleThreadOverlayStartTurn(ws, message) {
    const requestId = message.requestId;
    if (!this.appServer) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-start-turn-response",
        requestId,
        error: "app-server unavailable"
      });
      return;
    }

    try {
      const params = message.params || message.turnStartParams || {};
      const response = await this.appServer.sendRequest("turn/start", params);
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-start-turn-response",
        requestId,
        result: response?.result ?? null,
        error: null
      });
    } catch (error) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-start-turn-response",
        requestId,
        result: null,
        error: toErrorMessage(error)
      });
    }
  }

  async _handleThreadOverlayInterrupt(ws, message) {
    const requestId = message.requestId;
    if (!this.appServer) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-interrupt-response",
        requestId,
        error: "app-server unavailable"
      });
      return;
    }

    try {
      const params = message.params || message.interruptParams || {};
      await this.appServer.sendRequest("turn/interrupt", params);
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-interrupt-response",
        requestId,
        error: null
      });
    } catch (error) {
      this.sendMainMessage(ws, {
        type: "thread-overlay-proxy-interrupt-response",
        requestId,
        error: toErrorMessage(error)
      });
    }
  }

  async _handleWorkerMessage(ws, workerId, payload) {
    if (workerId !== "git") {
      this.sendBridgeError(ws, "unsupported_worker", `Unsupported worker id: ${workerId}`);
      return;
    }

    await this.gitWorker.postMessage(ws, payload);
  }

  _openInBrowser(ws, message) {
    const url = message.url || message.href;
    if (!url) {
      this.sendBridgeError(ws, "missing_url", "open-in-browser requires `url`.");
      return;
    }

    const child = spawn("open", [url], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true
    });
    child.unref();
  }

  sendBridgeEnvelope(ws, envelope) {
    if (!ws || ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(envelope));
  }

  sendMainMessage(ws, payload) {
    this.sendBridgeEnvelope(ws, {
      type: "main-message",
      payload
    });
  }

  broadcastMainMessage(payload) {
    for (const ws of this.clients) {
      this.sendMainMessage(ws, payload);
    }
  }

  sendWorkerEvent(ws, workerId, payload) {
    this.sendBridgeEnvelope(ws, {
      type: "worker-event",
      workerId,
      payload
    });
  }

  broadcastWorkerEvent(workerId, payload) {
    for (const ws of this.clients) {
      this.sendWorkerEvent(ws, workerId, payload);
    }
  }

  sendBridgeError(ws, code, message, details) {
    this.logger.warn("bridge-error", {
      code,
      message
    });
    this.sendBridgeEnvelope(ws, {
      type: "bridge-error",
      code,
      message,
      details
    });
  }
}
