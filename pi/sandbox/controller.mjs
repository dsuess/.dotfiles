#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MemoryProvider, ReadonlyProvider, VM } from "@earendil-works/gondolin";

import { ensureGondolinImage, verifyImageDirectory } from "./build-gondolin-image.mjs";
import { IngressManager } from "./ingress.mjs";
import {
  buildSandboxPolicy,
  createNetworkOptions,
  createPolicyProviders,
  loadSandboxPolicy,
  parseSandboxSettingsText,
  SETTINGS_PATH,
} from "./policy.mjs";
import {
  encodeFrame,
  FrameDecoder,
  makeErrorResponse,
  makeResponse,
  makeStreamEvent,
  PROTOCOL_VERSION,
  validateRequest,
} from "./protocol.mjs";
import { discoverRepositoryScope } from "./repository-scope.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_STARTUP_IDLE_MS = 30_000;
const DEFAULT_CANCEL_GRACE_MS = 500;
const STREAM_CHUNK_BYTES = 48 * 1024;
const DEFAULT_ROOTFS_SIZE = "64G";

function getRootfsSize(environment = process.env) {
  return environment.PI_GONDOLIN_ROOTFS_SIZE || DEFAULT_ROOTFS_SIZE;
}

export const GUEST_ENVIRONMENT = Object.freeze({
  HOME: "/root",
  PATH: "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  XDG_CACHE_HOME: "/root/.cache",
  NPM_CONFIG_CACHE: "/root/.npm",
  PIP_CACHE_DIR: "/root/.cache/pip",
  UV_CACHE_DIR: "/root/.cache/uv",
  HF_HOME: "/root/.cache/huggingface",
  CARGO_HOME: "/root/.cargo",
});

function controllerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function traceStartup(phase) {
  const filePath = process.env.PI_GONDOLIN_STARTUP_TRACE_FILE;
  if (!filePath || !path.isAbsolute(filePath) || /[\t\r\n\0]/.test(filePath)) return;
  try {
    fs.appendFileSync(filePath, `${JSON.stringify({ phase, at: Date.now() })}\n`, { mode: 0o600 });
  } catch {
    // Optional benchmark tracing must never affect controller readiness.
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function serializeStat(stat) {
  return {
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
  };
}

function splitChunk(data) {
  const buffer = Buffer.from(data);
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += STREAM_CHUNK_BYTES) {
    chunks.push(buffer.subarray(offset, offset + STREAM_CHUNK_BYTES));
  }
  return chunks;
}

export async function synchronizeVmClock(vm) {
  let result;
  try {
    result = await vm.exec(["/bin/sh", "-lc", "exec hwclock --hctosys --utc"], {
      cwd: "/",
      env: {},
    });
  } catch (error) {
    throw controllerError(
      "clock_sync_failed",
      `guest RTC synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!result?.ok || result.exitCode !== 0) {
    throw controllerError(
      "clock_sync_failed",
      `guest RTC synchronization failed: ${result?.stderr || result?.stdout || "hwclock exited unsuccessfully"}`,
    );
  }
}

async function defaultVmFactory({ policy, imageDir }) {
  const network = createNetworkOptions(policy.network);
  return VM.create({
    sandbox: {
      imagePath: imageDir,
      netEnabled: network.netEnabled,
    },
    rootfs: { mode: "memory", size: getRootfsSize() },
    memory: process.env.PI_GONDOLIN_MEMORY ?? "3G",
    cpus: Number(process.env.PI_GONDOLIN_CPUS ?? 4),
    vfs: {
      mounts: {
        ...createPolicyProviders(policy),
        // Suppress Gondolin's generated CA while retaining its /etc/gondolin
        // control mount for ingress configuration.
        "/etc/gondolin/mitm": new ReadonlyProvider(new MemoryProvider()),
      },
    },
    env: GUEST_ENVIRONMENT,
    ...(network.httpHooks ? { httpHooks: network.httpHooks } : {}),
    ...(network.dns ? { dns: network.dns } : {}),
    ...(network.tcp ? { tcp: network.tcp } : {}),
    ...(network.publicTcp ? { publicTcp: network.publicTcp } : {}),
    allowWebSockets: network.allowWebSockets,
    sessionLabel: `pi:${policy.scope.workspaceKey.slice(0, 12)}`,
  });
}

export class WorkspaceController {
  constructor(options) {
    this.policy = options.policy;
    this.policyLoader = options.policyLoader;
    this.imageDir = options.imageDir;
    this.vmFactory = options.vmFactory ?? defaultVmFactory;
    this.dockerHealthCheck = options.dockerHealthCheck ?? true;
    this.clockSynchronizer = options.clockSynchronizer ?? synchronizeVmClock;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.onIdle = options.onIdle ?? (() => {});
    this.onStateChange = options.onStateChange ?? (() => {});
    this.vm = null;
    this.ingress = new IngressManager(this.policy.ingress);
    this.health = "starting";
    this.dockerHealthy = false;
    this.failure = null;
    this.pendingRestart = false;
    this.execTail = Promise.resolve();
    this.execRecords = new Map();
    this.activeExec = null;
    this.transitionTail = Promise.resolve();
    this.restartBarrier = null;
    this.leases = new Map();
    this.hadLease = false;
    this.idleNotified = false;
    this.closed = false;
    this.expiryTimer = setInterval(() => this.expireLeases(), Math.max(50, Math.floor(this.leaseTtlMs / 3)));
    this.expiryTimer.unref?.();
  }

  async transition(operation) {
    const task = this.transitionTail.catch(() => {}).then(operation);
    this.transitionTail = task;
    return task;
  }

  async start() {
    if (this.closed) throw controllerError("controller_closed", "controller is closed");
    if (this.vm) return;
    await this.transition(() => this.startVm());
  }

  async startVm() {
    if (this.vm) return;
    this.health = this.pendingRestart ? "restarting" : "starting";
    this.failure = null;
    let vm = null;
    let ingress = null;
    try {
      traceStartup("vm_create_start");
      vm = await this.vmFactory({ policy: this.policy, imageDir: this.imageDir });
      traceStartup("vm_create_complete");
      traceStartup("vm_start_start");
      await vm.start();
      traceStartup("vm_start_complete");
      ingress = new IngressManager(this.policy.ingress);
      await ingress.start(vm);
      await this.clockSynchronizer(vm);
      if (this.dockerHealthCheck) {
        traceStartup("docker_health_start");
        const health = await vm.exec([
          "/usr/bin/docker",
          "info",
          "--format",
          "{{.Driver}}|{{.DockerRootDir}}",
        ]);
        if (!health.ok || !/^vfs\|\/var\/lib\/docker/m.test(health.stdout)) {
          throw new Error(`guest Docker health check failed: ${health.stderr || health.stdout}`);
        }
        const bridge = await vm.exec([
          "/usr/bin/docker",
          "network",
          "inspect",
          "--format",
          "{{.Driver}}|{{.Name}}",
          "bridge",
        ]);
        if (!bridge.ok || bridge.stdout.trim() !== "bridge|bridge") {
          throw new Error(`guest Docker bridge readiness check failed: ${bridge.stderr || bridge.stdout}`);
        }
        traceStartup("docker_health_complete");
      }
      this.vm = vm;
      this.ingress = ingress;
      this.dockerHealthy = true;
      this.health = "healthy";
      this.onStateChange(this.status());
    } catch (error) {
      this.health = "failed";
      this.dockerHealthy = false;
      this.failure = error instanceof Error ? error.message : String(error);
      this.onStateChange(this.status());
      await ingress?.close().catch(() => {});
      await vm?.close().catch(() => {});
      throw error;
    }
  }

  async stopVm() {
    const vm = this.vm;
    const ingress = this.ingress;
    this.vm = null;
    this.ingress = new IngressManager(this.policy.ingress);
    this.dockerHealthy = false;
    await ingress?.close();
    if (vm) await vm.close();
  }

  async restartVm(nextPolicy = this.policy) {
    this.health = "restarting";
    this.pendingRestart = true;
    await this.stopVm();
    this.policy = nextPolicy;
    try {
      await this.startVm();
    } finally {
      this.pendingRestart = false;
      this.onStateChange(this.status());
    }
  }

  async ensureReady(policyGeneration) {
    if (this.closed) throw controllerError("controller_closed", "controller is closed");
    if (this.restartBarrier) await this.restartBarrier;
    await this.transitionTail.catch(() => {});
    if (!this.vm) await this.start();
    if (policyGeneration !== this.policy.policyGeneration) {
      throw controllerError(
        "policy_generation_mismatch",
        `policy generation mismatch: controller=${this.policy.policyGeneration}`,
      );
    }
    if (this.health !== "healthy") {
      throw controllerError("controller_unhealthy", this.failure ?? `controller is ${this.health}`);
    }
  }

  acquireLease(workspaceKey, clientId) {
    if (workspaceKey !== this.policy.scope.workspaceKey) {
      throw controllerError("workspace_mismatch", "controller workspace does not match");
    }
    const token = randomBytes(32).toString("hex");
    this.hadLease = true;
    this.idleNotified = false;
    this.leases.set(token, { clientId, lastHeartbeat: Date.now() });
    return token;
  }

  authenticateLease(token) {
    const lease = this.leases.get(token);
    if (!lease) throw controllerError("unauthorized", "lease is missing or expired");
    return lease;
  }

  heartbeatLease(token) {
    const lease = this.authenticateLease(token);
    lease.lastHeartbeat = Date.now();
    return this.status();
  }

  releaseLease(token) {
    this.authenticateLease(token);
    this.leases.delete(token);
    this.notifyIdleIfNeeded();
  }

  expireLeases(now = Date.now()) {
    for (const [token, lease] of this.leases) {
      if (now - lease.lastHeartbeat > this.leaseTtlMs) this.leases.delete(token);
    }
    this.notifyIdleIfNeeded();
  }

  notifyIdleIfNeeded() {
    if (!this.hadLease || this.leases.size !== 0 || this.idleNotified) return;
    this.idleNotified = true;
    queueMicrotask(() => this.onIdle());
  }

  status() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      health: this.health,
      failure: this.failure,
      dockerHealthy: this.dockerHealthy,
      vmId: this.vm?.id ?? null,
      workspaceKey: this.policy.scope.workspaceKey,
      workspaceRoot: this.policy.scope.canonicalWorkspaceRoot,
      bareCommonDirectory: this.policy.scope.bareCommonDirectory,
      policyGeneration: this.policy.policyGeneration,
      imageGeneration: this.policy.imageGeneration,
      pendingRestart: this.pendingRestart,
      attachedRoots: this.leases.size,
      activeExecution: this.activeExec?.id ?? null,
      queuedExecutions: [...this.execRecords.values()].filter((record) => !record.active).length,
      mounts: this.policy.mounts.map((mount) => ({
        kind: mount.kind,
        guestPath: mount.guestPath,
        access: mount.access,
      })),
      network: this.policy.network,
      ingress: this.ingress.status(),
    };
  }

  async withFilesystem(policyGeneration, operation) {
    await this.ensureReady(policyGeneration);
    return operation(this.vm.fs);
  }

  fsAccess(params) {
    return this.withFilesystem(params.policyGeneration, (guestFs) =>
      guestFs.access(params.path, { mode: params.mode }),
    ).then(() => ({}));
  }

  fsMkdir(params) {
    return this.withFilesystem(params.policyGeneration, (guestFs) =>
      guestFs.mkdir(params.path, { recursive: params.recursive, mode: params.mode }),
    ).then(() => ({}));
  }

  fsListDir(params) {
    return this.withFilesystem(params.policyGeneration, (guestFs) => guestFs.listDir(params.path));
  }

  fsStat(params) {
    return this.withFilesystem(params.policyGeneration, async (guestFs) =>
      serializeStat(await guestFs.stat(params.path)),
    );
  }

  fsRename(params) {
    return this.withFilesystem(params.policyGeneration, (guestFs) =>
      guestFs.rename(params.oldPath, params.newPath),
    ).then(() => ({}));
  }

  fsWriteFile(params) {
    return this.withFilesystem(params.policyGeneration, (guestFs) =>
      guestFs.writeFile(params.path, Buffer.from(params.data, "base64")),
    ).then(() => ({}));
  }

  fsDeleteFile(params) {
    return this.withFilesystem(params.policyGeneration, (guestFs) =>
      guestFs.deleteFile(params.path, { force: params.force, recursive: params.recursive }),
    ).then(() => ({}));
  }

  async fsReadFile(params) {
    return this.withFilesystem(params.policyGeneration, async (guestFs) => {
      const stream = await guestFs.readFileStream(params.path);
      const chunks = [];
      let skipped = 0;
      let collected = 0;
      let truncated = false;
      try {
        for await (const raw of stream) {
          let chunk = Buffer.from(raw);
          if (skipped < params.offset) {
            const drop = Math.min(chunk.length, params.offset - skipped);
            skipped += drop;
            chunk = chunk.subarray(drop);
          }
          if (chunk.length === 0) continue;
          const remaining = params.limit - collected;
          if (chunk.length > remaining) {
            chunks.push(chunk.subarray(0, remaining));
            collected += remaining;
            truncated = true;
            break;
          }
          chunks.push(chunk);
          collected += chunk.length;
          if (collected === params.limit) {
            truncated = true;
            break;
          }
        }
      } finally {
        stream.destroy();
      }
      return { data: Buffer.concat(chunks).toString("base64"), truncated };
    });
  }

  execute(id, params, onEvent = async () => {}) {
    const record = {
      id,
      params,
      onEvent,
      active: false,
      cancelled: false,
      cancelReason: null,
      abortController: new AbortController(),
      hostDone: deferred(),
      restartPromise: null,
    };
    if (this.execRecords.has(id)) {
      throw controllerError("duplicate_request", `execution already exists: ${id}`);
    }
    this.execRecords.set(id, record);
    const task = this.execTail.catch(() => {}).then(() => this.runExecution(record));
    this.execTail = task.catch(() => {});
    return task.finally(() => this.execRecords.delete(id));
  }

  triggerCancellation(record, reason) {
    if (record.cancelled) return record.restartPromise ?? Promise.resolve();
    record.cancelled = true;
    record.cancelReason = reason;
    if (!record.active) return Promise.resolve();

    record.abortController.abort();
    record.restartPromise = (async () => {
      await Promise.race([record.hostDone.promise.catch(() => {}), sleep(this.cancelGraceMs)]);
      await this.transition(() => this.restartVm(this.policy));
    })();
    return record.restartPromise;
  }

  async cancel(id, reason = "cancelled") {
    const record = this.execRecords.get(id);
    if (!record) return { cancelled: false };
    await this.triggerCancellation(record, reason);
    return { cancelled: true, restarted: record.active };
  }

  async runExecution(record) {
    await this.ensureReady(record.params.policyGeneration);
    if (record.cancelled) {
      throw controllerError("cancelled", record.cancelReason ?? "execution cancelled before start");
    }
    // A request is active while its fail-closed clock preflight runs so a
    // cancellation still replaces the VM exactly as it did before this check.
    record.active = true;
    this.activeExec = record;
    let outputBytes = 0;
    const timer = setTimeout(
      () => void this.triggerCancellation(record, "execution timed out"),
      record.params.timeoutMs,
    );
    timer.unref?.();

    let processHandle = null;
    try {
      await this.clockSynchronizer(this.vm);
      if (record.cancelled) {
        throw controllerError("cancelled", record.cancelReason ?? "execution cancelled before start");
      }
      processHandle = this.vm.exec(record.params.argv, {
        cwd: record.params.cwd,
        env: record.params.env,
        signal: record.abortController.signal,
        stdout: "pipe",
        stderr: "pipe",
      });
      for await (const chunk of processHandle.output()) {
        outputBytes += chunk.data.length;
        if (outputBytes > record.params.maxOutputBytes) {
          void this.triggerCancellation(record, "execution output exceeded the limit");
          throw controllerError("output_limit", "execution output exceeded the limit");
        }
        for (const part of splitChunk(chunk.data)) {
          try {
            await record.onEvent(chunk.stream, part);
          } catch (error) {
            void this.triggerCancellation(record, "client output stream failed");
            throw error;
          }
        }
      }
      const result = await processHandle;
      if (record.cancelled) {
        record.hostDone.resolve();
        await record.restartPromise;
        throw controllerError("cancelled", record.cancelReason ?? "execution cancelled");
      }
      return {
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        outputBytes,
        vmId: this.vm.id,
      };
    } catch (error) {
      if (processHandle) await Promise.resolve(processHandle).catch(() => {});
      record.hostDone.resolve();
      if (record.cancelled) {
        await record.restartPromise;
        throw controllerError("cancelled", record.cancelReason ?? "execution cancelled");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      record.hostDone.resolve();
      record.active = false;
      if (this.activeExec === record) this.activeExec = null;
    }
  }

  async reload(expectedPolicyGeneration) {
    if (!this.policyLoader) throw controllerError("reload_unavailable", "policy reload is unavailable");
    const nextPolicy = await this.policyLoader();
    if (
      expectedPolicyGeneration !== undefined &&
      nextPolicy.policyGeneration !== expectedPolicyGeneration
    ) {
      throw controllerError("policy_generation_mismatch", "saved policy generation does not match");
    }
    if (nextPolicy.policyGeneration === this.policy.policyGeneration) return this.status();
    this.pendingRestart = true;
    this.health = "restarting";
    const drained = this.execTail.catch(() => {});
    const barrier = drained.then(() => this.transition(() => this.restartVm(nextPolicy)));
    this.restartBarrier = barrier;
    try {
      await barrier;
      return this.status();
    } finally {
      if (this.restartBarrier === barrier) this.restartBarrier = null;
    }
  }

  async resetDocker(policyGeneration) {
    if (policyGeneration !== this.policy.policyGeneration) {
      throw controllerError("policy_generation_mismatch", "cannot reset Docker for an unknown generation");
    }
    return this.restart(policyGeneration);
  }

  async restart(policyGeneration) {
    if (policyGeneration !== this.policy.policyGeneration) {
      throw controllerError("policy_generation_mismatch", "cannot restart an unknown generation");
    }
    this.pendingRestart = true;
    this.health = "restarting";
    const drained = this.execTail.catch(() => {});
    const barrier = drained.then(() => this.transition(() => this.restartVm(this.policy)));
    this.restartBarrier = barrier;
    try {
      await barrier;
      return this.status();
    } finally {
      if (this.restartBarrier === barrier) this.restartBarrier = null;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.expiryTimer);
    for (const record of this.execRecords.values()) {
      record.cancelled = true;
      record.abortController.abort();
    }
    await this.transition(() => this.stopVm()).catch(() => {});
    this.health = "stopped";
    this.leases.clear();
  }
}

export function getControllerRuntimeRoot(options = {}) {
  if (options.runtimeRoot) return path.resolve(options.runtimeRoot);
  if (process.env.PI_GONDOLIN_RUNTIME_DIR) return path.resolve(process.env.PI_GONDOLIN_RUNTIME_DIR);
  const uid = process.getuid?.() ?? "user";
  return path.join("/tmp", `pi-g-${uid}`);
}

export function getControllerPaths(workspaceKey, options = {}) {
  if (!/^[0-9a-f]{64}$/.test(workspaceKey)) throw new Error("invalid workspace key");
  let runtimeRoot = getControllerRuntimeRoot(options);
  const shortKey = workspaceKey.slice(0, 24);
  if (Buffer.byteLength(path.join(runtimeRoot, `${shortKey}.sock`)) > 100) {
    runtimeRoot = path.join("/tmp", `pi-g-${process.getuid?.() ?? "user"}`);
  }
  return Object.freeze({
    runtimeRoot,
    socketPath: path.join(runtimeRoot, `${shortKey}.sock`),
    manifestPath: path.join(runtimeRoot, `${shortKey}.json`),
    lockPath: path.join(runtimeRoot, `${shortKey}.lock`),
    logPath: path.join(runtimeRoot, `${shortKey}.log`),
  });
}

function ensureRuntimeRoot(runtimeRoot) {
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeRoot, 0o700);
  const stat = fs.statSync(runtimeRoot);
  if ((stat.mode & 0o077) !== 0) throw new Error("controller runtime directory is not private");
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, filePath);
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireControllerLock(lockPath, workspaceKey) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, workspaceKey })}\n`);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stale = true;
      try {
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        stale = lock.workspaceKey !== workspaceKey || !pidIsAlive(lock.pid);
      } catch {
        stale = true;
      }
      if (!stale) return false;
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  return false;
}

class ControllerSocketServer {
  constructor(options) {
    this.controller = options.controller;
    this.controllerToken = options.controllerToken;
    this.socketPath = options.socketPath;
    this.onManifestChange = options.onManifestChange ?? (() => {});
    this.onFinalLease = options.onFinalLease ?? (() => {});
    this.connections = new Set();
    this.server = net.createServer((socket) => this.accept(socket));
    this.nextConnectionId = 1;
  }

  async listen() {
    fs.rmSync(this.socketPath, { force: true });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    fs.chmodSync(this.socketPath, 0o600);
  }

  async send(socket, value) {
    if (socket.destroyed) return;
    const frame = encodeFrame(value);
    if (socket.write(frame)) return;
    await new Promise((resolve, reject) => {
      socket.once("drain", resolve);
      socket.once("error", reject);
      socket.once("close", resolve);
    });
  }

  accept(socket) {
    const connectionId = this.nextConnectionId++;
    const connection = { id: connectionId, socket, requests: new Set() };
    this.connections.add(connection);
    const decoder = new FrameDecoder((frame) => void this.handleFrame(connection, frame));
    socket.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.connections.delete(connection);
      for (const requestId of connection.requests) {
        void this.controller.cancel(`${connectionId}:${requestId}`, "client disconnected");
      }
    });
  }

  async handleFrame(connection, raw) {
    let request;
    try {
      request = validateRequest(raw);
      if (connection.requests.has(request.id)) {
        throw controllerError("duplicate_request", "duplicate request id on connection");
      }
      connection.requests.add(request.id);
      const result = await this.dispatch(connection, request);
      await this.send(connection.socket, makeResponse(request.id, result));
      if (request.method === "lease.release" && this.controller.leases.size === 0) {
        queueMicrotask(() => this.onFinalLease());
      }
    } catch (error) {
      const id = Number.isSafeInteger(raw?.id) && raw.id > 0 ? raw.id : 1;
      await this.send(connection.socket, makeErrorResponse(id, error)).catch(() => {});
    } finally {
      if (request) connection.requests.delete(request.id);
    }
  }

  authenticate(request) {
    if (request.method === "lease.acquire") {
      if (request.auth !== this.controllerToken) {
        throw controllerError("unauthorized", "controller startup token is invalid");
      }
      return;
    }
    this.controller.authenticateLease(request.auth);
  }

  async dispatch(connection, request) {
    this.authenticate(request);
    const params = request.params;
    switch (request.method) {
      case "lease.acquire": {
        const leaseToken = this.controller.acquireLease(params.workspaceKey, params.clientId);
        return { leaseToken, status: this.controller.status() };
      }
      case "lease.heartbeat":
        return this.controller.heartbeatLease(request.auth);
      case "lease.release":
        this.controller.releaseLease(request.auth);
        return { released: true };
      case "status":
        if (params.policyGeneration && params.policyGeneration !== this.controller.policy.policyGeneration) {
          throw controllerError("policy_generation_mismatch", "status generation mismatch");
        }
        return this.controller.status();
      case "fs.access": return this.controller.fsAccess(params);
      case "fs.mkdir": return this.controller.fsMkdir(params);
      case "fs.listDir": return this.controller.fsListDir(params);
      case "fs.stat": return this.controller.fsStat(params);
      case "fs.rename": return this.controller.fsRename(params);
      case "fs.readFile": return this.controller.fsReadFile(params);
      case "fs.writeFile": return this.controller.fsWriteFile(params);
      case "fs.deleteFile": return this.controller.fsDeleteFile(params);
      case "exec":
        return this.controller.execute(
          `${connection.id}:${request.id}`,
          params,
          (stream, data) => this.send(connection.socket, makeStreamEvent(request.id, stream, data)),
        );
      case "cancel":
        return this.controller.cancel(`${connection.id}:${params.requestId}`);
      case "reload": {
        const result = await this.controller.reload(params.expectedPolicyGeneration);
        this.onManifestChange();
        return result;
      }
      case "restart":
        return this.controller.restart(params.policyGeneration);
      case "docker.reset":
        return this.controller.resetDocker(params.policyGeneration);
      default:
        throw controllerError("unknown_method", "method is not implemented");
    }
  }

  async close() {
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    if (!this.server.listening) return;
    await new Promise((resolve) => this.server.close(resolve));
    fs.rmSync(this.socketPath, { force: true });
  }
}

function parseDaemonArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!new Set(["--launch-dir", "--settings", "--cache-root", "--runtime-root", "--image-dir"]).has(arg)) {
      throw new Error(`unknown controller option: ${arg}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`missing value for ${arg}`);
    result[arg.slice(2).replaceAll("-", "_")] = value;
  }
  if (!result.launch_dir) throw new Error("--launch-dir is required");
  return result;
}

export async function runControllerDaemon(options) {
  const scope = discoverRepositoryScope({
    launchDirectory: options.launchDirectory,
    pathValue: options.pathValue ?? process.env.PATH,
  });
  const paths = getControllerPaths(scope.workspaceKey, { runtimeRoot: options.runtimeRoot });
  ensureRuntimeRoot(paths.runtimeRoot);
  if (!acquireControllerLock(paths.lockPath, scope.workspaceKey)) return { alreadyRunning: true };

  let server = null;
  let controller = null;
  let idleTimer = null;
  const controllerToken = randomBytes(32).toString("hex");
  try {
    fs.rmSync(paths.socketPath, { force: true });
    fs.rmSync(paths.manifestPath, { force: true });
    traceStartup("image_verify_start");
    const image = options.imageDir
      ? verifyImageDirectory(path.resolve(options.imageDir))
      : await ensureGondolinImage({ verifyOnly: true, verbose: false });
    traceStartup("image_verify_complete");
    traceStartup("policy_create_start");
    const policyOptions = {
      scope,
      settingsPath: options.settingsPath ?? SETTINGS_PATH,
      cacheRoot: options.cacheRoot,
      runtimeRoot: paths.runtimeRoot,
      imageGeneration: image.spec.digest,
    };
    const policyLoader = () => loadSandboxPolicy(policyOptions);
    const initialPolicy = policyLoader();
    traceStartup("policy_create_complete");
    let closeRequested = false;
    const requestClose = () => {
      if (closeRequested) return;
      closeRequested = true;
      const timer = setTimeout(() => {
        if (controller?.leases.size === 0) void close();
        else closeRequested = false;
      }, 10);
      timer.unref?.();
    };
    controller = new WorkspaceController({
      policy: initialPolicy,
      policyLoader,
      imageDir: image.imageDir,
      leaseTtlMs: options.leaseTtlMs,
      cancelGraceMs: options.cancelGraceMs,
      onIdle: requestClose,
    });
    await controller.start();
    traceStartup("controller_healthy");

    const writeManifest = () => {
      const status = controller.status();
      writeJsonAtomic(paths.manifestPath, {
        version: 1,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        uid: process.getuid?.() ?? null,
        workspaceKey: scope.workspaceKey,
        workspaceRoot: scope.canonicalWorkspaceRoot,
        bareCommonDirectory: scope.bareCommonDirectory,
        socketPath: paths.socketPath,
        controllerToken,
        policyGeneration: status.policyGeneration,
        imageGeneration: status.imageGeneration,
        vmId: status.vmId,
        dockerHealthy: status.dockerHealthy,
      });
    };
    controller.onStateChange = writeManifest;
    server = new ControllerSocketServer({
      controller,
      controllerToken,
      socketPath: paths.socketPath,
      onManifestChange: writeManifest,
      onFinalLease: requestClose,
    });
    await server.listen();
    writeManifest();

    const close = async () => {
      clearTimeout(idleTimer);
      await server?.close().catch(() => {});
      await controller?.close().catch(() => {});
      fs.rmSync(paths.manifestPath, { force: true });
      fs.rmSync(paths.socketPath, { force: true });
      fs.rmSync(paths.lockPath, { force: true });
      fs.rmSync(paths.logPath, { force: true });
    };

    idleTimer = setTimeout(requestClose, options.startupIdleMs ?? DEFAULT_STARTUP_IDLE_MS);
    idleTimer.unref?.();
    const signalHandler = () => requestClose();
    process.once("SIGTERM", signalHandler);
    process.once("SIGINT", signalHandler);

    await new Promise((resolve) => server.server.once("close", resolve));
    await close();
    return { alreadyRunning: false };
  } catch (error) {
    clearTimeout(idleTimer);
    await server?.close().catch(() => {});
    await controller?.close().catch(() => {});
    fs.rmSync(paths.manifestPath, { force: true });
    fs.rmSync(paths.socketPath, { force: true });
    fs.rmSync(paths.lockPath, { force: true });
    throw error;
  }
}

async function main() {
  if (process.argv[2] !== "--serve") throw new Error("controller must be started with --serve");
  const args = parseDaemonArgs(process.argv.slice(3));
  await runControllerDaemon({
    launchDirectory: args.launch_dir,
    settingsPath: args.settings,
    cacheRoot: args.cache_root,
    runtimeRoot: args.runtime_root,
    imageDir: args.image_dir,
  });
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH)
) {
  main().catch((error) => {
    process.stderr.write(`pi-gondolin-controller: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const controllerInternals = Object.freeze({
  ControllerSocketServer,
  acquireControllerLock,
  getRootfsSize,
  ensureRuntimeRoot,
  pidIsAlive,
  writeJsonAtomic,
});
