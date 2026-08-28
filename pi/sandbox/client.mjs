import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRepositoryScope } from "./repository-scope.mjs";
import { atomicJson, processMatches, readPrivateJson, sourceDigest, validateDescriptor, validateManifest } from "./capability.mjs";
import { encodeFrame, FrameDecoder, makeRequest, validateResponse } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const controller = path.join(HERE, "controller.mjs");
const sourceFiles = [controller, path.join(HERE, "operation-helper.mjs"), path.join(HERE, "srt-policy.mjs"), path.join(HERE, "docker-sidecar.mjs")];
// Darwin limits AF_UNIX paths to 104 bytes; do not put controller sockets in
// the otherwise conventional, but too long, ~/Library/Caches hierarchy.
const privateRoot = (key) => path.join("/tmp", `pi-srt-${process.getuid()}`, "c", key);
const brokerRootFor = (key) => path.join("/tmp", `pi-srt-${process.getuid()}`, "b", key);
function privateDirectory(directory) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); return directory; }
function stateIsUsable(descriptor) {
  try { const manifest = readPrivateJson(descriptor.manifestPath); const capability = validateDescriptor(readPrivateJson(descriptor.capabilityPath)); const socket = fs.lstatSync(descriptor.socketPath); return validateManifest(manifest, capability) && capability.sourceDigest === descriptor.sourceDigest && capability.workspaceKey === descriptor.workspaceKey && capability.workspaceRoot === descriptor.workspaceRoot && socket.isSocket() && (socket.mode & 0o077) === 0 ? capability : null; } catch { return null; }
}
function removeStale(descriptor) { for (const file of [descriptor.socketPath, descriptor.manifestPath, descriptor.capabilityPath]) fs.rmSync(file, { force: true }); }
function descriptorFor(launchDir) {
  const scope = discoverRepositoryScope({ launchDirectory: launchDir, pathValue: process.env.PATH });
  const runtimeRoot = privateDirectory(privateRoot(scope.workspaceKey)); const brokerRoot = privateDirectory(brokerRootFor(scope.workspaceKey));
  const base = { version: 2, workspaceKey: scope.workspaceKey, workspaceRoot: fs.realpathSync(scope.canonicalWorkspaceRoot), bareCommonDirectory: scope.bareCommonDirectory ? fs.realpathSync(scope.bareCommonDirectory) : null, runtimeRoot, brokerRoot, socketPath: path.join(runtimeRoot, "controller.sock"), dockerSocket: path.join(brokerRoot, "docker.sock"), manifestPath: path.join(runtimeRoot, "manifest.json"), capabilityPath: path.join(runtimeRoot, "capability.json"), sourceDigest: sourceDigest(sourceFiles), generation: 1 };
  const existing = stateIsUsable(base); if (existing) return existing;
  try {
    const manifest = readPrivateJson(base.manifestPath);
    // A live controller from a different reviewed source generation is stale,
    // not reusable. Terminate only the PID proven by its start identity before
    // atomically replacing its state.
    if (processMatches(manifest.pid, manifest.processStartIdentity)) {
      process.kill(manifest.pid, "SIGTERM");
      for (let attempt = 0; attempt < 50 && processMatches(manifest.pid, manifest.processStartIdentity); attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      if (processMatches(manifest.pid, manifest.processStartIdentity)) throw new Error("stale controller did not stop");
    }
  } catch (error) { if (error?.message === "stale controller did not stop") throw error; }
  removeStale(base); return { ...base, token: randomBytes(32).toString("hex") };
}
function start(descriptor) { if (stateIsUsable(descriptor)) return; const child = spawn(process.execPath, [controller, Buffer.from(JSON.stringify(descriptor)).toString("base64")], { detached: true, stdio: "ignore", cwd: descriptor.workspaceRoot, env: process.env }); child.unref(); }
export function beginControllerStartup({ launchDirectory }) { const descriptor = descriptorFor(launchDirectory); start(descriptor); return descriptor; }
export class ControllerClient {
  constructor(descriptor) { this.descriptor = validateDescriptor({ ...descriptor }); this.policyGeneration = descriptor.policyGeneration; this.sequence = 0; this.pending = new Map(); this.socket = net.createConnection(descriptor.socketPath); this.ready = new Promise((resolve, reject) => { this.socket.once("connect", resolve); this.socket.once("error", reject); }); const decoder = new FrameDecoder((frame) => { const response = validateResponse(frame); const item = this.pending.get(response.id); if (!item) return; if (response.type === "event") { item.events.push([response.event, Buffer.from(response.data, "base64")]); return; } this.pending.delete(response.id); response.ok ? item.resolve({ result: response.result, events: item.events }) : item.reject(Object.assign(new Error(response.error.message), { code: response.error.code })); }); this.socket.on("data", (data) => decoder.push(data)); }
  static async connectInherited(options) { const client = new ControllerClient({ ...options, version: 2, token: options.leaseToken, runtimeRoot: path.dirname(options.socketPath), manifestPath: options.manifestPath ?? path.join(path.dirname(options.socketPath), "manifest.json"), capabilityPath: options.capabilityPath ?? path.join(path.dirname(options.socketPath), "capability.json"), sourceDigest: options.sourceDigest ?? "0".repeat(64), generation: options.generation ?? 1 }); await client.ready; return { client, status: await client.status() }; }
  async request(method, params) { await this.ready; const id = ++this.sequence; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, events: [] }); this.socket.write(encodeFrame(makeRequest(id, method, this.descriptor.token, params))); }); }
  async status() { return (await this.request("status", { policyGeneration: this.policyGeneration })).result; }
  async access(filePath, mode = 0) { return (await this.request("fs.access", { path: filePath, mode, policyGeneration: this.policyGeneration })).result; }
  async mkdir(filePath, options = {}) { return (await this.request("fs.mkdir", { path: filePath, recursive: Boolean(options.recursive), mode: options.mode ?? 0o755, policyGeneration: this.policyGeneration })).result; }
  async listDir(filePath) { return (await this.request("fs.listDir", { path: filePath, policyGeneration: this.policyGeneration })).result; }
  async stat(filePath) { return (await this.request("fs.stat", { path: filePath, policyGeneration: this.policyGeneration })).result; }
  async rename(oldPath, newPath) { return (await this.request("fs.rename", { oldPath, newPath, policyGeneration: this.policyGeneration })).result; }
  async deleteFile(filePath, options = {}) { return (await this.request("fs.deleteFile", { path: filePath, force: Boolean(options.force), recursive: Boolean(options.recursive), policyGeneration: this.policyGeneration })).result; }
  async heartbeat() { return (await this.request("lease.heartbeat", {})).result; }
  async readFile(filePath, options = {}) { const result = (await this.request("fs.readFile", { path: filePath, offset: options.offset ?? 0, limit: options.limit ?? 524288, policyGeneration: this.policyGeneration })).result; return { data: Buffer.from(result.data, "base64"), truncated: result.truncated }; }
  async writeFile(filePath, data) { return (await this.request("fs.writeFile", { path: filePath, data: Buffer.from(data).toString("base64"), policyGeneration: this.policyGeneration })).result; }
  async exec(argv, options) { await this.ready; if (options.signal?.aborted) throw Object.assign(new Error("operation cancelled"), { code: "cancelled" }); const requestId = this.sequence + 1; const abort = () => { void this.request("cancel", { requestId }).catch(() => {}); }; options.signal?.addEventListener("abort", abort, { once: true }); try { const answer = await this.request("exec", { argv, cwd: options.cwd, env: options.env ?? {}, timeoutMs: options.timeoutMs ?? 3600000, maxOutputBytes: options.maxOutputBytes ?? 16777216, policyGeneration: this.policyGeneration }); for (const [stream, data] of answer.events) options.onEvent?.(stream, data); return answer.result; } finally { options.signal?.removeEventListener("abort", abort); } }
  async release() { try { await this.request("lease.release", {}); } finally { this.destroy(); } }
  destroy() { this.socket.destroy(); }
}
async function waitForClient(descriptor) { let last; for (let attempt = 0; attempt < 50; attempt += 1) { try { const client = new ControllerClient(descriptor); await client.ready; return client; } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 20)); } } throw last ?? new Error("controller did not become ready"); }
export async function acquireControllerLease({ startup, clientId }) { const client = await waitForClient(startup); const acquired = (await client.request("lease.acquire", { workspaceKey: startup.workspaceKey, clientId })).result; client.descriptor.token = acquired.leaseToken; const status = await client.status(); client.policyGeneration = status.policyGeneration; return { client, status, leaseToken: acquired.leaseToken, scope: { workspaceKey: startup.workspaceKey, canonicalWorkspaceRoot: startup.workspaceRoot }, manifest: { socketPath: startup.socketPath, manifestPath: startup.manifestPath } }; }
export function stopStartedController(startup) { try { const manifest = readPrivateJson(startup.manifestPath); if (validateManifest(manifest, startup)) process.kill(manifest.pid, "SIGTERM"); } catch {} }
