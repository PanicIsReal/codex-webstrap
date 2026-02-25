import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  ensurePersistentToken,
  SessionStore,
  createAuthController,
  normalizeAuthMode,
  parseCookies,
  serializeCookie
} from "../src/auth.mjs";

test("ensurePersistentToken creates and reuses token", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-webstrap-auth-test-"));
  const tokenFile = path.join(tempDir, "token");

  const first = await ensurePersistentToken(tokenFile);
  const second = await ensurePersistentToken(tokenFile);

  assert.equal(first.token, second.token);
  assert.ok(first.token.length >= 32);
});

test("session store validates and expires sessions", async () => {
  const store = new SessionStore({ ttlMs: 20 });
  const session = store.createSession();
  assert.equal(store.isValid(session.id), true);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(store.isValid(session.id), false);
});

test("cookie parse + serialize roundtrip", () => {
  const cookie = serializeCookie("cw_session", "abc123", {
    maxAgeSeconds: 60,
    path: "/",
    sameSite: "Lax",
    httpOnly: true
  });

  assert.match(cookie, /cw_session=abc123/);

  const parsed = parseCookies("cw_session=abc123; theme=dark");
  assert.equal(parsed.cw_session, "abc123");
  assert.equal(parsed.theme, "dark");
});

function createMockResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: "",
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    end(body = "") {
      this.body = String(body ?? "");
    }
  };
}

function createMockRequest({
  method = "GET",
  headers = {},
  body = ""
} = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  const req = Readable.from(chunks);
  req.method = method;
  req.headers = headers;
  return req;
}

function extractSessionCookieValue(setCookieHeader) {
  const cookie = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  const match = String(cookie ?? "").match(/cw_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

test("normalizeAuthMode accepts off/token/basic", () => {
  assert.equal(normalizeAuthMode("off"), "off");
  assert.equal(normalizeAuthMode("token"), "token");
  assert.equal(normalizeAuthMode("basic"), "basic");
  assert.equal(normalizeAuthMode("unexpected"), "off");
});

test("auth mode off allows requests without a session", () => {
  const store = new SessionStore();
  const auth = createAuthController({
    token: "test-token",
    sessionStore: store,
    authMode: "off"
  });
  const req = createMockRequest();
  const res = createMockResponse();
  assert.equal(auth.requireAuth(req, res), true);
  assert.equal(auth.isAuthorizedRequest(req), true);
});

test("auth mode token denies unauthenticated requests", () => {
  const store = new SessionStore();
  const auth = createAuthController({
    token: "test-token",
    sessionStore: store,
    authMode: "token"
  });
  const req = createMockRequest();
  const res = createMockResponse();
  assert.equal(auth.requireAuth(req, res), false);
  assert.equal(res.statusCode, 401);
});

test("basic auth accepts valid authorization header and issues session", () => {
  const store = new SessionStore();
  const auth = createAuthController({
    token: "test-token",
    sessionStore: store,
    authMode: "basic",
    basicUsername: "codex",
    basicPassword: "secret-pass"
  });

  const credentials = Buffer.from("codex:secret-pass", "utf8").toString("base64");
  const req = createMockRequest({
    headers: {
      authorization: `Basic ${credentials}`
    }
  });
  const res = createMockResponse();

  const allowed = auth.requireAuth(req, res);
  assert.equal(allowed, true);
  const cookie = extractSessionCookieValue(res.getHeader("set-cookie"));
  assert.ok(cookie);
  assert.equal(store.isValid(cookie), true);
});

test("basic auth login route issues cw_session on valid credentials", async () => {
  const store = new SessionStore();
  const auth = createAuthController({
    token: "test-token",
    sessionStore: store,
    authMode: "basic",
    basicUsername: "codex",
    basicPassword: "secret-pass"
  });

  const req = createMockRequest({
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: "codex",
      password: "secret-pass"
    })
  });
  const res = createMockResponse();
  await auth.handlePasswordLoginRoute(req, res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.getHeader("location"), "/");
  const cookie = extractSessionCookieValue(res.getHeader("set-cookie"));
  assert.ok(cookie);
  assert.equal(store.isValid(cookie), true);
});
