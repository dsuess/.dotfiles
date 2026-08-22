import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type NetworkMode = "public-http" | "allowlist" | "offline";
export type MountAccess = "ro" | "rw";

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

export interface SandboxSettings {
  version: 1;
  externalMounts: ExternalMountSetting[];
  network: {
    mode: NetworkMode;
    allowedHosts: string[];
    allowWebSockets: boolean;
    tcpMappings: TcpMappingSetting[];
  };
}

export interface SandboxStatusForSettings {
  workspaceRoot: string;
  bareCommonDirectory: string | null;
}

const writeQueues = new Map<string, Promise<void>>();

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

export function validateSandboxSettings(value: unknown): SandboxSettings {
  const root = plainObject(value, "settings");
  exactKeys(root, ["version", "externalMounts", "network"], "settings");
  if (root.version !== 1) throw new Error("settings.version must be 1");
  if (!Array.isArray(root.externalMounts) || root.externalMounts.length > 64) {
    throw new Error("settings.externalMounts must be an array with at most 64 entries");
  }
  const externalMounts = root.externalMounts.map((entry, index) => {
    const mount = plainObject(entry, `externalMounts[${index}]`);
    exactKeys(mount, ["path", "access"], `externalMounts[${index}]`);
    if (mount.access !== "ro" && mount.access !== "rw") {
      throw new Error(`externalMounts[${index}].access must be ro or rw`);
    }
    return {
      path: nonemptyString(mount.path, `externalMounts[${index}].path`),
      access: mount.access,
    };
  });

  const network = plainObject(root.network, "settings.network");
  exactKeys(network, ["mode", "allowedHosts", "allowWebSockets", "tcpMappings"], "settings.network");
  if (!new Set(["public-http", "allowlist", "offline"]).has(network.mode as string)) {
    throw new Error("settings.network.mode is invalid");
  }
  if (!Array.isArray(network.allowedHosts) || network.allowedHosts.length > 128) {
    throw new Error("settings.network.allowedHosts must have at most 128 entries");
  }
  const allowedHosts = network.allowedHosts.map((entry, index) =>
    hostname(entry, `allowedHosts[${index}]`, true),
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
    const mapping = plainObject(entry, `tcpMappings[${index}]`);
    exactKeys(mapping, ["guestHost", "guestPort", "connectHost", "connectPort"], `tcpMappings[${index}]`);
    return {
      guestHost: hostname(mapping.guestHost, `tcpMappings[${index}].guestHost`, false),
      guestPort: port(mapping.guestPort, `tcpMappings[${index}].guestPort`),
      connectHost: hostname(mapping.connectHost, `tcpMappings[${index}].connectHost`, false),
      connectPort: port(mapping.connectPort, `tcpMappings[${index}].connectPort`),
    };
  });
  const tcpKeys = tcpMappings.map((entry) => `${entry.guestHost}:${entry.guestPort}`);
  if (new Set(tcpKeys).size !== tcpKeys.length) {
    throw new Error("settings.network.tcpMappings contains duplicate guest targets");
  }

  const mode = network.mode as NetworkMode;
  if (mode === "public-http" && allowedHosts.length > 0) {
    throw new Error("public-http mode does not use allowedHosts");
  }
  if (mode === "allowlist" && allowedHosts.length === 0) {
    throw new Error("allowlist mode requires at least one allowed host");
  }
  if (mode === "offline" && (allowedHosts.length > 0 || network.allowWebSockets || tcpMappings.length > 0)) {
    throw new Error("offline mode cannot enable hosts, WebSockets, or TCP mappings");
  }

  return {
    version: 1,
    externalMounts,
    network: {
      mode,
      allowedHosts,
      allowWebSockets: network.allowWebSockets,
      tcpMappings,
    },
  };
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

function canonicalIfPresent(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
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
    path.join(home, ".cache", "pi-gondolin"),
    "/var/run/docker.sock",
    path.join("/tmp", `pi-g-${process.getuid?.() ?? "user"}`),
  ].map(canonicalIfPresent);
}

export function canonicalizeSandboxSettings(
  value: unknown,
  status: SandboxStatusForSettings,
  homeDirectory = os.homedir(),
): SandboxSettings {
  const settings = validateSandboxSettings(value);
  const home = fs.realpathSync(homeDirectory);
  const boundaries = [
    fs.realpathSync(status.workspaceRoot),
    ...(status.bareCommonDirectory ? [fs.realpathSync(status.bareCommonDirectory)] : []),
    ...invariantRoots(home),
  ];
  const resolved: ExternalMountSetting[] = [];
  for (const [index, mount] of settings.externalMounts.entries()) {
    const expanded = expandHome(mount.path, home);
    if (!path.isAbsolute(expanded)) throw new Error(`externalMounts[${index}].path must be absolute or use ~/`);
    const lexical = path.resolve(expanded);
    if (lexical === path.parse(lexical).root || lexical === home) {
      throw new Error(`externalMounts[${index}] cannot mount / or the whole home directory`);
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(lexical);
    } catch {
      throw new Error(`externalMounts[${index}] does not exist: ${mount.path}`);
    }
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error(`externalMounts[${index}] must be a directory`);
    }
    if (boundaries.some((boundary) => overlaps(canonical, boundary) || overlaps(lexical, boundary))) {
      throw new Error(`externalMounts[${index}] overlaps a code-enforced sandbox boundary`);
    }
    if (resolved.some((entry) => overlaps(entry.path, canonical))) {
      throw new Error(`externalMounts[${index}] overlaps another external mount`);
    }
    resolved.push({ path: canonical, access: mount.access });
  }
  return { ...settings, externalMounts: resolved };
}

export class SandboxSettingsStore {
  readonly settingsPath: string;

  constructor(settingsPath = path.join(os.homedir(), ".pi", "sandbox", "settings.json")) {
    this.settingsPath = settingsPath;
  }

  load(): SandboxSettings {
    return validateSandboxSettings(JSON.parse(fs.readFileSync(this.settingsPath, "utf8")));
  }

  async save(value: unknown, status: SandboxStatusForSettings): Promise<SandboxSettings> {
    const normalized = canonicalizeSandboxSettings(value, status);
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
