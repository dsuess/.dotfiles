#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { configureRuntimeCaches, ControllerClient, ensureControllerLease, validateRepositoryScope } from "./client.mjs";
import { discoverRepositoryScope } from "./repository-scope.mjs";

function parseOptions(argv) {
  const options = {};
  const allowed = new Set([
    "--launch-dir", "--settings", "--cache-root", "--runtime-root", "--image-dir", "--socket", "--lease",
    "--workspace-key", "--workspace-root", "--policy-generation", "--image-generation", "--vm-id", "--client-id",
    "--pi", "--auth", "--models", "--cache", "--scope-record", "--resolve-model-scope",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) throw new Error(`unknown client option: ${flag}`);
    if (flag === "--resolve-model-scope") {
      options.resolve_model_scope = true;
      continue;
    }
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

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 23 || (major === 23 && minor < 6)) throw new Error("Node.js 23.6 or newer is required");
}

function scopeFor(options) {
  const launchDirectory = required(options, "launch_dir");
  let scope;
  if (options.scope_record) {
    try { scope = JSON.parse(options.scope_record); } catch { throw new Error("repository scope record is invalid JSON"); }
  } else {
    scope = discoverRepositoryScope({ launchDirectory, pathValue: process.env.PATH });
  }
  return validateRepositoryScope(scope, launchDirectory);
}

function privateHandshakeFile(runtimeRoot) {
  const root = fs.realpathSync(runtimeRoot);
  const stat = fs.statSync(root);
  const uid = process.getuid?.() ?? null;
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) {
    throw new Error("controller runtime root is not a private directory");
  }
  const directory = path.join(runtimeRoot, `handshake.${process.pid}.${randomBytes(12).toString("hex")}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const directoryStat = fs.statSync(directory);
  if ((directoryStat.mode & 0o077) !== 0 || (uid !== null && directoryStat.uid !== uid)) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error("private handshake directory permissions are invalid");
  }
  return path.join(directory, "ready.json");
}

function leaseRecord(lease, handshakeFile, models) {
  return [
    lease.leaseToken, lease.paths.socketPath, lease.scope.workspaceKey, lease.scope.canonicalWorkspaceRoot,
    lease.status.policyGeneration, lease.status.imageGeneration, lease.status.vmId, lease.paths.runtimeRoot,
    handshakeFile, models.join(","),
  ].join("\t");
}

async function acquire(options) {
  const scope = scopeFor(options);
  const lease = await ensureControllerLease({
    launchDirectory: required(options, "launch_dir"), settingsPath: options.settings, cacheRoot: options.cache_root,
    runtimeRoot: options.runtime_root, imageDir: options.image_dir, clientId: options.client_id, scope,
  });
  const output = {
    version: 1, socketPath: lease.paths.socketPath, leaseToken: lease.leaseToken, workspaceKey: lease.scope.workspaceKey,
    workspaceRoot: lease.scope.canonicalWorkspaceRoot, bareCommonDirectory: lease.scope.bareCommonDirectory,
    policyGeneration: lease.status.policyGeneration, imageGeneration: lease.status.imageGeneration, vmId: lease.status.vmId,
    dockerHealthy: lease.status.dockerHealthy, controllerPid: lease.manifest.pid, runtimeRoot: lease.paths.runtimeRoot,
  };
  lease.client.destroy();
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function preflight(options) {
  const scope = scopeFor(options);
  const modelOptions = options.resolve_model_scope ? {
    piPath: required(options, "pi"), settingsPath: required(options, "settings"), authPath: required(options, "auth"),
    modelsPath: required(options, "models"), cachePath: required(options, "cache"),
  } : null;
  const modelScope = modelOptions ? import("./model-scope-cache.mjs").catch(() => null) : Promise.resolve(null);
  // The probe performs only bounded local reads, so it can overlap VM acquisition.
  const probe = modelScope.then((module) => module && modelOptions
    ? module.probeModelScope(modelOptions)
    : modelOptions ? {
      state: "fallback", models: [], source: "fallback", warning: "model scope cache helper is missing; continuing with Pi's native model resolution",
    } : null);
  let lease;
  try {
    lease = await ensureControllerLease({
      launchDirectory: required(options, "launch_dir"), settingsPath: options.sandbox_settings,
      cacheRoot: options.cache_root, runtimeRoot: options.runtime_root, imageDir: options.image_dir,
      clientId: options.client_id, scope,
    });
  } catch (error) {
    // Never start a metadata Pi process if the controller was not healthy.
    await probe.catch(() => {});
    throw error;
  }
  try {
    const probed = await probe;
    let models = [];
    let warning;
    if (probed?.state === "fresh" || probed?.state === "fallback") {
      models = probed.models;
      warning = probed.warning;
    } else if (modelOptions && await modelScope) {
      const resolved = await (await modelScope).resolveModelScope(modelOptions);
      models = resolved.models;
      warning = resolved.warning;
    }
    const handshakeFile = privateHandshakeFile(lease.paths.runtimeRoot);
    if (warning) process.stderr.write(`pi: warning: ${warning}\n`);
    lease.client.destroy();
    process.stdout.write(`${leaseRecord(lease, handshakeFile, models)}\n`);
  } catch (error) {
    await lease.client.release().catch(() => {});
    throw error;
  }
}

async function release(options) {
  const connected = await ControllerClient.connectInherited({
    socketPath: required(options, "socket"), leaseToken: required(options, "lease"), workspaceKey: required(options, "workspace_key"),
    workspaceRoot: required(options, "workspace_root"), policyGeneration: required(options, "policy_generation"),
    imageGeneration: required(options, "image_generation"), vmId: required(options, "vm_id"), heartbeatIntervalMs: 60_000,
  });
  await connected.client.releaseLease();
  process.stdout.write(`${JSON.stringify({ released: true })}\n`);
}

async function main() {
  assertNodeVersion();
  configureRuntimeCaches();
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (command === "acquire") await acquire(options);
  else if (command === "preflight") await preflight(options);
  else if (command === "release") await release(options);
  else throw new Error("usage: client-cli.mjs <acquire|preflight|release> [options]");
}

main().catch((error) => { process.stderr.write(`pi-gondolin-client: ${error.message}\n`); process.exitCode = 1; });
