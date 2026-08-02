#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";

function usage() {
  console.error("Usage: unrestricted-network.mjs --settings <path> -- <command> [args...]");
  process.exit(2);
}

function quoteArg(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const args = process.argv.slice(2);
if (args[0] !== "--settings" || !args[1] || args[2] !== "--" || args.length < 4) usage();

const settingsPath = args[1];
const commandArgs = args.slice(3);
let child;

try {
  const rawConfig = JSON.parse(await readFile(settingsPath, "utf8"));
  const config = SandboxRuntimeConfigSchema.parse(rawConfig);

  await SandboxManager.initialize(config);

  // SRT enables its network boundary whenever allowedDomains is present. The
  // schema requires that field, so remove it only after validation and
  // initialization. Filesystem, credential, PTY, and Apple Event restrictions
  // remain active, while the wrapped process keeps host network access without
  // an allowlist or proxy. Unix-socket access follows allowAllUnixSockets.
  delete config.network.allowedDomains;

  const command = commandArgs.map(quoteArg).join(" ");
  const sandboxedCommand = await SandboxManager.wrapWithSandbox(command);
  child = spawn(sandboxedCommand, { shell: true, stdio: "inherit" });

  process.on("SIGINT", () => child?.kill("SIGINT"));
  process.on("SIGTERM", () => child?.kill("SIGTERM"));

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  SandboxManager.cleanupAfterCommand();
  await SandboxManager.reset();
  process.exit(result.signal ? 1 : (result.code ?? 1));
} catch (error) {
  try {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset();
  } catch {
    // Preserve the original initialization or execution failure.
  }
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
