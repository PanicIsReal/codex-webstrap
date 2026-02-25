import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WebSocketServer } from "ws";

import {
  ensurePersistentToken,
  SessionStore,
  createAuthController
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
import { parseConfig } from "./config.mjs";
import { UdsIpcClient } from "./ipc-uds.mjs";
import { MessageRouter } from "./message-router.mjs";
import { ProfileSwitcher } from "./profile-switcher.mjs";
import { createLogger, safeJsonParse, sleep, toErrorMessage } from "./util.mjs";

const logger = createLogger("server");

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

async function resolveAuthPassword(config) {
  if (typeof config.authPassword === "string" && config.authPassword.length > 0) {
    return config.authPassword;
  }

  if (!config.authPasswordFile) {
    return "";
  }

  try {
    const loaded = (await fs.readFile(config.authPasswordFile, "utf8")).trim();
    return loaded;
  } catch (error) {
    logger.warn("Failed to load auth password from file", {
      path: config.authPasswordFile,
      error: toErrorMessage(error)
    });
    return "";
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => reject(error));
  });

  if (!raw.trim()) {
    return {};
  }

  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid JSON body");
  }
  return parsed;
}

async function main() {
  const { config, warnings } = await parseConfig();
  for (const warning of warnings) {
    logger.warn("Config warning", { warning });
  }

  const authPassword = await resolveAuthPassword(config);
  if (config.authMode === "basic" && !authPassword) {
    throw new Error("auth-mode basic requires --auth-password or --auth-password-file");
  }

  const tokenResult = await ensurePersistentToken(config.tokenFile);
  const runtimeMetadataPath = `${tokenResult.tokenFilePath}.runtime`;
  const sessionStore = new SessionStore({ ttlMs: 1000 * 60 * 60 * 12 });
  const auth = createAuthController({
    token: tokenResult.token,
    sessionStore,
    authMode: config.authMode,
    basicUsername: config.authUsername,
    basicPassword: authPassword,
    logger: createLogger("auth")
  });

  const codexPaths = resolveCodexAppPaths(config.codexAppPath);
  await ensureCodexAppExists(codexPaths);
  const build = await readBuildMetadata(codexPaths);

  const codexRunningAtStartup = await isCodexRunning();
  if (!codexRunningAtStartup && config.launchCodex === "auto") {
    logger.info("Launching Codex desktop app", { appPath: codexPaths.appPath });
    openCodexApp(codexPaths.appPath);
  } else if (!codexRunningAtStartup) {
    logger.info("Codex desktop app is not running; launch skipped by config", {
      launchCodex: config.launchCodex
    });
  }

  const profileSwitcher = new ProfileSwitcher({
    enabled: config.profileSwitching,
    strategy: config.profileStrategy,
    fixedProfile: config.profileFixed,
    profilesDir: config.profilesDir,
    hostAuthFile: config.hostAuthFile,
    stateFile: config.profileStateFile,
    logger: createLogger("profile-switcher")
  });

  let latestProfileSwitch = await profileSwitcher.apply({
    codexRunning: codexRunningAtStartup
  });
  if (latestProfileSwitch.status !== "disabled") {
    logger.info("Startup profile switch result", latestProfileSwitch);
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
    logger: createLogger("router"),
    globalStatePath: config.globalStatePath
  });

  const thisFilePath = fileURLToPath(import.meta.url);
  const shimPath = path.resolve(path.join(path.dirname(thisFilePath), "bridge-shim.js"));
  const shimBody = await fs.readFile(shimPath);

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `${config.bind}:${config.port}`;
      const url = new URL(req.url || "/", `http://${host}`);
      const pathname = url.pathname;

      if (pathname === "/__webstrapper/healthz") {
        const codexRunning = await isCodexRunning();
        const profileStatus = await profileSwitcher.describe({ codexRunning });
        sendJson(res, 200, {
          ok: true,
          appServer: appServer.getState(),
          udsReady: udsClient.isReady(),
          build: build.buildKey,
          auth: {
            mode: config.authMode
          },
          profileSwitch: {
            ...profileStatus,
            lastResult: latestProfileSwitch
          },
          config: {
            bind: config.bind,
            port: config.port,
            launchCodex: config.launchCodex,
            configFile: config.configFile
          }
        });
        return;
      }

      if (pathname === "/favicon.ico") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (pathname === "/__webstrapper/auth") {
        auth.handleAuthRoute(req, res, url);
        return;
      }

      if (pathname === auth.loginPath) {
        await auth.handlePasswordLoginRoute(req, res);
        return;
      }

      if (!auth.requireAuth(req, res)) {
        return;
      }

      if (pathname === "/__webstrapper/profiles" && req.method === "GET") {
        const codexRunning = await isCodexRunning();
        const status = await profileSwitcher.describe({ codexRunning });
        sendJson(res, 200, {
          ...status,
          lastResult: latestProfileSwitch
        });
        return;
      }

      if (pathname === "/__webstrapper/profiles/switch" && req.method === "POST") {
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch (error) {
          sendJson(res, 400, {
            error: "invalid_json",
            message: toErrorMessage(error)
          });
          return;
        }

        const requestedProfile = typeof payload.profile === "string" ? payload.profile : "";
        const codexRunning = await isCodexRunning();
        latestProfileSwitch = await profileSwitcher.apply({
          codexRunning,
          requestedProfile
        });

        if (latestProfileSwitch.status === "switched") {
          sendJson(res, 200, latestProfileSwitch);
          return;
        }
        if (latestProfileSwitch.status === "blocked") {
          sendJson(res, 409, latestProfileSwitch);
          return;
        }
        if (latestProfileSwitch.status === "no_profiles") {
          sendJson(res, 404, latestProfileSwitch);
          return;
        }
        if (latestProfileSwitch.status === "disabled") {
          sendJson(res, 409, latestProfileSwitch);
          return;
        }
        sendJson(res, 500, latestProfileSwitch);
        return;
      }

      if (
        pathname === "/__webstrapper/profiles"
        || pathname === "/__webstrapper/profiles/switch"
      ) {
        res.statusCode = 405;
        res.setHeader("allow", pathname.endsWith("/switch") ? "POST" : "GET");
        res.end();
        return;
      }

      if (pathname === "/__webstrapper/shim.js") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        res.end(shimBody);
        return;
      }

      if (pathname === "/" || pathname === "/index.html") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(patchedIndexHtml);
        return;
      }

      const staticFile = await readStaticFile(assetBundle.webRoot, pathname);
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
        configFile: config.configFile,
        authMode: config.authMode,
        profileSwitching: config.profileSwitching,
        launchCodex: config.launchCodex,
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
  const basicLoginUrl = `http://${config.bind}:${config.port}${auth.loginPath}`;

  logger.info("codex-relay started", {
    bind: config.bind,
    port: config.port,
    buildKey: build.buildKey,
    tokenFilePath: tokenResult.tokenFilePath,
    authMode: config.authMode,
    authHint,
    configFile: config.configFile
  });

  process.stdout.write(`\nCodex relay listening on http://${config.bind}:${config.port}\n`);
  process.stdout.write(`Config file: ${config.configFile}\n`);
  process.stdout.write(`Token file: ${tokenResult.tokenFilePath}\n`);
  if (config.authMode === "basic") {
    process.stdout.write(`Password login URL: ${basicLoginUrl}\n`);
  } else if (config.authMode === "off") {
    process.stdout.write("Auth mode: off (no login required)\n");
  } else {
    process.stdout.write(`Auth URL pattern: ${authHint}\n`);
    process.stdout.write(`Local login command: ${loginCommand}\n`);
  }
  process.stdout.write("\n");

  if (config.autoOpen) {
    const openUrl = config.authMode === "basic"
      ? basicLoginUrl
      : `http://${config.bind}:${config.port}/__webstrapper/auth?token=${encodeURIComponent(tokenResult.token)}`;
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
