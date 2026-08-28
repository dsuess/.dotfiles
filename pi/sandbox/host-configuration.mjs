import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFile = promisify(execFileCallback);
const TOKEN_ENV_NAMES = /^(?:GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|SSH_AUTH_SOCK|DOCKER_|SBX_|AWS_|AZURE_|GOOGLE_|PI_)/;
const FORBIDDEN_PATH_PARTS = new Set([".pi", ".codex", ".sbx", ".local/share/uv/credentials", "Library/Application Support/com.docker.sandboxes"]);
const USER_TOOL_ROOTS = [".local/bin", ".local/share/uv/tools", ".local/share/uv/python"];
const DEFAULT_EXECUTABLE_ROOTS = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), "bin"), path.join(os.homedir(), ".local/bin")];
const DEFAULT_SHELL_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile"];

function realFile(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isFile() ? resolved : null;
  } catch { return null; }
}

function realDirectory(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch { return null; }
}

function isForbidden(candidate, home) {
  const relative = path.relative(home, candidate);
  return relative === "" || [...FORBIDDEN_PATH_PARTS].some((part) =>
    candidate === path.join(home, part) || candidate.startsWith(`${path.join(home, part)}${path.sep}`));
}

function addFile(target, candidate, home) {
  const resolved = realFile(candidate);
  if (resolved && !isForbidden(resolved, home)) target.add(resolved);
}

/** Strip ambient authority before every controller-owned fixed spawn. */
export function sanitizedFixedEnvironment(environment = process.env) {
  const safe = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || TOKEN_ENV_NAMES.test(key)) continue;
    if (["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME"].includes(key)) safe[key] = value;
  }
  return safe;
}

/**
 * Resolve only controller-reviewed, non-secret host configuration. Every result
 * is a real canonical path; callers hand these exact paths to the SRT policy.
 */
export function resolveUserToolRuntime(options = {}) {
  const home = fs.realpathSync(options.home ?? os.homedir());
  const [bin, toolDir, pythonInstallDir] = USER_TOOL_ROOTS.map((item) => realDirectory(path.join(home, item)));
  return { bin, toolDir, pythonInstallDir };
}

export function resolveHostReadManifest(options = {}) {
  const home = fs.realpathSync(options.home ?? os.homedir());
  const dotfilesRoot = realDirectory(options.dotfilesRoot ?? path.join(home, ".dotfiles"));
  const files = new Set();
  const roots = new Set();
  for (const name of DEFAULT_SHELL_FILES) addFile(files, path.join(home, name), home);
  for (const candidate of [
    path.join(home, ".gitconfig"), path.join(home, ".config/git/config"),
    path.join(home, ".config/git/ignore"), path.join(home, ".config/uv/uv.toml"),
    path.join(home, ".config/uv/config.toml"), path.join(home, ".ssh/config"), path.join(home, ".ssh/known_hosts"),
  ]) addFile(files, candidate, home);
  for (const candidate of options.gitConfigOrigins ?? []) addFile(files, candidate, home);
  for (const candidate of options.signingMaterial ?? []) addFile(files, candidate, home);
  if (dotfilesRoot) roots.add(dotfilesRoot);
  for (const candidate of ["/opt/homebrew", "/usr/local", path.join(home, "bin"), ...USER_TOOL_ROOTS.map((item) => path.join(home, item)), ...(options.toolRoots ?? [])]) {
    const resolved = realDirectory(candidate);
    if (resolved && !isForbidden(resolved, home)) roots.add(resolved);
  }
  for (const candidate of options.additionalReadOnly ?? []) {
    const resolved = realFile(candidate);
    if (!resolved || isForbidden(resolved, home) || resolved.startsWith(`${path.join(home, ".ssh")}${path.sep}`)) {
      throw new Error("additional read-only path is not eligible");
    }
    files.add(resolved);
  }
  return { files: [...files].sort(), roots: [...roots].sort() };
}

export function validateAdditionalHostPath(candidate, access, options = {}) {
  const home = fs.realpathSync(options.home ?? os.homedir());
  const workspaceRoot = options.workspaceRoot && fs.realpathSync(options.workspaceRoot);
  const resolved = fs.realpathSync(candidate);
  if (!path.isAbsolute(candidate) || isForbidden(resolved, home)) throw new Error("path is a non-grantable runtime or credential root");
  if (resolved === home || (workspaceRoot && (resolved === workspaceRoot || resolved.startsWith(`${workspaceRoot}${path.sep}`)))) {
    throw new Error("path overlaps home or active workspace");
  }
  if (access !== "ro" && access !== "rw") throw new Error("access must be ro or rw");
  return resolved;
}

export function findCanonicalExecutable(name, roots = DEFAULT_EXECUTABLE_ROOTS) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("invalid executable name");
  for (const root of roots) {
    const canonicalRoot = realDirectory(root);
    const executable = canonicalRoot && realFile(path.join(canonicalRoot, name));
    // Homebrew executables are symlinks from /opt/homebrew/bin into Cellar;
    // permit that reviewed parent root while still returning the real target.
    const canonicalParent = canonicalRoot && ["/opt/homebrew/bin", "/usr/local/bin"].includes(canonicalRoot)
      ? realDirectory(path.dirname(canonicalRoot))
      : null;
    const inReviewedRoot = executable && [canonicalRoot, canonicalParent].some((allowed) =>
      allowed && (executable === allowed || executable.startsWith(`${allowed}${path.sep}`)));
    if (inReviewedRoot && (fs.statSync(executable).mode & 0o111)) return executable;
  }
  throw new Error(`reviewed executable not found: ${name}`);
}

/** Read Git's declared file origins without evaluating aliases or helpers. */
export async function discoverGitConfigOrigins(options = {}) {
  const gitPath = options.gitPath ?? findCanonicalExecutable("git", options.toolRoots);
  const run = options.execFile ?? execFile;
  const { stdout } = await run(gitPath, ["config", "--global", "--includes", "--show-origin", "--null", "--list"], {
    env: sanitizedFixedEnvironment(options.environment),
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: 256 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  const origins = new Set();
  for (const record of String(stdout).split("\0")) {
    if (!record.startsWith("file:")) continue;
    const candidate = record.slice("file:".length).split(/[\t\n]/, 1)[0];
    const resolved = realFile(candidate);
    if (resolved) origins.add(resolved);
  }
  return [...origins].sort();
}

/** Resolve a GitHub token through gh only; do not inherit token variables. */
export async function resolveGitHubToken(options = {}) {
  const ghPath = options.ghPath ?? findCanonicalExecutable("gh", options.toolRoots);
  const run = options.execFile ?? execFile;
  const { stdout } = await run(ghPath, ["auth", "token", "--hostname", "github.com"], {
    env: sanitizedFixedEnvironment(options.environment),
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: 8 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  const token = String(stdout).trim();
  if (!/^[A-Za-z0-9_=-]{20,4096}$/.test(token)) throw new Error("gh returned an invalid GitHub token");
  return token;
}
