import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const extensionModule = await jiti.import(new URL("./index.ts", import.meta.url).pathname);

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const AGENT_DIR = fileURLToPath(new URL("../../", import.meta.url));

function fakeClient() {
  return {
    policyGeneration: HEX_B,
    destroyCalls: 0,
    releaseCalls: 0,
    terminalListener: null,
    destroy() { this.destroyCalls += 1; },
    onTerminal(listener) { this.terminalListener = listener; return () => { this.terminalListener = null; }; },
    failTransport(message = "controller transport unavailable: peer closed") { this.terminalListener?.(new Error(message)); },
    async release() { this.releaseCalls += 1; },
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
      return { exitCode: 0, signal: null, outputBytes: 2, sidecarId: "vm-shared" };
    },
  };
}

function createHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srt-routing-extension-"));
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
  const client = options.client ?? fakeClient();
  const env = options.env ?? {
    PI_SRT_ROUTING_SANDBOX: "1",
    PI_SRT_ROUTING_SOCKET: path.join(root, "controller.sock"),
    PI_SRT_ROUTING_LEASE: HEX_A,
    PI_SRT_ROUTING_WORKSPACE_KEY: HEX_C,
    PI_SRT_ROUTING_WORKSPACE_ROOT: "/physical/workspace",
    PI_SRT_ROUTING_POLICY_GENERATION: HEX_B,
    PI_SRT_ROUTING_IMAGE_GENERATION: HEX_A,
    PI_SRT_ROUTING_VM_ID: "vm-shared",
    PI_SRT_ROUTING_BUILTIN_TOOLS: "read,bash",
    PI_SRT_ROUTING_HOST_TOOLS: "",
    PI_SRT_ROUTING_HANDSHAKE_FILE: handshake,
  };
  if (options.root) {
    for (const name of ["PI_SRT_ROUTING_SOCKET", "PI_SRT_ROUTING_LEASE", "PI_SRT_ROUTING_ROOT_OWNER_PID", "PI_SRT_ROUTING_WORKSPACE_KEY", "PI_SRT_ROUTING_WORKSPACE_ROOT", "PI_SRT_ROUTING_POLICY_GENERATION", "PI_SRT_ROUTING_IMAGE_GENERATION", "PI_SRT_ROUTING_VM_ID"]) delete env[name];
    env.PI_SRT_ROUTING_STARTUP_DESCRIPTOR = Buffer.from(JSON.stringify({
      version: 2, workspaceKey: HEX_C, workspaceRoot: "/physical/workspace", bareCommonDirectory: null,
      token: HEX_A, sourceDigest: HEX_B, generation: 1, runtimeRoot: root,
      socketPath: path.join(root, "controller.sock"), manifestPath: path.join(root, "controller.json"),
      capabilityPath: path.join(root, "capability.json"),
    })).toString("base64");
  }
  const connectCalls = [];
  extensionModule.createSrtToolRoutingSandboxExtension({
    env,
    statusIntervalMs: options.statusIntervalMs,
    auditOptions: { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR },
    acquire: options.acquire,
    async connect(request) {
      connectCalls.push(request);
      if (options.connectError) throw new Error(options.connectError);
      if (options.connect) return options.connect(request);
      return {
        client,
        status: {
          health: "healthy",
          dockerHealthy: true,
          sidecarId: "vm-shared",
          workspaceKey: HEX_C,
          workspaceRoot: "/physical/workspace",
          policyGeneration: HEX_B,
          runtimeGeneration: HEX_A,
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

test("session handshake activates only requested replacements and trusted current tools", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(harness.active().sort(), ["bash", "read"]);
  assert.equal(harness.connectCalls.length, 1);
  assert.equal(harness.getAllToolsCalls(), 1, "session_start reuses its first complete inventory audit");
  const handshake = JSON.parse(fs.readFileSync(harness.handshake, "utf8"));
  assert.equal(handshake.ok, true);
  assert.equal(handshake.sidecarId, "vm-shared");
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

  harness.sourceByName.set("bash", {
    path: "/tmp/spoofed-bash.ts",
    source: "another-extension",
    scope: "user",
    origin: "top-level",
    baseDir: AGENT_DIR,
  });
  const spoofed = await harness.emit("tool_call", {
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "pwd" },
  });
  assert.equal(spoofed.block, true);
  assert.equal(spoofed.terminate, true);
  await assert.rejects(
    () => harness.emit("before_agent_start", { prompt: "x" }),
    /built-in slot 'bash'.*trusted SRT tool-routing extension provenance/,
  );
  assert.equal(harness.active().includes("bash"), false);
});

test("user Bash runs synchronous planning preflight before any controller RPC", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  let controllerCalls = 0;
  harness.client.exec = async () => {
    controllerCalls += 1;
    return { exitCode: 0, signal: null, outputBytes: 0, sidecarId: "vm-shared" };
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
  harness.pi.events.on("srt-tool-routing:lifecycle", (event) => lifecycle.push(event));
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
      health: "healthy", dockerHealthy: true, sidecarId: "vm-shared", workspaceKey: HEX_C,
      workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, runtimeGeneration: HEX_A, attachedRoots: 1,
    },
  });
  assert.deepEqual(await queuedInput, { action: "continue" });
  assert.ok((await queuedBash).operations);
  assert.deepEqual(harness.active().sort(), ["bash", "read"]);
  assert.equal(lifecycle.at(-1).health, "healthy");
  assert.equal(harness.env.PI_SRT_ROUTING_LEASE, HEX_A);
});

