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
const DEFAULT_SAMPLES = 10;
const STOP_TIMEOUT_MS = 30_000;
const PHASES = [
  "repository_scope", "controller_begin", "image_verify", "policy_create", "vm_create",
  "vm_start", "docker_health", "model_cache_probe", "model_cache_refresh", "pi_initialize",
  "routing_connection_audit", "routing_handshake",
];
const COUNTED_EVENTS = ["metadata_pi_launch", "real_pi_launch"];

function parseOptions(argv) {
  const options = { samples: DEFAULT_SAMPLES, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--samples") options.samples = Number(argv[++index]);
    else throw new Error("usage: benchmark-startup.mjs [--samples <count>] [--json]");
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  return options;
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function parseTrace(tracePath) {
  const events = [];
  const text = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8") : "";
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event.phase === "string" && Number.isSafeInteger(event.at)) events.push(event);
    } catch {
      events.push({ phase: line }); // Backward-compatible diagnostic traces.
    }
  }
  return events;
}

function traceSummary(tracePath) {
  const events = parseTrace(tracePath);
  const phaseDurations = {};
  for (const phase of PHASES) {
    const start = events.find((event) => event.phase === `${phase}_start` && Number.isSafeInteger(event.at));
    const complete = events.find((event) => event.phase === `${phase}_complete` && Number.isSafeInteger(event.at));
    phaseDurations[phase] = start && complete && complete.at >= start.at ? complete.at - start.at : null;
  }
  const phaseCounts = Object.fromEntries(COUNTED_EVENTS.map((phase) => [
    phase,
    events.filter((event) => event.phase === phase).length,
  ]));
  const at = (phase) => events.find((event) => event.phase === phase && Number.isSafeInteger(event.at))?.at ?? null;
  const launch = at("pi_child_spawn");
  const hostUI = at("host_ui_ready") ?? at("pi_initialize_complete");
  const ready = at("routing_handshake_complete");
  return {
    phaseDurations,
    phaseCounts,
    launchToHostUIMs: launch !== null && hostUI !== null && hostUI >= launch ? hostUI - launch : null,
    hostUIToSandboxReadyMs: hostUI !== null && ready !== null && ready >= hostUI ? ready - hostUI : null,
  };
}

