import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stderr } from "node:process";
import { discoverRepositoryScope } from "./repository-scope.mjs";
import { WorkspaceDockerSidecar } from "./docker-sidecar.mjs";
import { runPiSbx } from "./srt-compatibility-canary.mjs";

const root = path.join("/tmp", `pi-srt-${process.getuid()}`, "c");
function scopeFor(directory) {
  const scope = discoverRepositoryScope({ launchDirectory: directory, pathValue: process.env.PATH });
  return { key: scope.workspaceKey, workspace: fs.realpathSync(scope.canonicalWorkspaceRoot) };
}
function runtimeFor(key) { return path.join(root, key); }
function candidate(key, workspace) { return new WorkspaceDockerSidecar({ workspaceKey: key, workspaceRoot: workspace, runtimeRoot: runtimeFor(key) }); }
export async function validatedSidecarForDirectory(directory = process.cwd()) {
  const { key, workspace } = scopeFor(directory); const sidecar = candidate(key, workspace);
  const metadata = sidecar.metadata();
  if (!metadata) throw new Error("no Pi Docker sidecar is recorded for this workspace");
  const inspect = await sidecar.inspect();
  if (!inspect || inspect.id !== metadata.id) throw new Error("Pi Docker sidecar identity drift");
  return { sidecar, metadata, inspect };
}
export async function inventory() {
  let keys = []; try { keys = fs.readdirSync(root).filter((key) => /^[0-9a-f]{64}$/.test(key)); } catch { return []; }
  const entries = [];
  for (const key of keys) {
    const metadataPath = path.join(runtimeFor(key), "sidecar.json");
    try {
      const raw = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      const sidecar = candidate(key, raw.workspaceRoot); const metadata = sidecar.metadata(); const inspect = await sidecar.inspect();
      if (metadata && inspect && inspect.id === metadata.id) entries.push({ sidecar, metadata, inspect });
    } catch { /* Fail closed: unknown or drifted entries are never manageable. */ }
  }
  return entries;
}
export async function dockerUsage(entry) {
  const result = await runPiSbx(["exec", entry.metadata.name, "docker", "system", "df"]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Docker disk usage failed");
  return result.stdout.trim();
}
export async function stop(entry) {
  const result = await runPiSbx(["stop", entry.metadata.name]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "sidecar stop failed");
}
export async function confirm(action, name, force) {
  if (force) return;
  if (!stdin.isTTY) throw new Error(`${action} requires --force outside an interactive terminal`);
  const prompt = readline.createInterface({ input: stdin, output: stderr });
  try { if ((await prompt.question(`${action} ${name}? [y/N] `)).trim().toLowerCase() !== "y") throw new Error("operation cancelled"); } finally { prompt.close(); }
}
export async function reset(entry) { await entry.sidecar.reset(); }
export const managementInternals = Object.freeze({ scopeFor, runtimeFor });
