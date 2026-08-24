import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const piRoot = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${piRoot}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": `${piRoot}/dist/index.js`,
  "@earendil-works/pi-tui": `${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  "@earendil-works/pi-ai": `${piRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  typebox: `${piRoot}/node_modules/typebox/build/index.mjs`,
} });
const extensionModule = await jiti.import(new URL("./index.ts", import.meta.url).pathname);

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const EXTENSION_PATH = new URL("./index.ts", import.meta.url).pathname;
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

function fakeClient() {
  return {
    policyGeneration: HEX_B,
    destroyCalls: 0,
    destroy() { this.destroyCalls += 1; },
    async access() {},
    async mkdir() {},
    async listDir() { return []; },
    async stat() {
      return { mode: 0o40755, size: 0, mtimeMs: 1, isFile: false, isDirectory: true, isSymbolicLink: false };
    },
    async readFile() { return { data: Buffer.alloc(0), truncated: false }; },
    async writeFile() {},
    async exec(_argv, options) {
      options.onEvent?.("stdout", Buffer.from("ok"));
      return { exitCode: 0, signal: null, outputBytes: 2, vmId: "vm-shared" };
    },
  };
}

function createHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-extension-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handshake = path.join(root, "ready.json");
  const handlers = new Map();
  const eventHandlers = new Map();
  const definitions = new Map();
  const sourceByName = new Map();
  const status = [];
  let active = ["read", "write", "edit", "bash", "grep", "find", "ls", "unknown_host_tool"];
  let getAllToolsCalls = 0;
  let shutdownCalls = 0;
  const sourceInfo = {
    path: EXTENSION_PATH,
    source: "auto",
    scope: "user",
    origin: "top-level",
    baseDir: AGENT_DIR,
  };
  const pi = {
    registerTool(definition) {
      definitions.set(definition.name, definition);
      sourceByName.set(definition.name, sourceInfo);
    },
    registerCommand() {},
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    events: {
      on(name, handler) {
        if (!eventHandlers.has(name)) eventHandlers.set(name, []);
        eventHandlers.get(name).push(handler);
        return () => {};
      },
      emit(name, payload) {
        for (const handler of eventHandlers.get(name) ?? []) handler(payload);
      },
    },
    getAllTools() {
      getAllToolsCalls += 1;
      const tools = [...definitions].map(([name, definition]) => ({
        name,
        description: definition.description,
        parameters: definition.parameters,
        promptGuidelines: definition.promptGuidelines,
        sourceInfo: sourceByName.get(name),
      }));
      tools.push({
        name: "unknown_host_tool",
        description: "unknown",
        parameters: { type: "object", properties: {} },
        sourceInfo: { path: "/tmp/unknown.ts", source: "auto", scope: "user", origin: "top-level", baseDir: AGENT_DIR },
      });
      return tools;
    },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; },
  };
  const client = fakeClient();
  const env = {
    PI_GONDOLIN_SANDBOX: "1",
    PI_GONDOLIN_SOCKET: path.join(root, "controller.sock"),
    PI_GONDOLIN_LEASE: HEX_A,
    PI_GONDOLIN_WORKSPACE_KEY: HEX_C,
    PI_GONDOLIN_WORKSPACE_ROOT: "/physical/workspace",
    PI_GONDOLIN_POLICY_GENERATION: HEX_B,
    PI_GONDOLIN_IMAGE_GENERATION: HEX_A,
    PI_GONDOLIN_VM_ID: "vm-shared",
    PI_GONDOLIN_BUILTIN_TOOLS: "read,bash",
    PI_GONDOLIN_HOST_TOOLS: "",
    PI_GONDOLIN_HANDSHAKE_FILE: handshake,
  };
  if (options.root) {
    for (const name of ["PI_GONDOLIN_SOCKET", "PI_GONDOLIN_LEASE", "PI_GONDOLIN_WORKSPACE_KEY", "PI_GONDOLIN_WORKSPACE_ROOT", "PI_GONDOLIN_POLICY_GENERATION", "PI_GONDOLIN_IMAGE_GENERATION", "PI_GONDOLIN_VM_ID"]) delete env[name];
    env.PI_GONDOLIN_STARTUP_DESCRIPTOR = Buffer.from(JSON.stringify({
      version: 1, workspaceKey: HEX_C, workspaceRoot: "/physical/workspace", bareCommonDirectory: null,
      runtimeRoot: root, socketPath: path.join(root, "controller.sock"), manifestPath: path.join(root, "controller.json"),
    })).toString("base64");
  }
  const connectCalls = [];
  extensionModule.createGondolinSandboxExtension({
    env,
    auditOptions: { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR },
    acquire: options.acquire,
    async connect(request) {
      connectCalls.push(request);
      if (options.connectError) throw new Error(options.connectError);
      return {
        client,
        status: {
          health: "healthy",
          dockerHealthy: true,
          vmId: "vm-shared",
          workspaceKey: HEX_C,
          workspaceRoot: "/physical/workspace",
          policyGeneration: HEX_B,
          imageGeneration: HEX_A,
          attachedRoots: 1,
        },
      };
    },
  })(pi);

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/physical/workspace",
    ui: {
      theme: { fg: (_color, value) => value },
      setStatus: (...args) => status.push(args),
      notify: () => {},
    },
    shutdown() { shutdownCalls += 1; },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next !== undefined) result = next;
    }
    return result;
  };
  return {
    pi,
    ctx,
    client,
    env,
    handshake,
    definitions,
    sourceByName,
    eventHandlers,
    connectCalls,
    emit,
    active: () => [...active],
    getAllToolsCalls: () => getAllToolsCalls,
    shutdownCalls: () => shutdownCalls,
  };
}

