#!/usr/bin/env node

import { ControllerClient, ensureControllerLease } from "./client.mjs";

function parseOptions(argv) {
  const options = {};
  const allowed = new Set([
    "--launch-dir",
    "--settings",
    "--cache-root",
    "--runtime-root",
    "--image-dir",
    "--socket",
    "--lease",
    "--workspace-key",
    "--workspace-root",
    "--policy-generation",
    "--image-generation",
    "--vm-id",
    "--client-id",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown client option: ${flag}`);
    const value = argv[++index];
    if (!value) throw new Error(`missing value for ${flag}`);
    options[flag.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name.replaceAll("_", "-")} is required`);
  return value;
}

async function acquire(options) {
  const lease = await ensureControllerLease({
    launchDirectory: required(options, "launch_dir"),
    settingsPath: options.settings,
    cacheRoot: options.cache_root,
    runtimeRoot: options.runtime_root,
    imageDir: options.image_dir,
    clientId: options.client_id,
  });
  const output = {
    version: 1,
    socketPath: lease.paths.socketPath,
    leaseToken: lease.leaseToken,
    workspaceKey: lease.scope.workspaceKey,
    workspaceRoot: lease.scope.canonicalWorkspaceRoot,
    bareCommonDirectory: lease.scope.bareCommonDirectory,
    policyGeneration: lease.status.policyGeneration,
    imageGeneration: lease.status.imageGeneration,
    vmId: lease.status.vmId,
    dockerHealthy: lease.status.dockerHealthy,
    controllerPid: lease.manifest.pid,
    runtimeRoot: lease.paths.runtimeRoot,
  };
  lease.client.destroy();
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function release(options) {
  const connected = await ControllerClient.connectInherited({
    socketPath: required(options, "socket"),
    leaseToken: required(options, "lease"),
    workspaceKey: required(options, "workspace_key"),
    workspaceRoot: required(options, "workspace_root"),
    policyGeneration: required(options, "policy_generation"),
    imageGeneration: required(options, "image_generation"),
    vmId: required(options, "vm_id"),
    heartbeatIntervalMs: 60_000,
  });
  await connected.client.releaseLease();
  process.stdout.write(`${JSON.stringify({ released: true })}\n`);
}

async function main() {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (command === "acquire") await acquire(options);
  else if (command === "release") await release(options);
  else throw new Error("usage: client-cli.mjs <acquire|release> [options]");
}

main().catch((error) => {
  process.stderr.write(`pi-gondolin-client: ${error.message}\n`);
  process.exitCode = 1;
});
