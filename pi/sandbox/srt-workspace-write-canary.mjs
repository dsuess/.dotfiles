#!/usr/bin/env node
/** Native proof that the reviewed SRT patch permits only complete workspace writes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { buildSrtPolicy } from "./srt-policy.mjs";

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options); let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const clientSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [workspace, outside] = process.argv.slice(2);
const output = {};
for (const [name, target] of Object.entries({ hook: path.join(workspace, ".git", "hooks", "post-commit"), config: path.join(workspace, ".git", "config"), piSource: path.join(workspace, "pi", "sandbox", "probe"), outside })) {
  try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, name); output[name] = "written"; }
  catch (error) { output[name] = error.code; }
}
process.stdout.write(JSON.stringify(output));
`;

export async function runSrtWorkspaceWriteCanary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-workspace-write-"));
  const hostHome = fs.realpathSync(os.homedir()); const workspace = path.join(root, "workspace"); const controller = path.join(root, "controller"); const broker = path.join(root, "broker");
  const socket = path.join(broker, "docker.sock");
  const outside = path.join(hostHome, `.pi-srt-workspace-write-canary-forbidden-${process.pid}`);
  const client = path.join(workspace, "client.cjs");
  fs.mkdirSync(path.join(workspace, ".git", "hooks"), { recursive: true }); fs.mkdirSync(path.join(workspace, "pi", "sandbox"), { recursive: true }); fs.mkdirSync(controller); fs.mkdirSync(broker);
  fs.writeFileSync(client, clientSource); const server = net.createServer(); let initialized = false; const originalCwd = process.cwd();
  try {
    await new Promise((resolve) => server.listen(socket, resolve));
    process.chdir(workspace);
    const policy = buildSrtPolicy({ home: hostHome, workspaceRoot: workspace, controllerRoot: controller, dockerSocket: socket });
    await SandboxManager.initialize(policy, async () => true); initialized = true;
    const command = [process.execPath, client, policy.workspaceRoot, outside].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
    const wrapped = await SandboxManager.wrapWithSandbox(command, "sh");
    const result = await run("/bin/sh", ["-lc", wrapped], { cwd: policy.workspaceRoot, env: { HOME: policy.filesystem.denyRead[0], PATH: process.env.PATH ?? "", TMPDIR: os.tmpdir() } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { hook: "written", config: "written", piSource: "written", outside: "EPERM" });
  } finally {
    process.chdir(originalCwd);
    if (initialized) await SandboxManager.reset();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(outside, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { await runSrtWorkspaceWriteCanary(); console.log("SRT complete-workspace-write canary passed."); }
  catch (error) { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }
}
