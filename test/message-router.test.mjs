import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FULL_HANDLING_BUCKET,
  BROWSER_EQUIVALENT_BUCKET,
  GRACEFUL_UNSUPPORTED_BUCKET,
  MessageRouter
} from "../src/message-router.mjs";

function createMockWs() {
  return {
    readyState: 1,
    sent: [],
    send(value) {
      this.sent.push(JSON.parse(String(value)));
    }
  };
}

test("bucket coverage includes required representative messages", () => {
  assert.ok(FULL_HANDLING_BUCKET.includes("ready"));
  assert.ok(FULL_HANDLING_BUCKET.includes("mcp-request"));
  assert.ok(FULL_HANDLING_BUCKET.includes("terminal-create"));
  assert.ok(BROWSER_EQUIVALENT_BUCKET.includes("open-in-browser"));
  assert.ok(GRACEFUL_UNSUPPORTED_BUCKET.includes("open-debug-window"));
});

test("unknown message type returns bridge-error and does not throw", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "not-a-real-message"
    }
  });

  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, "bridge-error");
  assert.equal(ws.sent[0].code, "unsupported_message_type");

  router.dispose();
});

test("update-diff-if-open is safely ignored", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "update-diff-if-open",
      conversationId: "c1",
      unifiedDiff: "diff --git a/x b/x"
    }
  });

  assert.equal(ws.sent.length, 0);
  router.dispose();
});

test("show-diff opens diff panel", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "show-diff",
      conversationId: "c1",
      unifiedDiff: "diff --git a/x b/x"
    }
  });

  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].type, "main-message");
  assert.deepEqual(ws.sent[0].payload, {
    type: "toggle-diff-panel",
    open: true
  });
  router.dispose();
});

test("show-plan-summary is safely ignored", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "show-plan-summary",
      conversationId: "c1",
      planContent: "- step 1"
    }
  });

  assert.equal(ws.sent.length, 0);
  router.dispose();
});

test("show-context-menu is safely ignored", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "show-context-menu",
      payload: { items: [] }
    }
  });

  assert.equal(ws.sent.length, 0);
  router.dispose();
});

test("ready emits host_config shared object update", async () => {
  const hostConfig = {
    id: "ssh-host-1",
    display_name: "SSH Host",
    kind: "ssh"
  };
  const router = new MessageRouter({ appServer: null, udsClient: null, hostConfig });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "ready"
    }
  });

  const hostConfigEnvelope = ws.sent.find((entry) => (
    entry.type === "main-message"
    && entry.payload?.type === "shared-object-updated"
    && entry.payload?.key === "host_config"
  ));

  assert.ok(hostConfigEnvelope);
  assert.deepEqual(hostConfigEnvelope.payload.value, hostConfig);
  router.dispose();
});

test("archive-thread pre-signal does not invoke backend archive", async () => {
  let sendRequestCalls = 0;
  const appServer = {
    on() {},
    getState() {
      return { connected: true, initialized: true, transportKind: "stdio" };
    },
    async sendRequest() {
      sendRequestCalls += 1;
      return {};
    }
  };

  const router = new MessageRouter({ appServer, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "archive-thread",
      conversationId: "thread-123",
      cwd: "/tmp/project"
    }
  });

  assert.equal(sendRequestCalls, 0);
  assert.equal(ws.sent.length, 0);
  router.dispose();
});

test("virtual vscode fetch endpoints return expected payload shapes", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "r1",
      method: "POST",
      url: "vscode://codex/generate-thread-title",
      body: JSON.stringify({ params: { prompt: "Fix commit flow bridge errors quickly" } })
    }
  });

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "r2",
      method: "POST",
      url: "vscode://codex/mcp-codex-config",
      body: JSON.stringify({ params: {} })
    }
  });

  const first = ws.sent[0];
  const second = ws.sent[1];
  assert.equal(first.type, "main-message");
  assert.equal(first.payload.type, "fetch-response");
  assert.equal(first.payload.requestId, "r1");
  assert.equal(first.payload.responseType, "success");
  assert.ok(JSON.parse(first.payload.bodyJsonString).title.length > 0);

  assert.equal(second.type, "main-message");
  assert.equal(second.payload.type, "fetch-response");
  assert.equal(second.payload.requestId, "r2");
  assert.deepEqual(JSON.parse(second.payload.bodyJsonString), { config: {} });

  router.dispose();
});

