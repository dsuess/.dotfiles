import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function canonicalDirectory(directory) {
  const canonical = fs.realpathSync(directory);
  if (!fs.statSync(canonical).isDirectory()) {
    throw new Error(`not a directory: ${directory}`);
  }
  return canonical;
}

function isLiteralPath(candidate) {
  return !/[?*\[\]]/.test(candidate);
}

function addUnique(items, value) {
  if (path.isAbsolute(value) && !items.includes(value)) items.push(value);
}

function readFirstLine(filePath) {
  const value = fs.readFileSync(filePath, "utf8");
  return value.split(/\r?\n/, 1)[0];
}

/**
 * Find candidate repository paths without running repository-controlled code.
 * These are executable-lookup exclusions only until trusted Git verifies them.
 */
export function discoverBootstrapExclusions(launchDirectory) {
  const physicalLaunchDirectory = canonicalDirectory(launchDirectory);
  const excludedRoots = [physicalLaunchDirectory];
  let cursor = physicalLaunchDirectory;
  let candidateWorktreeRoot = null;

  while (true) {
    const dotGit = path.join(cursor, ".git");
    try {
      fs.lstatSync(dotGit);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") break;
      if (cursor === path.parse(cursor).root) break;
      cursor = path.dirname(cursor);
      continue;
    }

    candidateWorktreeRoot = cursor;
    addUnique(excludedRoots, cursor);
    try {
      let metadataDirectory = null;
      const dotGitStat = fs.statSync(dotGit);
      if (dotGitStat.isDirectory()) {
        metadataDirectory = canonicalDirectory(dotGit);
      } else if (dotGitStat.isFile()) {
        const marker = readFirstLine(dotGit);
        if (!marker.startsWith("gitdir: ")) throw new Error("malformed .git marker");
        let hint = marker.slice("gitdir: ".length);
        if (!hint) throw new Error("empty .git marker");
        if (!path.isAbsolute(hint)) hint = path.join(cursor, hint);
        metadataDirectory = canonicalDirectory(hint);
      } else {
        throw new Error("unsupported .git marker");
      }
      addUnique(excludedRoots, metadataDirectory);

      const commonMarker = path.join(metadataDirectory, "commondir");
      if (fs.existsSync(commonMarker)) {
        let commonHint = readFirstLine(commonMarker);
        if (!commonHint) throw new Error("empty commondir marker");
        if (!path.isAbsolute(commonHint)) commonHint = path.join(metadataDirectory, commonHint);
        addUnique(excludedRoots, canonicalDirectory(commonHint));
      }
    } catch {
      // Keep the candidate root excluded, but let trusted verification fail narrow.
    }
    break;
  }

  return Object.freeze({
    physicalLaunchDirectory,
    candidateWorktreeRoot,
    excludedRoots: Object.freeze([...excludedRoots]),
  });
}

export function getSafePathEntries(pathValue, excludedRoots) {
  const safe = [];
  for (const entry of String(pathValue ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    let canonical;
    try {
      canonical = canonicalDirectory(entry);
    } catch {
      continue;
    }
    if (excludedRoots.some((root) => isWithin(canonical, root))) continue;
    if (!safe.includes(canonical)) safe.push(canonical);
  }
  return safe;
}

export function findTrustedExecutable(name, pathValue, excludedRoots) {
  if (!name || name.includes(path.sep)) throw new Error("executable name must be a basename");
  for (const directory of getSafePathEntries(pathValue, excludedRoots)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fsConstants.X_OK);
      if (fs.statSync(candidate).isDirectory()) continue;
      const resolved = fs.realpathSync(candidate);
      fs.accessSync(resolved, fsConstants.X_OK);
      if (fs.statSync(resolved).isDirectory()) continue;
      if (excludedRoots.some((root) => isWithin(resolved, root))) continue;
      return resolved;
    } catch {
      // Keep searching the trusted PATH.
    }
  }
  return null;
}

function gitScalar(gitPath, args) {
  const result = spawnSync(gitPath, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: {
      HOME: "/",
      XDG_CONFIG_HOME: "/nonexistent",
      PATH: `${path.dirname(gitPath)}:/usr/bin:/bin`,
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error) return null;
  const value = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (!value || value.includes("\n") || value.includes("\r")) return null;
  return value;
}

function workspaceKey(workspaceRoot, bareCommonDirectory) {
  return createHash("sha256")
    .update(JSON.stringify([workspaceRoot, bareCommonDirectory ?? null]))
    .digest("hex");
}

function immutableScope(physicalLaunchDirectory, canonicalWorkspaceRoot, bareCommonDirectory) {
  return Object.freeze({
    physicalLaunchDirectory,
    canonicalWorkspaceRoot,
    bareCommonDirectory,
    workspaceKey: workspaceKey(canonicalWorkspaceRoot, bareCommonDirectory),
  });
}

/**
 * Resolve the nearest trusted workspace. Failure is deliberately narrow: the
 * physical launch directory becomes the workspace and no external Git metadata
 * is granted.
 */
export function discoverRepositoryScope(options = {}) {
  const bootstrap = discoverBootstrapExclusions(options.launchDirectory ?? process.cwd());
  const fallback = () =>
    immutableScope(bootstrap.physicalLaunchDirectory, bootstrap.physicalLaunchDirectory, null);

  if (!bootstrap.candidateWorktreeRoot) return fallback();
  const gitPath = findTrustedExecutable(
    "git",
    options.pathValue ?? process.env.PATH,
    bootstrap.excludedRoots,
  );
  if (!gitPath) return fallback();

  const launch = bootstrap.physicalLaunchDirectory;
  if (gitScalar(gitPath, ["-C", launch, "rev-parse", "--is-inside-work-tree"]) !== "true") {
    return fallback();
  }

  const topLevelRaw = gitScalar(gitPath, ["-C", launch, "rev-parse", "--show-toplevel"]);
  if (!topLevelRaw) return fallback();
  let topLevel;
  try {
    topLevel = canonicalDirectory(topLevelRaw);
  } catch {
    return fallback();
  }
  if (
    topLevel !== bootstrap.candidateWorktreeRoot ||
    !isWithin(launch, topLevel) ||
    !isLiteralPath(topLevel)
  ) {
    return fallback();
  }

  const gitDirRaw = gitScalar(gitPath, ["-C", launch, "rev-parse", "--absolute-git-dir"]);
  const commonRaw = gitScalar(gitPath, [
    "-C",
    launch,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!gitDirRaw || !commonRaw) return fallback();

  let gitDirectory;
  let commonDirectory;
  try {
    gitDirectory = canonicalDirectory(gitDirRaw);
    commonDirectory = canonicalDirectory(commonRaw);
  } catch {
    return fallback();
  }

  let bareCommonDirectory = null;
  if (!isWithin(commonDirectory, topLevel)) {
    const bare = gitScalar(gitPath, [
      `--git-dir=${commonDirectory}`,
      "rev-parse",
      "--is-bare-repository",
    ]);
    if (
      bare === "true" &&
      isWithin(gitDirectory, path.join(commonDirectory, "worktrees")) &&
      isLiteralPath(commonDirectory)
    ) {
      bareCommonDirectory = commonDirectory;
    }
  }

  return immutableScope(launch, topLevel, bareCommonDirectory);
}

export const repositoryScopeInternals = Object.freeze({
  isWithin,
  isLiteralPath,
  workspaceKey,
});