function summarize(samples) {
  const elapsedMs = samples.map((sample) => sample.elapsedMs);
  const phaseCounts = {};
  const phaseDurations = {};
  for (const sample of samples) {
    for (const [phase, count] of Object.entries(sample.phaseCounts)) {
      (phaseCounts[phase] ??= []).push(count);
    }
    for (const [phase, duration] of Object.entries(sample.phaseDurations)) {
      if (duration !== null) (phaseDurations[phase] ??= []).push(duration);
    }
  }
  const range = (values) => ({ min: Math.min(...values), median: median(values), max: Math.max(...values) });
  const interval = (name) => {
    const values = samples.map((sample) => sample[name]).filter((value) => value !== null);
    return values.length ? range(values) : null;
  };
  return {
    samples: elapsedMs.length,
    medianMs: median(elapsedMs), minMs: Math.min(...elapsedMs), maxMs: Math.max(...elapsedMs),
    launchToHostUIMs: interval("launchToHostUIMs"),
    hostUIToSandboxReadyMs: interval("hostUIToSandboxReadyMs"),
    phaseDurationsMs: Object.fromEntries(Object.entries(phaseDurations).map(([phase, values]) => [phase, range(values)])),
    phaseCounts: Object.fromEntries(Object.entries(phaseCounts).map(([phase, values]) => [phase, range(values)])),
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

async function launch(workspace, tracePath, cachePath, forceRefresh = false) {
  fs.writeFileSync(tracePath, "", { mode: 0o600 });
  if (forceRefresh) fs.rmSync(cachePath, { force: true });
  const startedAt = process.hrtime.bigint();
  const child = spawn(WRAPPER, ["--mode", "rpc", "--no-session"], {
    cwd: workspace,
    env: {
      ...process.env,
      PI_GONDOLIN_STARTUP_TRACE_FILE: tracePath,
      PI_GONDOLIN_BENCHMARK_MODEL_SCOPE_CACHE_FILE: cachePath,
      PI_TIMING: "1",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // Closing RPC stdin during controller boot requests session shutdown in Pi.
  // Keep it open until the externally required routing handshake is complete.
  await waitFor(
    () => parseTrace(tracePath).some((event) => event.phase === "routing_handshake_complete"),
    "benchmark routing handshake did not complete",
  );
  child.stdin.end();
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  if (code !== 0) throw new Error(`wrapper exited ${code ?? signal}: ${stderr.trim()}`);
  return { elapsedMs, ...traceSummary(tracePath) };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-startup-benchmark-")));
  const workspace = path.join(root, "workspace");
  const tracePath = path.join(root, "startup.trace");
  const cachePath = path.join(root, "model-scope.json");
  fs.mkdirSync(workspace, { mode: 0o700 });
  const scope = discoverRepositoryScope({ launchDirectory: workspace, pathValue: process.env.PATH });
  const controllerPaths = getClientControllerPaths(scope.workspaceKey);
  const workspaceStatePath = path.join(os.homedir(), ".cache", "pi-gondolin", "workspaces", scope.workspaceKey);
  const cold = [];
  const active = [];
  const forcedRefresh = [];
  let heldLease = null;
  try {
    await launch(workspace, tracePath, cachePath); // Untimed cold warm-up.
    await waitFor(() => !fs.existsSync(controllerPaths.manifestPath) && !fs.existsSync(controllerPaths.socketPath), "cold warm-up controller did not stop after its lease was released");
    for (let index = 0; index < options.samples; index += 1) {
      cold.push(await launch(workspace, tracePath, cachePath));
      await waitFor(() => !fs.existsSync(controllerPaths.manifestPath) && !fs.existsSync(controllerPaths.socketPath), `cold sample ${index + 1} controller did not stop after its lease was released`);
    }
    heldLease = await ensureControllerLease({ launchDirectory: workspace, clientId: `startup-benchmark-${process.pid}` });
    await launch(workspace, tracePath, cachePath); // Untimed active-controller warm-up.
    for (let index = 0; index < options.samples; index += 1) active.push(await launch(workspace, tracePath, cachePath));
    for (let index = 0; index < options.samples; index += 1) {
      forcedRefresh.push(await launch(workspace, tracePath, cachePath, true));
    }
  } finally {
    if (heldLease) await heldLease.client.release().catch(() => {});
    await waitFor(() => !fs.existsSync(controllerPaths.manifestPath) && !fs.existsSync(controllerPaths.socketPath), "benchmark controller did not stop after its owned lease was released");
    fs.rmSync(workspaceStatePath, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
  const result = { workspace: "disposable", cold: summarize(cold), activeController: summarize(active), forcedRefresh: summarize(forcedRefresh) };
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else for (const [label, summary] of Object.entries({ cold: result.cold, activeController: result.activeController, forcedRefresh: result.forcedRefresh })) {
    console.log(`${label}: median ${summary.medianMs.toFixed(1)} ms (range ${summary.minMs.toFixed(1)}–${summary.maxMs.toFixed(1)} ms)`);
    console.log(`  UI: launch-to-host=${summary.launchToHostUIMs?.median ?? "unavailable"}ms, host-to-ready=${summary.hostUIToSandboxReadyMs?.median ?? "unavailable"}ms`);
    console.log(`  durations: ${Object.entries(summary.phaseDurationsMs).map(([phase, value]) => `${phase}=${value.median}ms`).join(", ") || "unavailable"}`);
    console.log(`  processes: ${Object.entries(summary.phaseCounts).map(([phase, value]) => `${phase}=${value.median}`).join(", ")}`);
  }
}

main().catch((error) => { process.stderr.write(`pi startup benchmark: ${error.message}\n`); process.exitCode = 1; });
