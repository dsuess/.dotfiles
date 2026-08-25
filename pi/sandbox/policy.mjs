import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createHttpHooks,
  isWriteFlag,
  MemoryProvider,
  ReadonlyProvider,
  RealFSProvider,
  VirtualProviderClass,
} from "@earendil-works/gondolin";

export const SETTINGS_VERSION = 1;
export const SETTINGS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "settings.json");

const SETTINGS_ROOT_KEYS = new Set(["version", "filesystem", "network"]);
const FILESYSTEM_KEYS = new Set(["workspace", "workspaceOverrides", "bareCommon", "externalMounts"]);
const ACCESS_POLICY_KEYS = new Set(["access", "writeProtectedPaths"]);
const WORKSPACE_OVERRIDE_KEYS = new Set(["root", "access", "writeProtectedPaths"]);
const MOUNT_KEYS = new Set(["path", "access"]);
const NETWORK_KEYS = new Set([
  "mode",
  "allowedHosts",
  "allowWebSockets",
  "tcpMappings",
]);
const TCP_KEYS = new Set(["guestHost", "guestPort", "connectHost", "connectPort"]);
const NETWORK_MODES = new Set(["public-http", "public-tcp", "allowlist", "offline"]);
const ACCESS_MODES = new Set(["ro", "rw"]);
const MAX_MOUNTS = 64;
const MAX_PROTECTED_PATHS = 128;
const MAX_HOSTS = 128;
const MAX_TCP_MAPPINGS = 32;

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown key: ${key}`);
  }
}

function assertString(value, label, maxLength = 4096) {
  if (typeof value !== "string" || !value || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return value;
}

function assertHostname(value, label, { wildcard = false } = {}) {
  const hostname = assertString(value, label, 253).toLowerCase();
  if (/[:/\s]/.test(hostname)) throw new Error(`${label} is not a hostname`);
  if (hostname === "*") {
    throw new Error(`${label} cannot be a global wildcard`);
  }
  const candidate = hostname.startsWith("*.") && wildcard ? hostname.slice(2) : hostname;
  if (!candidate || candidate.startsWith(".") || candidate.endsWith(".")) {
    throw new Error(`${label} is not a hostname`);
  }
  for (const part of candidate.split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) {
      throw new Error(`${label} is not a hostname`);
    }
  }
  return hostname;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parseWriteProtectedPaths(value, label) {
  if (!Array.isArray(value) || value.length > MAX_PROTECTED_PATHS) {
    throw new Error(`${label} must be an array with at most ${MAX_PROTECTED_PATHS} entries`);
  }
  const paths = value.map((entry, index) => {
    const protectedPath = assertString(entry, `${label}[${index}]`);
    if (
      path.isAbsolute(protectedPath) ||
      protectedPath === "." ||
      protectedPath.split(/[\\/]/).some((part) => !part || part === "..")
    ) {
      throw new Error(`${label}[${index}] must be a bounded relative path without traversal`);
    }
    return protectedPath;
  });
  if (new Set(paths).size !== paths.length) throw new Error(`${label} contains duplicates`);
  return paths;
}

function parseAccessPolicy(value, label) {
  const policy = assertPlainObject(value, label);
  rejectUnknownKeys(policy, ACCESS_POLICY_KEYS, label);
  if (!ACCESS_MODES.has(policy.access)) throw new Error(`${label}.access must be ro or rw`);
  return { access: policy.access, writeProtectedPaths: parseWriteProtectedPaths(policy.writeProtectedPaths, `${label}.writeProtectedPaths`) };
}

function canonicalWorkspaceOverrideRoot(value, label, homeDirectory) {
  const configuredRoot = assertString(value, label);
  const expanded = expandHome(configuredRoot, homeDirectory);
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be absolute or use ~/`);
  try {
    const canonicalRoot = fs.realpathSync(path.resolve(expanded));
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error("not a directory");
    return { configuredRoot, canonicalRoot };
  } catch {
    throw new Error(`${label} must be an existing directory`);
  }
}