test("local-environments lists workspace environment configs", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-local-envs-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const envDir = path.join(tempDir, ".codex", "environments");
  const envPath = path.join(envDir, "environment.toml");
  await fs.mkdir(envDir, { recursive: true });
  await fs.writeFile(envPath, [
    "version = 1",
    'name = "my-local-env"',
    "",
    "[setup]",
    'script = "./scripts/worktree-bootstrap.sh"'
  ].join("\n"));

  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "local-envs",
      method: "POST",
      url: "vscode://codex/local-environments",
      body: JSON.stringify({
        params: {
          workspaceRoot: tempDir
        }
      })
    }
  });

  const envelope = ws.sent.find((entry) => (
    entry.type === "main-message"
    && entry.payload?.type === "fetch-response"
    && entry.payload?.requestId === "local-envs"
  ));

  assert.ok(envelope);
  const parsed = JSON.parse(envelope.payload.bodyJsonString);
  assert.equal(Array.isArray(parsed.environments), true);
  assert.equal(parsed.environments.length, 1);
  assert.deepEqual(parsed.environments[0], {
    type: "success",
    configPath: envPath,
    environment: {
      version: 1,
      name: "my-local-env",
      setup: {
        script: "./scripts/worktree-bootstrap.sh"
      },
      actions: []
    }
  });

  router.dispose();
});

test("gh-cli-status reflects installed + auth state", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  router._runCommand = async (command, args) => {
    if (command !== "gh") {
      return { ok: false, stdout: "", stderr: "", error: "unexpected command" };
    }
    if (args[0] === "--version") {
      return { ok: true, stdout: "gh version 2.70.0", stderr: "", error: null };
    }
    if (args[0] === "auth" && args[1] === "status") {
      return { ok: true, stdout: "", stderr: "", error: null };
    }
    return { ok: false, stdout: "", stderr: "", error: "unexpected args" };
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "gh-status",
      method: "POST",
      url: "vscode://codex/gh-cli-status",
      body: JSON.stringify({ params: {} })
    }
  });

  const envelope = ws.sent[0];
  assert.equal(envelope.type, "main-message");
  assert.equal(envelope.payload.type, "fetch-response");
  assert.deepEqual(JSON.parse(envelope.payload.bodyJsonString), {
    isInstalled: true,
    isAuthenticated: true
  });

  router.dispose();
});

test("gh-pr-status returns open PR metadata when present", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  router._runCommand = async (command, args) => {
    if (command !== "gh") {
      return { ok: false, stdout: "", stderr: "", error: "unexpected command" };
    }
    if (args[0] === "--version") {
      return { ok: true, stdout: "gh version 2.70.0", stderr: "", error: null };
    }
    if (args[0] === "auth" && args[1] === "status") {
      return { ok: true, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "pr" && args[1] === "list") {
      return {
        ok: true,
        stdout: JSON.stringify([{ number: 42, url: "https://github.com/org/repo/pull/42" }]),
        stderr: "",
        error: null
      };
    }
    return { ok: false, stdout: "", stderr: "", error: "unexpected args" };
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "gh-pr",
      method: "POST",
      url: "vscode://codex/gh-pr-status",
      body: JSON.stringify({
        params: {
          cwd: "/tmp/repo",
          headBranch: "feature/test"
        }
      })
    }
  });

  const envelope = ws.sent[0];
  assert.equal(envelope.type, "main-message");
  assert.equal(envelope.payload.type, "fetch-response");
  assert.deepEqual(JSON.parse(envelope.payload.bodyJsonString), {
    status: "success",
    hasOpenPr: true,
    url: "https://github.com/org/repo/pull/42",
    number: 42
  });

  router.dispose();
});

test("git-merge-base returns merge-base sha", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  router._runCommand = async (command, args) => {
    if (command === "git" && args[0] === "-C" && args[2] === "merge-base") {
      return {
        ok: true,
        stdout: "abc123",
        stderr: "",
        error: null
      };
    }
    return { ok: false, stdout: "", stderr: "", error: "unexpected command" };
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "merge-base",
      method: "POST",
      url: "vscode://codex/git-merge-base",
      body: JSON.stringify({
        params: {
          gitRoot: "/tmp/repo",
          baseBranch: "main"
        }
      })
    }
  });

  const envelope = ws.sent[0];
  assert.equal(envelope.type, "main-message");
  assert.equal(envelope.payload.type, "fetch-response");
  assert.deepEqual(JSON.parse(envelope.payload.bodyJsonString), {
    mergeBaseSha: "abc123"
  });

  router.dispose();
});

