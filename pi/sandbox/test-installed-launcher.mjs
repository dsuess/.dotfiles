import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getClientControllerPaths } from "./client.mjs";
import { discoverRepositoryScope } from "./repository-scope.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INSTALLED_LAUNCHER = path.join(os.homedir(), "bin", "pi");
const STOW_SOURCE_LAUNCHER = path.resolve(SCRIPT_DIR, "..", "..", "bin", "pi");
const RPC_TIMEOUT_MS = 90_000;

function deploymentError(message) {
  return `${message}; run ./install.sh config to deploy the Stow-managed Pi launcher and current Gondolin image`;
}

function assertInstalledLauncher() {
  assert.ok(fs.existsSync(INSTALLED_LAUNCHER), deploymentError(`installed launcher is missing: ${INSTALLED_LAUNCHER}`));
  assert.equal(
    fs.realpathSync(INSTALLED_LAUNCHER),
    fs.realpathSync(STOW_SOURCE_LAUNCHER),
    deploymentError(`${INSTALLED_LAUNCHER} does not resolve to ${STOW_SOURCE_LAUNCHER}`),
  );
}

function startRpc(workspace) {
  const env = { ...process.env, PI_GONDOLIN_HANDSHAKE_TIMEOUT_MS: "60000", PI_SKIP_VERSION_CHECK: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(INSTALLED_LAUNCHER, [
    "--mode", "rpc", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--tools", "bash",
  ], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new StringDecoder("utf8");
  const responses = new Map();
  const events = [];
  let stdout = "";
  let stderr = "";
  let buffer = "";
  let protocolError = null;
  let closedResult = null;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const rejectPending = (error) => {
    for (const { reject, timer } of responses.values()) {
      clearTimeout(timer);
      reject(error);
    }
    responses.clear();
  };
  const protocolFailure = (error) => {
    if (protocolError) return;
    protocolError = error;
    rejectPending(error);
    child.kill("SIGTERM");
  };
  const handleRecord = (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      protocolFailure(new Error(`launcher emitted invalid JSONL: ${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      return;
    }
    if (message.type === "response" && message.id && responses.has(message.id)) {
      const { resolve, timer } = responses.get(message.id);
      clearTimeout(timer);
      responses.delete(message.id);
      resolve(message);
      return;
    }
    events.push(message);
  };
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      handleRecord(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => protocolFailure(new Error(`installed launcher could not start: ${error.message}`)));
  child.once("close", (code, signal) => {
    const trailing = buffer + decoder.end();
    if (trailing) handleRecord(trailing);
    closedResult = { code, signal };
    rejectPending(protocolError ?? new Error(`installed launcher exited before completing RPC\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    resolveClosed(closedResult);
  });

  return {
    child,
    closed,
    events,
    diagnostics: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
    request(command) {
      const id = `installed-launcher-${responses.size + 1}-${Date.now()}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          responses.delete(id);
          reject(new Error(`RPC ${command.type} timed out\n${this.diagnostics()}`));
        }, RPC_TIMEOUT_MS);
        responses.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (error) protocolFailure(error);
        });
      });
    },
    async close() {
      if (closedResult) return closedResult;
      if (!child.stdin.destroyed) child.stdin.end();
      let timeout;
      const result = await Promise.race([
        closed,
        new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 30_000); }),
      ]);
      clearTimeout(timeout);
      if (result === null) {
        child.kill("SIGKILL");
        throw new Error(`installed launcher did not exit after stdin closed\n${this.diagnostics()}`);
      }
      return result;
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test("installed Stow launcher routes a non-Git RPC bash probe and releases its root lease", { timeout: 150_000 }, async () => {
  assertInstalledLauncher();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-installed-launcher-")));
  const workspace = path.join(root, "non-git-workspace");
  fs.mkdirSync(workspace);
  const canonicalWorkspace = fs.realpathSync(workspace);
  const scope = discoverRepositoryScope({ launchDirectory: canonicalWorkspace, pathValue: process.env.PATH });
  assert.equal(scope.canonicalWorkspaceRoot, canonicalWorkspace, "fixture must remain a non-Git canonical workspace");
  const paths = getClientControllerPaths(scope.workspaceKey);
  const rpc = startRpc(canonicalWorkspace);
  try {
    const state = await rpc.request({ type: "get_state" });
    assert.equal(state.success, true, rpc.diagnostics());
    assert.equal(state.data.sessionFile ?? null, null, "--no-session must disable persistence");

    const probe = await rpc.request({ type: "bash", command: "pwd" });
    assert.equal(probe.success, true, rpc.diagnostics());
    assert.equal(probe.data.exitCode, 0, rpc.diagnostics());
    assert.equal(probe.data.output.trim(), canonicalWorkspace, "bash probe did not execute in the canonical guest workspace");
    assert.equal(rpc.events.some((event) => event.type === "agent_start"), false, "canary must not send a model prompt");

    const result = await rpc.close();
    assert.equal(result.code, 0, rpc.diagnostics());
    assert.equal(result.signal, null, rpc.diagnostics());
    await waitFor(
      () => !fs.existsSync(paths.manifestPath) && !fs.existsSync(paths.socketPath),
      "installed launcher closed but did not release the controller root lease",
    );
  } finally {
    if (!rpc.child.killed && !rpc.child.stdin.destroyed) {
      await rpc.close().catch(() => rpc.child.kill("SIGKILL"));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
