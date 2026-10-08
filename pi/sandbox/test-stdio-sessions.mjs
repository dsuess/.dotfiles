import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { StdioSessions, STDIO_BUFFER_BYTES, STDIO_CHUNK_BYTES, MAX_STDIO_SESSIONS } from "./stdio-sessions.mjs";
import { makeRequest, validateRequest } from "./protocol.mjs";

const generation = "a".repeat(64);
const params = { argv: ["/bin/cat"], cwd: "/tmp", env: {}, policyGeneration: generation };
function fixture() {
  const children = [], events = [], signals = [];
  const pool = new StdioSessions({
    spawn: async () => {
      const child = new EventEmitter();
      child.pid = 100 + children.length;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      children.push(child);
      return child;
    },
    emit: (session, name, data) => events.push({ handle: session.handle, name, data }),
    kill: (pid, signal) => { signals.push([pid, signal]); if (signal === 0) throw Object.assign(new Error(), { code: "ESRCH" }); },
  });
  return { pool, children, events, signals };
}

test("stdio is connection-owned, policy-bound, bidirectional and incrementally bounded", async () => {
  const { pool, children, events, signals } = fixture();
  const owner = {}, sibling = {};
  const opened = await pool.open(owner, 1, params, {});
  const input = { handle: opened.handle, policyGeneration: generation, data: Buffer.from("hello").toString("base64") };
  await assert.rejects(pool.input(sibling, input), { code: "stdio_owner" });
  await assert.rejects(pool.close(sibling, input), { code: "stdio_owner" });
  await assert.rejects(pool.input(owner, { ...input, policyGeneration: "b".repeat(64) }), { code: "stale_generation" });
  await pool.input(owner, input);
  assert.equal(children[0].stdin.read().toString(), "hello");
  children[0].stdout.write(Buffer.alloc(STDIO_CHUNK_BYTES * 3, 65));
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.data.length <= STDIO_CHUNK_BYTES));
  await pool.retire(owner);
  assert.deepEqual(signals.slice(0, 2), [[100, "SIGTERM"], [100, "SIGKILL"]]);
  assert.equal(pool.sessions.size, 0);
  assert.equal(events.at(-1).name, "exit");
  await assert.rejects(pool.open(owner, 2, params, {}), { code: "stdio_unavailable" });
  pool.allow(owner);
  const next = await pool.open(owner, 3, params, {});
  await pool.close(owner, { ...input, handle: next.handle });
  await pool.close(owner, { ...input, handle: next.handle });
});

test("output backpressure and the separate process limit retire sessions", async () => {
  const { pool, children } = fixture();
  const owner = { writableLength: STDIO_BUFFER_BYTES + 1 };
  await pool.open(owner, 1, params, {});
  children[0].stdout.write("overflow");
  await pool.retire(owner);
  pool.allow(owner); owner.writableLength = 0;
  for (let i = 0; i < MAX_STDIO_SESSIONS; i++) await pool.open(owner, i + 2, params, {});
  await assert.rejects(pool.open({}, 9, params, {}), { code: "busy" });
  await pool.shutdown();
  assert.equal(pool.sessions.size, 0);
});

test("cleanup failure blocks fresh authority; late startup cannot survive retirement", async () => {
  const { pool } = fixture();
  const owner = {};
  await pool.open(owner, 1, params, {});
  pool.kill = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
  await assert.rejects(pool.retire(owner), { code: "EPERM" });
  assert.throws(() => pool.allow(owner), { code: "stdio_cleanup" });
  await assert.rejects(pool.open(owner, 2, params, {}), { code: "stdio_unavailable" });
  const late = fixture();
  const spawn = late.pool.spawn;
  let proceed;
  late.pool.spawn = async () => { await new Promise((r) => { proceed = r; }); return spawn(); };
  const starting = late.pool.open(owner, 3, params, {});
  await new Promise((r) => setImmediate(r));
  await late.pool.retire(owner);
  proceed();
  await assert.rejects(starting, { code: "stdio_unavailable" });
  assert.equal(late.pool.sessions.size, 0);
  assert.ok(late.signals.some((s) => s[1] === "SIGKILL"));
});

test("startup deadline fails closed and kills a process that arrives late", async () => {
  const { pool, signals } = fixture();
  const spawn = pool.spawn;
  let proceed;
  pool.spawn = async () => { await new Promise((resolve) => { proceed = resolve; }); return spawn(); };
  const owner = {};
  await assert.rejects(pool.open(owner, 1, params, {}), { code: "stdio_start_timeout" });
  await assert.rejects(pool.open(owner, 2, params, {}), { code: "stdio_unavailable" });
  proceed();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pool.sessions.size, 0);
  assert.ok(signals.some((signal) => signal[1] === "SIGKILL"));
});

test("channel protocol rejects malformed or oversized inputs and extra startup authority", () => {
  const request = (method, p) => makeRequest(1, method, generation, p);
  validateRequest(request("process.open", params));
  assert.throws(() => validateRequest(request("process.open", { ...params, sandbox: false })));
  const input = { handle: generation, policyGeneration: generation, data: Buffer.alloc(65536).toString("base64") };
  validateRequest(request("process.input", input));
  assert.throws(() => validateRequest(request("process.input", { ...input, data: Buffer.alloc(65537).toString("base64") })));
  assert.throws(() => validateRequest(request("process.input", { ...input, data: "!!!!" })));
});
