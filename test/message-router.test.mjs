import test from "node:test";
import assert from "node:assert/strict";

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