export function parseSandboxSettings(value, options = {}) {
  const root = assertPlainObject(value, "settings");
  rejectUnknownKeys(root, SETTINGS_ROOT_KEYS, "settings");
  if (root.version !== SETTINGS_VERSION) {
    throw new Error(`settings.version must be ${SETTINGS_VERSION}`);
  }
  const homeDirectory = fs.realpathSync(options.homeDirectory ?? os.homedir());
  const rawFilesystem = assertPlainObject(root.filesystem, "settings.filesystem");
  rejectUnknownKeys(rawFilesystem, FILESYSTEM_KEYS, "settings.filesystem");
  const workspace = parseAccessPolicy(rawFilesystem.workspace, "settings.filesystem.workspace");
  const bareCommon = parseAccessPolicy(rawFilesystem.bareCommon, "settings.filesystem.bareCommon");
  if (!Array.isArray(rawFilesystem.workspaceOverrides) || rawFilesystem.workspaceOverrides.length > MAX_MOUNTS) {
    throw new Error(`settings.filesystem.workspaceOverrides must be an array with at most ${MAX_MOUNTS} entries`);
  }
  const canonicalOverrideRoots = new Set();
  const workspaceOverrides = rawFilesystem.workspaceOverrides.map((raw, index) => {
    const override = assertPlainObject(raw, `settings.filesystem.workspaceOverrides[${index}]`);
    rejectUnknownKeys(override, WORKSPACE_OVERRIDE_KEYS, `settings.filesystem.workspaceOverrides[${index}]`);
    const { configuredRoot, canonicalRoot } = canonicalWorkspaceOverrideRoot(
      override.root,
      `settings.filesystem.workspaceOverrides[${index}].root`,
      homeDirectory,
    );
    if (canonicalOverrideRoots.has(canonicalRoot)) {
      throw new Error("settings.filesystem.workspaceOverrides contains duplicate canonical roots");
    }
    canonicalOverrideRoots.add(canonicalRoot);
    const policy = parseAccessPolicy(
      { access: override.access, writeProtectedPaths: override.writeProtectedPaths },
      `settings.filesystem.workspaceOverrides[${index}]`,
    );
    return { root: configuredRoot, ...policy };
  });
  if (!Array.isArray(rawFilesystem.externalMounts) || rawFilesystem.externalMounts.length > MAX_MOUNTS) {
    throw new Error(`settings.filesystem.externalMounts must be an array with at most ${MAX_MOUNTS} entries`);
  }
  const externalMounts = rawFilesystem.externalMounts.map((raw, index) => {
    const mount = assertPlainObject(raw, `settings.filesystem.externalMounts[${index}]`);
    rejectUnknownKeys(mount, MOUNT_KEYS, `settings.filesystem.externalMounts[${index}]`);
    const mountPath = assertString(mount.path, `settings.filesystem.externalMounts[${index}].path`);
    if (!ACCESS_MODES.has(mount.access)) {
      throw new Error(`settings.filesystem.externalMounts[${index}].access must be ro or rw`);
    }
    return { path: mountPath, access: mount.access };
  });

  const rawNetwork = assertPlainObject(root.network, "settings.network");
  rejectUnknownKeys(rawNetwork, NETWORK_KEYS, "settings.network");
  if (!NETWORK_MODES.has(rawNetwork.mode)) {
    throw new Error("settings.network.mode is invalid");
  }
  if (!Array.isArray(rawNetwork.allowedHosts) || rawNetwork.allowedHosts.length > MAX_HOSTS) {
    throw new Error(`settings.network.allowedHosts must have at most ${MAX_HOSTS} entries`);
  }
  const allowedHosts = rawNetwork.allowedHosts.map((host, index) =>
    assertHostname(host, `settings.network.allowedHosts[${index}]`, { wildcard: true }),
  );
  if (new Set(allowedHosts).size !== allowedHosts.length) {
    throw new Error("settings.network.allowedHosts contains duplicates");
  }
  if (typeof rawNetwork.allowWebSockets !== "boolean") {
    throw new Error("settings.network.allowWebSockets must be boolean");
  }
  if (!Array.isArray(rawNetwork.tcpMappings) || rawNetwork.tcpMappings.length > MAX_TCP_MAPPINGS) {
    throw new Error(`settings.network.tcpMappings must have at most ${MAX_TCP_MAPPINGS} entries`);
  }
  const tcpMappings = rawNetwork.tcpMappings.map((raw, index) => {
    const mapping = assertPlainObject(raw, `tcpMappings[${index}]`);
    rejectUnknownKeys(mapping, TCP_KEYS, `tcpMappings[${index}]`);
    return {
      guestHost: assertHostname(mapping.guestHost, `tcpMappings[${index}].guestHost`),
      guestPort: assertPort(mapping.guestPort, `tcpMappings[${index}].guestPort`),
      connectHost: assertHostname(mapping.connectHost, `tcpMappings[${index}].connectHost`),
      connectPort: assertPort(mapping.connectPort, `tcpMappings[${index}].connectPort`),
    };
  });
  const tcpKeys = tcpMappings.map((mapping) => `${mapping.guestHost}:${mapping.guestPort}`);
  if (new Set(tcpKeys).size !== tcpKeys.length) {
    throw new Error("settings.network.tcpMappings contains duplicate guest targets");
  }

  if ((rawNetwork.mode === "public-http" || rawNetwork.mode === "public-tcp") && allowedHosts.length !== 0) {
    throw new Error(`${rawNetwork.mode} mode does not use allowedHosts`);
  }
  if (rawNetwork.mode === "allowlist" && allowedHosts.length === 0) {
    throw new Error("allowlist mode requires at least one allowed host");
  }
  if (
    rawNetwork.mode === "offline" &&
    (allowedHosts.length !== 0 || rawNetwork.allowWebSockets || tcpMappings.length !== 0)
  ) {
    throw new Error("offline mode cannot enable hosts, WebSockets, or TCP mappings");
  }

  return deepFreeze({
    version: SETTINGS_VERSION,
    filesystem: { workspace, workspaceOverrides, bareCommon, externalMounts },
    network: {
      mode: rawNetwork.mode,
      allowedHosts,
      allowWebSockets: rawNetwork.allowWebSockets,
      tcpMappings,
    },
  });
}

