import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, "config.json");
export const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_GRANTS = 32;
const MAX_PATH_LENGTH = 4096;
const PROTECTED_HOME_ROOTS = [
  ".pi", ".pi/agent", ".pi/sandbox", ".codex", ".sbx", ".aws", ".azure", ".docker", ".gcp", ".kube", ".ssh",
  ".config/gcloud", ".config/azure", ".config/gh", ".local", "Library/Application Support/com.docker.sandboxes",
];

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function overlaps(first, second) { return within(first, second) || within(second, first); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new Error(`${label} has an invalid shape`);
}
function expandHome(value, home) {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(value)) throw new Error("filesystem grant path is invalid (maximum 4096 characters; no NUL or line breaks)");
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  if (!path.isAbsolute(value)) throw new Error("filesystem grant path must be absolute or home-relative (~/...)");
  return value;
}
function directory(value, label) {
  try {
    const canonical = fs.realpathSync(value);
    if (fs.statSync(canonical).isDirectory()) return canonical;
  } catch {}
  throw new Error(`${label} must be an existing directory`);
}
// Protect a root even when its final components do not yet exist, or when an
// existing parent (for example ~/.config) is itself a symlink.
function canonicalBoundary(value) {
  try { return fs.realpathSync(value); } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    const parent = path.dirname(value);
    if (parent === value) throw error;
    return path.join(canonicalBoundary(parent), path.basename(value));
  }
}
export function filesystemGrantContext(options = {}) {
  const lexicalHome = path.resolve(options.home ?? os.homedir());
  const home = directory(lexicalHome, "home");
  const workspaceRoot = directory(options.workspaceRoot, "workspace root");
  const controllerRoot = directory(options.controllerRoot ?? options.runtimeRoot, "controller root");
  const homes = [...new Set([lexicalHome, home])];
  const protectedRoots = homes.flatMap((root) => PROTECTED_HOME_ROOTS.flatMap((part) => {
    const lexical = path.join(root, part);
    return [{ path: lexical, part }, { path: canonicalBoundary(lexical), part }];
  }));
  return { home, homes, workspaceRoot, controllerRoot, protectedRoots,
    workspaceRoots: [...new Set([path.resolve(options.workspaceRoot), workspaceRoot])],
    controllerRoots: [...new Set([path.resolve(options.controllerRoot ?? options.runtimeRoot), controllerRoot])] };
}
function assertSafe(pathname, context) {
  if (pathname === path.parse(pathname).root || context.homes.some((root) => within(root, pathname))) throw new Error("filesystem grant overlaps protected home root; choose a narrower directory");
  if (context.workspaceRoots.some((root) => overlaps(pathname, root))) throw new Error("filesystem grant overlaps workspace; workspace access is derived, not a saved grant");
  if (context.controllerRoots.some((root) => overlaps(pathname, root))) throw new Error("filesystem grant overlaps controller state");
  for (const root of context.protectedRoots) {
    if (!overlaps(pathname, root.path)) continue;
    if (root.part === ".local") throw new Error("filesystem grant overlaps user-tool credential root");
    throw new Error("filesystem grant overlaps credential root or protected runtime root");
  }
}
export function resolveFilesystemGrant(value, access, options = {}) {
  if (access !== "ro" && access !== "rw") throw new Error("filesystem grant access must be ro or rw");
  const context = options.protectedRoots ? options : filesystemGrantContext(options);
  const lexicalPath = path.resolve(expandHome(value, context.home));
  if (lexicalPath.length > MAX_PATH_LENGTH) throw new Error("filesystem grant path is too long after home expansion");
  assertSafe(lexicalPath, context);
  let canonicalPath;
  try {
    if (!fs.statSync(lexicalPath).isDirectory()) throw new Error("filesystem grant is not a directory");
    canonicalPath = fs.realpathSync(lexicalPath);
  } catch (error) {
    if (error?.message === "filesystem grant is not a directory") throw error;
    throw new Error("filesystem grant directory does not exist or cannot be accessed; create it separately before granting access");
  }
  if (canonicalPath.length > MAX_PATH_LENGTH) throw new Error("filesystem grant canonical path is too long");
  assertSafe(canonicalPath, context);
  return Object.freeze({ path: lexicalPath, canonicalPath, access });
}

