import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPiJiti, piPackageRoot } from "../../../test-helpers.mjs";
import { SERENA_PROFILE, SERENA_TOOLS } from "./serena-profile.mjs";
import { createWorkspaceApproval, WorkspaceApprovalStore } from "./workspace-approval.mjs";
const { runToolCall } = await import(path.join(piPackageRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js"));

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
    async status() {
      return {
        health: "healthy", dockerHealthy: true, sidecarId: "vm-shared", workspaceKey: HEX_C,
        workspaceRoot: "/physical/workspace", policyGeneration: HEX_B, runtimeGeneration: HEX_A, attachedRoots: 1,
      };
    },
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
  if (options.malformedApproval) {
    fs.mkdirSync(path.join(root, ".pi/routed-mcp"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, ".pi/routed-mcp/approvals.json"), '{"version":99}', { mode: 0o600 });
  }
  const workspaceRoot = options.projectMcp ? path.join(root, "project") : options.reviewedMcp ? SERENA_PROFILE.workspace : "/physical/workspace";
  if (options.projectMcp) {
    fs.mkdirSync(path.join(workspaceRoot, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".pi/mcp.json"), JSON.stringify({ mcpServers: options.projectMcp }));
  }
  const handlers = new Map();
  const eventHandlers = new Map();
  const definitions = new Map();
  const commands = new Map();
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
      if (definition.exposure === "direct" && !active.includes(definition.name)) active.push(definition.name);
      if (definition.exposure === "hidden") active = active.filter((name) => name !== definition.name);
    },
    registerCommand(name, definition) { commands.set(name, definition); },
    getMcpServers() { return [
      { name: "serena", config: { command: "/unapproved/spoof" }, extensionPath: "/tmp/spoof.ts" },
      { name: "arbitrary", config: { url: "https://example.invalid/mcp" }, extensionPath: "/tmp/arbitrary.ts" },
    ]; },
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
        exposure: definition.exposure ?? "direct",
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
  const mcpExecutions = [], channels = [];
  let offerings = [...SERENA_TOOLS, "execute_shell_command"];
  if (options.reviewedMcp || options.projectMcp) {
    const status = client.status.bind(client);
    client.status = async () => ({ ...await status(), workspaceRoot });
    client.openProcess = async (_argv, transportOptions) => {
      if (channels.filter((channel) => !channel.closed).length >= 2) throw new Error("stdio process limit reached (2)");
      let closed = false;
      const channel = {
        get closed() { return closed; },
        policyGeneration: client.policyGeneration,
        argv: _argv,
        receive: transportOptions.onEvent,
        send: async (bytes) => {
          if (closed) throw new Error("fixture channel closed");
          const message = JSON.parse(bytes.toString());
          let result;
          if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1" } };
          else if (message.method === "tools/list") result = { tools: offerings.map((name) => ({ name, description: name, annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { relative_path: { type: "string" } }, additionalProperties: true } })) };
          else if (message.method === "tools/call") { mcpExecutions.push(message.params); result = { content: [{ type: "text", text: JSON.stringify({ symbols: ["VerifiedFixtureSymbol"], name: message.params.name }) }] }; }
          if (message.id !== undefined) queueMicrotask(() => transportOptions.onEvent("stdout", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)));
        },
        close: async () => { if (!closed) { closed = true; transportOptions.onEvent("exit", Buffer.alloc(0)); } },
      };
      channels.push(channel);
      return channel;
    };
  }
  const env = options.env ?? {
    PI_SRT_ROUTING_SANDBOX: "1",
    PI_SRT_ROUTING_SOCKET: path.join(root, "controller.sock"),
    PI_SRT_ROUTING_LEASE: HEX_A,
    PI_SRT_ROUTING_WORKSPACE_KEY: HEX_C,
    PI_SRT_ROUTING_WORKSPACE_ROOT: workspaceRoot,
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
  let control;
  extensionModule.createSrtToolRoutingSandboxExtension({
    env,
    mcpApproval: createWorkspaceApproval({ store: new WorkspaceApprovalStore(root) }),
    onControl: (value) => { control = value; },
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
          workspaceRoot,
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
    cwd: workspaceRoot,
    isProjectTrusted: () => options.projectTrusted !== false && Boolean(options.reviewedMcp || options.projectMcp),
    sessionManager: options.sessionManager ?? {},
    isIdle: () => true,
    ui: {
      theme: { fg: (_color, value) => value },
      setStatus: (...args) => status.push(args),
      notify: () => {},
      confirm: async () => options.mcpApprove !== false,
    },
    shutdown() { shutdownCalls += 1; },
  };
  const emit = async (name, event = {}) => {
    if (name === "before_agent_start") event = { systemPromptOptions: { sections: {} }, ...event };
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
    commands,
    channels,
    mcpExecutions,
    async changeOfferings(next) {
      offerings = next;
      channels.at(-1).receive("stdout", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`));
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    async runTool(name, args = {}, parentToolCallId) {
      return runToolCall({ type: "toolCall", id: "pipeline-fixture", name, arguments: args }, {
        tools: [...definitions.values()], assistantMessage: { role: "assistant", content: [], timestamp: Date.now() },
        context: { messages: [], tools: [] },
        beforeToolCall: ({ toolCall, args }) => emit("tool_call", { toolName: toolCall.name, toolCallId: toolCall.id, input: args, parentToolCallId }),
      });
    },
    sourceByName,
    eventHandlers,
    connectCalls,
    control,
    status,
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

test("verified late MCP offerings pass the real tool pipeline; identical names without authority fail", async (t) => {
  const harness = createHarness(t, { reviewedMcp: true });
  await harness.emit("session_start", { reason: "startup" });
  assert.equal(harness.channels.length, 0, "background MCP startup follows controller readiness");
  await harness.emit("before_agent_start");
  const name = "mcp__serena__get_symbols_overview";
  assert.ok(harness.active().includes(name));
  assert.equal(harness.definitions.has("mcp__serena__execute_shell_command"), true, "approved non-hidden offerings are normalized to direct exposure outside planning");
  assert.deepEqual(harness.channels.map((channel) => channel.argv), [[path.join(SERENA_PROFILE.workspace, SERENA_PROFILE.command), "pi"]], "same-name and arbitrary server registrations never start");
  assert.equal((await harness.runTool("mcp__serena__execute_shell_command")).isError, false);
  assert.equal((await harness.runTool("mcp__arbitrary__find_symbol")).isError, true);
  assert.equal(harness.mcpExecutions.length, 1);
  const result = await harness.runTool(name, { relative_path: "fixture.py" });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(result.result.content[0].text, /VerifiedFixtureSymbol/);
  const nested = await harness.runTool(name, {}, "parent-codemode-call");
  assert.equal(nested.isError, false);
  harness.sourceByName.set(name, { path: "/tmp/spoofed-serena.ts", source: "auto", scope: "user", origin: "top-level", baseDir: AGENT_DIR });
  const rejected = await harness.runTool(name);
  assert.equal(rejected.isError, true);
  assert.match(rejected.result.content[0].text, /not a trusted SRT/);
  assert.equal(harness.mcpExecutions.length, 3);
  const projection = harness.definitions.get("read").prepareLoadout({ declared: [{ name }] });
  assert.ok(projection.hiddenDeclarations.includes(name), "late spoofed declarations are hidden by the loadout projection");
  harness.pi.setActiveTools([name]);
  await harness.emit("turn_start");
  assert.equal(harness.active().includes(name), false, "turn audit also covers a loadout without core anchors");
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("late MCP registration composes with the real planning guard and restores only reviewed edits", async (t) => {
  const harness = createHarness(t, { reviewedMcp: true });
  const plan = await jiti.import(new URL("../plan-mode/index.ts", import.meta.url).pathname);
  harness.pi.registerFlag = () => {}; harness.pi.registerShortcut = () => {};
  harness.pi.getFlag = () => undefined; harness.pi.appendEntry = () => {};
  harness.pi.sendMessage = () => {}; harness.pi.sendUserMessage = () => {};
  harness.pi.registerMessageRenderer = () => {}; harness.pi.registerEntryRenderer = () => {}; harness.ctx.ui.setWidget = () => {};
  harness.ctx.sessionManager.getBranch = () => [];
  plan.default(harness.pi);
  await harness.emit("session_start", { reason: "startup" });
  await harness.commands.get("plan").handler("", harness.ctx);
  await harness.emit("before_agent_start");
  const read = "mcp__serena__get_symbols_overview", edit = "mcp__serena__replace_symbol_body";
  assert.ok(harness.active().includes(read));
  assert.equal(harness.active().includes(edit), false);
  assert.equal((await harness.runTool(read)).isError, false);
  const blocked = await harness.runTool(edit, {}, "nested-parent");
  assert.equal(blocked.isError, true);
  assert.match(blocked.result.content[0].text, /Planning mode blocks/);
  await harness.commands.get("plan").handler("off", harness.ctx);
  assert.ok(harness.active().includes(edit), "planning exit restores an edit registered while guard was active");
  assert.equal((await harness.runTool(edit)).isError, false, "server readOnlyHint does not control classification");
  await harness.changeOfferings(["get_symbols_overview"]);
  assert.equal(harness.active().includes(edit), false);
  assert.equal((await harness.runTool(edit)).isError, true);
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("policy refresh reconnects lazily; core off mode never grants a host Serena fallback", async (t) => {
  const harness = createHarness(t, { reviewedMcp: true });
  await harness.emit("session_start", { reason: "startup" });
  await harness.emit("before_agent_start");
  const name = "mcp__serena__get_symbols_overview";
  await harness.control.setMode("off", harness.ctx);
  assert.equal((await harness.runTool(name)).isError, false);
  harness.client.policyGeneration = "e".repeat(64);
  await harness.channels[0].close();
  assert.equal(harness.active().includes(name), false);
  await harness.emit("before_agent_start");
  assert.equal(harness.channels.length, 2);
  assert.equal(harness.channels[1].policyGeneration, "e".repeat(64));
  assert.equal((await harness.runTool(name)).isError, false);
  harness.client.failTransport();
  assert.equal((await harness.runTool(name)).isError, true);
  assert.equal(harness.channels.length, 2, "no host transport or edit replay after controller loss");
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("verified MCP authority is retired on every conversation/runtime replacement", async (t) => {
  for (const reason of ["reload", "new", "resume", "fork", "quit"]) {
    const first = createHarness(t, { reviewedMcp: true });
    await first.emit("session_start", { reason: "startup" });
    await first.emit("before_agent_start");
    const name = "mcp__serena__get_symbols_overview";
    const retiredDefinition = first.definitions.get(name);
    assert.equal((await first.runTool(name)).isError, false);
    await first.emit("session_shutdown", { reason });
    await assert.rejects(retiredDefinition.execute("old", {}), /retired/);
    assert.equal(first.active().includes(name), false);
    const next = createHarness(t, { reviewedMcp: true });
    await next.emit("session_start", { reason });
    await next.emit("before_agent_start");
    assert.equal((await next.runTool(name)).isError, false);
    assert.notEqual(next.definitions.get(name).parameters, retiredDefinition.parameters);
    await next.emit("session_shutdown", { reason: "quit" });
  }
});

test("baseline regression: a late direct Serena declaration is rejected without verified channel authority", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  const name = "mcp__serena__get_symbols_overview";
  let executions = 0;
  harness.pi.registerTool({ name, exposure: "direct", parameters: { type: "object", properties: {} }, execute: async () => { executions++; return { content: [], details: undefined }; } });
  harness.pi.setActiveTools([...harness.active(), name]);
  assert.ok(harness.active().includes(name), "dynamic registration can reach declarations after the inventory pass");
  const rejected = await harness.emit("tool_call", {
    toolName: name, toolCallId: "late-serena-baseline", input: { relative_path: "conductor/visonic_conductor/job.py", depth: 0, max_answer_chars: 3000 },
  });
  assert.equal(rejected.block, true);
  assert.equal(rejected.terminate, true);
  assert.match(rejected.reason, /not a trusted SRT tool-routing replacement, host adapter, or live routed MCP tool/);
  assert.equal(executions, 0);
  const result = await harness.runTool(name, { relative_path: "conductor/visonic_conductor/job.py" });
  assert.equal(result.isError, true, "inspect the actual pipeline result, not exit status or tool visibility");
  assert.match(result.result.content[0].text, /not a trusted SRT/);
  await harness.emit("before_agent_start");
  assert.equal(harness.active().includes(name), false);
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

test("conversation-local off survives only extension reload, never replacement, child, or restart", async (t) => {
  for (const reason of ["reload", "new", "resume", "fork", "startup"]) {
    const sessionManager = {};
    const first = createHarness(t, { sessionManager });
    await first.emit("session_start", { reason: "startup" });
    await first.control.setMode("off", first.ctx);
    assert.deepEqual(first.control.getMode(), { mode: "off", blockedReason: null });
    assert.equal(Object.values(first.env).includes("off"), false, "off is never environment authority");
    const child = createHarness(t, { env: { ...first.env }, sessionManager: {} });
    await child.emit("session_start", { reason: "reload" });
    assert.equal(child.control.getMode().mode, "on", "another client cannot inherit off even with identical capabilities");
    await child.emit("session_shutdown", { reason: "quit" });
    await first.emit("session_shutdown", { reason: reason === "startup" ? "reload" : reason });
    const replacement = createHarness(t, { env: first.env, sessionManager });
    await replacement.emit("session_start", { reason });
    assert.equal(replacement.control.getMode().mode, reason === "reload" ? "off" : "on", reason);
    await replacement.emit("session_shutdown", { reason: "quit" });
  }
});

test("idle controls reject active tools, batches, user Bash, and policy transitions", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  for (const [start, end, event] of [
    ["agent_start", "agent_end", {}],
    ["tool_execution_start", "tool_execution_end", { toolCallId: "host-1", toolName: "ketch_search" }],
  ]) {
    await harness.emit(start, event);
    await assert.rejects(() => harness.control.setMode("off", harness.ctx), /idle.*Retry after/);
    assert.equal(harness.control.getMode().mode, "on");
    await harness.emit(end, event);
  }
  let finish;
  harness.client.exec = async () => new Promise((resolve) => { finish = resolve; });
  const response = await harness.emit("user_bash", { command: "pwd" });
  await assert.rejects(() => harness.control.setMode("off", harness.ctx), /idle.*Retry after/, "Bash authority is reserved before its engine starts");
  const running = response.operations.exec("pwd", process.cwd(), { onData() {} });
  await assert.rejects(() => harness.control.setMode("off", harness.ctx), /idle.*Retry after/);
  finish({ exitCode: 0 });
  await running;
  let release;
  const transition = harness.control.atIdle(harness.ctx, async () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(() => harness.control.setMode("off", harness.ctx), /idle.*Retry after/);
  await assert.rejects(() => harness.definitions.get("read").execute("blocked", { path: "x" }), /controls are changing/);
  release();
  await transition;
  await harness.control.setMode("off", harness.ctx);
  assert.equal(harness.control.getMode().mode, "off");
  harness.ctx.isIdle = () => false;
  await assert.rejects(() => harness.control.setMode("on", harness.ctx), /idle.*Retry after/);
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("on waits for controller and effective policy, and failure blocks execution instead of host fallback", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  await harness.control.setMode("off", harness.ctx);
  let finish;
  harness.control.setPolicyVerifier(async () => new Promise((resolve) => { finish = resolve; }));
  const enabling = harness.control.setMode("on", harness.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(harness.control.getMode().blockedReason, /being verified/);
  await assert.rejects(() => harness.definitions.get("read").execute("read-transition", { path: "x" }), /controls are changing/);
  finish();
  await enabling;
  assert.deepEqual(harness.control.getMode(), { mode: "on", blockedReason: null });
  await harness.control.setMode("off", harness.ctx);
  harness.control.setPolicyVerifier(async () => { throw new Error("effective snapshot is not ready"); });
  await assert.rejects(() => harness.control.setMode("on", harness.ctx), /execution blocked.*effective snapshot/);
  assert.equal(harness.control.getMode().mode, "on");
  await assert.rejects(() => harness.definitions.get("read").execute("read-blocked", { path: "x" }), /execution blocked/);
  const bash = await harness.emit("user_bash", { command: "pwd" });
  assert.equal(bash.result.exitCode, 126);
  assert.match(bash.result.output, /effective snapshot/);
  assert.deepEqual(await harness.emit("input", { text: "x" }), { action: "handled" });
  await harness.control.setMode("off", harness.ctx);
  harness.client.status = async () => { throw new Error("controller unavailable"); };
  await assert.rejects(() => harness.control.setMode("on", harness.ctx), /execution blocked.*controller unavailable/);
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("controller health failure while deliberately off retains host execution and reload choice", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  await harness.control.setMode("off", harness.ctx);
  harness.client.failTransport();
  assert.equal(harness.control.getMode().mode, "off");
  assert.deepEqual(harness.active().sort(), ["bash", "read"]);
  assert.equal(harness.shutdownCalls(), 0);
  const chunks = [];
  const response = await harness.emit("user_bash", { command: "printf host" });
  await response.operations.exec("printf host", process.cwd(), { onData: (data) => chunks.push(data.toString()) });
  assert.equal(chunks.join(""), "host");
  await assert.rejects(() => harness.control.setMode("on", harness.ctx), /execution blocked.*transport unavailable/);
  await harness.control.setMode("off", harness.ctx);
  await harness.emit("session_shutdown", { reason: "reload" });
  const replacement = createHarness(t, { env: harness.env, sessionManager: harness.ctx.sessionManager, connectError: "controller unavailable" });
  // Supply failed inherited transport rather than acquiring a new controller.
  Object.assign(replacement.env, {
    PI_SRT_ROUTING_SOCKET: "/tmp/failed.sock", PI_SRT_ROUTING_LEASE: HEX_A,
    PI_SRT_ROUTING_WORKSPACE_KEY: HEX_C, PI_SRT_ROUTING_WORKSPACE_ROOT: "/physical/workspace",
    PI_SRT_ROUTING_POLICY_GENERATION: HEX_B, PI_SRT_ROUTING_IMAGE_GENERATION: HEX_A,
  });
  await replacement.emit("session_start", { reason: "reload" });
  assert.deepEqual(await replacement.emit("input", { text: "x" }), { action: "continue" });
  assert.equal(replacement.control.getMode().mode, "off");
  assert.deepEqual(replacement.active().sort(), ["bash", "read"]);
  assert.equal(replacement.shutdownCalls(), 0);
  await assert.rejects(() => replacement.control.setMode("on", replacement.ctx), /execution blocked.*controller unavailable/);
  await replacement.control.setMode("off", replacement.ctx);
  assert.equal(replacement.control.getMode().mode, "off", "failed reload readiness cannot erase prior explicit authorization");
  await replacement.emit("session_shutdown", { reason: "quit" });
});

test("off cannot bypass normal startup readiness or trusted provenance", async (t) => {
  const harness = createHarness(t, { connectError: "controller unavailable" });
  await harness.emit("session_start", { reason: "startup" });
  await assert.rejects(() => harness.control.setMode("off", harness.ctx), /controller unavailable/);
  assert.equal(harness.control.getMode().mode, "on");
  const ready = createHarness(t);
  await ready.emit("session_start", { reason: "startup" });
  await ready.control.setMode("off", ready.ctx);
  ready.sourceByName.set("bash", { path: "/tmp/spoofed.ts", scope: "user", origin: "top-level", baseDir: AGENT_DIR });
  assert.equal((await ready.emit("tool_call", { toolName: "bash" })).block, true);
  await assert.rejects(() => ready.emit("before_agent_start"), /trusted SRT tool-routing extension provenance/);
  assert.deepEqual(ready.active(), []);
  assert.equal(ready.shutdownCalls(), 1);
});

test("off keeps the independent planning user-Bash preflight", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  await harness.control.setMode("off", harness.ctx);
  harness.pi.events.on(extensionModule.SANDBOX_BEFORE_USER_BASH_EVENT, (payload) => {
    payload.result = { result: { output: "Planning mode blocks mutations", exitCode: 126, cancelled: false, truncated: false } };
  });
  const result = await harness.emit("user_bash", { command: "touch must-not-exist" });
  assert.equal(result.result.exitCode, 126);
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("real planning extension blocks native-off mutations independently of routing mode", async (t) => {
  const plan = await jiti.import(new URL("../plan-mode/index.ts", import.meta.url).pathname);
  const harness = createHarness(t);
  const entries = [];
  Object.assign(harness.pi, {
    registerFlag() {}, getFlag: () => true, registerEntryRenderer() {}, registerShortcut() {},
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  });
  Object.assign(harness.ctx.sessionManager, { getBranch: () => entries, getSessionFile: () => undefined });
  harness.ctx.ui.setWidget = () => {};
  plan.default(harness.pi);
  await harness.emit("session_start", { reason: "startup" });
  await harness.emit("input", { text: "planning", source: "interactive" });
  const planningTools = harness.active();
  assert.equal(planningTools.includes("write"), false);
  for (const selectedMode of ["off", "on"]) {
    await harness.control.setMode(selectedMode, harness.ctx);
    assert.deepEqual(harness.active(), planningTools, "changing SRT mode must not restore gated mutation tools");
    for (const [toolName, input] of [["write", { path: "denied", content: "x" }], ["bash", { command: "touch denied" }]]) {
      const blocked = await harness.emit("tool_call", { toolName, input });
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /Planning mode/);
    }
    const userBash = await harness.emit("user_bash", { command: "touch denied" });
    assert.equal(userBash.result.exitCode, 126);
    assert.match(userBash.result.output, /Planning mode/);
  }
  assert.equal(entries.some((entry) => JSON.stringify(entry).includes('"mode":"off"')), false, "bypass authority is never persisted with planning history");
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("module re-evaluation retains trusted reload state, not transcript or environment off claims", async () => {
  const modeModule = await jiti.import(new URL("./mode-state.ts", import.meta.url).pathname);
  const manager = { getBranch: () => [{ type: "custom", customType: "sandbox-mode", data: { mode: "off" } }] };
  const mode = await modeModule.startConversationMode(manager, "startup");
  assert.equal(mode.snapshot().mode, "on", "transcript claims have no authority");
  await mode.switchMode("off", () => true, async () => {});
  modeModule.retireConversationMode(mode, manager, "reload");
  const freshJiti = await createPiJiti(import.meta.url);
  const reloadedModule = await freshJiti.import(new URL("./mode-state.ts", import.meta.url).pathname);
  const retained = await reloadedModule.startConversationMode(manager, "reload");
  assert.equal(retained.snapshot().mode, "off");
  reloadedModule.retireConversationMode(retained, manager, "quit");
  const restarted = await reloadedModule.startConversationMode(manager, "reload");
  assert.equal(restarted.snapshot().mode, "on");
});

test("actual child-runtime environment selection does not transmit parent off authority", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { runSubagent } = await import("../subagent/runtime.js");
  const parent = createHarness(t);
  await parent.emit("session_start", { reason: "startup" });
  await parent.control.setMode("off", parent.ctx);
  let childEnv;
  await runSubagent({
    prompt: "Report mode", model: "test-provider/test-model", thinkingLevel: "high",
    cwd: process.cwd(), systemPrompt: "OFF — host access (parent conversation only)", activeTools: parent.active(),
  }, {
    baseEnv: parent.env,
    spawnImpl(_command, args, options) {
      childEnv = options.env;
      assert.ok(args.includes("--no-builtin-tools"));
      assert.equal(args.includes("--yolo"), false);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "on" }], stopReason: "stop" } })}\n`);
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  });
  assert.equal(childEnv.PI_SRT_ROUTING_LEASE, parent.env.PI_SRT_ROUTING_LEASE);
  assert.equal(Object.values(childEnv).includes("off"), false);
  const child = createHarness(t, { env: childEnv });
  await child.emit("session_start", { reason: "startup" });
  assert.equal(child.control.getMode().mode, "on");
  assert.equal(parent.control.getMode().mode, "off");
  await child.emit("session_shutdown", { reason: "quit" });
  await parent.emit("session_shutdown", { reason: "quit" });
});