export function parseSandboxSettingsText(text, options) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`settings JSON is malformed: ${error.message}`);
  }
  return parseSandboxSettings(value, options);
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function overlaps(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function expandHome(inputPath, homeDirectory) {
  if (inputPath === "~") return homeDirectory;
  if (inputPath.startsWith(`~${path.sep}`) || inputPath.startsWith("~/")) {
    return path.join(homeDirectory, inputPath.slice(2));
  }
  return inputPath;
}

function canonicalIfPresent(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function signingPublicKeyPath(homeDirectory) {
  return canonicalIfPresent(path.join(homeDirectory, ".ssh", "git", "id_ed25519_signing.pub"));
}

function defaultInvariantRoots(homeDirectory, cacheRoot, runtimeRoot) {
  return [
    path.join(homeDirectory, ".pi"),
    path.join(homeDirectory, ".dotfiles", "pi"),
    path.join(homeDirectory, ".config", "ketch"),
    path.join(homeDirectory, "Library", "Application Support", "ketch"),
    path.join(homeDirectory, ".dotfiles", "ketch"),
    path.join(homeDirectory, ".ssh"),
    path.join(homeDirectory, ".gnupg"),
    path.join(homeDirectory, ".aws"),
    path.join(homeDirectory, ".azure"),
    path.join(homeDirectory, ".kube"),
    path.join(homeDirectory, ".docker"),
    path.join(homeDirectory, ".config", "gcloud"),
    path.join(homeDirectory, ".config", "gh"),
    path.join(homeDirectory, ".config", "op"),
    path.join(homeDirectory, ".netrc"),
    path.join(homeDirectory, ".npmrc"),
    path.join(homeDirectory, ".pypirc"),
    path.join(homeDirectory, ".cargo", "credentials"),
    path.join(homeDirectory, ".cargo", "credentials.toml"),
    path.join(homeDirectory, "local_cache"),
    path.join(homeDirectory, "Library", "Caches"),
    path.join(homeDirectory, "Library", "Containers"),
    "/var/run/docker.sock",
    cacheRoot,
    runtimeRoot,
  ].map(canonicalIfPresent);
}

export function resolveExternalMounts(settings, options) {
  const homeDirectory = fs.realpathSync(options.homeDirectory ?? os.homedir());
  const workspaceRoot = fs.realpathSync(options.workspaceRoot);
  const bareCommonDirectory = options.bareCommonDirectory
    ? fs.realpathSync(options.bareCommonDirectory)
    : null;
  const invariantRoots = [
    ...(options.invariantRoots ?? []),
    workspaceRoot,
    ...(bareCommonDirectory ? [bareCommonDirectory] : []),
  ].map(canonicalIfPresent);
  const resolved = [];

  for (const [index, mount] of settings.filesystem.externalMounts.entries()) {
    const expanded = expandHome(mount.path, homeDirectory);
    if (!path.isAbsolute(expanded)) {
      throw new Error(`externalMounts[${index}].path must be absolute or use ~/`);
    }
    const lexical = path.resolve(expanded);
    if (lexical === path.parse(lexical).root || lexical === homeDirectory) {
      throw new Error(`externalMounts[${index}] cannot mount / or the whole home directory`);
    }
    let canonical;
    let stat;
    try {
      canonical = fs.realpathSync(lexical);
      stat = fs.statSync(canonical);
    } catch (error) {
      throw new Error(`externalMounts[${index}] does not exist: ${mount.path}`);
    }
    const isSigningPublicKey =
      canonical === signingPublicKeyPath(homeDirectory) && stat.isFile() && mount.access === "ro";
    if (!stat.isDirectory() && !isSigningPublicKey) {
      throw new Error(`externalMounts[${index}] must be a directory or the read-only signing public key`);
    }
    if (!isSigningPublicKey && invariantRoots.some((root) => overlaps(canonical, root) || overlaps(lexical, root))) {
      throw new Error(`externalMounts[${index}] overlaps a code-enforced sandbox boundary`);
    }
    if (resolved.some((entry) => overlaps(entry.hostPath, canonical))) {
      throw new Error(`externalMounts[${index}] overlaps another external mount`);
    }
    resolved.push(
      deepFreeze({
        kind: isSigningPublicKey ? "signing-public-key" : "external",
        configuredPath: mount.path,
        hostPath: canonical,
        guestPath: isSigningPublicKey ? path.dirname(canonical) : canonical,
        access: mount.access,
      }),
    );
  }
  return Object.freeze(resolved);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function ensureDeveloperLocalCache(homeDirectory) {
  const directory = path.join(homeDirectory, "local_cache");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error(`developer local cache is not a directory: ${directory}`);
  }
  return fs.realpathSync(directory);
}

function protectedHostPaths(root, relatives) {
  return Object.freeze(relatives.map((relative) => path.join(root, relative)));
}

function selectWorkspacePolicy(filesystem, workspaceRoot, homeDirectory) {
  const canonicalWorkspaceRoot = fs.realpathSync(workspaceRoot);
  for (const override of filesystem.workspaceOverrides) {
    const { canonicalRoot } = canonicalWorkspaceOverrideRoot(
      override.root,
      "settings.filesystem.workspaceOverrides.root",
      homeDirectory,
    );
    if (canonicalRoot === canonicalWorkspaceRoot) {
      return { ...override, canonicalRoot };
    }
  }
  return { ...filesystem.workspace, canonicalRoot: null };
}

function computeGeneration(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildSandboxPolicy(options) {
  const scope = options.scope;
  if (!scope?.canonicalWorkspaceRoot || !scope?.workspaceKey) {
    throw new Error("repository scope is required");
  }
  const homeDirectory = fs.realpathSync(options.homeDirectory ?? os.homedir());
  const cacheRoot = path.resolve(
    options.cacheRoot ?? path.join(homeDirectory, ".cache", "pi-gondolin"),
  );
  const runtimeRoot = path.resolve(
    options.runtimeRoot ?? path.join(os.tmpdir(), `pi-gondolin-${process.getuid?.() ?? "user"}`),
  );
  const workspaceState = ensurePrivateDirectory(
    path.join(cacheRoot, "workspaces", scope.workspaceKey),
  );
  const developerLocalCache = ensureDeveloperLocalCache(homeDirectory);
  const cacheDirectory = ensurePrivateDirectory(path.join(workspaceState, "cache"));
  const npmDirectory = ensurePrivateDirectory(path.join(workspaceState, "npm"));
  const cargoDirectory = ensurePrivateDirectory(path.join(workspaceState, "cargo"));
  ensurePrivateDirectory(runtimeRoot);

  const invariantRoots = defaultInvariantRoots(homeDirectory, cacheRoot, runtimeRoot);
  const externalMounts = resolveExternalMounts(options.settings, {
    homeDirectory,
    workspaceRoot: scope.canonicalWorkspaceRoot,
    bareCommonDirectory: scope.bareCommonDirectory,
    invariantRoots,
  });
  const workspacePolicy = selectWorkspacePolicy(
    options.settings.filesystem,
    scope.canonicalWorkspaceRoot,
    homeDirectory,
  );
  const workspaceProtected = workspacePolicy.access === "rw" && workspacePolicy.writeProtectedPaths.length > 0
    ? protectedHostPaths(scope.canonicalWorkspaceRoot, workspacePolicy.writeProtectedPaths)
    : null;
  const mounts = [
    deepFreeze({
      kind: "workspace",
      hostPath: scope.canonicalWorkspaceRoot,
      guestPath: scope.canonicalWorkspaceRoot,
      access: workspacePolicy.access,
      ...(workspaceProtected ? { protectedHostPaths: workspaceProtected } : {}),
    }),
    deepFreeze({
      kind: "developer-local-cache",
      hostPath: developerLocalCache,
      guestPath: "/root/local_cache",
      access: "rw",
    }),
  ];
  if (scope.bareCommonDirectory) {
    const bareProtected = options.settings.filesystem.bareCommon.access === "rw" &&
      options.settings.filesystem.bareCommon.writeProtectedPaths.length > 0
      ? protectedHostPaths(
        scope.bareCommonDirectory,
        options.settings.filesystem.bareCommon.writeProtectedPaths,
      )
      : null;
    mounts.push(
      deepFreeze({
        kind: "bare-common",
        hostPath: scope.bareCommonDirectory,
        guestPath: scope.bareCommonDirectory,
        access: options.settings.filesystem.bareCommon.access,
        ...(bareProtected ? { protectedHostPaths: bareProtected } : {}),
      }),
    );
  }
  mounts.push(...externalMounts);
  mounts.push(
    deepFreeze({ kind: "cache", hostPath: cacheDirectory, guestPath: "/root/.cache", access: "rw" }),
    deepFreeze({ kind: "npm-cache", hostPath: npmDirectory, guestPath: "/root/.npm", access: "rw" }),
    deepFreeze({ kind: "cargo-cache", hostPath: cargoDirectory, guestPath: "/root/.cargo", access: "rw" }),
  );

  const effective = {
    settingsVersion: options.settings.version,
    workspaceKey: scope.workspaceKey,
    workspaceRoot: scope.canonicalWorkspaceRoot,
    workspaceOverrideRoot: workspacePolicy.canonicalRoot,
    bareCommonDirectory: scope.bareCommonDirectory,
    mounts: mounts.map(({ protectedHostPaths: protectedPaths, ...mount }) => ({
      ...mount,
      ...(protectedPaths ? { protectedHostPaths: protectedPaths } : {}),
    })),
    network: options.settings.network,
  };

  return deepFreeze({
    scope,
    settings: options.settings,
    policyGeneration: computeGeneration(effective),
    imageGeneration: options.imageGeneration ?? null,
    cacheRoot,
    runtimeRoot,
    workspaceState,
    mounts,
    network: options.settings.network,
  });
}

export function loadSandboxPolicy(options) {
  const settingsPath = options.settingsPath ?? SETTINGS_PATH;
  const settings = parseSandboxSettingsText(fs.readFileSync(settingsPath, "utf8"), options);
  return buildSandboxPolicy({ ...options, settings });
}

function errnoError(message) {
  const error = new Error(message);
  error.code = "EACCES";
  error.errno = os.constants.errno.EACCES;
  return error;
}

function providerHostPath(rootPath, providerPath) {
  const normalized = path.posix.normalize(providerPath);
  if (!normalized.startsWith("/")) throw errnoError("provider path is not absolute");
  const hostPath = path.resolve(rootPath, `.${normalized}`);
  if (!isWithin(hostPath, rootPath)) throw errnoError("provider path escapes its root");
  return hostPath;
}

function resolveExistingTarget(hostPath) {
  try {
    return fs.realpathSync(hostPath);
  } catch {
    let cursor = path.dirname(hostPath);
    const suffix = [path.basename(hostPath)];
    while (cursor !== path.dirname(cursor)) {
      try {
        return path.join(fs.realpathSync(cursor), ...suffix);
      } catch {
        suffix.unshift(path.basename(cursor));
        cursor = path.dirname(cursor);
      }
    }
    return hostPath;
  }
}

function createWriteGuard(rootPath, protectedPaths) {
  const canonicalRoot = fs.realpathSync(rootPath);
  const canonicalProtected = protectedPaths.map((entry) => canonicalIfPresent(entry));

  const checkHostPath = (hostPath, { contentWrite = false, structural = false } = {}) => {
    const lexical = path.resolve(hostPath);
    const resolved = resolveExistingTarget(lexical);
    if (
      canonicalProtected.some(
        (protectedPath) =>
          isWithin(lexical, protectedPath) ||
          isWithin(resolved, protectedPath) ||
          (structural && (isWithin(protectedPath, lexical) || isWithin(protectedPath, resolved))),
      )
    ) {
      throw errnoError(`write denied by protected-path policy: ${lexical}`);
    }
    if (contentWrite) {
      try {
        const stat = fs.statSync(lexical);
        if (stat.isFile() && stat.nlink > 1) {
          throw errnoError(`write denied through a hard-linked file: ${lexical}`);
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  };

  const checkProviderPath = (providerPath, options) =>
    checkHostPath(providerHostPath(canonicalRoot, providerPath), options);

  return { canonicalRoot, checkHostPath, checkProviderPath };
}

class GuardedHandle {
  constructor(handle, providerPath, guard) {
    this.handle = handle;
    this.path = providerPath;
    this.flags = handle.flags;
    this.mode = handle.mode;
    this.guard = guard;
  }
  get position() {
    return this.handle.position;
  }
  get closed() {
    return this.handle.closed;
  }
  read(...args) {
    return this.handle.read(...args);
  }
  readSync(...args) {
    return this.handle.readSync(...args);
  }
  write(...args) {
    this.guard.checkProviderPath(this.path, { contentWrite: true });
    return this.handle.write(...args);
  }
  writeSync(...args) {
    this.guard.checkProviderPath(this.path, { contentWrite: true });
    return this.handle.writeSync(...args);
  }
  readFile(...args) {
    return this.handle.readFile(...args);
  }
  readFileSync(...args) {
    return this.handle.readFileSync(...args);
  }
  writeFile(...args) {
    this.guard.checkProviderPath(this.path, { contentWrite: true });
    return this.handle.writeFile(...args);
  }
  writeFileSync(...args) {
    this.guard.checkProviderPath(this.path, { contentWrite: true });
    return this.handle.writeFileSync(...args);
  }
  stat(...args) {
    return this.handle.stat(...args);
  }
  statSync(...args) {
    return this.handle.statSync(...args);
  }
  truncate(...args) {
    this.guard.checkProviderPath(this.path, { contentWrite: true });
    return this.handle.truncate(...args);
  }
  truncateSync(...args) {
    this.guard.checkProviderPath(this.path, { contentWrite: true });
    return this.handle.truncateSync(...args);
  }
  close(...args) {
    return this.handle.close(...args);
  }
  closeSync(...args) {
    return this.handle.closeSync(...args);
  }
}

export class ProtectedWriteProvider extends VirtualProviderClass {
  constructor(rootPath, protectedPaths) {
    super();
    this.backend = new RealFSProvider(rootPath);
    this.guard = createWriteGuard(rootPath, protectedPaths);
    this.rootPath = this.guard.canonicalRoot;
  }
  get readonly() {
    return false;
  }
  get supportsSymlinks() {
    return this.backend.supportsSymlinks;
  }
  get supportsWatch() {
    return this.backend.supportsWatch;
  }
  async open(providerPath, flags, mode) {
    if (isWriteFlag(flags)) this.guard.checkProviderPath(providerPath, { contentWrite: true });
    return new GuardedHandle(await this.backend.open(providerPath, flags, mode), providerPath, this.guard);
  }
  openSync(providerPath, flags, mode) {
    if (isWriteFlag(flags)) this.guard.checkProviderPath(providerPath, { contentWrite: true });
    return new GuardedHandle(this.backend.openSync(providerPath, flags, mode), providerPath, this.guard);
  }
  stat(...args) { return this.backend.stat(...args); }
  statSync(...args) { return this.backend.statSync(...args); }
  lstat(...args) { return this.backend.lstat(...args); }
  lstatSync(...args) { return this.backend.lstatSync(...args); }
  readdir(...args) { return this.backend.readdir(...args); }
  readdirSync(...args) { return this.backend.readdirSync(...args); }
  async mkdir(providerPath, options) {
    this.guard.checkProviderPath(providerPath);
    return this.backend.mkdir(providerPath, options);
  }
  mkdirSync(providerPath, options) {
    this.guard.checkProviderPath(providerPath);
    return this.backend.mkdirSync(providerPath, options);
  }
  async rmdir(providerPath) {
    this.guard.checkProviderPath(providerPath, { structural: true });
    return this.backend.rmdir(providerPath);
  }
  rmdirSync(providerPath) {
    this.guard.checkProviderPath(providerPath, { structural: true });
    return this.backend.rmdirSync(providerPath);
  }
  async unlink(providerPath) {
    this.guard.checkProviderPath(providerPath, { structural: true });
    return this.backend.unlink(providerPath);
  }
  unlinkSync(providerPath) {
    this.guard.checkProviderPath(providerPath, { structural: true });
    return this.backend.unlinkSync(providerPath);
  }
  async rename(oldPath, newPath) {
    this.guard.checkProviderPath(oldPath, { structural: true });
    this.guard.checkProviderPath(newPath, { structural: true });
    return this.backend.rename(oldPath, newPath);
  }
  renameSync(oldPath, newPath) {
    this.guard.checkProviderPath(oldPath, { structural: true });
    this.guard.checkProviderPath(newPath, { structural: true });
    return this.backend.renameSync(oldPath, newPath);
  }
  async link(oldPath, newPath) {
    this.guard.checkProviderPath(oldPath);
    this.guard.checkProviderPath(newPath);
    return this.backend.link(oldPath, newPath);
  }
  linkSync(oldPath, newPath) {
    this.guard.checkProviderPath(oldPath);
    this.guard.checkProviderPath(newPath);
    return this.backend.linkSync(oldPath, newPath);
  }
  readlink(...args) { return this.backend.readlink(...args); }
  readlinkSync(...args) { return this.backend.readlinkSync(...args); }
  async symlink(target, providerPath, type) {
    this.guard.checkProviderPath(providerPath);
    const targetHost = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(path.dirname(providerHostPath(this.rootPath, providerPath)), target);
    if (!isWithin(targetHost, this.rootPath)) throw errnoError("symlink target escapes workspace");
    this.guard.checkHostPath(targetHost);
    return this.backend.symlink(target, providerPath, type);
  }
  symlinkSync(target, providerPath, type) {
    this.guard.checkProviderPath(providerPath);
    const targetHost = path.isAbsolute(target)
      ? path.resolve(target)
      : path.resolve(path.dirname(providerHostPath(this.rootPath, providerPath)), target);
    if (!isWithin(targetHost, this.rootPath)) throw errnoError("symlink target escapes workspace");
    this.guard.checkHostPath(targetHost);
    return this.backend.symlinkSync(target, providerPath, type);
  }
  realpath(...args) { return this.backend.realpath(...args); }
  realpathSync(...args) { return this.backend.realpathSync(...args); }
  access(...args) { return this.backend.access(...args); }
  accessSync(...args) { return this.backend.accessSync(...args); }
  watch(...args) { return this.backend.watch?.(...args); }
  watchAsync(...args) { return this.backend.watchAsync?.(...args); }
  watchFile(...args) { return this.backend.watchFile?.(...args); }
  unwatchFile(...args) { return this.backend.unwatchFile?.(...args); }
  async truncate(providerPath, length) {
    this.guard.checkProviderPath(providerPath, { contentWrite: true });
    return this.backend.truncate(providerPath, length);
  }
  truncateSync(providerPath, length) {
    this.guard.checkProviderPath(providerPath, { contentWrite: true });
    return this.backend.truncateSync(providerPath, length);
  }
  statfs(...args) { return this.backend.statfs(...args); }
  async close() {
    await this.backend.close?.();
  }
}

export function createPolicyProviders(policy) {
  const mounts = {};
  for (const mount of policy.mounts) {
    let provider;
    if (mount.kind === "signing-public-key") {
      const signingKeyProvider = new MemoryProvider();
      signingKeyProvider.writeFileSync(`/${path.basename(mount.hostPath)}`, fs.readFileSync(mount.hostPath));
      signingKeyProvider.setReadOnly();
      provider = new ReadonlyProvider(signingKeyProvider);
    } else {
      provider = new RealFSProvider(mount.hostPath);
      if (mount.access === "ro") provider = new ReadonlyProvider(provider);
      else if (mount.protectedHostPaths?.length > 0) {
        provider = new ProtectedWriteProvider(mount.hostPath, mount.protectedHostPaths);
      }
    }
    mounts[mount.guestPath] = provider;
  }
  return mounts;
}

export function createNetworkOptions(network) {
  if (network.mode === "offline") {
    return deepFreeze({ netEnabled: false, allowWebSockets: false });
  }
  const tcpHosts = {};
  for (const mapping of network.tcpMappings) {
    tcpHosts[`${mapping.guestHost}:${mapping.guestPort}`] =
      `${mapping.connectHost}:${mapping.connectPort}`;
  }
  const dns = network.tcpMappings.length > 0 || network.mode === "public-tcp"
    ? { mode: "synthetic", syntheticHostMapping: "per-host" }
    : { mode: "synthetic" };
  if (network.mode === "public-tcp") {
    // Reuse Gondolin's reviewed public-address classifier, but do not install
    // HTTP hooks: public TCP must remain raw through the origin TLS handshake.
    const { httpHooks } = createHttpHooks({ allowedHosts: ["*"], blockInternalRanges: true });
    return {
      netEnabled: true,
      publicTcp: {
        isIpAllowed: ({ hostname, ip, family, port }) =>
          httpHooks.isIpAllowed({ hostname, ip, family, port, protocol: "https" }),
      },
      allowWebSockets: network.allowWebSockets,
      dns,
      ...(network.tcpMappings.length > 0 ? { tcp: { hosts: tcpHosts } } : {}),
    };
  }
  const allowedHosts = network.mode === "allowlist" ? network.allowedHosts : ["*"];
  const { httpHooks } = createHttpHooks({ allowedHosts, blockInternalRanges: true });
  return {
    netEnabled: true,
    httpHooks,
    allowWebSockets: network.allowWebSockets,
    dns,
    ...(network.tcpMappings.length > 0 ? { tcp: { hosts: tcpHosts } } : {}),
  };
}

export const policyInternals = Object.freeze({
  defaultInvariantRoots,
  isWithin,
  overlaps,
  providerHostPath,
  resolveExistingTarget,
});
