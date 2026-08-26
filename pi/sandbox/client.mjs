import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeFrame,
  FrameDecoder,
  makeRequest,
  PROTOCOL_VERSION,
  validateRequest,
  validateResponse,
} from "./protocol.mjs";
import { discoverRepositoryScope } from "./repository-scope.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTROLLER_PATH = path.join(SCRIPT_DIR, "controller.mjs");
const DEFAULT_SETTINGS_PATH = path.join(SCRIPT_DIR, "settings.json");
const START_TIMEOUT_MS = 150_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const HOST_CODE_CACHE_ROOT = path.join(os.homedir(), ".cache", "pi-gondolin", "host");

export function configureRuntimeCaches(cacheRoot = HOST_CODE_CACHE_ROOT) {
  const uid = process.getuid?.() ?? null;
  for (const directory of [cacheRoot, path.join(cacheRoot, "node-compile"), path.join(cacheRoot, "jiti")]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const stat = fs.statSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) {
      throw clientError("invalid_cache", "host code cache directory is not private");
    }
  }
  process.env.NODE_COMPILE_CACHE = path.join(cacheRoot, "node-compile");
  process.env.JITI_FS_CACHE = path.join(cacheRoot, "jiti");
  return Object.freeze({
    root: cacheRoot,
    nodeCompile: process.env.NODE_COMPILE_CACHE,
    jiti: process.env.JITI_FS_CACHE,
  });
}

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError() {
  return clientError("aborted", "controller startup was cancelled");
}

function sleep(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => { clearTimeout(timer); done(abortError()); };
    function done(error) {
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertHex(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw clientError("invalid_manifest", `${label} is invalid`);
  }
  return value;
}

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw clientError("invalid_manifest", `${label} is invalid`);
  }
  return value;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function validateRepositoryScope(scope, launchDirectory) {
  const keys = ["physicalLaunchDirectory", "canonicalWorkspaceRoot", "bareCommonDirectory", "workspaceKey"];
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).length !== keys.length || !keys.every((key) => Object.hasOwn(scope, key))) {
    throw clientError("invalid_scope", "repository scope has an invalid shape");
  }
  for (const key of ["physicalLaunchDirectory", "canonicalWorkspaceRoot"]) {
    if (typeof scope[key] !== "string" || scope[key].length > 4096 || !path.isAbsolute(scope[key]) || /[\t\r\n\0]/.test(scope[key])) {
      throw clientError("invalid_scope", `repository scope ${key} is invalid`);
    }
  }
  if (scope.bareCommonDirectory !== null &&
      (typeof scope.bareCommonDirectory !== "string" || scope.bareCommonDirectory.length > 4096 ||
       !path.isAbsolute(scope.bareCommonDirectory) || /[\t\r\n\0]/.test(scope.bareCommonDirectory))) {
    throw clientError("invalid_scope", "repository scope bare common directory is invalid");
  }
  const physicalLaunchDirectory = fs.realpathSync(scope.physicalLaunchDirectory);
  const canonicalWorkspaceRoot = fs.realpathSync(scope.canonicalWorkspaceRoot);
  if (!fs.statSync(physicalLaunchDirectory).isDirectory() || !fs.statSync(canonicalWorkspaceRoot).isDirectory() ||
      !isWithin(physicalLaunchDirectory, canonicalWorkspaceRoot)) {
    throw clientError("invalid_scope", "repository scope paths are not contained directories");
  }
  if (launchDirectory && physicalLaunchDirectory !== fs.realpathSync(launchDirectory)) {
    throw clientError("invalid_scope", "repository scope launch directory does not match");
  }
  const bareCommonDirectory = scope.bareCommonDirectory === null ? null : fs.realpathSync(scope.bareCommonDirectory);
  if (bareCommonDirectory !== null && !fs.statSync(bareCommonDirectory).isDirectory()) {
    throw clientError("invalid_scope", "repository scope bare common directory is not a directory");
  }
  const workspaceKey = createHash("sha256")
    .update(JSON.stringify([canonicalWorkspaceRoot, bareCommonDirectory]))
    .digest("hex");
  if (scope.workspaceKey !== workspaceKey) throw clientError("invalid_scope", "repository scope key does not match paths");
  return Object.freeze({ physicalLaunchDirectory, canonicalWorkspaceRoot, bareCommonDirectory, workspaceKey });
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

