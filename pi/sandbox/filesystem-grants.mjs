import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, "config.json");
const MAX_GRANTS = 32;
const MAX_PATH_LENGTH = 4096;
const PROTECTED_HOME_ROOTS = new Set([".pi", ".codex", ".sbx", ".aws", ".azure", ".docker", ".gcp", ".kube", ".ssh"]);

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function overlaps(first, second) { return within(first, second) || within(second, first); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) throw new Error(`${label} has an invalid shape`);
}
function expandHome(value, home) {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || value.includes("\0")) throw new Error("filesystem grant path is invalid");
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  if (!path.isAbsolute(value)) throw new Error("filesystem grant path must be absolute or home-relative");
  return value;
}
function assertSafe(pathname, { home, workspaceRoot, controllerRoot }) {
  if (pathname === "/" || pathname === home) throw new Error("filesystem grant overlaps protected root");
  if (overlaps(pathname, workspaceRoot)) throw new Error("filesystem grant overlaps workspace");
  if (overlaps(pathname, controllerRoot)) throw new Error("filesystem grant overlaps controller state");
  if (!within(pathname, home)) return;
  const relative = path.relative(home, pathname);
  const [first, second] = relative.split(path.sep);
  if (PROTECTED_HOME_ROOTS.has(first) || (first === ".config" && ["gcloud", "azure", "gh"].includes(second))) throw new Error("filesystem grant overlaps credential root");
  const local = path.join(home, ".local");
  const credentials = path.join(local, "share", "uv", "credentials");
  if (overlaps(pathname, local) || overlaps(pathname, credentials)) throw new Error("filesystem grant overlaps user-tool credential root");
}
function resolveGrant(value, access, context) {
  const lexicalPath = path.resolve(expandHome(value, context.home));
  let canonicalPath;
  try {
    const stat = fs.statSync(lexicalPath);
    if (!stat.isDirectory()) throw new Error("filesystem grant is not a directory");
    canonicalPath = fs.realpathSync(lexicalPath);
  } catch (error) {
    if (error?.message === "filesystem grant is not a directory") throw error;
    throw new Error("filesystem grant directory does not exist");
  }
  assertSafe(lexicalPath, context);
  assertSafe(canonicalPath, context);
  return { path: lexicalPath, canonicalPath, access };
}

/** Loads the checked-in, startup-only filesystem grant configuration. */
export function loadFilesystemGrants(options = {}) {
  const home = fs.realpathSync(options.home ?? os.homedir());
  const workspaceRoot = fs.realpathSync(options.workspaceRoot);
  const controllerRoot = fs.realpathSync(options.controllerRoot);
  const configPath = options.configPath ?? CONFIG_PATH;
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { throw new Error("sandbox filesystem configuration is missing or invalid JSON"); }
  exactKeys(config, ["version", "filesystem"], "sandbox filesystem configuration");
  if (config.version !== 1) throw new Error("sandbox filesystem configuration version is unsupported");
  exactKeys(config.filesystem, ["readOnly", "readWrite"], "sandbox filesystem configuration filesystem");
  const context = { home, workspaceRoot, controllerRoot };
  const grants = [];
  for (const [access, entries] of [["ro", config.filesystem.readOnly], ["rw", config.filesystem.readWrite]]) {
    if (!Array.isArray(entries) || entries.length > MAX_GRANTS) throw new Error("sandbox filesystem grants must be bounded arrays");
    for (const entry of entries) grants.push(resolveGrant(entry, access, context));
  }
  const canonical = new Set();
  for (const grant of grants) {
    if (canonical.has(grant.canonicalPath)) throw new Error("sandbox filesystem grants contain duplicate or overlapping paths");
    for (const other of canonical) if (overlaps(grant.canonicalPath, other)) throw new Error("sandbox filesystem grants contain duplicate or overlapping paths");
    canonical.add(grant.canonicalPath);
  }
  return Object.freeze(grants.map((grant) => Object.freeze(grant)));
}

export const filesystemGrantInternals = Object.freeze({ expandHome, overlaps, assertSafe });
