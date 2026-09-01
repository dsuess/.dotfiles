#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { applySrtWorkspaceWritePatch } from "./apply-srt-workspace-write-patch.mjs";
import { buildSrtPolicy } from "./srt-policy.mjs";
import { WorkspaceDockerSidecar } from "./docker-sidecar.mjs";
import { materializeDockerClientEnvironment, resolveDockerClientTools } from "./docker-client-env.mjs";
import { resolveHostReadManifest, resolveUserToolRuntime } from "./host-configuration.mjs";
import { atomicJson, manifestFor, validateDescriptor } from "./capability.mjs";
import { FrameDecoder, encodeFrame, makeErrorResponse, makeResponse, makeStreamEvent, validateRequest } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const descriptor = validateDescriptor(JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")));
function recordFatal(error) {
  let diagnostic = error instanceof Error ? error.stack : String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.length >= 4 && /(?:TOKEN|KEY|SECRET|PASSWORD|AUTH)/i.test(name)) diagnostic = diagnostic.replaceAll(value, "[redacted]");
  }
  try { fs.writeFileSync(path.join(descriptor.runtimeRoot, "controller-error.log"), `${diagnostic}\n`, { mode: 0o600 }); } catch {}
}
process.on("uncaughtException", (error) => { recordFatal(error); process.exit(1); });
process.on("unhandledRejection", (error) => { recordFatal(error); process.exit(1); });
const MAX_OPERATIONS = 8;
const TERM_GRACE_MS = 1_000;
const testLeaseTtl = Number(process.env.PI_SRT_TEST_LEASE_TTL_MS);
const LEASE_TTL_MS = process.env.NODE_TEST_CONTEXT && Number.isSafeInteger(testLeaseTtl) && testLeaseTtl > 0
  ? testLeaseTtl
  : 30_000;
const sourceHelper = path.join(HERE, "operation-helper.mjs");
for (const directory of [descriptor.runtimeRoot, path.dirname(descriptor.socketPath), descriptor.brokerRoot]) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); }
fs.rmSync(path.join(descriptor.runtimeRoot, "controller-error.log"), { force: true });
fs.rmSync(descriptor.socketPath, { force: true });
const generationRoot = path.join(descriptor.runtimeRoot, `generation-${descriptor.generation}`);
const toolHomeRoot = path.join("/tmp", `pi-srt-${process.getuid()}`, "g", descriptor.workspaceKey, String(descriptor.generation));
const buildxConfig = path.join(toolHomeRoot, "buildx");
const uvCache = path.join(toolHomeRoot, "cache", "uv");
for (const directory of [generationRoot, toolHomeRoot, path.join(toolHomeRoot, "home"), path.join(toolHomeRoot, "tmp"), path.join(toolHomeRoot, "cache"), buildxConfig]) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); }
const helper = path.join(generationRoot, "operation-helper.mjs");
fs.rmSync(helper, { force: true });
fs.copyFileSync(sourceHelper, helper); fs.chmodSync(helper, 0o500);
const hostHome = os.homedir();
const generatedHome = path.join(toolHomeRoot, "home");
const serenaConfiguration = path.join(hostHome, ".serena", "serena_config.yml");
try {
  if (fs.statSync(serenaConfiguration).isFile()) {
    const generatedSerenaDirectory = path.join(generatedHome, ".serena");
    fs.mkdirSync(generatedSerenaDirectory, { recursive: true, mode: 0o700 });
    fs.copyFileSync(serenaConfiguration, path.join(generatedSerenaDirectory, "serena_config.yml"));
  }
} catch (error) { if (error?.code !== "ENOENT") throw error; }
const hostReadManifest = resolveHostReadManifest({ home: hostHome });
const userToolRuntime = resolveUserToolRuntime({ home: hostHome });
const dockerClient = materializeDockerClientEnvironment(generationRoot, resolveDockerClientTools());
applySrtWorkspaceWritePatch();
const sidecar = new WorkspaceDockerSidecar({ workspaceKey: descriptor.workspaceKey, workspaceRoot: descriptor.workspaceRoot, bareCommonDirectory: descriptor.bareCommonDirectory, runtimeRoot: descriptor.runtimeRoot, brokerRoot: descriptor.brokerRoot });
await sidecar.startBroker(); // Sidecar creation stays lazy: bridge() calls ensure on first Docker use.
const policy = buildSrtPolicy({ home: hostHome, workspaceRoot: descriptor.workspaceRoot, bareCommonDirectory: descriptor.bareCommonDirectory, controllerRoot: descriptor.runtimeRoot, dockerSocket: descriptor.dockerSocket, stagedHelper: helper, generatedRoots: [toolHomeRoot, generatedHome, path.join(toolHomeRoot, "tmp"), path.join(toolHomeRoot, "cache"), buildxConfig, dockerClient.path, dockerClient.config, dockerClient.pluginDirectory], toolFiles: dockerClient.files, hostReadManifest, grants: [] });
await SandboxManager.initialize(policy, async () => true);
atomicJson(descriptor.manifestPath, manifestFor(descriptor));
atomicJson(descriptor.capabilityPath, descriptor);

