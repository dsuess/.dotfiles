#!/usr/bin/env node
/**
 * Opt-in native contract check for the Pi SRT/Docker-Sandboxes transport.
 * It intentionally refuses to create or mutate anything until a reviewed
 * stable sbx release and a separately authenticated pi-srt app are present.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PI_SBX_APP = "pi-srt";
export const REQUIRED_SBX_VERSION = "0.42.0-rc1";
export const REQUIRED_SBX_COMMIT = "a6d7101a6c48908b39af0dad0103a2700c85ee4d";
export const MANUAL_LOGIN_COMMAND = "sbx --app-name pi-srt login";
export const REVIEWED_SHELL_TEMPLATE = "docker.io/docker/sandbox-templates@sha256:5fc81bc7a127e59d81b244a06831ae3212a0310b2e5a0349c54e29249e45e919";
const FIXED_ENV_NAMES = new Set(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME"]);

export function fixedSpawnEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    value !== undefined && FIXED_ENV_NAMES.has(key) && !/^(?:SSH_AUTH_SOCK|SBX_|DOCKER_|GH_TOKEN|GITHUB_TOKEN|AWS_|AZURE_|GOOGLE_|CI|NODE_OPTIONS|npm_config_)/.test(key)));
}

export function piSbxArgs(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
    throw new Error("invalid fixed sbx arguments");
  }
  return ["--app-name", PI_SBX_APP, ...arguments_];
}

export async function runPiSbx(arguments_, options = {}) {
  const executable = options.executable ?? "/opt/homebrew/bin/sbx";
  const args = piSbxArgs(arguments_);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? os.tmpdir(), env: fixedSpawnEnvironment(options.environment), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    const limit = options.maxBytes ?? 64 * 1024;
    const append = (current, chunk) => `${current}${chunk}`.slice(0, limit);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, args }));
  });
  return result;
}

/** Verify that sbx exec emits only Docker Engine bytes on stdout. */
export async function dialPiDockerPing(name, options = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,127}$/.test(name)) throw new Error("invalid sandbox name");
  const executable = options.executable ?? "/opt/homebrew/bin/sbx";
  const args = piSbxArgs(["exec", "-i", name, "docker", "system", "dial-stdio"]);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? os.tmpdir(), env: fixedSpawnEnvironment(options.environment), stdio: ["pipe", "pipe", "pipe"],
    });
    const outputLimit = options.maxBytes ?? 128 * 1024;
    let stdout = ""; let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(0, outputLimit);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr, args }));
    child.stdin.end("GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n");
  });
  assert.equal(result.code, 0, `Docker dial-stdio ping failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /^HTTP\/1\.1 200 OK\r?\n/im, `Docker dial-stdio stdout was contaminated: ${result.stdout || result.stderr}`);
  assert.match(result.stdout, /(?:^|\r?\n)API-Version: /i, "Docker Engine ping omitted API-Version");
  return result;
}

export function assertStableSbxVersion(output) {
  const match = output.match(/v(\d+\.\d+\.\d+(?:-[\w.-]+)?)\s+([0-9a-f]{40})/i);
  if (!match) throw new Error("could not determine sbx version and commit");
  const [, version, commit] = match;
  if (version !== REQUIRED_SBX_VERSION || commit.toLowerCase() !== REQUIRED_SBX_COMMIT) {
    throw new Error(`exact reviewed sbx v${REQUIRED_SBX_VERSION} (${REQUIRED_SBX_COMMIT.slice(0, 8)}) is required; found v${version} (${commit.slice(0, 8)})`);
  }
  return { version, commit };
}

export function assertAppAuthenticated(result) {
  if (/not authenticated|sign in with/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Pi Docker Sandboxes authentication is required. Run exactly: ${MANUAL_LOGIN_COMMAND}`);
  }
}

/** The dedicated Pi app must have no host-managed MCP server registrations. */
export function assertEmptyMcpRegistry(report) {
  assert.ok(report && typeof report === "object", "MCP registry response is invalid");
  assert.ok(Array.isArray(report.servers), "MCP registry response has no servers list");
  assert.deepEqual(report.servers, [], "Pi app MCP registry must remain empty");
}

/** Pi accepts the built-in MCP gateway, but never a restricted local egress policy. */
export function assertAllowAllPolicy(report) {
  assert.ok(report && typeof report === "object", "policy response is invalid");
  assert.ok(Array.isArray(report.rules), "policy response has no rules list");
  const networkRules = report.rules.filter((rule) => rule?.resource_type === "network");
  assert.equal(networkRules.some((rule) => rule.decision === "deny"), false, "Pi app network policy contains a deny rule");
  assert.equal(
    networkRules.some((rule) => rule.scope === "global" && rule.decision === "allow" && rule.resources?.includes("**")),
    true,
    "Pi app network policy is not allow-all",
  );
}

