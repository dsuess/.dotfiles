import assert from "node:assert/strict";
import test from "node:test";
import { RoutedMcpTransport, routedTransportLimits } from "./mcp-transport.mjs";

function fixture() {
  let receive, terminal;
  const sent = [], launches = [];
  let closes = 0, retired = 0;
  const client = {
    onTerminal(listener) { terminal = listener; return () => { terminal = null; }; },
    async openProcess(argv, options) {
      launches.push({ argv, cwd: options.cwd, env: options.env });
      receive = options.onEvent;
      return { send: async (data) => sent.push(data.toString()), close: async () => { closes++; } };
    },
  };
  const transport = new RoutedMcpTransport({ connect: async () => client, validate: () => ({ argv: ["/reviewed/launcher", "pi"], cwd: "/reviewed", env: { SAFE: "literal" } }), onRetire: () => retired++ });
  return { transport, client, sent, launches, receive: (...args) => receive(...args), terminal: (...args) => terminal(...args), closes: () => closes, retired: () => retired };
}

test("MCP transport uses only controller stdio, decodes split/coalesced messages, and orders sends", async () => {
  const f = fixture(), messages = [];
  f.transport.onMessage((message) => messages.push(message));
  await f.transport.start();
  assert.deepEqual(f.launches, [{ argv: ["/reviewed/launcher", "pi"], cwd: "/reviewed", env: { SAFE: "literal" } }]);
  const first = { jsonrpc: "2.0", id: 1, result: { symbol: "λ" } };
  const bytes = Buffer.from(`${JSON.stringify(first)}\n${JSON.stringify({ jsonrpc: "2.0", method: "changed" })}\n`);
  const split = bytes.indexOf(Buffer.from("λ")) + 1;
  f.receive("stdout", bytes.subarray(0, split));
  assert.equal(messages.length, 0);
  f.receive("stdout", bytes.subarray(split));
  assert.deepEqual(messages, [first, { jsonrpc: "2.0", method: "changed" }]);
  await Promise.all([f.transport.send({ jsonrpc: "2.0", id: 1, method: "one" }), f.transport.send({ jsonrpc: "2.0", id: 2, method: "two" })]);
  assert.deepEqual(f.sent.map((line) => JSON.parse(line).method), ["one", "two"]);
  await f.transport.close(); await f.transport.close();
  assert.equal(f.closes(), 1);
  assert.equal(f.retired(), 1);
});

test("malformed and oversized stdout fails closed; stderr is bounded", async () => {
  for (const bytes of [Buffer.from("not json\n"), Buffer.from('{}\n'), Buffer.alloc(routedTransportLimits.maxMessageBytes + 1, 65)]) {
    const f = fixture(), errors = [];
    f.transport.onError((error) => errors.push(error));
    await f.transport.start();
    f.receive("stderr", Buffer.alloc(routedTransportLimits.maxStderrBytes * 2, 66));
    assert.equal(Buffer.byteLength(f.transport.stderr), routedTransportLimits.maxStderrBytes);
    f.receive("stdout", bytes);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.transport.closed, true);
    assert.equal(f.closes(), 1);
    assert.equal(f.retired(), 1);
    assert.equal(errors.length, 1);
    await assert.rejects(f.transport.send({}), /closed/);
  }
});

test("controller loss and failed sends never replay requests or choose a host fallback", async () => {
  const f = fixture(), errors = [];
  f.transport.onError((error) => errors.push(error));
  await f.transport.start();
  let executions = 0;
  f.transport.channel.send = async () => { executions++; throw new Error("ambiguous edit failure"); };
  await assert.rejects(f.transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call" }), /ambiguous/);
  assert.equal(executions, 1);
  assert.equal(f.launches.length, 1);
  assert.equal(f.transport.closed, true);
  const g = fixture();
  await g.transport.start();
  g.terminal(new Error("controller failed"));
  assert.equal(g.transport.closed, true);
  await assert.rejects(g.transport.send({}), /closed/);
  assert.equal(g.launches.length, 1);
});

test("profile rejection cannot spawn; startup awaits restored controller policy", async () => {
  const f = fixture();
  f.transport.validate = () => { throw new Error("launcher drift"); };
  await assert.rejects(f.transport.start(), /launcher drift/);
  assert.equal(f.launches.length, 0);
  const g = fixture();
  let ready;
  g.transport.connect = () => new Promise((resolve) => { ready = () => resolve(g.client); });
  const started = g.transport.start();
  assert.equal(g.launches.length, 0);
  ready(); await started;
  assert.equal(g.launches.length, 1);
  await g.transport.close();
});

test("output during startup and close during readiness never leave a live channel", async () => {
  const f = fixture();
  f.client.openProcess = async (_argv, options) => {
    options.onEvent("exit", Buffer.alloc(0));
    return { close: async () => {}, send: async () => { throw new Error("must not send"); } };
  };
  await assert.rejects(f.transport.start(), /closed/);
  assert.equal(f.transport.closed, true);
  const g = fixture();
  let ready;
  g.transport.connect = () => new Promise((resolve) => { ready = () => resolve(g.client); });
  const starting = g.transport.start();
  await g.transport.close(); ready();
  await assert.rejects(starting, /closed/);
  assert.equal(g.launches.length, 0);
});
