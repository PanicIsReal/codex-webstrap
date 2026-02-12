import test from "node:test";
import assert from "node:assert/strict";

import { encodeFrame, FrameDecoder } from "../src/ipc-uds.mjs";

test("frame encoder and decoder roundtrip", () => {
  const payload = { type: "broadcast", method: "x", params: { ok: true } };
  const frame = encodeFrame(payload);

  const decoder = new FrameDecoder();
  const outputs = decoder.push(frame);

  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0], payload);
});

test("decoder can handle split chunks", () => {
  const payload = { hello: "world", n: 42 };
  const frame = encodeFrame(payload);

  const decoder = new FrameDecoder();
  const firstPart = frame.subarray(0, 5);
  const secondPart = frame.subarray(5);

  assert.equal(decoder.push(firstPart).length, 0);
  const outputs = decoder.push(secondPart);
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0], payload);
});
