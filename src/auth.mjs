import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { randomId } from "./util.mjs";

export const SESSION_COOKIE_NAME = "cw_session";

export function defaultTokenFilePath() {
  return path.join(os.homedir(), ".codex-webstrap", "token");
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

export function createAuthController({ token, sessionStore, cookieName = SESSION_COOKIE_NAME }) {
  function hasValidSession(req) {
    const cookies = parseCookies(req.headers.cookie || "");
    return sessionStore.isValid(cookies[cookieName]);
  }

  function isAuthorizedRequest(req) {
    return hasValidSession(req);
  }

  function rejectUnauthorized(res) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "unauthorized",
        hint: "Authenticate first via /__webstrapper/auth?token=<TOKEN>."
      })
    );
  }

  function requireAuth(req, res) {
    if (hasValidSession(req)) {
      return true;
    }
    rejectUnauthorized(res);
    return false;
  }

  function handleAuthRoute(req, res, parsedUrl) {
    const provided = parsedUrl.searchParams.get("token") || "";
    if (!provided || provided !== token) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    const session = sessionStore.createSession();
    const cookie = serializeCookie(cookieName, session.id, {
      maxAgeSeconds: Math.floor(sessionStore.ttlMs / 1000),
      httpOnly: true,
      sameSite: "Lax",
      path: "/"
    });

    res.statusCode = 302;
    res.setHeader("set-cookie", cookie);
    res.setHeader("location", "/");
    res.end();
  }

  return {
    cookieName,
    isAuthorizedRequest,
    requireAuth,
    handleAuthRoute
  };
}
