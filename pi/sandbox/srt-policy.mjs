import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateFilesystemGrants } from "./filesystem-grants.mjs";

const TOOL_ROOTS = ["/opt/homebrew", "/usr/local", "/usr/bin", "/bin"];

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function directory(value, label) {
  const resolved = fs.realpathSync(value);
  if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory`);
  return resolved;
}
function existing(value, label) {
  const resolved = fs.realpathSync(value);
  if (!path.isAbsolute(resolved)) throw new Error(`${label} is not absolute`);
  return resolved;
}
function aliases(value) {
  const resolved = fs.realpathSync(value);
  const out = new Set([resolved, path.resolve(value)]);
  for (const item of [...out]) {
    if (item === "/var" || item.startsWith("/var/")) out.add(`/private${item}`);
    if (item === "/private" || item.startsWith("/private/")) out.add(item.slice(8) || "/");
  }
  // Never turn a textual /private alias into authority for a different root.
  return [...out].filter((item) => {
    try { return fs.realpathSync(item) === resolved; } catch { return false; }
  });
}
function assertHostReadRoot(pathname, home) {
  const local = path.join(home, ".local");
  const uvCredentials = path.join(local, "share", "uv", "credentials");
  if (pathname === local || within(pathname, uvCredentials) || within(uvCredentials, pathname)) {
    throw new Error("host read root overlaps user-tool credential root");
  }
}

/** Immutable, controller-derived SRT policy. Controller state is never writable. */
export function buildSrtPolicy(options) {
  const home = directory(options.home ?? os.homedir(), "home");
  const workspaceRoot = directory(options.workspaceRoot, "workspace root");
  const controllerRoot = directory(options.controllerRoot ?? options.runtimeRoot, "controller root");
  const common = options.bareCommonDirectory ? directory(options.bareCommonDirectory, "common Git directory") : null;
  const dockerSocket = existing(options.dockerSocket, "Docker socket");
  if (within(dockerSocket, workspaceRoot) || within(dockerSocket, home) || within(dockerSocket, controllerRoot)) throw new Error("Docker socket must be outside writable roots");
  const workspaceAliases = aliases(options.workspaceRoot);
  const commonAliases = common ? aliases(common) : [];
  const stagedHelper = options.stagedHelper ? existing(options.stagedHelper, "staged helper") : null;
  const generatedRoots = (options.generatedRoots ?? []).map((item) => directory(item, "generated tool directory"));
  const toolFiles = (options.toolFiles ?? []).map((item) => existing(item, "reviewed Docker client file"));
  const reads = new Set([...workspaceAliases, ...commonAliases, ...TOOL_ROOTS, ...generatedRoots, ...toolFiles]);
  const writes = new Set([...workspaceAliases, ...commonAliases, ...generatedRoots]);
  if (stagedHelper) reads.add(stagedHelper);
  for (const file of options.hostReadManifest?.files ?? []) reads.add(existing(file, "host read file"));
  for (const root of options.hostReadManifest?.roots ?? []) {
    const resolved = directory(root, "host read root");
    assertHostReadRoot(resolved, home);
    reads.add(resolved);
  }
  for (const grant of validateFilesystemGrants(options.grants ?? [], { ...options, home: options.home ?? home, controllerRoot: options.controllerRoot ?? options.runtimeRoot })) {
    const grantAliases = aliases(grant.path);
    if (grant.access === "ro") grantAliases.forEach((item) => reads.add(item));
    else if (grant.access === "rw") grantAliases.forEach((item) => { reads.add(item); writes.add(item); });
    else throw new Error("filesystem grant access is invalid");
  }
  // Explicit, narrow denies must override even a broad workspace grant. This
  // authority store is never part of generated HOME or the Stow agent tree.
  const approvalRoots = [...new Set([path.join(home, ".pi/routed-mcp"), path.join(path.resolve(options.home ?? os.homedir()), ".pi/routed-mcp")])];
  const socketPaths = [dockerSocket];
  if (fs.existsSync("/var/run/mDNSResponder")) socketPaths.unshift("/var/run/mDNSResponder");
  const policy = {
    filesystem: {
      // SRT's write policy is allow-only.  A home-level denyWrite masks a
      // workspace nested below home, so controller state is protected by the
      // absence of a write grant instead.
      denyRead: [home, controllerRoot, ...approvalRoots],
      denyWrite: [controllerRoot, ...approvalRoots],
      allowRead: [...reads].sort(),
      allowWrite: [...writes].sort(),
      allowGitConfig: true,
      allowCompleteWorkspaceWrites: [...workspaceAliases, ...commonAliases],
    },
    network: {
      allowedDomains: [], deniedDomains: [], allowUnrestrictedIp: true,
      allowLocalBinding: true, allowUnixSockets: [...new Set(socketPaths.flatMap(aliases))],
    },
  };
  return Object.freeze({ ...policy, workspaceRoot, bareCommonDirectory: common, controllerRoot, dockerSocket, generation: createHash("sha256").update(JSON.stringify(policy)).digest("hex") });
}
export const srtPolicyInternals = Object.freeze({ within, assertHostReadRoot, aliases });
