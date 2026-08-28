import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireControllerLease, beginControllerStartup, stopStartedController } from "./client.mjs";

async function acquire(startup, name) {
  return acquireControllerLease({ startup, clientId: name });
}

test("controller publishes a private manifest, shares root leases, and frames helper results", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-controller-"));
  fs.writeFileSync(path.join(workspace, "input.txt"), "controller result\n");
  const startup = beginControllerStartup({ launchDirectory: workspace });
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); });
  const first = await acquire(startup, "first");
  const second = await acquire(startup, "second");
  assert.equal(first.status.workspaceRoot, fs.realpathSync(workspace));
  assert.equal(first.status.sidecarId, null, "readiness must not create a Docker sidecar");
  const manifest = JSON.parse(fs.readFileSync(startup.manifestPath, "utf8"));
  assert.match(manifest.tokenDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(manifest).includes(startup.token), false, "manifest never persists the token");
  const read = await first.client.readFile(path.join(workspace, "input.txt"));
  assert.equal(read.data.toString(), "controller result\n");
  await first.client.release();
  assert.equal((await second.client.status()).attachedRoots, 1);
  await second.client.release();
});

test("controller forwards ordinary secret values but strips control authority", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-environment-"));
  const startup = beginControllerStartup({ launchDirectory: workspace });
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); });
  const attached = await acquire(startup, "environment");
  const chunks = [];
  await attached.client.exec(["/bin/bash", "-lc", "printf '%s|%s|%s' \"$SYNTHETIC_SECRET\" \"${PI_SRT_ROUTING_TOKEN-unset}\" \"${SSH_AUTH_SOCK-unset}\""], {
    cwd: workspace, env: { SYNTHETIC_SECRET: "raw-secret-value", PI_SRT_ROUTING_TOKEN: "must-not-cross", SSH_AUTH_SOCK: "/private/agent" },
    onEvent: (stream, data) => { if (stream === "stdout") chunks.push(data); },
  });
  assert.equal(Buffer.concat(chunks).toString(), "raw-secret-value||");
  await attached.client.release();
});

test("controller cancels a process group on timeout", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-timeout-"));
  const startup = beginControllerStartup({ launchDirectory: workspace });
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); });
  const attached = await acquire(startup, "timeout");
  const result = await attached.client.exec(["/bin/bash", "-lc", "trap '' TERM; sleep 10"], {
    cwd: workspace, timeoutMs: 50, maxOutputBytes: 1024,
  });
  assert.equal(result.cancelled, true);
  await attached.client.release();
});
