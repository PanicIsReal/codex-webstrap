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