async function withPrivateLock(operation, runtimeRoot = path.join(os.homedir(), "Library", "Caches", "pi-srt")) {
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(runtimeRoot, 0o700);
  const lock = path.join(runtimeRoot, "app-initialization.lock");
  let descriptor;
  try {
    descriptor = fs.openSync(lock, "wx", 0o600);
    return await operation();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

export async function preflightPiApp(options = {}) {
  return withPrivateLock(async () => {
    const daemonStatus = await runPiSbx(["daemon", "status"], options);
    if (daemonStatus.code !== 0 || !/^Status: running$/m.test(daemonStatus.stdout)) {
      const started = await runPiSbx(["daemon", "start", "--detach"], options);
      assert.equal(started.code, 0, `Pi app daemon start failed: ${started.stderr || started.stdout}`);
    }
    const version = await runPiSbx(["version"], options);
    assert.equal(version.code, 0, `sbx version failed: ${version.stderr}`);
    const versionInfo = assertStableSbxVersion(`${version.stdout}\n${version.stderr}`);
    const diagnose = await runPiSbx(["diagnose", "--json"], options);
    assertAppAuthenticated(diagnose);
    assert.equal(diagnose.code, 0, `Pi app daemon diagnose failed: ${diagnose.stderr || diagnose.stdout}`);
    const parsed = JSON.parse(diagnose.stdout);
    if (!Array.isArray(parsed.checks) || parsed.checks.some((check) => check.status === "fail")) throw new Error("sbx diagnose reported a failed check");
    const sshForwarding = await runPiSbx(["settings", "set", "ssh.agentForwardingEnabled", "false"], options);
    assert.equal(sshForwarding.code, 0, `could not disable Pi-app SSH-agent forwarding: ${sshForwarding.stderr || sshForwarding.stdout}`);
    const sshForwardingStatus = await runPiSbx(["settings", "get", "ssh.agentForwardingEnabled"], options);
    assert.equal(sshForwardingStatus.code, 0, `could not read Pi-app SSH-agent forwarding setting: ${sshForwardingStatus.stderr || sshForwardingStatus.stdout}`);
    assert.equal(sshForwardingStatus.stdout.trim(), "false", "Pi-app SSH-agent forwarding remains enabled");
    let policyResult = await runPiSbx(["policy", "ls", "--json"], options);
    assert.equal(policyResult.code, 0, `Pi-app policy inspection failed: ${policyResult.stderr || policyResult.stdout}`);
    let policy = JSON.parse(policyResult.stdout);
    if (policy.rules?.length === 0) {
      const initialized = await runPiSbx(["policy", "init", "allow-all"], options);
      assert.equal(initialized.code, 0, `Pi-app allow-all policy initialization failed: ${initialized.stderr || initialized.stdout}`);
      policyResult = await runPiSbx(["policy", "ls", "--json"], options);
      assert.equal(policyResult.code, 0, `Pi-app policy reinspection failed: ${policyResult.stderr || policyResult.stdout}`);
      policy = JSON.parse(policyResult.stdout);
    }
    assertAllowAllPolicy(policy);
    const mcpRegistry = await runPiSbx(["mcp", "ls", "--json"], options);
    assertAppAuthenticated(mcpRegistry);
    assert.equal(mcpRegistry.code, 0, `Pi app MCP registry inspection failed: ${mcpRegistry.stderr || mcpRegistry.stdout}`);
    assertEmptyMcpRegistry(JSON.parse(mcpRegistry.stdout));
    const inventory = await runPiSbx(["template", "ls", "--json"], options);
    assertAppAuthenticated(inventory);
    assert.equal(inventory.code, 0, `Pi app template inventory failed: ${inventory.stderr || inventory.stdout}`);
    return { version: versionInfo, diagnose: parsed, policy, mcpRegistry: JSON.parse(mcpRegistry.stdout), templateInventory: JSON.parse(inventory.stdout) };
  }, options.runtimeRoot);
}

/** Reject every sidecar capability except Docker Sandboxes' accepted gateway. */
export function assertCanarySandbox(inspect, workspace) {
  assert.equal(inspect.agent, "shell", "canary must use the shell agent");
  assert.equal(inspect.image_digest, REVIEWED_SHELL_TEMPLATE.slice("docker.io/docker/sandbox-templates@".length), "template digest drift");
  assert.equal(inspect.workspace, workspace, "workspace mount drift");
  assert.deepEqual(inspect.kits, [], "kits are forbidden");
  assert.deepEqual(inspect.secrets, [{ name: "mcpgateway", source: "uploaded" }], "sidecar has unexpected secrets");
  assert.equal(inspect.mcp_gateway, true, "Docker Sandboxes MCP gateway is missing");
  assert.equal(inspect.sessions, 0, "new sidecar has an unexpected session");
  assert.equal(inspect.network_policy?.scope, "global", "sidecar is not using the Pi app-global policy");
}

/**
 * Destructive but self-cleaning native contract check. Docker Sandboxes always
 * creates its MCP gateway; the user accepted that channel. The dedicated Pi
 * app registry remains empty so no host-managed MCP server is exposed.
 */
export async function runDisposableSidecarCanary(options = {}) {
  await preflightPiApp(options);
  const name = `pi-srt-canary-${process.pid}-${randomBytes(4).toString("hex")}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-canary-"));
  let created = false;
  try {
    const createdSandbox = await runPiSbx([
      "create", "--name", name, "--cpus", "2", "--memory", "4g",
      "--template", REVIEWED_SHELL_TEMPLATE, "shell", workspace,
    ], { ...options, maxBytes: 256 * 1024 });
    assert.equal(createdSandbox.code, 0, `canary sidecar creation failed: ${createdSandbox.stderr || createdSandbox.stdout}`);
    created = true;
    const inspected = await runPiSbx(["inspect", name, "--json"], options);
    assert.equal(inspected.code, 0, `canary inspect failed: ${inspected.stderr || inspected.stdout}`);
    assertCanarySandbox(JSON.parse(inspected.stdout), workspace);
    const ping = await dialPiDockerPing(name, options);
    return { name, workspace, ping };
  } finally {
    if (created) await runPiSbx(["rm", "--force", name], options).catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await runDisposableSidecarCanary();
    console.log("Pi app and disposable sidecar canary passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
