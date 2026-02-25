import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfig } from "../src/config.mjs";

test("parseConfig applies precedence defaults < config file < env < argv", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-config-test-"));
  const configFile = path.join(tempDir, "config.json");

  await fs.writeFile(
    configFile,
    JSON.stringify({
      bind: "0.0.0.0",
      port: 9010,
      authMode: "token",
      profileSwitching: false
    })
  );

  const env = {
    CODEX_RELAY_CONFIG_FILE: configFile,
    CODEX_RELAY_PORT: "9020",
    CODEX_RELAY_PROFILE_SWITCHING: "1"
  };

  const { config } = await parseConfig(["--port", "9030", "--bind", "127.0.0.1"], env);
  assert.equal(config.port, 9030);
  assert.equal(config.bind, "127.0.0.1");
  assert.equal(config.authMode, "token");
  assert.equal(config.profileSwitching, true);
});

test("parseConfig normalizes invalid auth mode to off", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-config-test-"));
  const configFile = path.join(tempDir, "config.json");
  await fs.writeFile(configFile, JSON.stringify({ authMode: "invalid-mode" }));

  const { config } = await parseConfig([], {
    CODEX_RELAY_CONFIG_FILE: configFile
  });

  assert.equal(config.authMode, "off");
});