test("unexpected terminal client failures disable routing without waiting for status polling", async (t) => {
  const client = fakeClient();
  const harness = createHarness(t, { client });
  const lifecycle = [];
  harness.pi.events.on("srt-tool-routing:lifecycle", (event) => lifecycle.push(event));
  await harness.emit("session_start", { reason: "startup" });
  client.failTransport();
  assert.deepEqual(harness.active(), []);
  assert.equal(harness.shutdownCalls(), 1);
  assert.equal(lifecycle.at(-1).health, "failed");
  assert.match(lifecycle.at(-1).failure, /controller transport unavailable: peer closed/);
});

test("retired client transport failures do not fail a replacement runtime", async (t) => {
  const client = fakeClient();
  const harness = createHarness(t, { client });
  await harness.emit("session_start", { reason: "startup" });
  await harness.emit("session_shutdown", { reason: "new" });
  client.failTransport();
  assert.equal(harness.shutdownCalls(), 0);
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
    status: { health: "healthy", dockerHealthy: true, sidecarId: "vm-shared", workspaceKey: HEX_C,
      workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, runtimeGeneration: HEX_A, attachedRoots: 1 },
  });
  await ready.emit("input", { text: "queued", source: "interactive" });
  await ready.emit("session_shutdown", { reason: "quit" });
  await ready.emit("session_shutdown", { reason: "quit" });
  assert.equal(releases, 1);
  assert.equal(ready.env.PI_SRT_ROUTING_LEASE, undefined);
});

test("root replacements retain one lease and VM for every Pi replacement reason", async (t) => {
  for (const reason of ["new", "resume", "fork", "reload"]) {
    const shared = { PI_SRT_ROUTING_SANDBOX: "1", PI_SRT_ROUTING_BUILTIN_TOOLS: "read,bash", PI_SRT_ROUTING_HOST_TOOLS: "" };
    const firstClient = fakeClient();
    const secondClient = fakeClient();
    let acquisitions = 0;
    const first = createHarness(t, {
      env: shared,
      root: true,
      client: firstClient,
      acquire: async ({ startup }) => {
        acquisitions += 1;
        return {
          client: firstClient, leaseToken: HEX_A, manifest: { socketPath: startup.socketPath },
          scope: { workspaceKey: HEX_C, canonicalWorkspaceRoot: "/physical/workspace" },
          status: { health: "healthy", dockerHealthy: true, sidecarId: "vm-shared", workspaceKey: HEX_C,
            workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, runtimeGeneration: HEX_A, attachedRoots: 1 },
        };
      },
    });
    await first.emit("session_start", { reason: "startup" });
    const sidecarId = shared.PI_SRT_ROUTING_VM_ID;
    await first.emit("session_shutdown", { reason });
    assert.equal(firstClient.releaseCalls, 0, `${reason} must not release the root lease`);
    assert.equal(shared.PI_SRT_ROUTING_LEASE, HEX_A, `${reason} must retain the capability`);
    assert.equal(shared.PI_SRT_ROUTING_VM_ID, sidecarId, `${reason} must retain the VM identity`);

    const second = createHarness(t, { env: shared, client: secondClient });
    await second.emit("session_start", { reason });
    assert.equal(acquisitions, 1, `${reason} must not acquire a second root lease`);
    assert.equal(second.connectCalls.length, 1);
    assert.equal(second.connectCalls[0].adoptLease, true, `${reason} must transfer release ownership`);
    assert.equal(second.connectCalls[0].renewalStartup.token, HEX_A, `${reason} must retain root renewal authority`);
    assert.deepEqual(second.active().sort(), ["bash", "read"]);
    await second.emit("session_shutdown", { reason: "quit" });
    assert.equal(secondClient.releaseCalls, 1, `${reason} final quit must release exactly once`);
    assert.equal(firstClient.releaseCalls, 0);
    assert.equal(shared.PI_SRT_ROUTING_LEASE, undefined);
    assert.equal(shared.PI_SRT_ROUTING_ROOT_OWNER_PID, undefined);
  }
});

