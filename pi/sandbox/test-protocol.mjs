import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeFrame,
  FrameDecoder,
  makeRequest,
  MAX_FILE_BYTES,
  MAX_FRAME_BYTES,
  validateRequest,
  validateResponse,
} from "./protocol.mjs";

const TOKEN = "a".repeat(64);
const GENERATION = "b".repeat(64);

function validExec(overrides = {}) {
  return makeRequest(1, "exec", TOKEN, {
    argv: ["/bin/echo", "hello"],
    cwd: "/workspace",
    env: { LANG: "C.UTF-8" },
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    policyGeneration: GENERATION,
    ...overrides,
  });
}

test("length-prefixed frames decode fragmented and coalesced input", () => {
  const values = [];
  const decoder = new FrameDecoder((value) => values.push(value));
  const first = encodeFrame({ one: 1 });
  const second = encodeFrame({ two: 2 });
  decoder.push(first.subarray(0, 2));
  decoder.push(Buffer.concat([first.subarray(2), second]));
  assert.deepEqual(values, [{ one: 1 }, { two: 2 }]);
});

test("frame decoder rejects oversized declarations and invalid JSON", () => {
  const decoder = new FrameDecoder(() => {});
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => decoder.push(oversized), /frame/);

  const invalid = Buffer.alloc(5);
  invalid.writeUInt32BE(1);
  invalid[4] = "{".charCodeAt(0);
  assert.throws(() => new FrameDecoder(() => {}).push(invalid), /JSON/);
  assert.throws(() => encodeFrame({ value: "x".repeat(MAX_FRAME_BYTES) }), /size limit/);
});

test("request validation accepts bounded operation shapes", () => {
  assert.equal(validateRequest(validExec()).method, "exec");
  assert.equal(
    validateRequest(
      makeRequest(2, "fs.readFile", TOKEN, {
        path: "/workspace/file",
        offset: 0,
        limit: MAX_FILE_BYTES,
        policyGeneration: GENERATION,
      }),
    ).method,
    "fs.readFile",
  );
  assert.equal(
    validateRequest(
      makeRequest(3, "fs.writeFile", TOKEN, {
        path: "/workspace/file",
        data: Buffer.from("hello").toString("base64"),
        policyGeneration: GENERATION,
      }),
    ).method,
    "fs.writeFile",
  );
});

test("request validation blocks unknown fields, host commands, and unbounded data", () => {
  assert.throws(
    () => validateRequest({ ...validExec(), surprise: true }),
    /unknown key/,
  );
  assert.throws(() => validateRequest(validExec({ argv: ["bash"] })), /absolute/);
  assert.throws(() => validateRequest(validExec({ cwd: "relative" })), /absolute/);
  assert.throws(() => validateRequest(validExec({ env: { "BAD=NAME": "x" } })), /environment/);
  assert.throws(
    () =>
      validateRequest(
        makeRequest(4, "fs.writeFile", TOKEN, {
          path: "/workspace/file",
          data: Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64"),
          policyGeneration: GENERATION,
        }),
      ),
    /file limit|invalid/,
  );
  assert.throws(
    () => validateRequest(makeRequest(5, "host.exec", TOKEN, {})),
    /not allowed/,
  );
  assert.throws(
    () => validateRequest(makeRequest(6, "status", "bad", {})),
    /authentication/,
  );
});

test("response validation distinguishes stream events and bounded errors", () => {
  assert.equal(
    validateResponse({ v: 1, type: "event", id: 1, event: "stdout", data: "aGVsbG8=" }).event,
    "stdout",
  );
  assert.equal(
    validateResponse({ v: 1, type: "response", id: 1, ok: true, result: { ok: true } }).ok,
    true,
  );
  assert.equal(
    validateResponse({
      v: 1,
      type: "response",
      id: 1,
      ok: false,
      error: { code: "denied", message: "blocked" },
    }).ok,
    false,
  );
  assert.throws(
    () =>
      validateResponse({
        v: 1,
        type: "event",
        id: 1,
        event: "host-path",
        data: "",
      }),
    /stream event/,
  );
});
