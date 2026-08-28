import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type NetworkMode = "public-http" | "public-tcp" | "allowlist" | "offline";
export type MountAccess = "ro" | "rw";

export interface AccessPolicySetting {
  access: MountAccess;
  writeProtectedPaths: string[];
}

export interface WorkspaceOverrideSetting extends AccessPolicySetting {
  root: string;
}

export interface ExternalMountSetting {
  path: string;
  access: MountAccess;
}

export interface TcpMappingSetting {
  guestHost: string;
  guestPort: number;
  connectHost: string;
  connectPort: number;
}

export interface IngressListenerSetting {
  name: string;
  hostPort: number;
  guestPort: number;
}

export interface IngressWorkspaceProfileSetting {
  root: string;
  allowWebSockets: boolean;
  listeners: IngressListenerSetting[];
}

export interface SandboxSettings {
  version: 1;
  filesystem: {
    workspace: AccessPolicySetting;
    workspaceOverrides: WorkspaceOverrideSetting[];
    bareCommon: AccessPolicySetting;
    externalMounts: ExternalMountSetting[];
  };
  network: {
    mode: NetworkMode;
    allowedHosts: string[];
    allowWebSockets: boolean;
    tcpMappings: TcpMappingSetting[];
  };
  ingress: {
    workspaceProfiles: IngressWorkspaceProfileSetting[];
  };
}

export interface SandboxStatusForSettings {
  workspaceRoot: string;
  bareCommonDirectory: string | null;
}

const writeQueues = new Map<string, Promise<void>>();
const maxProtectedPaths = 128;
const maxIngressProfiles = 32;
const maxIngressListeners = 16;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withSettingsLock<T>(target: string, operation: () => T): Promise<T> {
  const lockPath = `${target}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      try {
        return operation();
      } finally {
        fs.rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
        if (!processAlive(owner.pid)) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 30_000) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("Timed out waiting for the sandbox settings lock");
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has unknown key: ${key}`);
  }
}

function nonemptyString(value: unknown, label: string, maxLength = 4096): string {
  if (typeof value !== "string" || !value || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function accessPolicy(value: unknown, label: string): AccessPolicySetting {
  const policy = plainObject(value, label);
  exactKeys(policy, ["access", "writeProtectedPaths"], label);
  if (policy.access !== "ro" && policy.access !== "rw") {
    throw new Error(`${label}.access must be ro or rw`);
  }
  if (!Array.isArray(policy.writeProtectedPaths) || policy.writeProtectedPaths.length > maxProtectedPaths) {
    throw new Error(`${label}.writeProtectedPaths must be an array with at most ${maxProtectedPaths} entries`);
  }
  const writeProtectedPaths = policy.writeProtectedPaths.map((entry, index) => {
    const protectedPath = nonemptyString(entry, `${label}.writeProtectedPaths[${index}]`);
    if (
      path.isAbsolute(protectedPath) ||
      protectedPath === "." ||
      protectedPath.split(/[\\/]/).some((part) => !part || part === "..")
    ) {
      throw new Error(`${label}.writeProtectedPaths[${index}] must be a bounded relative path without traversal`);
    }
    return protectedPath;
  });
  if (new Set(writeProtectedPaths).size !== writeProtectedPaths.length) {
    throw new Error(`${label}.writeProtectedPaths contains duplicates`);
  }
  return { access: policy.access, writeProtectedPaths };
}

function hostname(value: unknown, label: string, allowWildcard: boolean): string {
  const result = nonemptyString(value, label, 253).toLowerCase();
  if (result === "*" || /[:/\s]/.test(result)) throw new Error(`${label} is not a hostname`);
  const candidate = allowWildcard && result.startsWith("*.") ? result.slice(2) : result;
  if (!candidate || candidate.startsWith(".") || candidate.endsWith(".")) {
    throw new Error(`${label} is not a hostname`);
  }
  for (const part of candidate.split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) {
      throw new Error(`${label} is not a hostname`);
    }
  }
  return result;
}

function port(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return Number(value);
}

function hostPort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 65535) {
    throw new Error(`${label} must be an integer from 0 to 65535`);
  }
  return Number(value);
}

function ingressListenerName(value: unknown, label: string): string {
  const name = nonemptyString(value, label, 64);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(name)) {
    throw new Error(`${label} must use letters, numbers, dots, underscores, or hyphens`);
  }
  return name;
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

