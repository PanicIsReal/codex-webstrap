import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProfileSwitcher } from "../src/profile-switcher.mjs";

async function writeProfileFile(profilesDir, id, accountId) {
  await fs.writeFile(
    path.join(profilesDir, `${id}.json`),
    JSON.stringify({
      tokens: {
        account_id: accountId,
        access_token: `${id}-token`
      }
    })
  );
}

test("fixed strategy switches auth.json using label from profiles.json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-profile-test-"));
  const profilesDir = path.join(tempDir, "profiles");
  const hostAuthFile = path.join(tempDir, "auth.json");
  const stateFile = path.join(tempDir, "profile-state.json");
  await fs.mkdir(profilesDir, { recursive: true });

  await writeProfileFile(profilesDir, "work-id", "acct-work");
  await writeProfileFile(profilesDir, "personal-id", "acct-personal");
  await fs.writeFile(
    path.join(profilesDir, "profiles.json"),
    JSON.stringify({
      version: 2,
      profiles: {
        "work-id": { label: "work" },
        "personal-id": { label: "personal" }
      }
    })
  );

  const switcher = new ProfileSwitcher({
    enabled: true,
    strategy: "fixed",
    fixedProfile: "work",
    profilesDir,
    hostAuthFile,
    stateFile
  });

  const result = await switcher.apply({ codexRunning: false });
  assert.equal(result.status, "switched");
  assert.equal(result.profile.id, "work-id");

  const activeAuth = await fs.readFile(hostAuthFile, "utf8");
  assert.match(activeAuth, /acct-work/);
});

test("round-robin strategy rotates across available profiles", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-profile-test-"));
  const profilesDir = path.join(tempDir, "profiles");
  const hostAuthFile = path.join(tempDir, "auth.json");
  const stateFile = path.join(tempDir, "profile-state.json");
  await fs.mkdir(profilesDir, { recursive: true });

  await writeProfileFile(profilesDir, "alpha", "acct-alpha");
  await writeProfileFile(profilesDir, "beta", "acct-beta");

  const switcher = new ProfileSwitcher({
    enabled: true,
    strategy: "round-robin",
    profilesDir,
    hostAuthFile,
    stateFile
  });

  const first = await switcher.apply({ codexRunning: false });
  const second = await switcher.apply({ codexRunning: false });
  assert.equal(first.status, "switched");
  assert.equal(second.status, "switched");
  assert.equal(first.profile.id, "alpha");
  assert.equal(second.profile.id, "beta");
});

test("switch is blocked when native Codex is running", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-relay-profile-test-"));
  const profilesDir = path.join(tempDir, "profiles");
  await fs.mkdir(profilesDir, { recursive: true });
  await writeProfileFile(profilesDir, "alpha", "acct-alpha");

  const switcher = new ProfileSwitcher({
    enabled: true,
    strategy: "fixed",
    profilesDir,
    hostAuthFile: path.join(tempDir, "auth.json"),
    stateFile: path.join(tempDir, "profile-state.json")
  });

  const result = await switcher.apply({ codexRunning: true });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "codex_running");
});