const active = new Map();
const leases = new Map();
let operationCount = 0;
function boundedEnvironment(overrides = {}) {
  const blocked = /^(PI_SRT_|SSH_AUTH_SOCK|GPG_AGENT_INFO|DOCKER_|SBX_|DYLD_|LD_PRELOAD|HOME|TMPDIR|XDG_CACHE_HOME|UV_CACHE_DIR)$/;
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (typeof value === "string" && !blocked.test(name)) env[name] = value;
  for (const [name, value] of Object.entries(overrides)) if (typeof value === "string" && !blocked.test(name)) env[name] = value;
  return { ...env, PI_SRT_ROUTING: "", PI_SRT_ROUTING_TOKEN: "", PI_SRT_ROUTING_STARTUP_DESCRIPTOR: "", PI_SRT_ROUTING_SOCKET: "", PI_SRT_ROUTING_LEASE: "", PI_SRT_ROUTING_ROOT_OWNER_PID: "", HOME: generatedHome, TMPDIR: path.join(toolHomeRoot, "tmp"), XDG_CACHE_HOME: path.join(toolHomeRoot, "cache"), UV_CACHE_DIR: uvCache, PATH: `${dockerClient.path}:${process.env.PATH ?? ""}`, ...(userToolRuntime.bin ? { UV_TOOL_BIN_DIR: userToolRuntime.bin } : {}), ...(userToolRuntime.toolDir ? { UV_TOOL_DIR: userToolRuntime.toolDir } : {}), ...(userToolRuntime.pythonInstallDir ? { UV_PYTHON_INSTALL_DIR: userToolRuntime.pythonInstallDir } : {}), DOCKER_CONFIG: dockerClient.config, BUILDX_CONFIG: buildxConfig, DOCKER_HOST: `unix://${descriptor.dockerSocket}`, DOCKER_CONTEXT: "default", SSH_AUTH_SOCK: "" };
}
function removeOperation(id, child) { if (active.get(id)?.child === child) { active.delete(id); operationCount -= 1; } }
async function terminate(operation) {
  if (!operation || operation.finished) return false;
  operation.cancelled = true;
  try { process.kill(-operation.child.pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));
  if (!operation.finished) try { process.kill(-operation.child.pid, "SIGKILL"); } catch {}
  return true;
}
function quoteBash(argv) { return argv.map((item) => `'${String(item).replace(/'/g, "'\\''")}'`).join(" "); }
async function spawnSandbox({ argv, cwd, env, requestId, socket, timeoutMs, maxOutputBytes, helperRequest }) {
  if (operationCount >= MAX_OPERATIONS) throw Object.assign(new Error("operation concurrency limit reached"), { code: "busy" });
  const command = helperRequest ? quoteBash([process.execPath, helper]) : quoteBash(argv);
  const wrapped = await SandboxManager.wrapWithSandboxArgv(command, "/bin/bash");
  return new Promise((resolve, reject) => {
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd, env: boundedEnvironment({ ...wrapped.env, ...env }), shell: false, detached: true, stdio: [helperRequest ? "pipe" : "ignore", "pipe", "pipe"] });
    const operation = { child, socket, finished: false, cancelled: false }; active.set(requestId, operation); operationCount += 1;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0;
    const stream = (name, chunk) => {
      const bytesName = name === "stdout" ? "stdoutBytes" : "stderrBytes";
      if (name === "stdout") stdoutBytes += chunk.length; else stderrBytes += chunk.length;
      const allowed = Math.max(0, maxOutputBytes - Math.min(maxOutputBytes, stdoutBytes + stderrBytes - chunk.length));
      const sent = chunk.subarray(0, allowed);
      if (helperRequest) { if (name === "stdout") stdout = Buffer.concat([stdout, sent]); else stderr = Buffer.concat([stderr, sent]); }
      else if (sent.length) socket.write(encodeFrame(makeStreamEvent(requestId, name, sent)));
    };
    child.stdout.on("data", (chunk) => stream("stdout", chunk)); child.stderr.on("data", (chunk) => stream("stderr", chunk));
    const timeout = setTimeout(() => void terminate(operation), timeoutMs); timeout.unref();
    child.once("error", (error) => { clearTimeout(timeout); operation.finished = true; removeOperation(requestId, child); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timeout); operation.finished = true; removeOperation(requestId, child); if (helperRequest) { try { const answer = JSON.parse(stdout.toString("utf8")); if (!answer.ok) throw Object.assign(new Error(answer.message || "helper failed"), { code: answer.code || "helper_error" }); resolve(answer.result); } catch (error) { reject(error); } } else resolve({ exitCode: code ?? 1, signal: signal ?? null, outputBytes: Math.min(maxOutputBytes, stdoutBytes + stderrBytes), truncated: stdoutBytes + stderrBytes > maxOutputBytes, cancelled: operation.cancelled }); });
    if (helperRequest) child.stdin.end(JSON.stringify(helperRequest));
  });
}
function leaseError(code, message) { return Object.assign(new Error(message), { code }); }
function activeLeaseCount(now = Date.now()) {
  let count = 0;
  for (const lease of leases.values()) if (lease.expiresAt >= now) count += 1;
  return count;
}
function validateLease(request) {
  const lease = leases.get(request.auth);
  if (!lease) throw leaseError("invalid_lease", "invalid lease");
  if (lease.expiresAt < Date.now()) throw leaseError("lease_expired", "lease expired");
  lease.expiresAt = Date.now() + LEASE_TTL_MS;
  return lease;
}
async function dispatch(request, socket) {
  const p = request.params;
  if (request.method === "lease.acquire") {
    if (request.auth !== descriptor.token || p.workspaceKey !== descriptor.workspaceKey) {
      throw leaseError("unauthorized", "workspace mismatch");
    }
    const leaseToken = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + LEASE_TTL_MS;
    leases.set(leaseToken, { clientId: p.clientId, expiresAt });
    return { leaseToken, expiresAt };
  }
  if (request.method === "lease.renew") {
    if (request.auth !== descriptor.token || p.workspaceKey !== descriptor.workspaceKey) {
      throw leaseError("unauthorized", "workspace mismatch");
    }
    const lease = leases.get(p.leaseToken);
    if (!lease) throw leaseError("invalid_lease", "invalid lease");
    const expiresAt = Date.now() + LEASE_TTL_MS;
    lease.expiresAt = expiresAt;
    return { leaseToken: p.leaseToken, expiresAt };
  }
  validateLease(request);
  if (request.method === "status") { const owned = sidecar.metadata(); return { health: "healthy", workspaceKey: descriptor.workspaceKey, workspaceRoot: descriptor.workspaceRoot, policyGeneration: policy.generation, runtimeGeneration: String(descriptor.generation).padStart(64, "0"), sidecarId: owned?.id ?? null, dockerHealthy: Boolean(owned), attachedRoots: activeLeaseCount(), pendingRestart: false, brokerHealthy: true }; }
  if (request.method === "lease.heartbeat") return { ok: true };
  if (request.method === "lease.release") { leases.delete(request.auth); return { ok: true, final: activeLeaseCount() === 0 }; }
  if (request.method === "cancel") return { cancelled: await terminate(active.get(p.requestId)) };
  if (p.policyGeneration !== policy.generation) throw Object.assign(new Error("stale policy generation"), { code: "stale_generation" });
  if (request.method === "docker.reset") { await sidecar.reset(); return { reset: true }; }
  if (request.method === "exec") return spawnSandbox({ ...p, requestId: request.id, socket });
  const map = { "fs.access": "access", "fs.mkdir": "mkdir", "fs.listDir": "listDir", "fs.stat": "stat", "fs.rename": "rename", "fs.readFile": "readFile", "fs.writeFile": "writeFile", "fs.deleteFile": "deleteFile" };
  const operation = map[request.method]; if (!operation) throw Object.assign(new Error("unsupported controller operation"), { code: "unknown_method" });
  return spawnSandbox({ argv: [], cwd: descriptor.workspaceRoot, env: {}, requestId: request.id, socket, timeoutMs: 60_000, maxOutputBytes: 12 * 1024 * 1024, helperRequest: { operation, params: p } });
}
const server = net.createServer((socket) => { const decoder = new FrameDecoder(async (value) => { let request; try { request = validateRequest(value); const result = await dispatch(request, socket); socket.write(encodeFrame(makeResponse(request.id, result))); } catch (error) { socket.write(encodeFrame(makeErrorResponse(request?.id ?? 1, error))); } }); socket.on("data", (data) => { try { decoder.push(data); } catch { socket.destroy(); } }); socket.on("close", () => { for (const [id, operation] of active) if (operation.socket === socket) void terminate(operation); }); });
let controllerSocketInode = null;
server.listen(descriptor.socketPath, () => { fs.chmodSync(descriptor.socketPath, 0o600); controllerSocketInode = fs.lstatSync(descriptor.socketPath).ino; });
function shutdown() {
  for (const operation of active.values()) void terminate(operation);
  server.close(); void sidecar.close();
  let ownsPublishedState = false;
  try { ownsPublishedState = JSON.parse(fs.readFileSync(descriptor.manifestPath, "utf8")).pid === process.pid; } catch {}
  if (ownsPublishedState) {
    try { if (fs.lstatSync(descriptor.socketPath).ino === controllerSocketInode) fs.rmSync(descriptor.socketPath); } catch {}
    fs.rmSync(descriptor.manifestPath, { force: true }); fs.rmSync(descriptor.capabilityPath, { force: true });
  }
}
process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
