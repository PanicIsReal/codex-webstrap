import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { randomId, safeJsonParse } from "./util.mjs";

export const SESSION_COOKIE_NAME = "cw_session";
const AUTH_MODES = new Set(["off", "token", "basic"]);
const LOGIN_PATH = "/__webstrapper/login";

export function normalizeAuthMode(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (AUTH_MODES.has(normalized)) {
    return normalized;
  }
  return "off";
}

export function defaultTokenFilePath() {
  return path.join(os.homedir(), ".codex-relay", "token");
}

export async function ensurePersistentToken(tokenFilePath) {
  const resolvedPath = path.resolve(tokenFilePath || defaultTokenFilePath());
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });

  try {
    const existing = (await fs.readFile(resolvedPath, "utf8")).trim();
    if (existing.length >= 32) {
      return { token: existing, tokenFilePath: resolvedPath };
    }
  } catch {
    // No token yet.
  }

  const token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(resolvedPath, `${token}\n`, { mode: 0o600 });
  return { token, tokenFilePath: resolvedPath };
}

export function parseCookies(cookieHeader) {
  const output = Object.create(null);
  if (!cookieHeader) {
    return output;
  }

  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rest] = segment.trim().split("=");
    if (!rawKey) {
      continue;
    }
    output[rawKey] = decodeURIComponent(rest.join("="));
  }
  return output;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAgeSeconds != null) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }

  parts.push(`Path=${options.path ?? "/"}`);

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function appendSetCookieHeader(res, cookieValue) {
  const current = res.getHeader("set-cookie");
  if (!current) {
    res.setHeader("set-cookie", cookieValue);
    return;
  }

  if (Array.isArray(current)) {
    res.setHeader("set-cookie", [...current, cookieValue]);
    return;
  }

  res.setHeader("set-cookie", [String(current), cookieValue]);
}