function canonicalWorkspaceOverrideRoot(value: unknown, label: string, home: string): { root: string; canonicalRoot: string } {
  const root = nonemptyString(value, label);
  const expanded = expandHome(root, home);
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be absolute or use ~/`);
  try {
    const canonicalRoot = fs.realpathSync(path.resolve(expanded));
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error("not a directory");
    return { root, canonicalRoot };
  } catch {
    throw new Error(`${label} must be an existing directory`);
  }
}

export function validateSandboxSettings(value: unknown, homeDirectory = os.homedir()): SandboxSettings {
  const root = plainObject(value, "settings");
  exactKeys(root, ["version", "filesystem", "network", "ingress"], "settings");
  if (root.version !== 1) throw new Error("settings.version must be 1");
  const home = fs.realpathSync(homeDirectory);
  const filesystem = plainObject(root.filesystem, "settings.filesystem");
  exactKeys(filesystem, ["workspace", "workspaceOverrides", "bareCommon", "externalMounts"], "settings.filesystem");
  const workspace = accessPolicy(filesystem.workspace, "settings.filesystem.workspace");
  const bareCommon = accessPolicy(filesystem.bareCommon, "settings.filesystem.bareCommon");
  if (!Array.isArray(filesystem.workspaceOverrides) || filesystem.workspaceOverrides.length > 64) {
    throw new Error("settings.filesystem.workspaceOverrides must be an array with at most 64 entries");
  }
  const overrideRoots = new Set<string>();
  const workspaceOverrides = filesystem.workspaceOverrides.map((entry, index) => {
    const override = plainObject(entry, `settings.filesystem.workspaceOverrides[${index}]`);
    exactKeys(override, ["root", "access", "writeProtectedPaths"], `settings.filesystem.workspaceOverrides[${index}]`);
    const { root: configuredRoot, canonicalRoot } = canonicalWorkspaceOverrideRoot(
      override.root,
      `settings.filesystem.workspaceOverrides[${index}].root`,
      home,
    );
    if (overrideRoots.has(canonicalRoot)) {
      throw new Error("settings.filesystem.workspaceOverrides contains duplicate canonical roots");
    }
    overrideRoots.add(canonicalRoot);
    const policy = accessPolicy(
      { access: override.access, writeProtectedPaths: override.writeProtectedPaths },
      `settings.filesystem.workspaceOverrides[${index}]`,
    );
    return { root: configuredRoot, ...policy };
  });
  if (!Array.isArray(filesystem.externalMounts) || filesystem.externalMounts.length > 64) {
    throw new Error("settings.filesystem.externalMounts must be an array with at most 64 entries");
  }
  const externalMounts = filesystem.externalMounts.map((entry, index) => {
    const mount = plainObject(entry, `settings.filesystem.externalMounts[${index}]`);
    exactKeys(mount, ["path", "access"], `settings.filesystem.externalMounts[${index}]`);
    if (mount.access !== "ro" && mount.access !== "rw") {
      throw new Error(`settings.filesystem.externalMounts[${index}].access must be ro or rw`);
    }
    return {
      path: nonemptyString(mount.path, `settings.filesystem.externalMounts[${index}].path`),
      access: mount.access,
    };
  });

  const network = plainObject(root.network, "settings.network");
  exactKeys(network, ["mode", "allowedHosts", "allowWebSockets", "tcpMappings"], "settings.network");
  if (!new Set(["public-http", "public-tcp", "allowlist", "offline"]).has(network.mode as string)) {
    throw new Error("settings.network.mode is invalid");
  }
  if (!Array.isArray(network.allowedHosts) || network.allowedHosts.length > 128) {
    throw new Error("settings.network.allowedHosts must have at most 128 entries");
  }
  const allowedHosts = network.allowedHosts.map((entry, index) =>
    hostname(entry, `settings.network.allowedHosts[${index}]`, true),
  );
  if (new Set(allowedHosts).size !== allowedHosts.length) {
    throw new Error("settings.network.allowedHosts contains duplicates");
  }
  if (typeof network.allowWebSockets !== "boolean") {
    throw new Error("settings.network.allowWebSockets must be boolean");
  }
  if (!Array.isArray(network.tcpMappings) || network.tcpMappings.length > 32) {
    throw new Error("settings.network.tcpMappings must have at most 32 entries");
  }
  const tcpMappings = network.tcpMappings.map((entry, index) => {
    const mapping = plainObject(entry, `settings.network.tcpMappings[${index}]`);
    exactKeys(mapping, ["guestHost", "guestPort", "connectHost", "connectPort"], `tcpMappings[${index}]`);
    return {
      guestHost: hostname(mapping.guestHost, `settings.network.tcpMappings[${index}].guestHost`, false),
      guestPort: port(mapping.guestPort, `settings.network.tcpMappings[${index}].guestPort`),
      connectHost: hostname(mapping.connectHost, `settings.network.tcpMappings[${index}].connectHost`, false),
      connectPort: port(mapping.connectPort, `settings.network.tcpMappings[${index}].connectPort`),
    };
  });
  const tcpKeys = tcpMappings.map((entry) => `${entry.guestHost}:${entry.guestPort}`);
  if (new Set(tcpKeys).size !== tcpKeys.length) {
    throw new Error("settings.network.tcpMappings contains duplicate guest targets");
  }

  const mode = network.mode as NetworkMode;
  if ((mode === "public-http" || mode === "public-tcp") && allowedHosts.length > 0) {
    throw new Error(`${mode} mode does not use allowedHosts`);
  }
  if (mode === "allowlist" && allowedHosts.length === 0) {
    throw new Error("allowlist mode requires at least one allowed host");
  }
  if (mode === "offline" && (allowedHosts.length > 0 || network.allowWebSockets || tcpMappings.length > 0)) {
    throw new Error("offline mode cannot enable hosts, WebSockets, or TCP mappings");
  }

  const ingress = root.ingress === undefined ? { workspaceProfiles: [] } : plainObject(root.ingress, "settings.ingress");
  exactKeys(ingress, ["workspaceProfiles"], "settings.ingress");
  if (!Array.isArray(ingress.workspaceProfiles) || ingress.workspaceProfiles.length > maxIngressProfiles) {
    throw new Error(`settings.ingress.workspaceProfiles must be an array with at most ${maxIngressProfiles} entries`);
  }
  const ingressRoots = new Set<string>();
  const workspaceProfiles = ingress.workspaceProfiles.map((entry, index) => {
    const label = `settings.ingress.workspaceProfiles[${index}]`;
    const profile = plainObject(entry, label);
    exactKeys(profile, ["root", "allowWebSockets", "listeners"], label);
    const { root: configuredRoot, canonicalRoot } = canonicalWorkspaceOverrideRoot(profile.root, `${label}.root`, home);
    if (ingressRoots.has(canonicalRoot)) {
      throw new Error("settings.ingress.workspaceProfiles contains duplicate canonical roots");
    }
    ingressRoots.add(canonicalRoot);
    if (typeof profile.allowWebSockets !== "boolean") {
      throw new Error(`${label}.allowWebSockets must be boolean`);
    }
    if (!Array.isArray(profile.listeners) || profile.listeners.length > maxIngressListeners) {
      throw new Error(`${label}.listeners must be an array with at most ${maxIngressListeners} entries`);
    }
    const names = new Set<string>();
    const preferredPorts = new Set<number>();
    const listeners = profile.listeners.map((listenerEntry, listenerIndex) => {
      const listenerLabel = `${label}.listeners[${listenerIndex}]`;
      const listener = plainObject(listenerEntry, listenerLabel);
      exactKeys(listener, ["name", "hostPort", "guestPort"], listenerLabel);
      const name = ingressListenerName(listener.name, `${listenerLabel}.name`);
      const nameKey = name.toLowerCase();
      if (names.has(nameKey)) throw new Error(`${label}.listeners contains duplicate names`);
      names.add(nameKey);
      const preferredHostPort = hostPort(listener.hostPort, `${listenerLabel}.hostPort`);
      if (preferredHostPort !== 0) {
        if (preferredPorts.has(preferredHostPort)) throw new Error(`${label}.listeners contains duplicate preferred host ports`);
        preferredPorts.add(preferredHostPort);
      }
      return { name, hostPort: preferredHostPort, guestPort: port(listener.guestPort, `${listenerLabel}.guestPort`) };
    });
    return { root: configuredRoot, allowWebSockets: profile.allowWebSockets, listeners };
  });

  return {
    version: 1,
    filesystem: { workspace, workspaceOverrides, bareCommon, externalMounts },
    network: { mode, allowedHosts, allowWebSockets: network.allowWebSockets, tcpMappings },
    ingress: { workspaceProfiles },
  };
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function canonicalIfPresent(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function signingPublicKeyPath(home: string): string {
  return canonicalIfPresent(path.join(home, ".ssh", "git", "id_ed25519_signing.pub"));
}

function invariantRoots(home: string): string[] {
  return [
    path.join(home, ".pi"),
    path.join(home, ".dotfiles", "pi"),
    path.join(home, ".config", "ketch"),
    path.join(home, "Library", "Application Support", "ketch"),
    path.join(home, ".dotfiles", "ketch"),
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".config", "gcloud"),
    path.join(home, ".config", "gh"),
    path.join(home, ".config", "op"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(home, ".pypirc"),
    path.join(home, ".cargo", "credentials"),
    path.join(home, ".cargo", "credentials.toml"),
    path.join(home, "Library", "Caches"),
    path.join(home, "Library", "Containers"),
    path.join(home, ".cache", "pi-srt-routing"),
    "/var/run/docker.sock",
    path.join("/tmp", `pi-g-${process.getuid?.() ?? "user"}`),
  ].map(canonicalIfPresent);
}

export function canonicalizeSandboxSettings(
  value: unknown,
  status: SandboxStatusForSettings,
  homeDirectory = os.homedir(),
): SandboxSettings {
  const home = fs.realpathSync(homeDirectory);
  const settings = validateSandboxSettings(value, home);
  const boundaries = [
    fs.realpathSync(status.workspaceRoot),
    ...(status.bareCommonDirectory ? [fs.realpathSync(status.bareCommonDirectory)] : []),
    ...invariantRoots(home),
  ];
  const resolved: ExternalMountSetting[] = [];
  for (const [index, mount] of settings.filesystem.externalMounts.entries()) {
    const expanded = expandHome(mount.path, home);
    if (!path.isAbsolute(expanded)) throw new Error(`settings.filesystem.externalMounts[${index}].path must be absolute or use ~/`);
    const lexical = path.resolve(expanded);
    if (lexical === path.parse(lexical).root || lexical === home) {
      throw new Error(`settings.filesystem.externalMounts[${index}] cannot mount / or the whole home directory`);
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(lexical);
    } catch {
      throw new Error(`settings.filesystem.externalMounts[${index}] does not exist: ${mount.path}`);
    }
    const isSigningPublicKey =
      canonical === signingPublicKeyPath(home) && fs.statSync(canonical).isFile() && mount.access === "ro";
    if (!fs.statSync(canonical).isDirectory() && !isSigningPublicKey) {
      throw new Error(`settings.filesystem.externalMounts[${index}] must be a directory or the read-only signing public key`);
    }
    if (!isSigningPublicKey && boundaries.some((boundary) => overlaps(canonical, boundary) || overlaps(lexical, boundary))) {
      throw new Error(`settings.filesystem.externalMounts[${index}] overlaps a code-enforced sandbox boundary`);
    }
    if (resolved.some((entry) => overlaps(entry.path, canonical))) {
      throw new Error(`settings.filesystem.externalMounts[${index}] overlaps another external mount`);
    }
    resolved.push({ path: canonical, access: mount.access });
  }
  return {
    ...settings,
    filesystem: { ...settings.filesystem, externalMounts: resolved },
  };
}

export class SandboxSettingsStore {
  readonly settingsPath: string;
  readonly homeDirectory: string;

  constructor(settingsPath = path.join(os.homedir(), ".pi", "sandbox", "settings.json"), homeDirectory = os.homedir()) {
    this.settingsPath = settingsPath;
    this.homeDirectory = homeDirectory;
  }

  load(): SandboxSettings {
    return validateSandboxSettings(JSON.parse(fs.readFileSync(this.settingsPath, "utf8")), this.homeDirectory);
  }

  async save(value: unknown, status: SandboxStatusForSettings): Promise<SandboxSettings> {
    const normalized = canonicalizeSandboxSettings(value, status, this.homeDirectory);
    const queueKey = fs.realpathSync(this.settingsPath);
    const previous = writeQueues.get(queueKey) ?? Promise.resolve();
    let saved!: SandboxSettings;
    const next = previous.catch(() => {}).then(async () => {
      const target = fs.realpathSync(this.settingsPath);
      await withSettingsLock(target, () => {
        const metadata = fs.statSync(target);
        const temporary = path.join(
          path.dirname(target),
          `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
        );
        try {
          fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
            mode: metadata.mode & 0o777,
            flag: "wx",
          });
          fs.renameSync(temporary, target);
        } catch (error) {
          fs.rmSync(temporary, { force: true });
          throw error;
        }
        saved = normalized;
      });
    });
    writeQueues.set(queueKey, next);
    return next.finally(() => {
      if (writeQueues.get(queueKey) === next) writeQueues.delete(queueKey);
    }).then(() => saved);
  }
}
