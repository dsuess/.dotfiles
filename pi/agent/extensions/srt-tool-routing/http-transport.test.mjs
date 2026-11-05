import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piPackageRoot } from "../../../test-helpers.mjs";
import { ApprovedHttpTransport } from "./http-transport.mjs";
const { StreamableHttpTransport, McpClient } = await import(pathToFileURL(path.join(piPackageRoot, "node_modules/@earendil-works/pi-mcp/dist/index.js")));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t, { sse = false, mode } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.method);
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    if (req.method === "GET") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(': open\n\n'); return; }
    let text = ""; for await (const part of req) text += part;
    const msg = JSON.parse(text); requests.push(msg.method);
    if (mode === "stall" && msg.method === "tools/call") return;
    if (mode === "body" && msg.method === "tools/call") { res.writeHead(200, { "content-type": "application/json" }); res.write('{'); return; }
    if (mode === "expired" && msg.method === "tools/call") { res.writeHead(404); res.end(); return; }
    if (mode === "loss" && msg.method === "tools/call") { res.destroy(); return; }
    if (mode === "redirect") { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
    if (mode === "auth") { res.writeHead(401); res.end(); return; }
    if (!Object.hasOwn(msg, "id")) { res.writeHead(202); res.end(); return; }
    let result;
    if (msg.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    if (msg.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    if (msg.method === "tools/call") result = { content: [{ type: "text", text: "fixture-ok" }] };
    let body = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    if (mode === "malformed") body = '{bad';
    if (mode === "oversize") body = 'x'.repeat(1024 * 1024 + 1);
    res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json", "mcp-session-id": "fixture-session" });
    res.end(sse ? `data: ${body}\n\n` : body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let valid = true, terminal;
  const controller = { policyGeneration: "p1", onTerminal(fn) { terminal = fn; return () => {}; } };
  const transport = new ApprovedHttpTransport({ connect: async () => controller, validate: () => { if (!valid) throw new Error("revoked"); return { url }; }, createHttpTransport: (options) => new StreamableHttpTransport(options), timeoutMs: 150 });
  const client = new McpClient({ name: "test", version: "1", requestTimeoutMs: 500 });
  t.after(() => transport.close());
  return { transport, client, controller, requests, revoke: () => { valid = false; }, terminal: () => terminal() };
}
for (const sse of [false, true]) test(`real local ${sse ? "SSE" : "JSON"} initialization, listing, execution and shutdown`, async (t) => {
  const f = await fixture(t, { sse }); await f.client.connect(f.transport);
  assert.equal((await f.client.listTools())[0].name, "echo");
  assert.equal((await f.client.callTool("echo", {})).content[0].text, "fixture-ok");
  await f.client.close(); assert.equal(f.transport.closed, true);
  assert.ok(f.requests.includes("DELETE"));
});
for (const mode of ["stall", "body", "loss", "expired"]) test(`finite ${mode} cleanup and no POST replay`, async (t) => {
  const f = await fixture(t, { mode }); await f.client.connect(f.transport);
  await assert.rejects(f.client.callTool("echo", {}));
  assert.equal(f.requests.filter((x) => x === "tools/call").length, 1);
  assert.equal(f.transport.closed, true);
});
for (const mode of ["redirect", "auth", "malformed", "oversize"]) test(`reject ${mode} without retries or recovery`, async (t) => {
  const f = await fixture(t, { mode }); await assert.rejects(f.client.connect(f.transport));
  assert.equal(f.requests.filter((x) => x === "initialize").length, 1);
});
for (const reason of ["revocation", "policy", "controller", "cancel", "shutdown"]) test(`${reason} aborts pending request and idle stream`, async (t) => {
  const f = await fixture(t, { mode: "stall" }); await f.client.connect(f.transport);
  const abort = new AbortController();
  const pending = f.client.callTool("echo", {}, { signal: abort.signal });
  const rejected = assert.rejects(pending);
  await wait(20);
  if (reason === "revocation") f.revoke();
  if (reason === "policy") f.controller.policyGeneration = "p2";
  if (reason === "controller") f.terminal();
  if (reason === "cancel") abort.abort();
  if (reason === "shutdown") await f.transport.close();
  await rejected; await wait(60);
  assert.equal(f.transport.closed, true);
  assert.equal(f.requests.filter((x) => x === "tools/call").length, 1);
});
test("close during readiness settles start without waiting for controller", async () => {
  const transport = new ApprovedHttpTransport({ connect: () => new Promise(() => {}), validate: () => ({ url: "http://127.0.0.1/mcp" }), createHttpTransport: () => { throw new Error("must not construct"); } });
  const start = transport.start(); const rejection = assert.rejects(start); await transport.close(); await rejection;
});

for (const mode of ["malformed", "oversize"]) test(`SSE ${mode} is rejected before exposure`, async (t) => {
  const f = await fixture(t, { sse: true, mode }); await assert.rejects(f.client.connect(f.transport));
  assert.equal(f.transport.closed, true);
});
