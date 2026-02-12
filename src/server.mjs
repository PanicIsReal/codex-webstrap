import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import {
  ensurePersistentToken,
  SessionStore,
  createAuthController,
  defaultTokenFilePath
} from "./auth.mjs";
import {
  buildPatchedIndexHtml,
  ensureCodexAppExists,
  ensureExtractedAssets,
  readBuildMetadata,
  readStaticFile,
  resolveCodexAppPaths
} from "./assets.mjs";
import { AppServerManager } from "./app-server.mjs";
import { UdsIpcClient } from "./ipc-uds.mjs";
import { MessageRouter } from "./message-router.mjs";
import { createLogger, safeJsonParse, sleep, toErrorMessage } from "./util.mjs";

const logger = createLogger("server");

function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const config = {
    port: Number(env.CODEX_WEBSTRAP_PORT || 8080),
    bind: env.CODEX_WEBSTRAP_BIND || "127.0.0.1",
    tokenFile: env.CODEX_WEBSTRAP_TOKEN_FILE || defaultTokenFilePath(),
    codexAppPath: env.CODEX_WEBSTRAP_CODEX_APP || "/Applications/Codex.app",
    internalWsPort: Number(env.CODEX_WEBSTRAP_INTERNAL_WS_PORT || 38080),
    autoOpen: env.CODEX_WEBSTRAP_OPEN === "1"
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--port":
        config.port = Number(argv[++i]);
        break;
      case "--bind":
        config.bind = argv[++i];
        break;
      case "--token-file":
        config.tokenFile = argv[++i];
        break;
      case "--codex-app":
        config.codexAppPath = argv[++i];
        break;
      case "--open":
        config.autoOpen = true;
        break;
      default:
        break;
    }
  }

  return config;
}

async function isCodexRunning() {
  return new Promise((resolve) => {
    const child = spawn("pgrep", ["-x", "Codex"], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("exit", (code) => {
      resolve(code === 0);
    });
    child.on("error", () => {
      resolve(false);
    });
  });
}

function openCodexApp(appPath) {
  const child = spawn("open", ["-a", appPath], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true
  });
  child.unref();
}

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendNotFound(res) {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Not found");
}