test("session handshake activates only requested replacements and audited current tools", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(harness.active().sort(), ["bash", "read"]);
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(harness.getAllToolsCalls(), 1, "session_start reuses its first complete inventory audit");
  const handshake = JSON.parse(fs.readFileSync(harness.handshake, "utf8"));
  assert.equal(handshake.ok, true);
  assert.equal(handshake.vmId, "vm-shared");
  assert.deepEqual(handshake.tools.sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
});

test("unknown and source-spoofed tools are removed and blocked before execution", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  const unknown = await harness.emit("tool_call", {
    toolName: "unknown_host_tool",
    toolCallId: "unknown-1",
    input: {},
  });
  assert.equal(unknown.block, true);
  assert.equal(unknown.terminate, true);

  harness.sourceByName.set("read", {
    path: "/tmp/spoofed-read.ts",
    source: "auto",
    scope: "user",
    origin: "top-level",
    baseDir: AGENT_DIR,
  });
  await assert.rejects(() => harness.emit("before_agent_start", { prompt: "x" }), /not owned/);
  assert.equal(harness.active().includes("read"), false);
});

test("user Bash runs synchronous planning preflight before any controller RPC", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  let controllerCalls = 0;
  harness.client.exec = async () => {
    controllerCalls += 1;
    return { exitCode: 0, signal: null, outputBytes: 0, vmId: "vm-shared" };
  };
  harness.pi.events.on(extensionModule.SANDBOX_BEFORE_USER_BASH_EVENT, (payload) => {
    payload.result = {
      result: {
        output: "blocked known mutation",
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });
  const result = await harness.emit("user_bash", { command: "touch denied", cwd: "/physical/workspace" });
  assert.equal(result.result.exitCode, 126);
  assert.equal(controllerCalls, 0);
});

test("interactive startup publishes starting and queues input and Bash until root acquisition", async (t) => {
  let resolveAcquire;
  const acquired = new Promise((resolve) => { resolveAcquire = resolve; });
  const harness = createHarness(t, {
    root: true,
    acquire: async () => acquired,
  });
  const lifecycle = [];
  harness.pi.events.on("gondolin-sandbox:lifecycle", (event) => lifecycle.push(event));
  await harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(harness.active(), []);
  assert.equal(lifecycle.at(-1).health, "starting");
  let inputSettled = false;
  const queuedInput = harness.emit("input", { text: "queued", source: "interactive" }).then((value) => { inputSettled = true; return value; });
  let bashSettled = false;
  const queuedBash = harness.emit("user_bash", { command: "pwd" }).then((value) => { bashSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inputSettled, false);
  assert.equal(bashSettled, false);
  resolveAcquire({
    client: harness.client,
    leaseToken: HEX_A,
    manifest: { socketPath: path.join(path.dirname(harness.handshake), "controller.sock") },
    scope: { workspaceKey: HEX_C, canonicalWorkspaceRoot: "/physical/workspace" },
    status: {
      health: "healthy", dockerHealthy: true, vmId: "vm-shared", workspaceKey: HEX_C,
      workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, imageGeneration: HEX_A, attachedRoots: 1,
    },
  });
  assert.deepEqual(await queuedInput, { action: "continue" });
  assert.ok((await queuedBash).operations);
  assert.deepEqual(harness.active().sort(), ["bash", "read"]);
  assert.equal(lifecycle.at(-1).health, "healthy");
  assert.equal(harness.env.PI_GONDOLIN_LEASE, HEX_A);
});

test("root shutdown aborts pending acquisition and releases an acquired lease once", async (t) => {
  let signal;
  const pending = createHarness(t, {
    root: true,
    acquire: async ({ signal: nextSignal }) => {
      signal = nextSignal;
      return new Promise(() => {});
    },
  });
  await pending.emit("session_start", { reason: "startup" });
  await pending.emit("session_shutdown", { reason: "quit" });
  assert.equal(signal.aborted, true);

  let resolveAcquire;
  let releases = 0;
  const ready = createHarness(t, {
    root: true,
    acquire: async () => new Promise((resolve) => { resolveAcquire = resolve; }),
  });
  ready.client.release = async () => { releases += 1; };
  await ready.emit("session_start", { reason: "startup" });
  resolveAcquire({
    client: ready.client, leaseToken: HEX_A, manifest: { socketPath: "/tmp/controller.sock" },
    scope: { workspaceKey: HEX_C, canonicalWorkspaceRoot: "/physical/workspace" },
    status: { health: "healthy", dockerHealthy: true, vmId: "vm-shared", workspaceKey: HEX_C,
      workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, imageGeneration: HEX_A, attachedRoots: 1 },
  });
  await ready.emit("input", { text: "queued", source: "interactive" });
  await ready.emit("session_shutdown", { reason: "quit" });
  await ready.emit("session_shutdown", { reason: "quit" });
  assert.equal(releases, 1);
  assert.equal(ready.env.PI_GONDOLIN_LEASE, undefined);
});

test("connection failure handles queued input without activating built-ins", async (t) => {
  const harness = createHarness(t, { connectError: "controller unavailable" });
  await harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(await harness.emit("input", { text: "queued" }), { action: "handled" });
  assert.equal(harness.active().some((name) => ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(name)), false);
  assert.equal(harness.shutdownCalls(), 1);
  const handshake = JSON.parse(fs.readFileSync(harness.handshake, "utf8"));
  assert.equal(handshake.ok, false);
});

test("extension is inert for explicit --yolo launches", () => {
  const definitions = [];
  extensionModule.createGondolinSandboxExtension({ env: {} })({
    registerTool: (tool) => definitions.push(tool),
  });
  assert.deepEqual(definitions, []);
});