function createSha256Digest(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function secureTextEquals(left, right) {
  const leftDigest = createSha256Digest(left);
  const rightDigest = createSha256Digest(right);
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function extractBasicCredentials(req) {
  const raw = req?.headers?.authorization;
  if (typeof raw !== "string") {
    return null;
  }

  const match = raw.match(/^basic\s+(.+)$/i);
  if (!match || !match[1]) {
    return null;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const splitAt = decoded.indexOf(":");
  if (splitAt < 0) {
    return null;
  }

  return {
    username: decoded.slice(0, splitAt),
    password: decoded.slice(splitAt + 1)
  };
}

function renderPasswordLoginHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>codex-relay login</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #1c2530; }
    main { width: min(92vw, 380px); background: #fff; border: 1px solid #d7dee6; border-radius: 12px; padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0 0 14px; font-size: 14px; color: #536273; }
    label { display: block; margin: 0 0 6px; font-size: 13px; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #c3ceda; border-radius: 8px; font-size: 14px; }
    button { margin-top: 14px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: #0f4c81; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #0b3c66; }
    .hint { margin-top: 12px; font-size: 12px; color: #66778a; }
  </style>
</head>
<body>
  <main>
    <h1>codex-relay</h1>
    <p>Enter the relay password to start a session.</p>
    <form method="post" action="${LOGIN_PATH}">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" required value="codex" />
      <label for="password" style="margin-top:12px;">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
    <p class="hint">Session cookie: <code>${SESSION_COOKIE_NAME}</code></p>
  </main>
</body>
</html>`;
}

async function readRequestBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
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

    req.on("error", (error) => {
      reject(error);
    });
  });
}

function parseLoginPayload(req, rawBody) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/json")) {
    const parsed = safeJsonParse(rawBody);
    if (!parsed || typeof parsed !== "object") {
      return { username: "", password: "" };
    }
    return {
      username: typeof parsed.username === "string" ? parsed.username : "",
      password: typeof parsed.password === "string" ? parsed.password : ""
    };
  }

  const params = new URLSearchParams(rawBody);
  return {
    username: params.get("username") || "",
    password: params.get("password") || ""
  };
}

export class SessionStore {
  constructor({ ttlMs = 1000 * 60 * 60 * 12 } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  createSession() {
    const id = randomId(24);
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(id, expiresAt);
    return { id, expiresAt };
  }

  isValid(sessionId) {
    if (!sessionId) {
      return false;
    }
    const expiresAt = this.sessions.get(sessionId);
    if (!expiresAt) {
      return false;
    }
    if (expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  pruneExpired() {
    const now = Date.now();
    for (const [id, expiresAt] of this.sessions.entries()) {
      if (expiresAt < now) {
        this.sessions.delete(id);
      }
    }
  }
}

export function createAuthController({
  token,
  sessionStore,
  cookieName = SESSION_COOKIE_NAME,
  authMode = "off",
  basicUsername = "codex",
  basicPassword = "",
  logger = null
}) {
  const normalizedAuthMode = normalizeAuthMode(authMode);
  const normalizedBasicUsername = typeof basicUsername === "string" ? basicUsername.trim() : "codex";
  const normalizedBasicPassword = typeof basicPassword === "string" ? basicPassword : "";

  function hasValidSession(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    return sessionStore.isValid(cookies[cookieName]);
  }

  function issueSessionCookie(res) {
    const session = sessionStore.createSession();
    const cookie = serializeCookie(cookieName, session.id, {
      maxAgeSeconds: Math.floor(sessionStore.ttlMs / 1000),
      httpOnly: true,
      sameSite: "Lax",
      path: "/"
    });
    appendSetCookieHeader(res, cookie);
    return session;
  }

  function hasValidBasicCredentials(req) {
    if (normalizedAuthMode !== "basic") {
      return false;
    }
    if (!normalizedBasicPassword) {
      return false;
    }

    const credentials = extractBasicCredentials(req);
    if (!credentials) {
      return false;
    }

    if (normalizedBasicUsername && !secureTextEquals(credentials.username, normalizedBasicUsername)) {
      return false;
    }

    return secureTextEquals(credentials.password, normalizedBasicPassword);
  }

  function isAuthorizedRequest(req) {
    if (normalizedAuthMode === "off") {
      return true;
    }

    if (hasValidSession(req)) {
      return true;
    }

    return hasValidBasicCredentials(req);
  }

  function shouldRedirectToLogin(req) {
    if (normalizedAuthMode !== "basic") {
      return false;
    }
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return false;
    }
    const accept = String(req.headers.accept || "");
    return accept.includes("text/html") || accept.includes("*/*");
  }

  function rejectUnauthorized(req, res) {
    if (shouldRedirectToLogin(req)) {
      res.statusCode = 302;
      res.setHeader("location", LOGIN_PATH);
      res.end();
      return;
    }

    res.statusCode = 401;
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (normalizedAuthMode === "basic") {
      res.setHeader("www-authenticate", 'Basic realm="codex-relay", charset="UTF-8"');
    }
    res.end(
      JSON.stringify({
        error: "unauthorized",
        hint: normalizedAuthMode === "basic"
          ? "Authenticate via /__webstrapper/login."
          : "Authenticate first via /__webstrapper/auth?token=<TOKEN>."
      })
    );
  }

  function requireAuth(req, res) {
    if (normalizedAuthMode === "off") {
      return true;
    }

    if (hasValidSession(req)) {
      return true;
    }

    if (hasValidBasicCredentials(req)) {
      issueSessionCookie(res);
      return true;
    }

    rejectUnauthorized(req, res);
    return false;
  }

  function handleAuthRoute(req, res, parsedUrl) {
    if (normalizedAuthMode === "off") {
      issueSessionCookie(res);
      res.statusCode = 302;
      res.setHeader("location", "/");
      res.end();
      return;
    }

    const provided = parsedUrl.searchParams.get("token") || "";
    if (!provided || provided !== token) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    issueSessionCookie(res);
    res.statusCode = 302;
    res.setHeader("location", "/");
    res.end();
  }

  function verifyPasswordLogin(username, password) {
    if (normalizedAuthMode !== "basic" || !normalizedBasicPassword) {
      return false;
    }

    if (normalizedBasicUsername && !secureTextEquals(username, normalizedBasicUsername)) {
      return false;
    }

    return secureTextEquals(password, normalizedBasicPassword);
  }

  async function handlePasswordLoginRoute(req, res) {
    if (normalizedAuthMode !== "basic") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    if (req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(renderPasswordLoginHtml());
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, POST");
      res.end("Method not allowed");
      return;
    }

    let parsed;
    try {
      const rawBody = await readRequestBody(req);
      parsed = parseLoginPayload(req, rawBody);
    } catch (error) {
      logger?.warn?.("Failed to parse login payload", { error: error?.message || String(error) });
      res.statusCode = 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "bad_request" }));
      return;
    }

    const username = String(parsed?.username || "");
    const password = String(parsed?.password || "");
    if (!verifyPasswordLogin(username, password)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_credentials" }));
      return;
    }

    issueSessionCookie(res);
    res.statusCode = 302;
    res.setHeader("location", "/");
    res.end();
  }

  return {
    cookieName,
    authMode: normalizedAuthMode,
    loginPath: LOGIN_PATH,
    isAuthorizedRequest,
    requireAuth,
    handleAuthRoute,
    handlePasswordLoginRoute
  };
}
