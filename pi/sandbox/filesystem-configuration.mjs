import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CONFIG_PATH, MAX_CONFIG_BYTES, parseFilesystemConfiguration, readFilesystemConfigurationSource, resolveFilesystemGrant,
  validateFilesystemConfiguration, validateFilesystemGrants,
} from "./filesystem-grants.mjs";

function conflict(message = "Saved sandbox configuration changed; reload saved grants and retry") {
  return Object.assign(new Error(message), { code: "CONFIG_CONFLICT" });
}
function revision(targetPath, bytes) {
  return createHash("sha256").update(targetPath).update("\0").update(bytes).digest("hex");
}
function identity(stat) { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}`; }
function immutableConfig(config) {
  return Object.freeze({ version: 1, filesystem: Object.freeze({
    readOnly: Object.freeze([...config.filesystem.readOnly]), readWrite: Object.freeze([...config.filesystem.readWrite]),
  }) });
}
function snapshot(configPath, targetPath, bytes, stat, config, grants) {
  return Object.freeze({ configPath, targetPath, revision: revision(targetPath, bytes), fileIdentity: identity(stat), config: immutableConfig(config), grants });
}

/** Trusted host-only read/list. The revision covers exact bytes and Stow target. */
export function readFilesystemConfiguration(options = {}) {
  const { configPath, targetPath, bytes, stat } = readFilesystemConfigurationSource(options.configPath);
  const config = parseFilesystemConfiguration(bytes);
  const grants = validateFilesystemConfiguration(config, options);
  if (fs.realpathSync(configPath) !== targetPath || identity(fs.lstatSync(targetPath)) !== identity(stat)) throw conflict();
  return snapshot(configPath, targetPath, bytes, stat, config, grants);
}

/** Prepare without saving so callers can verify/prepare client activation first. */
export function prepareFilesystemGrantChange(saved, change, options = {}) {
  if (!saved || saved.configPath !== path.resolve(options.configPath ?? CONFIG_PATH) || typeof saved.revision !== "string") throw new Error("Read saved sandbox configuration before preparing an edit");
  const existing = validateFilesystemConfiguration(saved.config, options);
  validateFilesystemGrants(saved.grants, options); // detect aliases changed since read
  if (!change || !["add", "remove"].includes(change.type)) throw new Error("filesystem grant change must be add or remove");
  const requested = resolveFilesystemGrant(change.path, change.type === "add" ? change.access : "ro", options);
  const index = existing.findIndex((grant) => grant.path === requested.path || grant.canonicalPath === requested.canonicalPath);
  if (change.type === "remove" && index === -1) throw new Error("No saved grant matches this directory; derived workspace access cannot be removed here");
  const config = { version: 1, filesystem: { readOnly: [...saved.config.filesystem.readOnly], readWrite: [...saved.config.filesystem.readWrite] } };
  if (index !== -1) {
    const previous = existing[index];
    const key = previous.access === "ro" ? "readOnly" : "readWrite";
    const entryIndex = existing.slice(0, index).filter((grant) => grant.access === previous.access).length;
    const [entry] = config.filesystem[key].splice(entryIndex, 1);
    // Preserve the saved lexical/Stow spelling when changing access via an alias.
    if (change.type === "add") config.filesystem[change.access === "ro" ? "readOnly" : "readWrite"].push(entry);
  } else {
    config.filesystem[change.access === "ro" ? "readOnly" : "readWrite"].push(change.path);
  }
  const grants = validateFilesystemConfiguration(config, options);
  return Object.freeze({ ...saved, config: immutableConfig(config), grants, expectedRevision: saved.revision });
}

async function acquireLock(targetPath, timeoutMs) {
  const lockPath = `${targetPath}.lock`, deadline = Date.now() + timeoutMs;
  while (true) {
    let fd;
    try { fd = fs.openSync(lockPath, "wx", 0o600); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw Object.assign(new Error(`Sandbox configuration is locked by another edit; retry when idle. If a writer crashed, inspect ${lockPath} before removing its stale lock.`), { code: "CONFIG_LOCKED" });
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      continue;
    }
    const stat = fs.fstatSync(fd);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }) + "\n"); } catch (error) {
      fs.closeSync(fd); fs.unlinkSync(lockPath); throw error;
    }
    return () => {
      fs.closeSync(fd);
      // Never remove a different process's lock if a host edit replaced ours.
      try { if (identity(fs.lstatSync(lockPath)) === identity(stat)) fs.unlinkSync(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    };
  }
}
function assertUnchanged(current, candidate) {
  if (current.targetPath !== candidate.targetPath || current.revision !== candidate.expectedRevision || current.fileIdentity !== candidate.fileIdentity) throw conflict();
}
function validatedCandidate(candidate, options) {
  const grants = validateFilesystemConfiguration(candidate.config, options);
  validateFilesystemGrants(candidate.grants, options);
  if (JSON.stringify(grants) !== JSON.stringify(candidate.grants)) throw conflict("Prepared grant paths changed; reload saved grants and retry");
  return grants;
}

/** Atomic replacement of the canonical file, never the deployment symlink. */
export async function commitFilesystemConfiguration(candidate, options = {}) {
  const configPath = path.resolve(options.configPath ?? CONFIG_PATH);
  if (!candidate || candidate.configPath !== configPath || !/^[a-f0-9]{64}$/.test(candidate.expectedRevision ?? "")) throw new Error("A prepared edit with an expected saved revision is required");
  const timeoutMs = options.lockTimeoutMs ?? 2000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new Error("configuration lock timeout must be between 0 and 30000 ms");
  assertUnchanged(readFilesystemConfiguration(options), candidate);
  const release = await acquireLock(candidate.targetPath, timeoutMs);
  let temporaryPath, fd, committed = false;
  try {
    const current = readFilesystemConfiguration(options);
    assertUnchanged(current, candidate);
    let grants = validatedCandidate(candidate, options);
    const bytes = Buffer.from(JSON.stringify(candidate.config, null, 2) + "\n");
    if (bytes.length > MAX_CONFIG_BYTES) throw new Error("sandbox filesystem configuration is too large (maximum 256 KiB)");
    temporaryPath = path.join(path.dirname(current.targetPath), `.${path.basename(current.targetPath)}.${randomUUID()}.tmp`);
    fd = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    const originalStat = fs.statSync(current.targetPath), temporaryStat = fs.fstatSync(fd);
    if (temporaryStat.uid !== originalStat.uid || temporaryStat.gid !== originalStat.gid) fs.fchownSync(fd, originalStat.uid, originalStat.gid);
    fs.fchmodSync(fd, originalStat.mode & 0o777);
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    fs.closeSync(fd); fd = undefined;
    // Re-resolve Stow, compare the file revision/identity, and revalidate all
    // grant targets immediately before replacement. Failure leaves bytes intact.
    assertUnchanged(readFilesystemConfiguration(options), candidate);
    grants = validatedCandidate(candidate, options);
    fs.renameSync(temporaryPath, current.targetPath);
    committed = true;
    temporaryPath = undefined;
    // Do not perform fallible reads after commit: callers need an unambiguous
    // saved result even if later client activation fails.
    return snapshot(configPath, current.targetPath, bytes, stat, candidate.config, grants);
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
    } finally {
      try { release(); } catch (error) {
        if (!committed) throw error;
        process.emitWarning(`Sandbox configuration was saved, but lock cleanup failed: ${error.message}`);
      }
    }
  }
}

/** This service is for explicit trusted command handlers, never a model tool. */
export function createFilesystemConfigurationService(options = {}) {
  const context = { ...options };
  const read = () => readFilesystemConfiguration(context);
  return Object.freeze({ read, list: read,
    prepare: (change, saved = read()) => prepareFilesystemGrantChange(saved, change, context),
    commit: (candidate) => commitFilesystemConfiguration(candidate, context),
  });
}
