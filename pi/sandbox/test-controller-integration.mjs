import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureGondolinImage } from "./build-gondolin-image.mjs";
import { ensureControllerLease } from "./client.mjs";
import { loadSandboxPolicy } from "./policy.mjs";

function settings(mode = "public-http") {
  return {
    version: 1,
    externalMounts: [],
    network: {
      mode,
      allowedHosts: [],
      allowWebSockets: false,
      tcpMappings: [],
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test(
  "two real clients share one QEMU VM and survive cancellation and policy restart",
  { timeout: 300_000 },
  async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-controller-native-")));
    const workspace = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    const cacheRoot = path.join(root, "cache");
    const settingsPath = path.join(root, "settings.json");
    fs.mkdirSync(workspace);
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings(), null, 2)}\n`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const image = await ensureGondolinImage({ verbose: false });
    const options = {
      launchDirectory: workspace,
      runtimeRoot,
      cacheRoot,
      settingsPath,
      imageDir: image.imageDir,
      heartbeatIntervalMs: 100,
      startTimeoutMs: 180_000,
    };
    const [first, second] = await Promise.all([
      ensureControllerLease({ ...options, clientId: "root-one" }),
      ensureControllerLease({ ...options, clientId: "root-two" }),
    ]);
    let firstReleased = false;
    let secondReleased = false;
    t.after(async () => {
      if (!firstReleased) await first.client.release().catch(() => {});
      if (!secondReleased) await second.client.release().catch(() => {});
    });

    assert.equal(first.manifest.pid, second.manifest.pid);
    assert.equal(first.status.vmId, second.status.vmId);
    assert.equal(first.status.policyGeneration, second.status.policyGeneration);
    assert.equal((await first.client.status()).attachedRoots, 2);
    assert.equal(first.status.dockerHealthy, true);

    const guestFile = path.join(workspace, "controller-write.txt");
    await first.client.writeFile(guestFile, "shared-vfs");
    assert.equal(fs.readFileSync(guestFile, "utf8"), "shared-vfs");
    const read = await second.client.readFile(guestFile, { offset: 0, limit: 64 });
    assert.equal(read.data.toString(), "shared-vfs");

    const dockerOutput = [];
    const docker = await second.client.exec(
      ["/usr/bin/docker", "info", "--format", "{{.Driver}}|{{.DockerRootDir}}"],
      {
        cwd: workspace,
        env: {},
        onEvent: (stream, data) => dockerOutput.push([stream, data.toString()]),
      },
    );
    assert.equal(docker.vmId, first.status.vmId);
    assert.match(dockerOutput.map((entry) => entry[1]).join(""), /^vfs\|\/var\/lib\/docker/m);

    const oldVmId = first.status.vmId;
    const abortController = new AbortController();
    const sleeping = first.client.exec(["/bin/bash", "-lc", "sleep 30"], {
      cwd: workspace,
      env: {},
      signal: abortController.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => abortController.abort(), 100).unref?.();
    await assert.rejects(sleeping, /cancel/i);
    const afterCancel = await second.client.status();
    assert.notEqual(afterCancel.vmId, oldVmId);
    assert.equal(afterCancel.dockerHealthy, true);

    fs.writeFileSync(settingsPath, `${JSON.stringify(settings("offline"), null, 2)}\n`);
    const expectedPolicy = loadSandboxPolicy({
      scope: first.scope,
      settingsPath,
      cacheRoot,
      runtimeRoot,
      imageGeneration: first.manifest.imageGeneration,
    });
    const afterReload = await first.client.reload();
    assert.equal(afterReload.policyGeneration, expectedPolicy.policyGeneration);
    assert.notEqual(afterReload.vmId, afterCancel.vmId);
    const converged = await second.client.status();
    assert.equal(converged.policyGeneration, expectedPolicy.policyGeneration);
    assert.equal(converged.vmId, afterReload.vmId);

    const dockerDirectory = path.join(cacheRoot, "workspaces", first.scope.workspaceKey, "docker");
    const resetMarker = path.join(dockerDirectory, "reset-marker");
    fs.writeFileSync(resetMarker, "delete-me");
    const afterReset = await first.client.resetDocker();
    assert.notEqual(afterReset.vmId, afterReload.vmId);
    assert.equal(fs.existsSync(resetMarker), false);
    assert.equal((await second.client.status()).vmId, afterReset.vmId);

    await first.client.release();
    firstReleased = true;
    assert.equal((await second.client.status()).attachedRoots, 1);
    await second.client.release();
    secondReleased = true;
    await waitFor(
      () => !fs.existsSync(first.paths.manifestPath) && !fs.existsSync(first.paths.socketPath),
      "controller did not stop after the final lease",
    );
  },
);
