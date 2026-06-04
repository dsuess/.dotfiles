/**
 * vLLM-MLX Local Model Provider
 *
 * Registers a local vllm-mlx model and auto-starts the server when selected.
 * Uses `vllm-mlx serve` (not bench) so it starts an OpenAI-compatible API server.
 * Uses a PID file keyed by port to ensure only one server runs across pi sessions.
 * Injects generation parameters (temperature, top_k, repetition_penalty) on every request.
 *
 * Model: LiquidAI/LFM2.5-8B-A1B-MLX-8bit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

// ── Configuration ────────────────────────────────────────────────────────────
const GENERATION_PARAMS = {
  temperature: 0.2,
  top_k: 80,
  repetition_penalty: 1.05,
};

const PORT = 28700;
const PID_FILE = `/tmp/vllm-mlx-${PORT}.pid`;
const BASE_URL = `http://localhost:${PORT}/v1`;
const MODEL_ID = "LiquidAI/LFM2.5-8B-A1B-MLX-8bit";
const PROVIDER_NAME = "vllm-mlx";
const STARTUP_COMMAND = "uv";
const STARTUP_ARGS = [
  "tool",
  "run",
  "vllm-mlx",
  "serve",
  MODEL_ID,
  "--port",
  String(PORT),
  "--default-temperature",
  String(GENERATION_PARAMS.temperature),
];

// ── Server lifecycle helpers ─────────────────────────────────────────────────

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

function isServerRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) return false;
  if (!isProcessRunning(pid)) {
    // Stale PID file — clean it up
    try {
      unlinkSync(PID_FILE);
    } catch {}
    return false;
  }
  return true;
}

function startServerProcess(): number | null {
  const child = spawn(STARTUP_COMMAND, STARTUP_ARGS, {
    detached: true,
    stdio: "ignore",
  });

  const pid = child.pid;
  if (!pid) return null;

  child.unref();
  writeFileSync(PID_FILE, String(pid));
  return pid;
}

async function waitForServer(
  maxRetries = 120,
  delayMs = 2000,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    if (signal?.aborted) return false;
    try {
      const response = await fetch(`${BASE_URL}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function ensureServer(ctx?: any): Promise<boolean> {
  if (isServerRunning()) return true;

  ctx?.ui?.notify("Starting vllm-mlx server…", "info");
  const pid = startServerProcess();
  if (!pid) {
    ctx?.ui?.notify("Failed to start vllm-mlx server", "error");
    return false;
  }

  const ready = await waitForServer(undefined, undefined, ctx?.signal);
  if (ready) {
    ctx?.ui?.notify(`vllm-mlx server ready (pid ${pid}, port ${PORT})`, "info");
  } else {
    ctx?.ui?.notify("vllm-mlx server did not become ready in time", "error");
  }
  return ready;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Register the provider
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: BASE_URL,
    apiKey: "local",
    api: "openai-completions",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    models: [
      {
        id: MODEL_ID,
        name: "LFM2.5-8B-A1B (Local MLX 8-bit)",
        reasoning: false,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });

  // Auto-start server when the model is selected
  pi.on("model_select", async (event, ctx) => {
    if (event.model?.provider !== PROVIDER_NAME) return;

    if (isServerRunning()) {
      ctx.ui.notify(
        `vllm-mlx server already running (pid ${readPidFile()}, port ${PORT})`,
        "info",
      );
      return;
    }

    await ensureServer(ctx);
  });

  // Safety net: ensure server is running before each request + inject params
  pi.on("before_provider_request", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_NAME) return;

    // Ensure server is up (covers first-request edge case)
    if (!isServerRunning()) {
      await ensureServer(ctx);
    }

    // Inject generation parameters into the payload
    return {
      ...event.payload,
      temperature: GENERATION_PARAMS.temperature,
      top_k: GENERATION_PARAMS.top_k,
      repetition_penalty: GENERATION_PARAMS.repetition_penalty,
    };
  });
}