async function main() {
  const config = parseConfig();

  const tokenResult = await ensurePersistentToken(config.tokenFile);
  const runtimeMetadataPath = `${tokenResult.tokenFilePath}.runtime`;
  const sessionStore = new SessionStore({ ttlMs: 1000 * 60 * 60 * 12 });
  const auth = createAuthController({ token: tokenResult.token, sessionStore });

  const codexPaths = resolveCodexAppPaths(config.codexAppPath);
  await ensureCodexAppExists(codexPaths);
  const build = await readBuildMetadata(codexPaths);

  const running = await isCodexRunning();
  if (!running) {
    logger.info("Launching Codex desktop app", { appPath: codexPaths.appPath });
    openCodexApp(codexPaths.appPath);
  }

  const udsClient = new UdsIpcClient({ logger: createLogger("uds") });
  const udsSocketReady = await waitForFile(udsClient.socketPath, 6000);
  if (!udsSocketReady) {
    logger.warn("UDS socket not detected before startup timeout", { socketPath: udsClient.socketPath });
  }

  try {
    await udsClient.start();
  } catch (error) {
    logger.warn("UDS client start failed; continuing with app-server fallback", {
      error: toErrorMessage(error)
    });
  }

  const assetBundle = await ensureExtractedAssets({
    asarPath: codexPaths.asarPath,
    buildKey: build.buildKey,
    logger
  });
  const patchedIndexHtml = await buildPatchedIndexHtml(assetBundle.indexPath);

  let codexCliPath = process.env.CODEX_CLI_PATH || codexPaths.codexCliPath;
  if (!process.env.CODEX_CLI_PATH) {
    const bundledCliExists = await fs.access(codexPaths.codexCliPath).then(() => true).catch(() => false);
    if (!bundledCliExists) {
      codexCliPath = "codex";
      logger.warn("Bundled Codex CLI not found, falling back to PATH", {
        bundledCliPath: codexPaths.codexCliPath
      });
    }
  }

  const appServer = new AppServerManager({
    internalPort: config.internalWsPort,
    codexCliPath,
    logger: createLogger("app-server")
  });

  try {
    await appServer.start();
  } catch (error) {
    logger.warn("App-server startup failed; UI may be degraded", {
      error: toErrorMessage(error)
    });
  }

  const router = new MessageRouter({
    appServer,
    udsClient,
    hostConfig: {
      id: "local",
      display_name: "Codex",
      kind: "local"
    },
    workerPath: assetBundle.workerPath,
    logger: createLogger("router")
  });

  const thisFilePath = fileURLToPath(import.meta.url);
  const shimPath = path.resolve(path.join(path.dirname(thisFilePath), "bridge-shim.js"));
  const shimBody = await fs.readFile(shimPath);

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `${config.bind}:${config.port}`;
      const url = new URL(req.url || "/", `http://${host}`);

      if (url.pathname === "/__webstrapper/healthz") {
        sendJson(res, 200, {
          ok: true,
          appServer: appServer.getState(),
          udsReady: udsClient.isReady(),
          build: build.buildKey
        });
        return;
      }

      if (url.pathname === "/favicon.ico") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (url.pathname === "/__webstrapper/auth") {
        auth.handleAuthRoute(req, res, url);
        return;
      }

      if (!auth.requireAuth(req, res)) {
        return;
      }

      if (url.pathname === "/__webstrapper/shim.js") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        res.end(shimBody);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(patchedIndexHtml);
        return;
      }

      const staticFile = await readStaticFile(assetBundle.webRoot, url.pathname);
      if (!staticFile) {
        sendNotFound(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", staticFile.contentType);
      res.end(staticFile.body);
    } catch (error) {
      logger.error("HTTP handler failed", { error: toErrorMessage(error) });
      sendJson(res, 500, { error: "internal_server_error" });
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    router.registerClient(ws);

    ws.on("message", async (raw) => {
      const text = raw.toString("utf8");
      const parsed = safeJsonParse(text);
      if (!parsed) {
        router.sendBridgeError(ws, "invalid_json", "Failed to parse bridge JSON payload.");
        return;
      }

      await router.handleEnvelope(ws, parsed);
    });

    ws.on("close", () => {
      router.unregisterClient(ws);
    });

    ws.on("error", () => {
      router.unregisterClient(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host || `${config.bind}:${config.port}`;
    const url = new URL(req.url || "/", `http://${host}`);

    if (url.pathname !== "/__webstrapper/bridge") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!auth.isAuthorizedRequest(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bind, resolve);
  });

  try {
    await fs.writeFile(
      runtimeMetadataPath,
      JSON.stringify({
        bind: config.bind,
        port: config.port,
        tokenFile: tokenResult.tokenFilePath,
        pid: process.pid,
        startedAt: Date.now()
      }) + "\n",
      { mode: 0o600 }
    );
  } catch (error) {
    logger.warn("Failed to write runtime metadata file", {
      path: runtimeMetadataPath,
      error: toErrorMessage(error)
    });
  }

  const authHint = `http://${config.bind}:${config.port}/__webstrapper/auth?token=<redacted>`;
  const loginCommand = `open \"http://${config.bind}:${config.port}/__webstrapper/auth?token=$(cat ${tokenResult.tokenFilePath})\"`;

  logger.info("codex-webstrapper started", {
    bind: config.bind,
    port: config.port,
    buildKey: build.buildKey,
    tokenFilePath: tokenResult.tokenFilePath,
    authHint
  });

  process.stdout.write(`\nCodex Webstrapper listening on http://${config.bind}:${config.port}\n`);
  process.stdout.write(`Token file: ${tokenResult.tokenFilePath}\n`);
  process.stdout.write(`Auth URL pattern: ${authHint}\n`);
  process.stdout.write(`Local login command: ${loginCommand}\n\n`);

  if (config.autoOpen) {
    const openUrl = `http://${config.bind}:${config.port}/__webstrapper/auth?token=${encodeURIComponent(tokenResult.token)}`;
    const child = spawn("open", [openUrl], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true
    });
    child.unref();
  }

  const pruneInterval = setInterval(() => {
    sessionStore.pruneExpired();
  }, 60_000);
  pruneInterval.unref();

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    logger.info("Shutting down", { signal });

    clearInterval(pruneInterval);

    wss.clients.forEach((client) => {
      try {
        client.close();
      } catch {
        // ignore
      }
    });

    router.dispose();
    appServer.stop();
    udsClient.stop();

    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    try {
      await fs.unlink(runtimeMetadataPath);
    } catch {
      // ignore
    }

    process.exit(0);
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

main().catch((error) => {
  logger.error("Fatal startup error", { error: toErrorMessage(error) });
  process.exit(1);
});
