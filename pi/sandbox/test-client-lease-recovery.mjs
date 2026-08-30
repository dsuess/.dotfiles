import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControllerClient } from "./client.mjs";
import { encodeFrame, FrameDecoder, makeErrorResponse, makeResponse, validateRequest } from "./protocol.mjs";

const MASTER = "a".repeat(64);
const LEASE = "b".repeat(64);
const WORKSPACE = "c".repeat(64);
const POLICY = "d".repeat(64);

function descriptor(socketPath) {
  const runtimeRoot = path.dirname(socketPath);
  return {
    version: 2,
    token: MASTER,
    workspaceKey: WORKSPACE,
    workspaceRoot: "/workspace",
    runtimeRoot,
    socketPath,
    manifestPath: path.join(runtimeRoot, "manifest.json"),
    capabilityPath: path.join(runtimeRoot, "capability.json"),
    sourceDigest: POLICY,
    generation: 1,
  };
}

function status() {
  return {
    health: "healthy",
    workspaceKey: WORKSPACE,
    workspaceRoot: "/workspace",
    policyGeneration: POLICY,
    runtimeGeneration: "1".padStart(64, "0"),
    sidecarId: null,
    dockerHealthy: false,
    attachedRoots: 1,
    pendingRestart: false,
    brokerHealthy: true,
  };
}

async function startMockController(t, onRequest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-client-recovery-"));
  const socketPath = path.join(root, "controller.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const decoder = new FrameDecoder((frame) => onRequest(validateRequest(frame), socket));
    socket.on("data", (chunk) => decoder.push(chunk));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return socketPath;
}

function respondError(socket, request, code, message = code) {
  socket.write(encodeFrame(makeErrorResponse(request.id, Object.assign(new Error(message), { code }))));
}

test("root recovery renews once, retains its lease token, and retries each rejected request once", async (t) => {
  let expired = false;
  let renewals = 0;
  let dispatchedWrites = 0;
  const requests = [];
  const socketPath = await startMockController(t, (request, socket) => {
    requests.push(request);
    if (request.method === "lease.renew") {
      renewals += 1;
      assert.equal(request.auth, MASTER);
      assert.deepEqual(request.params, { workspaceKey: WORKSPACE, leaseToken: LEASE });
      expired = false;
      socket.write(encodeFrame(makeResponse(request.id, { leaseToken: LEASE, expiresAt: Date.now() + 1_000 })));
      return;
    }
    if (expired) {
      respondError(socket, request, "lease_expired", "lease expired");
      return;
    }
    if (request.method === "status") {
      socket.write(encodeFrame(makeResponse(request.id, status())));
      return;
    }
    if (request.method === "fs.writeFile") {
      dispatchedWrites += 1;
      socket.write(encodeFrame(makeResponse(request.id, { ok: true })));
      return;
    }
    respondError(socket, request, "unknown_method");
  });
  const startup = descriptor(socketPath);
  const { client } = await ControllerClient.connectInherited({
    socketPath,
    leaseToken: LEASE,
    workspaceKey: WORKSPACE,
    workspaceRoot: "/workspace",
    policyGeneration: POLICY,
    runtimeGeneration: "1".padStart(64, "0"),
    renewalStartup: startup,
    adoptLease: true,
  });
  t.after(() => client.destroy());

  expired = true;
  const recovered = await Promise.all([client.status(), client.status(), client.status()]);
  assert.equal(renewals, 1, "concurrent expired requests share one renewal");
  assert.deepEqual(recovered.map((item) => item.workspaceKey), [WORKSPACE, WORKSPACE, WORKSPACE]);
  assert.equal(client.descriptor.token, LEASE, "renewal keeps the opaque lease token stable");

  expired = true;
  await client.writeFile("/workspace/output.txt", "written once");
  assert.equal(dispatchedWrites, 1, "the pre-auth rejection never dispatches the write");
  assert.equal(renewals, 2);
  const writes = requests.filter((request) => request.method === "fs.writeFile");
  assert.equal(writes.length, 2, "the original write is retried exactly once");
});

test("inherited clients and non-lease failures never invoke root renewal", async (t) => {
  let failureCode = null;
  let renewals = 0;
  let statusRequests = 0;
  const socketPath = await startMockController(t, (request, socket) => {
    if (request.method === "lease.renew") {
      renewals += 1;
      socket.write(encodeFrame(makeResponse(request.id, { leaseToken: LEASE, expiresAt: Date.now() + 1_000 })));
      return;
    }
    if (request.method === "status") {
      statusRequests += 1;
      if (failureCode) {
        respondError(socket, request, failureCode, failureCode.replace("_", " "));
        return;
      }
      socket.write(encodeFrame(makeResponse(request.id, status())));
      return;
    }
    respondError(socket, request, "unknown_method");
  });
  const options = {
    socketPath,
    leaseToken: LEASE,
    workspaceKey: WORKSPACE,
    workspaceRoot: "/workspace",
    policyGeneration: POLICY,
    runtimeGeneration: "1".padStart(64, "0"),
  };
  const inherited = await ControllerClient.connectInherited(options);
  const root = await ControllerClient.connectInherited({ ...options, renewalStartup: descriptor(socketPath), adoptLease: true });
  t.after(() => {
    inherited.client.destroy();
    root.client.destroy();
  });

  failureCode = "lease_expired";
  await assert.rejects(inherited.client.status(), (error) => error.code === "lease_expired");
  assert.equal(renewals, 0, "lease-only children cannot renew");

  failureCode = "stale_generation";
  const before = statusRequests;
  await assert.rejects(root.client.status(), (error) => error.code === "stale_generation");
  assert.equal(renewals, 0, "policy failures are not retried as lease failures");
  assert.equal(statusRequests, before + 1, "non-lease failures make one request");
});
