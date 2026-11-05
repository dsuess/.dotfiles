import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { piPackageRoot } from "../../../test-helpers.mjs";
import { RoutedMcpTransport } from "./mcp-transport.mjs";
const { StreamableHttpTransport } = await import(pathToFileURL(path.join(piPackageRoot, "node_modules/@earendil-works/pi-mcp/dist/index.js")));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/mcp`;
}
for (const mode of ["initialization", "body"]) test(`upstream stalled ${mode} outlives caller cancellation until transport close`, async (t) => {
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const url = await fixture(t, (_req, res) => {
    if (mode === "body") { res.writeHead(200, { "content-type": "application/json" }); res.write('{"jsonrpc":'); }
    reached();
  });
  const transport = new StreamableHttpTransport({ url });
  await transport.start();
  const controller = new AbortController();
  let settled = false;
  const sending = transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" }, { signal: controller.signal }).catch(() => {}).finally(() => { settled = true; });
  await arrived; controller.abort(); await wait(30);
  assert.equal(settled, false);
  await transport.close(); await sending;
});
test("upstream open SSE stream stops on close during connection", async (t) => {
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  const url = await fixture(t, (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(': open\n\n'); reached(); });
  const transport = new StreamableHttpTransport({ url }); await transport.start();
  const sending = transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await arrived; await sending; await transport.close(); assert.equal(transport.closed, true);
});
test("routed stdio close settles unresolved readiness for manager shutdown", async () => {
  const transport = new RoutedMcpTransport({ connect: () => new Promise(() => {}), validate: () => ({ argv: ["node"] }) });
  const starting = transport.start(); const rejected = assert.rejects(starting, /closed/);
  await transport.close(); await rejected;
});