test("git-push executes git and returns success payload", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  let observed = null;
  router._runCommand = async (command, args, options) => {
    observed = { command, args, options };
    return {
      ok: true,
      code: 0,
      stdout: "Everything up-to-date",
      stderr: "",
      error: null
    };
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "git-push-ok",
      method: "POST",
      url: "vscode://codex/git-push",
      body: JSON.stringify({
        params: {
          cwd: "/tmp/repo",
          force: true
        }
      })
    }
  });

  assert.deepEqual(observed?.command, "git");
  assert.deepEqual(observed?.args, ["-C", "/tmp/repo", "push", "--force-with-lease"]);

  const envelope = ws.sent[0];
  assert.equal(envelope.type, "main-message");
  assert.equal(envelope.payload.type, "fetch-response");
  assert.equal(envelope.payload.status, 200);
  assert.deepEqual(JSON.parse(envelope.payload.bodyJsonString), {
    ok: true,
    code: 0,
    stdout: "Everything up-to-date",
    stderr: ""
  });

  router.dispose();
});

test("git-push failure returns non-2xx response", async () => {
  const router = new MessageRouter({ appServer: null, udsClient: null });
  const ws = createMockWs();

  router._runCommand = async () => ({
    ok: false,
    code: 1,
    stdout: "",
    stderr: "fatal: No configured push destination.",
    error: "fatal: No configured push destination."
  });

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "git-push-fail",
      method: "POST",
      url: "vscode://codex/git-push",
      body: JSON.stringify({
        params: {
          cwd: "/tmp/repo",
          force: false
        }
      })
    }
  });

  const envelope = ws.sent[0];
  assert.equal(envelope.type, "main-message");
  assert.equal(envelope.payload.type, "fetch-response");
  assert.equal(envelope.payload.status, 500);

  const parsed = JSON.parse(envelope.payload.bodyJsonString);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 1);
  assert.match(parsed.error, /push destination/i);

  router.dispose();
});

test("thread list responses are filtered to saved workspace roots", async () => {
  const appServer = {
    on() {},
    getState() {
      return { connected: true, initialized: true, transportKind: "stdio" };
    },
    async sendRaw() {
      return {
        id: 42,
        result: {
          data: [
            { id: "t1", cwd: "/repo/current" },
            { id: "t2", cwd: "/repo/current/sub" },
            { id: "t3", cwd: "/repo/other" },
            { id: "t4", cwd: null }
          ]
        }
      };
    }
  };

  const router = new MessageRouter({ appServer, udsClient: null });
  const ws = createMockWs();

  router.workspaceRootOptions = {
    roots: ["/repo/current", "/repo/other"],
    labels: {}
  };

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "mcp-request",
      request: {
        id: 42,
        method: "thread/list",
        params: {}
      }
    }
  });

  const responseEnvelope = ws.sent.find((entry) => entry.type === "main-message" && entry.payload.type === "mcp-response");
  assert.ok(responseEnvelope);
  assert.deepEqual(responseEnvelope.payload.message.result.data, [
    { id: "t1", cwd: "/repo/current" },
    { id: "t2", cwd: "/repo/current/sub" },
    { id: "t3", cwd: "/repo/other" }
  ]);

  router.dispose();
});

test("loads persisted atom and global state values from desktop global state file", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cw-router-test-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const globalStatePath = path.join(tempDir, ".codex-global-state.json");
  await fs.writeFile(globalStatePath, JSON.stringify({
    "electron-saved-workspace-roots": ["/repo/current"],
    "active-workspace-roots": ["/repo/current"],
    "electron-workspace-root-labels": { "/repo/current": "Current Repo" },
    "electron-main-window-bounds": { x: 10, y: 20, width: 1000, height: 700 },
    "electron-persisted-atom-state": {
      appearanceTheme: "light",
      "notifications-turn-mode": "always"
    }
  }));

  const router = new MessageRouter({
    appServer: null,
    udsClient: null,
    globalStatePath
  });
  const ws = createMockWs();

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "ready"
    }
  });

  await router.handleEnvelope(ws, {
    type: "view-message",
    payload: {
      type: "fetch",
      requestId: "global-state",
      method: "POST",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({
        params: {
          key: "electron-main-window-bounds"
        }
      })
    }
  });

  const atomSyncEnvelope = ws.sent.find((entry) => (
    entry.type === "main-message"
    && entry.payload?.type === "persisted-atom-sync"
  ));
  assert.ok(atomSyncEnvelope);
  assert.equal(atomSyncEnvelope.payload.state.appearanceTheme, "light");
  assert.equal(atomSyncEnvelope.payload.state["notifications-turn-mode"], "always");

  const globalStateEnvelope = ws.sent.find((entry) => (
    entry.type === "main-message"
    && entry.payload?.type === "fetch-response"
    && entry.payload?.requestId === "global-state"
  ));
  assert.ok(globalStateEnvelope);
  assert.deepEqual(JSON.parse(globalStateEnvelope.payload.bodyJsonString), {
    value: { x: 10, y: 20, width: 1000, height: 700 }
  });

  router.dispose();
});
