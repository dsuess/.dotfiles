import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOOL_ROOTS = ["/opt/homebrew", "/usr/local", "/usr/bin", "/bin"];
const FORBIDDEN_HOME = new Set([".pi", ".codex", ".sbx", ".aws", ".azure", ".docker", ".kube", ".ssh"]);

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
  return [...out];
}
function assertGrant(pathname, home, workspace, controllerRoot) {
  if (within(pathname, controllerRoot) || pathname === "/" || pathname === home || within(pathname, path.join(home, ".ssh"))) throw new Error("grant overlaps protected root");
  if (within(pathname, home)) {
    const first = path.relative(home, pathname).split(path.sep)[0];
    if (FORBIDDEN_HOME.has(first)) throw new Error("grant overlaps credential root");
  }
  if (within(pathname, workspace) || within(workspace, pathname)) throw new Error("additional grant overlaps workspace");
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
  const reads = new Set([...workspaceAliases, ...commonAliases, ...TOOL_ROOTS, ...generatedRoots]);
  const writes = new Set([...workspaceAliases, ...commonAliases, ...generatedRoots]);
  if (stagedHelper) reads.add(stagedHelper);
  for (const file of options.hostReadManifest?.files ?? []) reads.add(existing(file, "host read file"));
  for (const root of options.hostReadManifest?.roots ?? []) reads.add(directory(root, "host read root"));
  for (const grant of options.grants ?? []) {
    const resolved = existing(grant.path, "filesystem grant");
    assertGrant(resolved, home, workspaceRoot, controllerRoot);
    if (grant.access === "ro") reads.add(resolved);
    else if (grant.access === "rw") writes.add(resolved);
    else throw new Error("filesystem grant access is invalid");
  }
  const socketPaths = [dockerSocket];
  if (fs.existsSync("/var/run/mDNSResponder")) socketPaths.unshift("/var/run/mDNSResponder");
  const policy = {
    filesystem: {
      // SRT's write policy is allow-only.  A home-level denyWrite masks a
      // workspace nested below home, so controller state is protected by the
      // absence of a write grant instead.
      denyRead: [home, controllerRoot],
      denyWrite: [controllerRoot],
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
export const srtPolicyInternals = Object.freeze({ within, assertGrant, aliases });
