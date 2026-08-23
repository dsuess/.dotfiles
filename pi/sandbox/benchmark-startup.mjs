#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureControllerLease, getClientControllerPaths } from "./client.mjs";
import { discoverRepositoryScope } from "./repository-scope.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(SCRIPT_DIR, "../../bin/pi");
const DEFAULT_SAMPLES = 5;
const STOP_TIMEOUT_MS = 30_000;
const PHASES = [
  "controller_acquire_start",
  "image_verify_start",
  "image_verify_complete",
  "controller_healthy",
  "controller_acquire_complete",
  "pi_child_spawn",
  "metadata_pi_launch",
  "real_pi_launch",
  "routing_handshake_start",
  "routing_handshake_complete",
];

function parseOptions(argv) {
  const options = { samples: DEFAULT_SAMPLES, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--samples") options.samples = Number(argv[++index]);
    else throw new Error(`usage: benchmark-startup.mjs [--samples <count>] [--json]`);
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(samples) {
  const elapsedMs = samples.map((sample) => sample.elapsedMs);
  const phaseCounts = {};
  for (const sample of samples) {
    for (const [phase, count] of Object.entries(sample.phaseCounts)) {
      phaseCounts[phase] = [...(phaseCounts[phase] ?? []), count];
    }
  }
  return {
    samples: elapsedMs.length,
    medianMs: median(elapsedMs),
    minMs: Math.min(...elapsedMs),
    maxMs: Math.max(...elapsedMs),
    phaseCounts: Object.fromEntries(
      Object.entries(phaseCounts).map(([phase, counts]) => [phase, {
        min: Math.min(...counts),
        median: median(counts),
        max: Math.max(...counts),
      }]),
    ),
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(message);
}

function readPhaseCounts(tracePath) {
  const counts = Object.fromEntries(PHASES.map((phase) => [phase, 0]));
  const text = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : "";
  for (const phase of text.split("\n")) {
    if (phase) counts[phase] = (counts[phase] ?? 0) + 1;
  }
  return counts;
}

async function launch(workspace, tracePath) {
  fs.writeFileSync(tracePath, "", { mode: 0o600 });
  const startedAt = process.hrtime.bigint();
  const child = spawn(WRAPPER, ["--mode", "rpc", "--no-session"], {
    cwd: workspace,
    env: {
      ...process.env,
      PI_GONDOLIN_STARTUP_TRACE_FILE: tracePath,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stdin.end();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  if (code !== 0) throw new Error(`wrapper exited ${code ?? signal}: ${stderr.trim()}`);
  return { elapsedMs, phaseCounts: readPhaseCounts(tracePath) };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-startup-benchmark-")));
  const workspace = path.join(root, "workspace");
  const tracePath = path.join(root, "startup.trace");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const scope = discoverRepositoryScope({ launchDirectory: workspace, pathValue: process.env.PATH });
  const controllerPaths = getClientControllerPaths(scope.workspaceKey);
  const workspaceStatePath = path.join(os.homedir(), ".cache", "pi-gondolin", "workspaces", scope.workspaceKey);
  const cold = [];
  const active = [];
  let heldLease = null;
  try {
    // Untimed cold warm-up verifies the environment without contaminating samples.
    await launch(workspace, tracePath);
    await waitFor(
      () => !fs.existsSync(controllerPaths.manifestPath) && !fs.existsSync(controllerPaths.socketPath),
      "cold warm-up controller did not stop after its lease was released",
    );
    for (let index = 0; index < options.samples; index += 1) {
      cold.push(await launch(workspace, tracePath));
      await waitFor(
        () => !fs.existsSync(controllerPaths.manifestPath) && !fs.existsSync(controllerPaths.socketPath),
        `cold sample ${index + 1} controller did not stop after its lease was released`,
      );
    }

    // This owned lease is the only controller retention. It proves the active
    // mode and is always released before the disposable workspace is removed.
    heldLease = await ensureControllerLease({ launchDirectory: workspace, clientId: `startup-benchmark-${process.pid}` });
    await launch(workspace, tracePath); // untimed active-controller warm-up
    for (let index = 0; index < options.samples; index += 1) active.push(await launch(workspace, tracePath));
  } finally {
    if (heldLease) await heldLease.client.release().catch(() => {});
    await waitFor(
      () => !fs.existsSync(controllerPaths.manifestPath) && !fs.existsSync(controllerPaths.socketPath),
      "benchmark controller did not stop after its owned lease was released",
    );
    fs.rmSync(workspaceStatePath, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }

  const result = { workspace: "disposable", cold: summarize(cold), activeController: summarize(active) };
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    for (const [label, summary] of Object.entries({ cold: result.cold, activeController: result.activeController })) {
      console.log(`${label}: median ${summary.medianMs.toFixed(1)} ms (range ${summary.minMs.toFixed(1)}–${summary.maxMs.toFixed(1)} ms)`);
      console.log(`  phases: ${Object.entries(summary.phaseCounts).map(([phase, count]) => `${phase}=${count.median}`).join(", ")}`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`pi startup benchmark: ${error.message}\n`);
  process.exitCode = 1;
});