/** Shared saved-config and effective-policy validation. No filesystem mutation. */
export function validateFilesystemGrants(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length > MAX_GRANTS) throw new Error("sandbox filesystem grants must be bounded arrays (maximum 32 grants)");
  const context = filesystemGrantContext(options);
  const grants = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("filesystem grant has an invalid shape");
    const grant = resolveFilesystemGrant(entry.path, entry.access, context);
    if (entry.canonicalPath !== undefined && entry.canonicalPath !== grant.canonicalPath) throw new Error("filesystem grant symlink target changed; reload and retry");
    return grant;
  });
  for (let index = 0; index < grants.length; index += 1) {
    const first = grants[index];
    for (const second of grants.slice(index + 1)) {
      if ([first.path, first.canonicalPath].some((one) => [second.path, second.canonicalPath].some((two) => overlaps(one, two)))) throw new Error("sandbox filesystem grants contain duplicate or overlapping paths; remove the existing grant first");
    }
  }
  return Object.freeze(grants);
}
export function validateFilesystemConfiguration(config, options = {}) {
  exactKeys(config, ["version", "filesystem"], "sandbox filesystem configuration");
  if (config.version !== 1) throw new Error("sandbox filesystem configuration version is unsupported");
  exactKeys(config.filesystem, ["readOnly", "readWrite"], "sandbox filesystem configuration filesystem");
  const entries = [];
  for (const [access, paths] of [["ro", config.filesystem.readOnly], ["rw", config.filesystem.readWrite]]) {
    if (!Array.isArray(paths) || paths.length > MAX_GRANTS) throw new Error("sandbox filesystem grants must be bounded arrays (maximum 32 grants)");
    for (const value of paths) entries.push({ path: value, access });
  }
  return validateFilesystemGrants(entries, options);
}
export function parseFilesystemConfiguration(bytes) {
  if (Buffer.byteLength(bytes) > MAX_CONFIG_BYTES) throw new Error("sandbox filesystem configuration is too large (maximum 256 KiB)");
  try { return JSON.parse(String(bytes)); } catch { throw new Error("sandbox filesystem configuration is missing or invalid JSON"); }
}

/** Bound reads even if a host writer grows the file after the initial stat. */
export function readFilesystemConfigurationSource(configPath = CONFIG_PATH) {
  const lexicalPath = path.resolve(configPath), targetPath = fs.realpathSync(lexicalPath);
  if (!fs.lstatSync(targetPath).isFile()) throw new Error("sandbox filesystem configuration must be an existing regular file");
  const fd = fs.openSync(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("sandbox filesystem configuration must be an existing regular file");
    if (stat.size > MAX_CONFIG_BYTES) throw new Error("sandbox filesystem configuration is too large (maximum 256 KiB)");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error("sandbox filesystem configuration is too large (maximum 256 KiB)");
    return { configPath: lexicalPath, targetPath, bytes: buffer.subarray(0, length), stat };
  } finally { fs.closeSync(fd); }
}

/** Load the existing versioned JSON schema; never creates grant directories. */
export function loadFilesystemGrants(options = {}) {
  let source;
  try { source = readFilesystemConfigurationSource(options.configPath); } catch (error) {
    if (!error.code) throw error;
    throw new Error("sandbox filesystem configuration is missing or unreadable");
  }
  return validateFilesystemConfiguration(parseFilesystemConfiguration(source.bytes), options);
}

export const filesystemGrantInternals = Object.freeze({ expandHome, overlaps, assertSafe });
