import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverRepositoryScope } from "./repository-scope.mjs";
import { atomicJson, processMatches, processStartIdentity, readPrivateJson, sourceDigest, validateDescriptor, validateManifest } from "./capability.mjs";
import { encodeFrame, FrameDecoder, makeRequest, validateResponse } from "./protocol.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const controller = path.join(HERE, "controller.mjs");
const sourceFiles = [controller, path.join(HERE, "capability.mjs"), path.join(HERE, "protocol.mjs"), path.join(HERE, "operation-helper.mjs"), path.join(HERE, "host-configuration.mjs"), path.join(HERE, "srt-policy.mjs"), path.join(HERE, "docker-sidecar.mjs"), path.join(HERE, "docker-client-env.mjs"), path.join(HERE, "srt-compatibility-canary.mjs")];
// Darwin limits AF_UNIX paths to 104 bytes; do not put controller sockets in
// the otherwise conventional, but too long, ~/Library/Caches hierarchy.
const privateRoot = (key) => path.join("/tmp", `pi-srt-${process.getuid()}`, "c", key);
const CONTROL_TIMEOUT_MS = 10_000;
const FILESYSTEM_TIMEOUT_MS = 65_000;
const TRANSPORT_GRACE_MS = 5_000;
const brokerRootFor = (key) => path.join("/tmp", `pi-srt-${process.getuid()}`, "b", key);
function privateDirectory(directory) { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700); return directory; }
function stateIsUsable(descriptor) {
  try { const manifest = readPrivateJson(descriptor.manifestPath); const capability = validateDescriptor(readPrivateJson(descriptor.capabilityPath)); const socket = fs.lstatSync(descriptor.socketPath); return validateManifest(manifest, capability) && capability.sourceDigest === descriptor.sourceDigest && capability.workspaceKey === descriptor.workspaceKey && capability.workspaceRoot === descriptor.workspaceRoot && socket.isSocket() && (socket.mode & 0o077) === 0 ? capability : null; } catch { return null; }
}
function removeStale(descriptor) { for (const file of [descriptor.socketPath, descriptor.manifestPath, descriptor.capabilityPath]) fs.rmSync(file, { force: true }); }
function controllerProcesses(output) {
  const matches = [];
  for (const line of String(output).split("\n")) {
    const found = line.match(/^\s*(\d+)\s+.*?\s(\/[^\s]+\/controller\.mjs)\s+([A-Za-z0-9+/=]+)\s*$/);
    if (!found) continue;
    try { if (fs.realpathSync.native(found[2]) !== fs.realpathSync.native(controller)) continue; } catch { continue; }
    try { matches.push({ pid: Number(found[1]), descriptor: validateDescriptor(JSON.parse(Buffer.from(found[3], "base64").toString("utf8"))) }); } catch {}
  }
  return matches;
}
function removeOrphanControllers(workspaceKey, keepPid = null) {
  let output = ""; try { output = execFileSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }); } catch { return; }
  const stopped = [];
  for (const item of controllerProcesses(output)) {
    if (item.descriptor.workspaceKey !== workspaceKey || item.pid === keepPid) continue;
    const identity = processStartIdentity(item.pid);
    if (!identity || !processMatches(item.pid, identity)) continue;
    try { process.kill(item.pid, "SIGTERM"); stopped.push({ pid: item.pid, identity }); } catch {}
  }
  for (let attempt = 0; attempt < 50 && stopped.some((item) => processMatches(item.pid, item.identity)); attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (stopped.some((item) => processMatches(item.pid, item.identity))) throw new Error("orphaned controller did not stop");
  return stopped.length;
}
function descriptorFor(launchDir) {
  const scope = discoverRepositoryScope({ launchDirectory: launchDir, pathValue: process.env.PATH });
  const runtimeRoot = privateDirectory(privateRoot(scope.workspaceKey)); const brokerRoot = privateDirectory(brokerRootFor(scope.workspaceKey));
  const base = { version: 2, workspaceKey: scope.workspaceKey, workspaceRoot: fs.realpathSync(scope.canonicalWorkspaceRoot), bareCommonDirectory: scope.bareCommonDirectory ? fs.realpathSync(scope.bareCommonDirectory) : null, runtimeRoot, brokerRoot, socketPath: path.join(runtimeRoot, "controller.sock"), dockerSocket: path.join(brokerRoot, "docker.sock"), manifestPath: path.join(runtimeRoot, "manifest.json"), capabilityPath: path.join(runtimeRoot, "capability.json"), sourceDigest: sourceDigest(sourceFiles), generation: 1 };
  const existing = stateIsUsable(base);
  if (existing) {
    let pid = null; try { pid = readPrivateJson(base.manifestPath).pid; } catch {}
    if (removeOrphanControllers(base.workspaceKey, pid) === 0) return existing;
  }
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
  removeOrphanControllers(base.workspaceKey);
  removeStale(base); return { ...base, token: randomBytes(32).toString("hex") };
}
function start(descriptor) { if (stateIsUsable(descriptor)) return; const child = spawn(process.execPath, [controller, Buffer.from(JSON.stringify(descriptor)).toString("base64")], { detached: true, stdio: "ignore", cwd: descriptor.workspaceRoot, env: process.env }); child.unref(); }
function waitForPublishedState(descriptor) {
  let ready;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    ready = stateIsUsable(descriptor); if (ready) return ready;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error("controller did not publish ready state");
}
function withStartupLock(workspaceKey, operation) {
  const runtimeRoot = privateDirectory(privateRoot(workspaceKey)); const lock = path.join(runtimeRoot, "startup.lock");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try { return operation(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new Error("timed out waiting for controller startup lock");
}
export function beginControllerStartup({ launchDirectory }) {
  const scope = discoverRepositoryScope({ launchDirectory, pathValue: process.env.PATH });
  return withStartupLock(scope.workspaceKey, () => { const descriptor = descriptorFor(launchDirectory); start(descriptor); return waitForPublishedState(descriptor); });
}
export class ControllerClient {
  constructor(descriptor) {
    this.descriptor = validateDescriptor({ ...descriptor });
    this.policyGeneration = descriptor.policyGeneration;
    this.sequence = 0;
    this.pending = new Map();
    this.renewalAuthority = null;
    this.renewal = null;
    this.leaseEpoch = 0;
    this.terminalError = null;
    this.terminalListeners = new Set();
    this.readySettled = false;
    this.socket = net.createConnection(descriptor.socketPath);
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.socket.once("connect", () => {
      if (this.terminalError) return;
      this.readySettled = true;
      this.resolveReady();
    });
    this.socket.on("error", () => this.terminate("socket error"));
    this.socket.on("close", () => this.terminate("peer closed"));
    const decoder = new FrameDecoder((frame) => {
      const response = validateResponse(frame);
      const item = this.pending.get(response.id);
      if (!item) return;
      if (response.type === "event") {
        item.events.push([response.event, Buffer.from(response.data, "base64")]);
        return;
      }
      this.settle(response.id, response.ok, response.ok
        ? { result: response.result, events: item.events }
        : Object.assign(new Error(response.error.message), { code: response.error.code }));
    });
    this.socket.on("data", (data) => {
      try { decoder.push(data); } catch { this.terminate("protocol failure"); }
    });
  }
  transportError(reason) {
    return Object.assign(new Error(`controller transport unavailable: ${reason}`), { code: "controller_transport" });
  }
  settle(id, ok, value) {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    clearTimeout(item.timer);
    ok ? item.resolve(value) : item.reject(value);
  }
  terminate(reason) {
    if (this.terminalError) return this.terminalError;
    const error = this.transportError(reason);
    this.terminalError = error;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const id of [...this.pending.keys()]) this.settle(id, false, error);
    try { this.socket.destroy(); } catch {}
    for (const listener of this.terminalListeners) {
      try { listener(error); } catch {}
    }
    this.terminalListeners.clear();
    return error;
  }
  onTerminal(listener) {
    if (this.terminalError) listener(this.terminalError);
    else this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }
  deadlineFor(method, params) {
    if (method === "exec") return (params.timeoutMs ?? 3_600_000) + TRANSPORT_GRACE_MS;
    if (method.startsWith("fs.")) return FILESYSTEM_TIMEOUT_MS;
    return CONTROL_TIMEOUT_MS;
  }
  configureLeaseRenewal(startup) {
    const authority = validateDescriptor({ ...startup });
    if (
      authority.workspaceKey !== this.descriptor.workspaceKey ||
      authority.workspaceRoot !== this.descriptor.workspaceRoot ||
      authority.socketPath !== this.descriptor.socketPath
    ) {
      throw new Error("renewal startup descriptor does not match the inherited lease");
    }
    this.renewalAuthority = {
      token: authority.token,
      workspaceKey: authority.workspaceKey,
      leaseToken: this.descriptor.token,
    };
  }
  static async connectInherited(options) {
    const client = new ControllerClient({
      ...options,
      version: 2,
      token: options.leaseToken,
      runtimeRoot: path.dirname(options.socketPath),
      manifestPath: options.manifestPath ?? path.join(path.dirname(options.socketPath), "manifest.json"),
      capabilityPath: options.capabilityPath ?? path.join(path.dirname(options.socketPath), "capability.json"),
      sourceDigest: options.sourceDigest ?? "0".repeat(64),
      generation: options.generation ?? 1,
    });
    try {
      if (options.adoptLease && options.renewalStartup) client.configureLeaseRenewal(options.renewalStartup);
      await client.ready;
      return { client, status: await client.status() };
    } catch (error) {
      client.destroy();
      throw error;
    }
  }
  async requestOnce(method, params, auth = this.descriptor.token) {
    await this.ready;
    if (this.terminalError) throw this.terminalError;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.terminate(`response timeout for ${method}`), this.deadlineFor(method, params));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, events: [], timer });
      let frame;
      try { frame = encodeFrame(makeRequest(id, method, auth, params)); } catch (error) {
        this.settle(id, false, error);
        return;
      }
      try {
        this.socket.write(frame, (error) => {
          if (error) this.terminate("socket write failure");
        });
      } catch {
        this.terminate("socket write failure");
      }
    });
  }
  async renewLease(observedEpoch) {
    if (this.leaseEpoch !== observedEpoch) return;
    if (!this.renewal) {
      const authority = this.renewalAuthority;
      this.renewal = (async () => {
        const response = await this.requestOnce("lease.renew", {
          workspaceKey: authority.workspaceKey,
          leaseToken: authority.leaseToken,
        }, authority.token);
        if (response.result?.leaseToken !== authority.leaseToken) {
          throw Object.assign(new Error("controller returned an invalid lease renewal"), { code: "invalid_response" });
        }
        this.leaseEpoch += 1;
      })();
    }
    try {
      await this.renewal;
    } finally {
      if (this.renewal) this.renewal = null;
    }
  }
  async request(method, params) {
    const leaseEpoch = this.leaseEpoch;
    try {
      return await this.requestOnce(method, params);
    } catch (error) {
      if (
        method === "lease.release" ||
        !this.renewalAuthority ||
        !["lease_expired", "invalid_lease"].includes(error?.code)
      ) {
        throw error;
      }
      await this.renewLease(leaseEpoch);
      return this.requestOnce(method, params);
    }
  }
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
  async resetDocker() { return (await this.request("docker.reset", { policyGeneration: this.policyGeneration })).result; }
  async release() { try { await this.request("lease.release", {}); } finally { this.destroy(); } }
  destroy() { this.terminate("client destroyed"); }
}
async function waitForClient(descriptor) { let last; for (let attempt = 0; attempt < 50; attempt += 1) { try { const client = new ControllerClient(descriptor); await client.ready; return client; } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 20)); } } throw last ?? new Error("controller did not become ready"); }
export async function acquireControllerLease({ startup, clientId }) {
  const client = await waitForClient(startup);
  const acquired = (await client.request("lease.acquire", { workspaceKey: startup.workspaceKey, clientId })).result;
  client.descriptor.token = acquired.leaseToken;
  client.configureLeaseRenewal(startup);
  const status = await client.status();
  client.policyGeneration = status.policyGeneration;
  return {
    client,
    status,
    leaseToken: acquired.leaseToken,
    scope: { workspaceKey: startup.workspaceKey, canonicalWorkspaceRoot: startup.workspaceRoot },
    manifest: { socketPath: startup.socketPath, manifestPath: startup.manifestPath },
  };
}
export function stopStartedController(startup) { try { const manifest = readPrivateJson(startup.manifestPath); if (validateManifest(manifest, startup)) process.kill(manifest.pid, "SIGTERM"); } catch {} }

export const clientInternals = Object.freeze({ controllerProcesses });