test("pending root replacement cancels only the old waiter and leaves cold startup reusable", async (t) => {
  const shared = { PI_SRT_ROUTING_SANDBOX: "1", PI_SRT_ROUTING_BUILTIN_TOOLS: "read,bash", PI_SRT_ROUTING_HOST_TOOLS: "" };
  let firstSignal;
  const first = createHarness(t, {
    env: shared,
    root: true,
    acquire: async ({ signal }) => new Promise((_resolve, reject) => {
      firstSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  });
  await first.emit("session_start", { reason: "startup" });
  await first.emit("session_shutdown", { reason: "new" });
  assert.equal(firstSignal.aborted, true);
  assert.ok(shared.PI_SRT_ROUTING_STARTUP_DESCRIPTOR, "replacement keeps the original startup descriptor");
  assert.equal(shared.PI_SRT_ROUTING_LEASE, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.shutdownCalls(), 0, "retired callback must not fail or shut down Pi");

  const secondClient = fakeClient();
  const second = createHarness(t, {
    env: shared,
    client: secondClient,
    acquire: async ({ startup }) => ({
      client: secondClient, leaseToken: HEX_A, manifest: { socketPath: startup.socketPath },
      scope: { workspaceKey: HEX_C, canonicalWorkspaceRoot: "/physical/workspace" },
      status: { health: "healthy", dockerHealthy: true, sidecarId: "vm-shared", workspaceKey: HEX_C,
        workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, runtimeGeneration: HEX_A, attachedRoots: 1 },
    }),
  });
  await second.emit("session_start", { reason: "new" });
  assert.deepEqual(second.active().sort(), ["bash", "read"]);
  assert.equal(shared.PI_SRT_ROUTING_ROOT_OWNER_PID, String(process.pid));
  await second.emit("session_shutdown", { reason: "quit" });
  assert.equal(secondClient.releaseCalls, 1);
});

test("child replacements reconnect but never adopt or release the parent root lease", async (t) => {
  const ownerPid = String(process.pid + 1);
  const firstClient = fakeClient();
  const child = createHarness(t, {
    client: firstClient,
    env: {
      PI_SRT_ROUTING_SANDBOX: "1", PI_SRT_ROUTING_SOCKET: "/tmp/controller.sock", PI_SRT_ROUTING_LEASE: HEX_A,
      PI_SRT_ROUTING_ROOT_OWNER_PID: ownerPid, PI_SRT_ROUTING_WORKSPACE_KEY: HEX_C,
      PI_SRT_ROUTING_WORKSPACE_ROOT: "/physical/workspace", PI_SRT_ROUTING_POLICY_GENERATION: HEX_B,
      PI_SRT_ROUTING_IMAGE_GENERATION: HEX_A, PI_SRT_ROUTING_VM_ID: "vm-shared",
      PI_SRT_ROUTING_BUILTIN_TOOLS: "read,bash", PI_SRT_ROUTING_HOST_TOOLS: "",
    },
  });
  await child.emit("session_start", { reason: "startup" });
  assert.equal(child.connectCalls[0].adoptLease, false);
  await child.emit("session_shutdown", { reason: "reload" });
  assert.equal(firstClient.releaseCalls, 0);
  assert.equal(child.env.PI_SRT_ROUTING_ROOT_OWNER_PID, ownerPid);

  const replacementClient = fakeClient();
  const replacement = createHarness(t, { env: child.env, client: replacementClient });
  await replacement.emit("session_start", { reason: "reload" });
  assert.equal(replacement.connectCalls[0].adoptLease, false);
  await replacement.emit("session_shutdown", { reason: "quit" });
  assert.equal(replacementClient.releaseCalls, 0);
});

test("retired status callbacks cannot change the replacement lifecycle", async (t) => {
  let resolveStatus;
  const client = fakeClient();
  client.status = async () => new Promise((resolve) => { resolveStatus = resolve; });
  const harness = createHarness(t, { client, statusIntervalMs: 1 });
  const lifecycle = [];
  harness.pi.events.on("srt-tool-routing:lifecycle", (event) => lifecycle.push(event.health));
  await harness.emit("session_start", { reason: "startup" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(resolveStatus, "the old runtime began its status poll");
  await harness.emit("session_shutdown", { reason: "new" });
  resolveStatus({
    health: "healthy", dockerHealthy: true, sidecarId: "vm-shared", workspaceKey: HEX_C,
    workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, runtimeGeneration: HEX_A, attachedRoots: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lifecycle.at(-1), "stopped");
  assert.equal(harness.shutdownCalls(), 0);
});

test("fatal root routing failures release the active lease before clearing capabilities", async (t) => {
  const client = fakeClient();
  const harness = createHarness(t, {
    root: true,
    client,
    acquire: async ({ startup }) => ({
      client, leaseToken: HEX_A, manifest: { socketPath: startup.socketPath },
      scope: { workspaceKey: HEX_C, canonicalWorkspaceRoot: "/physical/workspace" },
      status: { health: "healthy", dockerHealthy: false, sidecarId: "vm-shared", workspaceKey: HEX_C,
        workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, runtimeGeneration: HEX_A, attachedRoots: 1 },
    }),
  });
  await harness.emit("session_start", { reason: "startup" });
  assert.deepEqual(await harness.emit("input", { text: "queued" }), { action: "handled" });
  assert.equal(client.releaseCalls, 1);
  assert.equal(harness.env.PI_SRT_ROUTING_LEASE, undefined);
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

test("an adopted root that cannot prove renewal authority fails closed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srt-routing-renewal-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    PI_SRT_ROUTING_SANDBOX: "1",
    PI_SRT_ROUTING_SOCKET: path.join(root, "controller.sock"),
    PI_SRT_ROUTING_LEASE: HEX_A,
    PI_SRT_ROUTING_ROOT_OWNER_PID: String(process.pid),
    PI_SRT_ROUTING_WORKSPACE_KEY: HEX_C,
    PI_SRT_ROUTING_WORKSPACE_ROOT: "/physical/workspace",
    PI_SRT_ROUTING_POLICY_GENERATION: HEX_B,
    PI_SRT_ROUTING_IMAGE_GENERATION: HEX_A,
    PI_SRT_ROUTING_BUILTIN_TOOLS: "read,bash",
    PI_SRT_ROUTING_HOST_TOOLS: "",
    PI_SRT_ROUTING_STARTUP_DESCRIPTOR: Buffer.from(JSON.stringify({
      version: 2, token: "f".repeat(64), workspaceKey: HEX_C, workspaceRoot: "/physical/workspace",
      runtimeRoot: root, socketPath: path.join(root, "controller.sock"), manifestPath: path.join(root, "manifest.json"),
      capabilityPath: path.join(root, "capability.json"), sourceDigest: HEX_B, generation: 1,
    })).toString("base64"),
  };
  let supplied;
  const harness = createHarness(t, {
    env,
    connect: async (options) => {
      supplied = options.renewalStartup;
      throw new Error("lease renewal denied");
    },
  });
  await harness.emit("session_start", { reason: "reload" });
  assert.deepEqual(await harness.emit("input", { text: "queued" }), { action: "handled" });
  assert.equal(supplied.token, "f".repeat(64));
  assert.deepEqual(harness.active(), []);
  assert.equal(harness.shutdownCalls(), 1);
});

test("extension is inert for explicit --yolo launches", () => {
  const definitions = [];
  extensionModule.createSrtToolRoutingSandboxExtension({ env: {} })({
    registerTool: (tool) => definitions.push(tool),
  });
  assert.deepEqual(definitions, []);
});
