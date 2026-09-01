import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const CAPABILITY_VERSION = 2;
const HEX = /^[0-9a-f]{64}$/;

export function sourceDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) hash.update(file).update("\0").update(fs.readFileSync(file));
  return hash.digest("hex");
}
export function processStartIdentity(pid) {
  try { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim() || null; } catch { return null; }
}
export function processMatches(pid, startIdentity) {
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof startIdentity !== "string" || !startIdentity) return false;
  try { process.kill(pid, 0); } catch (error) { return error?.code === "EPERM"; }
  return processStartIdentity(pid) === startIdentity;
}
export function atomicJson(filePath, value, mode = 0o600) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode, flag: "wx" });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
}
export function readPrivateJson(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error("controller state is not private");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
export function validateDescriptor(value) {
  if (!value || value.version !== CAPABILITY_VERSION || !HEX.test(value.workspaceKey) || !HEX.test(value.token) ||
      typeof value.workspaceRoot !== "string" || !path.isAbsolute(value.workspaceRoot) ||
      typeof value.runtimeRoot !== "string" || !path.isAbsolute(value.runtimeRoot) ||
      typeof value.socketPath !== "string" || !path.isAbsolute(value.socketPath) ||
      typeof value.manifestPath !== "string" || !path.isAbsolute(value.manifestPath) ||
      typeof value.capabilityPath !== "string" || !path.isAbsolute(value.capabilityPath) ||
      !HEX.test(value.sourceDigest) || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error("invalid controller capability descriptor");
  }
  return value;
}
export function manifestFor(descriptor) {
  return { version: CAPABILITY_VERSION, pid: process.pid, processStartIdentity: processStartIdentity(process.pid), sourceDigest: descriptor.sourceDigest,
    workspaceKey: descriptor.workspaceKey, workspaceRoot: descriptor.workspaceRoot, runtimeRoot: descriptor.runtimeRoot,
    socketPath: descriptor.socketPath, tokenDigest: createHash("sha256").update(descriptor.token).digest("hex"), generation: descriptor.generation };
}
export function validateManifest(manifest, descriptor) {
  return Boolean(manifest && manifest.version === CAPABILITY_VERSION && manifest.workspaceKey === descriptor.workspaceKey &&
    manifest.workspaceRoot === descriptor.workspaceRoot && manifest.runtimeRoot === descriptor.runtimeRoot &&
    manifest.socketPath === descriptor.socketPath && manifest.sourceDigest === descriptor.sourceDigest &&
    manifest.generation === descriptor.generation && manifest.tokenDigest === createHash("sha256").update(descriptor.token).digest("hex") &&
    processMatches(manifest.pid, manifest.processStartIdentity));
}