test("entrypoint attaches isolated policy services, retains snapshots only for reload, and forwards no snapshot to children", async (t) => {
  function policyClient(revision) {
    const client = fakeClient();
    client.effectiveSnapshot = { revision, config: { version: 1, filesystem: { readOnly: [], readWrite: [] } }, grants: [], configPath: "/saved/config.json", targetPath: "/saved/config.json" };
    client.preparations = [];
    const originalStatus = client.status.bind(client);
    client.status = async () => ({ ...await originalStatus(), effectiveConfiguration: client.effectiveSnapshot, effectiveRevision: client.effectiveSnapshot.revision, savedRevision: HEX_C });
    client.preparePolicy = async (snapshot) => {
      client.preparations.push(snapshot);
      return { preparation: HEX_A, policyGeneration: HEX_B };
    };
    client.activatePolicy = async (_prepared, snapshot) => { client.effectiveSnapshot = snapshot; };
    return client;
  }
  const manager = {};
  const first = createHarness(t, { sessionManager: manager, client: policyClient(HEX_A) });
  await first.emit("session_start", { reason: "startup" });
  await first.emit("input");
  assert.equal((await first.control.getPolicyService().status()).effectiveRevision, HEX_A);
  await first.emit("session_shutdown", { reason: "reload" });
  const reloaded = createHarness(t, { sessionManager: manager, env: first.env, client: policyClient(HEX_C) });
  await reloaded.emit("session_start", { reason: "reload" });
  await reloaded.emit("input");
  assert.equal(reloaded.connectCalls[0].effectiveSnapshot.revision, HEX_A);
  assert.equal((await reloaded.control.getPolicyService().status()).effectiveRevision, HEX_A);
  const child = createHarness(t, { sessionManager: {}, env: { ...first.env }, client: policyClient(HEX_C) });
  await child.emit("session_start", { reason: "startup" });
  await child.emit("input");
  assert.equal(child.connectCalls[0].effectiveSnapshot, undefined);
  assert.equal((await child.control.getPolicyService().status()).effectiveRevision, HEX_C);
  await child.emit("session_shutdown", { reason: "quit" });
  await reloaded.emit("session_shutdown", { reason: "new" });
  const fresh = createHarness(t, { sessionManager: manager, env: reloaded.env, client: policyClient(HEX_C) });
  await fresh.emit("session_start", { reason: "new" });
  await fresh.emit("input");
  assert.equal(fresh.connectCalls[0].effectiveSnapshot, undefined);
  assert.equal((await fresh.control.getPolicyService().status()).effectiveRevision, HEX_C);
  await fresh.emit("session_shutdown", { reason: "quit" });
});

