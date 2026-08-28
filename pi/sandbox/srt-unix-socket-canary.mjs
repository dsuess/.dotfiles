#!/usr/bin/env node
/** Native SRT 0.0.74 macOS contract for a keyed Docker broker socket. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

function listen(socketPath) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((connection) => connection.pipe(connection));
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const clientSource = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const [allowed, sibling, replacement] = process.argv.slice(2);
function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.once("error", reject);
    client.once("connect", () => client.write("ping"));
    client.once("data", (chunk) => { client.end(); resolve(chunk.toString()); });
  });
}
(async () => {
  const result = {};
  try { result.allowed = await connect(allowed); } catch (error) { result.allowedError = error.code; }
  try { await connect(sibling); result.sibling = "connected"; } catch (error) { result.siblingError = error.code; }
  try { fs.unlinkSync(allowed); result.unlink = "succeeded"; } catch (error) { result.unlinkError = error.code; }
  fs.writeFileSync(replacement, "not a socket");
  try { fs.renameSync(replacement, allowed); result.replace = "succeeded"; } catch (error) { result.replaceError = error.code; }
  try { result.preserved = await connect(allowed); } catch (error) { result.preservedError = error.code; }
  process.stdout.write("SRT_SOCKET_RESULT=" + JSON.stringify(result) + "\n");
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
`;

/**
 * A confined client may use only the keyed socket. It cannot connect to its
 * sibling or replace/unlink the protected listener, while its workspace
 * remains writable.
 */
export async function runSrtUnixSocketCanary(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-socket-"));
  const workspace = path.join(root, "workspace");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(runtime, { mode: 0o700 });
  const allowedSocket = path.join(runtime, "docker.sock");
  const siblingSocket = path.join(runtime, "sibling.sock");
  const replacement = path.join(workspace, "replacement");
  const clientPath = path.join(workspace, "client.cjs");
  let allowedServer;
  let siblingServer;
  let initialized = false;
  try {
    allowedServer = await listen(allowedSocket);
    siblingServer = await listen(siblingSocket);
    fs.writeFileSync(clientPath, clientSource, { mode: 0o600 });
    await SandboxManager.initialize({
      network: {
        // Keep SRT's network branch active for exact AF_UNIX filtering while
        // the trusted callback permits every syntactically valid TCP target.
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [allowedSocket],
        allowLocalBinding: true,
      },
      // The broker lives outside the writable workspace. Exact socket access
      // is a network permission, not permission to replace its directory entry.
      filesystem: { allowRead: [workspace], allowWrite: [workspace], denyRead: [], denyWrite: [] },
    }, async () => true);
    initialized = true;
    const command = [process.execPath, clientPath, allowedSocket, siblingSocket, replacement]
      .map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
    const wrapped = await SandboxManager.wrapWithSandbox(command);
    const result = await run("/bin/sh", ["-lc", wrapped], {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? os.homedir(), TMPDIR: os.tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.code, 0, `SRT client failed: ${result.stderr || result.stdout}`);
    const match = result.stdout.match(/^SRT_SOCKET_RESULT=(.+)$/m);
    assert.ok(match, `SRT client produced no result: ${result.stdout || result.stderr}`);
    const observed = JSON.parse(match[1]);
    assert.deepEqual(observed, {
      allowed: "ping",
      siblingError: "EPERM",
      unlinkError: "EPERM",
      replaceError: "EPERM",
      preserved: "ping",
    });
    return observed;
  } finally {
    if (initialized) await SandboxManager.reset();
    if (allowedServer) await close(allowedServer);
    if (siblingServer) await close(siblingServer);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await runSrtUnixSocketCanary();
    console.log("SRT Unix-socket canary passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
