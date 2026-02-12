import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import { createLogger, toErrorMessage } from "./util.mjs";

export class AppServerManager extends EventEmitter {
  constructor({
    internalPort = 38080,
    codexCliPath = process.env.CODEX_CLI_PATH || "codex",
    logger
  } = {}) {
    super();
    this.internalPort = internalPort;
    this.codexCliPath = codexCliPath;
    this.logger = logger || createLogger("app-server");

    this.proc = null;
    this.connected = false;
    this.initialized = false;
    this.transportKind = "stdio";

    this.nextId = 1;
    this.pending = new Map();
    this.connectingPromise = null;
    this.stopped = false;
    this.stdoutBuffer = "";
  }

  getState() {
    return {
      connected: this.connected,
      initialized: this.initialized,
      transportKind: this.transportKind,
      wsUrl: null
    };
  }

  async start() {
    this.stopped = false;

    if (this.connected && this.initialized) {
      return;
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this._startInternal().finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  async _startInternal() {
    if (this.proc && !this.proc.killed && this.connected) {
      return;
    }

    await this._spawnStdioProcess();
    await this._initializeProtocol();
  }

  stop() {
    this.stopped = true;

    this._rejectAllPending(new Error("App server stopped"));

    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }

    this.proc = null;
    this.connected = false;
    this.initialized = false;
    this.stdoutBuffer = "";
    this._emitConnectionChanged();
  }

  async sendRequest(method, params, options = {}) {
    if (!options.skipReadyCheck) {
      await this._ensureReady();
    } else if (!(this.connected && this.proc && this.proc.stdin && !this.proc.stdin.destroyed)) {
      throw new Error("App server stdio is not connected");
    }

    const id = options.id ?? this.nextId++;
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timeout: ${method}`));
      }, options.timeoutMs || 15000);

      this.pending.set(id, { resolve, reject, timer, method });

      try {
        this._sendJson(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async sendNotification(method, params) {
    await this._ensureReady();
    this._sendJson({ method, params });
  }

  async sendRaw(message) {
    if (!message || typeof message !== "object") {
      throw new Error("sendRaw expects an object");
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      return this.sendRequest(message.method, message.params, {
        id: message.id,
        timeoutMs: 15000
      });
    }

    await this._ensureReady();
    this._sendJson(message);
    return null;
  }

  async _ensureReady() {
    if (this.connected && this.initialized && this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
      return;
    }

    await this.start();

    if (!(this.connected && this.initialized)) {
      throw new Error("App server is not connected");
    }
  }

  async _spawnStdioProcess() {
    if (this.proc && !this.proc.killed) {
      return;
    }

    const args = ["app-server", "--analytics-default-enabled"];

    this.logger.info("Starting codex app-server (stdio)", {
      codexCliPath: this.codexCliPath,
      args
    });

    const proc = spawn(this.codexCliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    proc.stderr?.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim();
      if (line) {
        this.logger.debug("app-server stderr", { line });
      }
    });

    proc.stdout?.on("data", (chunk) => {
      this._handleStdoutChunk(chunk.toString("utf8"));
    });

    proc.on("error", (error) => {
      this.logger.error("app-server spawn failed", { error: toErrorMessage(error) });
    });

    proc.on("exit", (code, signal) => {
      this.logger.warn("app-server exited", { code, signal });
      this.proc = null;
      this.connected = false;
      this.initialized = false;
      this.stdoutBuffer = "";
      this._rejectAllPending(new Error("App server process exited"));
      this._emitConnectionChanged();
    });

    this.proc = proc;
    this.connected = true;
    this.initialized = false;
    this._emitConnectionChanged();
  }

  _handleStdoutChunk(chunk) {
    this.stdoutBuffer += chunk;

    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(line);
      } catch (error) {
        this.logger.warn("Dropping non-JSON app-server line", {
          line,
          error: toErrorMessage(error)
        });
        continue;
      }

      this._handleIncoming(payload);
    }
  }

  _handleIncoming(payload) {
    this.emit("message", payload);

    if (payload.id != null) {
      const pending = this.pending.get(payload.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(payload.id);
        pending.resolve(payload);
        return;
      }
    }

    if (payload.method) {
      if (payload.id != null) {
        this.emit("request", payload);
        return;
      }
      this.emit("notification", payload);
    }
  }

  async _initializeProtocol() {
    const initializeResponse = await this.sendRequest(
      "initialize",
      {
        clientInfo: {
          name: "codex_webstrapper",
          title: "Codex Webstrapper",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      },
      { skipReadyCheck: true }
    );

    if (initializeResponse?.error) {
      throw new Error(`App server initialize failed: ${JSON.stringify(initializeResponse.error)}`);
    }

    this._sendJson({ method: "initialized", params: {} });
    this.initialized = true;
    this._emitConnectionChanged();
    this.emit("initialized");
  }

  _sendJson(payload) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error("App server stdin is not writable");
    }

    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _emitConnectionChanged() {
    this.emit("connection-changed", this.getState());
  }
}