export function getClientRuntimeRoot(options = {}) {
  if (options.runtimeRoot) return path.resolve(options.runtimeRoot);
  if (process.env.PI_GONDOLIN_RUNTIME_DIR) return path.resolve(process.env.PI_GONDOLIN_RUNTIME_DIR);
  return path.join("/tmp", `pi-g-${process.getuid?.() ?? "user"}`);
}

export function getClientControllerPaths(workspaceKey, options = {}) {
  assertHex(workspaceKey, "workspaceKey");
  let runtimeRoot = getClientRuntimeRoot(options);
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

export function readControllerManifest(manifestPath, expected = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw clientError("invalid_manifest", `controller manifest is unreadable: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw clientError("invalid_manifest", "controller manifest is malformed");
  }
  const allowed = new Set([
    "version",
    "protocolVersion",
    "pid",
    "uid",
    "workspaceKey",
    "workspaceRoot",
    "bareCommonDirectory",
    "socketPath",
    "controllerToken",
    "policyGeneration",
    "imageGeneration",
    "vmId",
    "dockerHealthy",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw clientError("invalid_manifest", `unknown controller manifest key: ${key}`);
  }
  if (raw.version !== 1 || raw.protocolVersion !== PROTOCOL_VERSION) {
    throw clientError("invalid_manifest", "controller protocol version is unsupported");
  }
  if (!Number.isSafeInteger(raw.pid) || raw.pid < 1 || !pidIsAlive(raw.pid)) {
    throw clientError("stale_manifest", "controller process is not running");
  }
  const uid = process.getuid?.() ?? null;
  if (raw.uid !== uid) throw clientError("invalid_manifest", "controller owner does not match");
  assertHex(raw.workspaceKey, "manifest.workspaceKey");
  assertHex(raw.controllerToken, "manifest.controllerToken");
  assertHex(raw.policyGeneration, "manifest.policyGeneration");
  assertHex(raw.imageGeneration, "manifest.imageGeneration");
  assertAbsolute(raw.workspaceRoot, "manifest.workspaceRoot");
  assertAbsolute(raw.socketPath, "manifest.socketPath");
  if (raw.bareCommonDirectory !== null) {
    assertAbsolute(raw.bareCommonDirectory, "manifest.bareCommonDirectory");
  }
  if (typeof raw.vmId !== "string" || !raw.vmId || raw.dockerHealthy !== true) {
    throw clientError("invalid_manifest", "controller VM or Docker is not healthy");
  }
  const stat = fs.statSync(manifestPath);
  if ((stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) {
    throw clientError("invalid_manifest", "controller manifest ownership or permissions are not private");
  }
  const socketStat = fs.lstatSync(raw.socketPath);
  if (!socketStat.isSocket() || (socketStat.mode & 0o077) !== 0 || (uid !== null && socketStat.uid !== uid)) {
    throw clientError("invalid_manifest", "controller socket ownership or permissions are invalid");
  }
  if (expected.workspaceKey && raw.workspaceKey !== expected.workspaceKey) {
    throw clientError("workspace_mismatch", "controller manifest workspace key does not match");
  }
  if (expected.workspaceRoot && raw.workspaceRoot !== expected.workspaceRoot) {
    throw clientError("workspace_mismatch", "controller manifest workspace root does not match");
  }
  if (expected.socketPath && raw.socketPath !== expected.socketPath) {
    throw clientError("invalid_manifest", "controller manifest socket path does not match");
  }
  return Object.freeze(raw);
}

function connectSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const onError = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      socket.on("error", () => {});
      resolve(socket);
    });
  });
}

export class ControllerClient {
  constructor(socket, options) {
    this.socket = socket;
    this.auth = options.auth;
    this.policyGeneration = options.policyGeneration ?? null;
    this.workspaceKey = options.workspaceKey ?? null;
    this.ownsLease = options.ownsLease ?? false;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.heartbeatTimer = null;
    this.decoder = new FrameDecoder((frame) => this.handleFrame(frame));
    socket.on("data", (chunk) => {
      try {
        this.decoder.push(chunk);
      } catch (error) {
        this.failAll(error);
        socket.destroy();
      }
    });
    socket.on("close", () => {
      this.closed = true;
      this.stopHeartbeat();
      this.failAll(clientError("controller_disconnected", "controller connection closed"));
    });
  }

  static async acquire(manifest, options = {}) {
    const socket = await connectSocket(manifest.socketPath);
    const client = new ControllerClient(socket, {
      auth: manifest.controllerToken,
      policyGeneration: manifest.policyGeneration,
      workspaceKey: manifest.workspaceKey,
      ownsLease: true,
    });
    try {
      const acquired = await client.request("lease.acquire", {
        workspaceKey: manifest.workspaceKey,
        clientId: options.clientId ?? `${process.pid}-${randomBytes(8).toString("hex")}`,
      });
      assertHex(acquired.leaseToken, "leaseToken");
      client.auth = acquired.leaseToken;
      client.validateStatus(acquired.status, manifest);
      client.startHeartbeat(options.heartbeatIntervalMs);
      return { client, status: acquired.status, leaseToken: acquired.leaseToken };
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  static async connectInherited(options) {
    assertHex(options.leaseToken, "leaseToken");
    const socket = await connectSocket(options.socketPath);
    const client = new ControllerClient(socket, {
      auth: options.leaseToken,
      policyGeneration: options.policyGeneration,
      workspaceKey: options.workspaceKey,
      // A replacement runtime in the original Pi process reconnects to its
      // already-acquired lease. This never sends lease.acquire.
      ownsLease: options.adoptLease === true,
    });
    try {
      const status = await client.status();
      client.validateStatus(status, options);
      client.startHeartbeat(options.heartbeatIntervalMs);
      return { client, status };
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.request("lease.heartbeat", {})
        .then((status) => {
          if (status.health === "starting" || status.health === "restarting") return;
          this.validateStatus(status, { workspaceKey: this.workspaceKey });
        })
        .catch(() => this.destroy());
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  validateStatus(status, expected = {}) {
    if (!status || status.health !== "healthy" || status.dockerHealthy !== true || !status.vmId) {
      throw clientError("controller_unhealthy", "controller status is not healthy");
    }
    if (expected.workspaceKey && status.workspaceKey !== expected.workspaceKey) {
      throw clientError("workspace_mismatch", "controller status workspace does not match");
    }
    if (expected.workspaceRoot && status.workspaceRoot !== expected.workspaceRoot) {
      throw clientError("workspace_mismatch", "controller status root does not match");
    }
    if (expected.policyGeneration && status.policyGeneration !== expected.policyGeneration) {
      throw clientError("policy_generation_mismatch", "controller status policy does not match");
    }
    if (expected.imageGeneration && status.imageGeneration !== expected.imageGeneration) {
      throw clientError("image_generation_mismatch", "controller status image does not match");
    }
    if (expected.vmId && status.vmId !== expected.vmId) {
      throw clientError("vm_mismatch", "controller VM does not match");
    }
    this.policyGeneration = status.policyGeneration;
    this.workspaceKey = status.workspaceKey;
    return status;
  }

  allocateId() {
    const id = this.nextId++;
    if (this.nextId > 0x7fffffff) this.nextId = 1;
    if (this.pending.has(id)) throw clientError("request_ids_exhausted", "no request id is available");
    return id;
  }

  async write(value) {
    if (this.closed || this.socket.destroyed) {
      throw clientError("controller_disconnected", "controller connection is closed");
    }
    const frame = encodeFrame(value);
    if (this.socket.write(frame)) return;
    await new Promise((resolve, reject) => {
      this.socket.once("drain", resolve);
      this.socket.once("error", reject);
      this.socket.once("close", resolve);
    });
  }

  request(method, params, options = {}) {
    const id = this.allocateId();
    const request = makeRequest(id, method, this.auth, params);
    validateRequest(request);
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent: options.onEvent });
    });
    void this.write(request).catch((error) => {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error);
    });
    return promise;
  }

  handleFrame(raw) {
    const frame = validateResponse(raw);
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    if (frame.type === "event") {
      let data;
      try {
        data = Buffer.from(frame.data, "base64");
      } catch {
        pending.reject(clientError("invalid_response", "stream event is not base64"));
        this.pending.delete(frame.id);
        return;
      }
      try {
        pending.onEvent?.(frame.event, data);
      } catch (error) {
        pending.reject(error);
        this.pending.delete(frame.id);
      }
      return;
    }
    this.pending.delete(frame.id);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      pending.reject(clientError(frame.error.code, frame.error.message));
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  status() {
    return this.request("status", {}).then((status) => {
      if (status.health === "starting" || status.health === "restarting") return status;
      return this.validateStatus(status, { workspaceKey: this.workspaceKey });
    });
  }

  access(pathValue, mode = 0) {
    return this.request("fs.access", {
      path: pathValue,
      mode,
      policyGeneration: this.policyGeneration,
    });
  }

  mkdir(pathValue, options = {}) {
    return this.request("fs.mkdir", {
      path: pathValue,
      recursive: options.recursive ?? true,
      mode: options.mode ?? 0o755,
      policyGeneration: this.policyGeneration,
    });
  }

  listDir(pathValue) {
    return this.request("fs.listDir", {
      path: pathValue,
      policyGeneration: this.policyGeneration,
    });
  }

  stat(pathValue) {
    return this.request("fs.stat", {
      path: pathValue,
      policyGeneration: this.policyGeneration,
    });
  }

  rename(oldPath, newPath) {
    return this.request("fs.rename", {
      oldPath,
      newPath,
      policyGeneration: this.policyGeneration,
    });
  }

  readFile(pathValue, options = {}) {
    return this.request("fs.readFile", {
      path: pathValue,
      offset: options.offset ?? 0,
      limit: options.limit ?? 512 * 1024,
      policyGeneration: this.policyGeneration,
    }).then((result) => ({ ...result, data: Buffer.from(result.data, "base64") }));
  }

  writeFile(pathValue, data) {
    return this.request("fs.writeFile", {
      path: pathValue,
      data: Buffer.from(data).toString("base64"),
      policyGeneration: this.policyGeneration,
    });
  }

  deleteFile(pathValue, options = {}) {
    return this.request("fs.deleteFile", {
      path: pathValue,
      force: options.force ?? false,
      recursive: options.recursive ?? false,
      policyGeneration: this.policyGeneration,
    });
  }

  exec(argv, options = {}) {
    let requestId = null;
    const id = this.allocateId();
    requestId = id;
    const request = makeRequest(id, "exec", this.auth, {
      argv,
      cwd: options.cwd,
      env: options.env ?? {},
      timeoutMs: options.timeoutMs ?? 120_000,
      maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
      policyGeneration: this.policyGeneration,
    });
    validateRequest(request);
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onEvent: options.onEvent });
    });
    let finished = false;
    const abort = () => {
      void this.request("cancel", { requestId }).catch(() => {});
    };
    void this.write(request)
      .then(() => {
        if (!options.signal || finished) return;
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      })
      .catch((error) => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      });
    return promise.finally(() => {
      finished = true;
      options.signal?.removeEventListener("abort", abort);
    });
  }

  reload(expectedPolicyGeneration) {
    return this.request("reload", {
      ...(expectedPolicyGeneration ? { expectedPolicyGeneration } : {}),
    }).then((status) =>
      this.validateStatus(status, { workspaceKey: this.workspaceKey }),
    );
  }

  restart() {
    return this.request("restart", { policyGeneration: this.policyGeneration }).then((status) =>
      this.validateStatus(status, { workspaceKey: this.workspaceKey }),
    );
  }

  resetDocker() {
    return this.request("docker.reset", { policyGeneration: this.policyGeneration }).then((status) =>
      this.validateStatus(status, { workspaceKey: this.workspaceKey }),
    );
  }

  async releaseLease() {
    this.stopHeartbeat();
    if (this.closed) return;
    try {
      await this.request("lease.release", {});
    } finally {
      this.destroy();
    }
  }

  async release() {
    if (!this.ownsLease) {
      this.destroy();
      return;
    }
    await this.releaseLease();
  }

  destroy() {
    this.stopHeartbeat();
    this.closed = true;
    this.socket.destroy();
    this.failAll(clientError("controller_disconnected", "controller client closed"));
  }
}

function controllerEnvironment(runtimeRoot, source = process.env) {
  const env = {
    HOME: os.homedir(),
    PATH: source.PATH ?? "/usr/bin:/bin",
    TMPDIR: source.TMPDIR ?? os.tmpdir(),
    PI_GONDOLIN_RUNTIME_DIR: runtimeRoot,
  };
  for (const name of [
    "PI_GONDOLIN_ROOTFS_SIZE", "PI_GONDOLIN_MEMORY", "PI_GONDOLIN_CPUS",
    "PI_GONDOLIN_STARTUP_TRACE_FILE", "NODE_COMPILE_CACHE", "JITI_FS_CACHE",
  ]) {
    if (source[name]) env[name] = source[name];
  }
  return env;
}

function spawnController(scope, paths, options) {
  const args = [CONTROLLER_PATH, "--serve", "--launch-dir", scope.physicalLaunchDirectory];
  const append = (flag, value) => {
    if (value) args.push(flag, path.resolve(value));
  };
  append("--settings", options.settingsPath ?? DEFAULT_SETTINGS_PATH);
  append("--cache-root", options.cacheRoot);
  append("--runtime-root", paths.runtimeRoot);
  append("--image-dir", options.imageDir);

  const env = controllerEnvironment(paths.runtimeRoot);
  const logFd = fs.openSync(paths.logPath, "a", 0o600);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  fs.closeSync(logFd);
  child.unref();
  return child;
}

export async function waitForManifest(paths, scope, child, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    try {
      const manifest = readControllerManifest(paths.manifestPath, {
        workspaceKey: scope.workspaceKey,
        workspaceRoot: scope.canonicalWorkspaceRoot,
        socketPath: paths.socketPath,
      });
      await connectSocket(manifest.socketPath).then((socket) => socket.destroy());
      return manifest;
    } catch (error) {
      lastError = error;
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined && child.exitCode !== 0) {
      let detail = "";
      try {
        detail = fs.readFileSync(paths.logPath, "utf8").slice(-4096).trim();
      } catch {
        // The log is best-effort diagnostics only.
      }
      throw clientError(
        "controller_start_failed",
        `controller exited with ${child.exitCode}${detail ? `: ${detail}` : ""}`,
      );
    }
    await sleep(50, signal);
  }
  throw clientError(
    "controller_start_timeout",
    `timed out waiting for the controller: ${lastError?.message ?? "manifest unavailable"}`,
  );
}

function controllerStartupDescriptor(scope, paths, child = null) {
  return Object.freeze({
    version: 1,
    workspaceKey: scope.workspaceKey,
    workspaceRoot: scope.canonicalWorkspaceRoot,
    bareCommonDirectory: scope.bareCommonDirectory,
    runtimeRoot: paths.runtimeRoot,
    socketPath: paths.socketPath,
    manifestPath: paths.manifestPath,
    // This is cancellation bookkeeping, not a controller capability. It is
    // present only for the process that began a cold controller.
    startupPid: Number.isSafeInteger(child?.pid) ? child.pid : null,
  });
}

export async function beginControllerStartup(options = {}) {
  const launchDirectory = options.launchDirectory ?? process.cwd();
  const scope = validateRepositoryScope(
    options.scope ?? discoverRepositoryScope({
      launchDirectory,
      pathValue: options.pathValue ?? process.env.PATH,
    }),
    launchDirectory,
  );
  const paths = getClientControllerPaths(scope.workspaceKey, { runtimeRoot: options.runtimeRoot });
  fs.mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.runtimeRoot, 0o700);

  let child = null;
  try {
    const manifest = readControllerManifest(paths.manifestPath, {
      workspaceKey: scope.workspaceKey,
      workspaceRoot: scope.canonicalWorkspaceRoot,
      socketPath: paths.socketPath,
    });
    await connectSocket(manifest.socketPath).then((socket) => socket.destroy());
  } catch {
    // The daemon lock makes concurrent begin calls join one controller rather
    // than publish a second one. No token or healthy-manifest data is returned.
    child = spawnController(scope, paths, options);
  }
  return controllerStartupDescriptor(scope, paths, child);
}

function validateStartupDescriptor(descriptor) {
  if (!descriptor || descriptor.version !== 1 || typeof descriptor.workspaceKey !== "string" ||
      typeof descriptor.workspaceRoot !== "string" || typeof descriptor.runtimeRoot !== "string" ||
      typeof descriptor.socketPath !== "string" || typeof descriptor.manifestPath !== "string" ||
      (descriptor.startupPid !== undefined && descriptor.startupPid !== null && !Number.isSafeInteger(descriptor.startupPid))) {
    throw clientError("invalid_startup_descriptor", "controller startup descriptor is invalid");
  }
  const scope = validateRepositoryScope({
    physicalLaunchDirectory: descriptor.workspaceRoot,
    canonicalWorkspaceRoot: descriptor.workspaceRoot,
    bareCommonDirectory: descriptor.bareCommonDirectory ?? null,
    workspaceKey: descriptor.workspaceKey,
  });
  const paths = getClientControllerPaths(scope.workspaceKey, { runtimeRoot: descriptor.runtimeRoot });
  if (paths.socketPath !== descriptor.socketPath || paths.manifestPath !== descriptor.manifestPath) {
    throw clientError("invalid_startup_descriptor", "controller startup descriptor paths do not match");
  }
  return { scope, paths };
}

export function stopStartedController(startup) {
  let paths;
  try { ({ paths } = validateStartupDescriptor(startup)); } catch { return false; }
  const pid = startup.startupPid;
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  // A descriptor carries the PID only when this root spawned the detached
  // daemon. Do not signal a warm/shared controller.
  try {
    const manifest = readControllerManifest(paths.manifestPath);
    if (manifest.pid !== pid) return false;
  } catch {
    // A cold daemon has no healthy manifest yet; its captured PID is the only
    // cancellation target and it owns no lease.
  }
  try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
}

export async function acquireControllerLease(options = {}) {
  const startup = options.startup ?? await beginControllerStartup(options);
  const { scope, paths } = validateStartupDescriptor(startup);
  const manifest = await waitForManifest(
    paths, scope, null, options.startTimeoutMs ?? START_TIMEOUT_MS, options.signal,
  );
  if (options.signal?.aborted) throw abortError();
  const acquired = await ControllerClient.acquire(manifest, { 
    clientId: options.clientId,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
  });
  acquired.client.validateStatus(acquired.status, manifest);
  return { ...acquired, manifest, scope, paths, startup };
}

export async function ensureControllerLease(options = {}) {
  return acquireControllerLease(options);
}

export const clientInternals = Object.freeze({
  connectSocket,
  pidIsAlive,
  configureRuntimeCaches,
  controllerEnvironment,
  spawnController,
  validateRepositoryScope,
  waitForManifest,
});
