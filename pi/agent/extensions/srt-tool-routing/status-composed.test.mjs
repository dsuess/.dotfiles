import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const sandboxModule = await jiti.import(new URL("./index.ts", import.meta.url).pathname);
const statusbarModule = await jiti.import(new URL("../statusbar.ts", import.meta.url).pathname);

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const EXTENSION_PATH = new URL("./index.ts", import.meta.url).pathname;

function fakeClient() {
  return {
    policyGeneration: "b".repeat(64),
    destroy() {},
    async status() {
      return {
        health: "healthy",
        dockerHealthy: true,
        sidecarId: "vm-shared-status",
        workspaceKey: "c".repeat(64),
        workspaceRoot: "/workspace",
        policyGeneration: "b".repeat(64),
        runtimeGeneration: "a".repeat(64),
        pendingRestart: false,
        attachedRoots: 2,
      };
    },
    async access() {}, async mkdir() {}, async listDir() { return []; },
    async stat() { return { mode: 0o40755, size: 0, mtimeMs: 1, isFile: false, isDirectory: true, isSymbolicLink: false }; },
    async readFile() { return { data: Buffer.alloc(0), truncated: false }; },
    async writeFile() {},
    async exec() { return { exitCode: 0, signal: null, outputBytes: 0, sidecarId: "vm-shared-status" }; },
  };
}

test("real sandbox lifecycle producer drives the real custom statusbar consumer", async () => {
  const handlers = new Map();
  const bus = new Map();
  const definitions = new Map();
  const sourceInfo = {
    path: EXTENSION_PATH,
    source: "auto",
    scope: "user",
    origin: "top-level",
    baseDir: AGENT_DIR,
  };
  let active = [];
  let footerFactory;
  const statusCalls = [];
  const lifecycle = [];
  const pi = {
    events: {
      on(name, handler) {
        if (!bus.has(name)) bus.set(name, []);
        bus.get(name).push(handler);
        return () => {};
      },
      emit(name, payload) {
        for (const handler of bus.get(name) ?? []) handler(payload);
      },
    },
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerTool(definition) {
      definitions.set(definition.name, definition);
      active.push(definition.name);
    },
    registerCommand() {},
    getActiveTools: () => [...active],
    setActiveTools(names) { active = [...names]; },
    getAllTools() {
      return [...definitions].map(([name, definition]) => ({
        name,
        description: definition.description,
        parameters: definition.parameters,
        promptGuidelines: definition.promptGuidelines,
        sourceInfo,
      }));
    },
    getThinkingLevel: () => "high",
  };

  statusbarModule.default(pi);
  sandboxModule.createSrtToolRoutingSandboxExtension({
    env: {
      PI_SRT_ROUTING_SANDBOX: "1",
      PI_SRT_ROUTING_SOCKET: "/tmp/controller.sock",
      PI_SRT_ROUTING_LEASE: "a".repeat(64),
      PI_SRT_ROUTING_WORKSPACE_KEY: "c".repeat(64),
      PI_SRT_ROUTING_WORKSPACE_ROOT: "/workspace",
      PI_SRT_ROUTING_POLICY_GENERATION: "b".repeat(64),
      PI_SRT_ROUTING_IMAGE_GENERATION: "a".repeat(64),
      PI_SRT_ROUTING_VM_ID: "vm-shared-status",
      PI_SRT_ROUTING_BUILTIN_TOOLS: "read,bash",
      PI_SRT_ROUTING_HOST_TOOLS: "",
    },
    auditOptions: { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR },
    async connect() {
      const client = fakeClient();
      return { client, status: await client.status() };
    },
  })(pi);
  pi.events.on(sandboxModule.SANDBOX_LIFECYCLE_EVENT ?? "srt-tool-routing:lifecycle", (event) => lifecycle.push(event));

  const ctx = {
    cwd: "/workspace",
    mode: "tui",
    hasUI: true,
    model: { id: "model" },
    getContextUsage: () => ({ tokens: 1000, percent: 1 }),
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color, value) => value },
      setStatus: (...args) => statusCalls.push(args),
      setFooter(factory) { footerFactory = factory; },
      notify() {},
    },
    shutdown() {},
  };
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({ reason: "startup" }, ctx);
  }
  for (const handler of handlers.get("input") ?? []) {
    await handler({ text: "queued", source: "interactive" }, ctx);
  }
  assert.ok(lifecycle.some((event) => event.health === "starting"));
  assert.equal(lifecycle.at(-1).health, "healthy");
  assert.equal(lifecycle.at(-1).attachedRoots, 2);
  assert.ok(statusCalls.some(([key, value]) => key === "srt-tool-routing" && /sandbox:vm-share/.test(value)));

  const tui = { requestRender() {} };
  const footer = footerFactory(tui, {}, { onBranchChange: () => () => {} });
  const rendered = footer.render(200).join("\n");
  assert.match(rendered, /vm:vm-sha/);

  for (const handler of handlers.get("session_shutdown") ?? []) {
    await handler({ reason: "quit" }, ctx);
  }
  assert.equal(lifecycle.at(-1).health, "stopped");
});