test("registered sandbox commands bind literal paths and menu actions to trusted policy services", async (t) => {
  const harness = createHarness(t);
  const calls = [], notifications = [], notices = [];
  harness.ctx.ui.notify = (...args) => notifications.push(args);
  harness.pi.sendMessage = (message) => notices.push(message);
  await harness.emit("session_start", { reason: "startup" });
  const snapshot = { savedRevision: HEX_A, effectiveRevision: HEX_A, refreshNeeded: false,
    configPath: "/canonical/config.json", configuredGrants: [{ path: "/safe/path with spaces", access: "ro" }],
    filesystemGrants: [{ path: "/safe/path with spaces", access: "ro" }] };
  harness.control.getPolicyService = () => ({
    async addGrant(...args) { calls.push(["add", ...args]); return snapshot; },
    async removeGrant(...args) { calls.push(["remove", ...args]); return snapshot; },
    async reloadGrants(...args) { calls.push(["reload", ...args]); return snapshot; },
  });
  const command = harness.commands.get("sandbox");
  await command.handler("grants add ro /safe/path with spaces", harness.ctx);
  assert.deepEqual(calls.at(-1), ["add", "ro", "/safe/path with spaces", harness.ctx]);
  assert.match(notifications.at(-1)[0], /Saved and activated/);
  assert.match(notifications.at(-1)[0], /Config: \/canonical\/config.json/);
  assert.match(notifications.at(-1)[0], /Configured grants:/);
  const choices = ["Add or change a saved grant", "Read-write (rw)"];
  harness.ctx.ui.select = async () => choices.shift();
  harness.ctx.ui.input = async () => "/safe/path with spaces";
  await command.handler("", harness.ctx);
  assert.deepEqual(calls.at(-1), ["add", "rw", "/safe/path with spaces", harness.ctx]);
  await command.handler("grants remove /safe/path with spaces", harness.ctx);
  assert.deepEqual(calls.at(-1), ["remove", "/safe/path with spaces", harness.ctx]);
  assert.match(notifications.at(-1)[0], /Derived access is unchanged/);
  await command.handler("reload", harness.ctx);
  assert.deepEqual(calls.at(-1), ["reload", harness.ctx]);
  const count = calls.length;
  harness.ctx.ui.select = async () => undefined;
  await command.handler("", harness.ctx);
  await command.handler("reset", harness.ctx);
  assert.equal(calls.length, count, "cancel and unsupported sidecar commands cannot mutate");
  assert.match(notifications.at(-1)[0], /Invalid \/sandbox syntax/);
  assert.equal(notices.length, 0, "grant actions do not change execution mode");
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("user commands publish immediate off warnings, retain indicators on reload, and report failed on", async (t) => {
  const manager = {};
  const first = createHarness(t, { sessionManager: manager });
  const notifications = [], messages = [];
  first.ctx.ui.notify = (...args) => notifications.push(args);
  first.pi.sendMessage = (message, options) => messages.push([message, options]);
  await first.emit("session_start", { reason: "startup" });
  const command = first.commands.get("sandbox");
  await command.handler("off", first.ctx);
  assert.equal(first.control.getMode().mode, "off");
  assert.equal(notifications.at(-1)[1], "warning");
  for (const term of [/files/, /credentials/, /Docker/, /Other clients remain sandboxed/, /cannot undo host effects/]) {
    assert.match(notifications.at(-1)[0], term);
  }
  assert.match(first.status.at(-1)[1], /sandbox: off — host access/);
  assert.equal(messages.at(-1)[0].display, false);
  assert.equal(messages.at(-1)[1].triggerTurn, false);
  await first.commands.get("srt-routing-status").handler("", first.ctx);
  assert.match(notifications.at(-1)[0], /Docker selection: host Docker/);
  assert.match(notifications.at(-1)[0], /Private Docker health: healthy \(not selected\)/);
  await command.handler("off", first.ctx);
  assert.equal(messages.length, 1, "repeated off does not create a mode-change notice");
  await first.emit("session_shutdown", { reason: "reload" });
  const next = createHarness(t, { env: first.env, sessionManager: manager });
  next.ctx.ui.notify = (...args) => notifications.push(args);
  next.pi.sendMessage = (message) => messages.push([message]);
  await next.emit("session_start", { reason: "reload" });
  assert.match(next.status.at(-1)[1], /sandbox: off — host access/);
  next.control.setPolicyVerifier(async () => { throw new Error("policy unavailable"); });
  await next.commands.get("sandbox").handler("on", next.ctx);
  assert.match(notifications.at(-1)[0], /policy unavailable/);
  assert.equal(notifications.at(-1)[1], "error");
  assert.match(next.status.at(-1)[1], /sandbox: on — blocked/);
  await next.commands.get("sandbox").handler("status", next.ctx);
  assert.match(notifications.at(-1)[0], /Sandbox execution blocked:/);
  assert.equal((await next.emit("tool_call", { toolName: "read" })).block, true);
  assert.equal(messages.length, 1, "failed mode transition sends no success notice");
  await next.emit("session_shutdown", { reason: "quit" });
});

test("registered no-UI commands publish read-only status and errors without mutation", async (t) => {
  const harness = createHarness(t);
  await harness.emit("session_start", { reason: "startup" });
  harness.ctx.hasUI = false;
  harness.ctx.mode = "print";
  const messages = [];
  harness.pi.sendMessage = (message, options) => messages.push([message, options]);
  harness.ctx.ui.notify = () => { throw new Error("no terminal output allowed"); };
  let mutations = 0;
  harness.control.setMode = async () => { mutations += 1; };
  harness.control.getPolicyService = () => { mutations += 1; throw new Error("must not run"); };
  const command = harness.commands.get("sandbox");
  for (const args of ["", "status", "grants list", "help"]) {
    await command.handler(args, harness.ctx);
    assert.equal(messages.at(-1)[0].display, true);
    assert.equal(messages.at(-1)[1].triggerTurn, false);
  }
  assert.match(messages[0][0].content, /Execution: ON — sandboxed/);
  for (const args of ["off", "on", "reload", "grants add rw /safe/path", "grants remove /safe/path"]) {
    await command.handler(args, harness.ctx);
    assert.match(messages.at(-1)[0].content, /requires interactive or RPC UI/);
  }
  assert.equal(mutations, 0);
  await harness.emit("session_shutdown", { reason: "quit" });
});

test("real MCP manager routes independent servers, hides configured tools and enforces capacity", async (t) => {
  const harness = createHarness(t, { projectMcp: {
    one: { command: "/fixture/one", exposure: "codemode" },
    two: { command: "/fixture/two", toolExposure: { get_symbols_overview: "hidden" } },
    three: { command: "/fixture/three" },
  } });
  await harness.emit("session_start", { reason: "startup" });
  await harness.emit("before_agent_start");
  assert.equal(harness.channels.length, 2);
  assert.ok(harness.active().includes("read"));
  assert.ok(!harness.active().includes("codemode"));
  assert.equal(harness.definitions.has("mcp__two__get_symbols_overview"), false);
  for (const name of ["mcp__one__find_symbol", "mcp__two__find_symbol"]) assert.equal((await harness.runTool(name)).isError, false);
  harness.channels[0].receive("exit", Buffer.alloc(0));
  assert.equal(harness.definitions.get("mcp__one__find_symbol").exposure, "hidden");
  assert.equal(harness.definitions.get("mcp__two__find_symbol").exposure, "direct");
  await harness.commands.get("mcp").handler("revoke", harness.ctx);
  assert.equal((await harness.runTool("mcp__two__find_symbol")).isError, true);
  await harness.emit("session_shutdown", { reason: "quit" });
});

for (const options of [{ mcpApprove: false }, { projectTrusted: false }, { malformedApproval: true }]) {
  test(`real manager starts no unapproved process: ${JSON.stringify(options)}`, async (t) => {
    const harness = createHarness(t, { projectMcp: { fixture: { command: "/fixture/server" } }, ...options });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("before_agent_start");
    assert.equal(harness.channels.length, 0);
    assert.ok(harness.active().includes("read"));
    await harness.emit("session_shutdown", { reason: "quit" });
  });
}

test("canonical MCP inventory remains admitted across sandbox mode transitions", async (t) => {
  const harness = createHarness(t);
  harness.pi.registerTool({ name: "mcp_list", parameters: { type: "object", properties: {}, additionalProperties: false } });
  harness.sourceByName.set("mcp_list", {
    path: path.join(AGENT_DIR, "extensions", "mcp-inventory", "index.ts"),
    source: "auto", scope: "user", origin: "top-level", baseDir: AGENT_DIR,
  });
  harness.env.PI_SRT_ROUTING_HOST_TOOLS = "mcp_list";
  await harness.emit("session_start", { reason: "startup" });
  assert.ok(harness.active().includes("mcp_list"));
  for (const mode of ["on", "off", "on"]) {
    await harness.control.setMode(mode, harness.ctx);
    assert.ok(harness.active().includes("mcp_list"));
    const allowed = await harness.emit("tool_call", { toolName: "mcp_list", input: {} });
    assert.notEqual(allowed?.block, true);
    const denied = await harness.emit("tool_call", { toolName: "mcp__serena__execute", input: {} });
    assert.equal(denied.block, true);
  }
  await harness.emit("session_shutdown", { reason: "quit" });
});
