import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensurePersistentToken,
  SessionStore,
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
