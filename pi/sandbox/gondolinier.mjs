#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { listSessions } from "@earendil-works/gondolin";

import {
  ControllerClient,
  getClientRuntimeRoot,
  readControllerManifest,
} from "./client.mjs";

const USAGE = `Usage:
  gondolinier vm list
  gondolinier storage list
  gondolinier storage purge

Commands:
  vm list       List connectable Gondolin VMs.
  storage list  Show reclaimable Docker storage in active Pi VMs.
  storage purge Preview and remove reclaimable Docker storage in active Pi VMs.`;

function write(output, text) {
  output.write(`${text}\n`);
}

function parseDockerSize(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|MB|GB|TB)/i.exec(String(value));
  if (!match) return 0;
  const units = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

function parseDockerDf(output) {
  const text = output.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }
}

function normalizeDockerCategory(category) {
  const type = String(category.Type ?? category.type ?? "").toLowerCase();
  if (type === "images") return "Images";
  if (type === "containers") return "Containers";
  if (type === "local volumes" || type === "volumes") return "Volumes";
  if (type === "build cache") return "Build cache";
  return null;
}

function formatGigabytes(bytes) {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

async function collectExecOutput(client, argv) {
  const chunks = [];
  const result = await client.exec(argv, {
    cwd: "/root",
    env: {},
    onEvent: (stream, data) => {
      if (stream === "stdout") chunks.push(data);
    },
  });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed with exit ${result.exitCode}`);
  return Buffer.concat(chunks).toString("utf8");
}

async function releaseControllers(controllers) {
  await Promise.all(controllers.map(({ client }) => client.release().catch(() => {})));
}

export async function inspectPiStorage(options = {}) {
  const manifests = options.manifests ?? readLiveControllerManifests(options);
  const acquire = options.acquireController ?? ControllerClient.acquire;
  const controllers = [];
  try {
    for (const manifest of manifests) {
      const acquired = await acquire(manifest, { clientId: "gondolinier-storage" });
      controllers.push({ manifest, client: acquired.client });
    }
    const categories = new Map(
      ["Images", "Containers", "Volumes", "Build cache"].map((name) => [name, 0]),
    );
    let activeVolumeCount = 0;
    let activeVolumeBytes = 0;
    for (const controller of controllers) {
      const rows = parseDockerDf(
        await collectExecOutput(controller.client, ["/usr/bin/docker", "system", "df", "--format", "json"]),
      );
      for (const row of rows) {
        const category = normalizeDockerCategory(row);
        if (!category) continue;
        const reclaimable = parseDockerSize(row.Reclaimable ?? row.reclaimable);
        categories.set(category, categories.get(category) + reclaimable);
        if (category === "Volumes") {
          const active = Number(row.Active ?? row.active ?? 0);
          if (Number.isSafeInteger(active) && active > 0) {
            activeVolumeCount += active;
            activeVolumeBytes += Math.max(0, parseDockerSize(row.Size ?? row.size) - reclaimable);
          }
        }
      }
    }
    const entries = [...categories].map(([name, reclaimableBytes]) => ({ name, reclaimableBytes }));
    const totalBytes = entries.reduce((total, entry) => total + entry.reclaimableBytes, 0);
    return { controllers, entries, totalBytes, activeVolumeCount, activeVolumeBytes };
  } catch (error) {
    await releaseControllers(controllers);
    throw error;
  }
}

export function formatStoragePreview(storage) {
  if (storage.controllers.length === 0) return "No active Pi VMs with Docker storage.";
  const rows = storage.entries.map((entry) => `${entry.name.padEnd(12)} ${formatGigabytes(entry.reclaimableBytes)}`);
  rows.push(`${"Total".padEnd(12)} ${formatGigabytes(storage.totalBytes)}`);
  if (storage.activeVolumeCount > 0) {
    rows.push(
      `WARNING: ${storage.activeVolumeCount} active volume${storage.activeVolumeCount === 1 ? "" : "s"} (${formatGigabytes(storage.activeVolumeBytes)}) will be preserved by purge.`,
    );
  }
  return ["Reclaimable Docker storage:", ...rows].join("\n");
}

async function confirmPurge(input, output) {
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question("Purge this reclaimable Docker storage? [y/N] ");
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function runStorageList(options) {
  const storage = await inspectPiStorage(options);
  try {
    write(options.stdout ?? process.stdout, formatStoragePreview(storage));
  } finally {
    await releaseControllers(storage.controllers);
  }
}

async function runStoragePurge(options) {
  const storage = await inspectPiStorage(options);
  try {
    const output = options.stdout ?? process.stdout;
    write(output, formatStoragePreview(storage));
    if (storage.totalBytes === 0) {
      write(output, "No reclaimable Docker storage found.");
      return;
    }
    const confirmed = await (options.confirm ?? confirmPurge)(options.stdin ?? process.stdin, output);
    if (!confirmed) {
      write(output, "Purge cancelled.");
      return;
    }
    for (const { client } of storage.controllers) {
      await collectExecOutput(client, ["/usr/bin/docker", "system", "prune", "--all", "--volumes", "--force"]);
    }
    write(output, "Reclaimable Docker storage purged.");
  } finally {
    await releaseControllers(storage.controllers);
  }
}

function isLiveSession(session) {
  return (
    session &&
    session.alive === true &&
    typeof session.id === "string" &&
    session.id.length > 0 &&
    Number.isSafeInteger(session.pid) &&
    session.pid > 0 &&
    typeof session.createdAt === "string" &&
    Number.isFinite(Date.parse(session.createdAt)) &&
    (session.label === undefined || typeof session.label === "string")
  );
}

function formatAge(createdAt, now) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function readLiveControllerManifests(options = {}) {
  const runtimeRoot = options.runtimeRoot ?? getClientRuntimeRoot();
  const readManifest = options.readControllerManifest ?? readControllerManifest;
  let names;
  try {
    names = fs.readdirSync(runtimeRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const manifests = [];
  for (const name of names) {
    if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
    try {
      manifests.push(readManifest(path.join(runtimeRoot, name)));
    } catch {
      // A malformed, stale, or unavailable controller is not running.
    }
  }
  return manifests;
}

export async function getVmInventory(options = {}) {
  const sessions = await (options.listSessions ?? listSessions)();
  const manifests = options.manifests ?? readLiveControllerManifests(options);
  const workspaceByVmId = new Map(manifests.map((manifest) => [manifest.vmId, manifest.workspaceRoot]));
  const now = options.now ?? Date.now();
  return sessions
    .filter(isLiveSession)
    .map((session) => ({
      id: session.id,
      pid: session.pid,
      age: formatAge(session.createdAt, now),
      label: session.label ?? "-",
      workspace: workspaceByVmId.get(session.id) ?? "-",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function formatVmInventory(inventory) {
  if (inventory.length === 0) return "No Gondolin VMs are running.";
  const headers = ["VM ID", "PID", "AGE", "LABEL", "WORKSPACE"];
  const rows = inventory.map((entry) => [entry.id, String(entry.pid), entry.age, entry.label, entry.workspace]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const render = (row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  return [render(headers), ...rows.map(render)].join("\n");
}

export async function runGondolinier(argv, options = {}) {
  const output = options.stdout ?? process.stdout;
  const error = options.stderr ?? process.stderr;
  const args = argv.filter((argument) => argument !== "--help" && argument !== "-h");
  const help = args.length !== argv.length;

  if (help && args.length === 0) {
    write(output, USAGE);
    return 0;
  }
  if (help && args[0] === "vm" && (args.length === 1 || (args.length === 2 && args[1] === "list"))) {
    write(output, "Usage: gondolinier vm list");
    return 0;
  }
  if (help && args[0] === "storage" && (args.length === 1 || (args.length === 2 && ["list", "purge"].includes(args[1])))) {
    write(output, `Usage: gondolinier storage ${args[1] ?? "list|purge"}`);
    return 0;
  }
  if (args.length === 2 && args[0] === "vm" && args[1] === "list") {
    write(output, formatVmInventory(await getVmInventory(options)));
    return 0;
  }
  if (args.length === 2 && args[0] === "storage" && args[1] === "list") {
    await runStorageList(options);
    return 0;
  }
  if (args.length === 2 && args[0] === "storage" && args[1] === "purge") {
    await runStoragePurge(options);
    return 0;
  }
  write(error, args.length === 0 ? USAGE : `Unknown gondolinier command: ${args.join(" ")}\n${USAGE}`);
  return 2;
}

async function main() {
  process.exitCode = await runGondolinier(process.argv.slice(2));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`gondolinier: ${error.message}\n`);
    process.exitCode = 1;
  });
}
