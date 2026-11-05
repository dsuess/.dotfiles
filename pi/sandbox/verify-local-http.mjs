#!/usr/bin/env node
// Manual real-launcher acceptance; test-owned loopback endpoints only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-http-launcher-"));
const launcher = path.resolve(import.meta.dirname, "../../bin/pi");
let stall = false;
const methods = [];
const server = http.createServer(async (req, res) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(': open\n\n'); return; }
  if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
  let bytes = ""; for await (const part of req) bytes += part;
  const message = JSON.parse(bytes); methods.push(message.method);
  if (!Object.hasOwn(message, "id")) { res.writeHead(202); res.end(); return; }
  if (stall && message.method === "tools/call") return;
  const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : message.method === "tools/list" ? { tools: [{ name: "identity", description: "Return the fixture identity", inputSchema: { type: "object" } }] }
    : { content: [{ type: "text", text: req.url }] };
  res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
fs.mkdirSync(path.join(workspace, ".pi")); fs.writeFileSync(path.join(workspace, "sentinel"), "fixture-core-read");
const env = { ...process.env }; delete env.PI_LAUNCHER_CHAIN;
const write = (count) => fs.writeFileSync(path.join(workspace, ".pi/mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: count }, (_, i) => [`fixture${i}`, { url: `http://127.0.0.1:${server.address().port}/fixture${i}`, timeout: 2 }])) }));
async function interactive(instruction) {
  console.log(`\n${instruction}\nWorkspace: ${workspace}`);
  const child = spawn(launcher, ["--no-session"], { cwd: workspace, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, "interactive launcher failed; inspect native prerequisites");
}
async function execute(count) {
  const names = Array.from({ length: count }, (_, i) => `mcp__fixture${i}__identity`);
  const events = []; let stderr = "";
  const child = spawn(launcher, ["-p", "--no-session", "--mode", "json", `Acceptance: call each of ${names.join(", ")} exactly once with {}. Then read sentinel with read and run bash command 'printf core-child-ok'. Use no other tools or configuration changes.`], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }, 60_000);
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-8192); });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try { const event = JSON.parse(line); if (event.type === "tool_execution_end") { events.push(event); console.log(JSON.stringify(event)); } } catch {}
  });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); clearTimeout(timer);
  assert.equal(code, 0, stderr);
  for (const [i, name] of names.entries()) {
    const completed = events.filter((event) => event.toolName === name);
    assert.equal(completed.length, 1); assert.equal(completed[0].isError, false);
    assert.match(JSON.stringify(completed[0].result), new RegExp(`/fixture${i}`));
  }
  assert.ok(events.some((event) => event.toolName === "read" && JSON.stringify(event.result).includes("fixture-core-read")));
  assert.ok(events.some((event) => event.toolName === "bash" && JSON.stringify(event.result).includes("core-child-ok")));
}
try {
  for (const count of [1, 2]) {
    write(count);
    await interactive(`Grant project trust and /mcp approve for ${count} test endpoint(s). Check that /mcp has one owner. Exit normally.`);
    await execute(count);
  }
  stall = true;
  await interactive("Call mcp__fixture0__identity (expected timeout). Then /reload, /new, /mcp revoke; verify retired tools cannot run. Exit normally. Do not select /sandbox off.");
  console.log(JSON.stringify({ workspace, methods, note: "Inspect interactive lifecycle outcomes. Print runs verify actual tool result bytes; native SRT denial requires test:native." }));
} finally {
  server.closeAllConnections(); server.close(); fs.rmSync(workspace, { recursive: true, force: true });
  console.log("Test folder removed. Its private approval record can be revoked through /mcp before exit; no production servers were used.");
}
