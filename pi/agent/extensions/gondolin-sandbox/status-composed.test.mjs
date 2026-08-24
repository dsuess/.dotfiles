import assert from "node:assert/strict";
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
        vmId: "vm-shared-status",
        workspaceKey: "c".repeat(64),
        workspaceRoot: "/workspace",
        policyGeneration: "b".repeat(64),
        imageGeneration: "a".repeat(64),
        pendingRestart: false,
        attachedRoots: 2,
      };
    },
    async access() {}, async mkdir() {}, async listDir() { return []; },
    async stat() { return { mode: 0o40755, size: 0, mtimeMs: 1, isFile: false, isDirectory: true, isSymbolicLink: false }; },
    async readFile() { return { data: Buffer.alloc(0), truncated: false }; },
    async writeFile() {},
    async exec() { return { exitCode: 0, signal: null, outputBytes: 0, vmId: "vm-shared-status" }; },
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
  sandboxModule.createGondolinSandboxExtension({
    env: {
      PI_GONDOLIN_SANDBOX: "1",
      PI_GONDOLIN_SOCKET: "/tmp/controller.sock",
      PI_GONDOLIN_LEASE: "a".repeat(64),
      PI_GONDOLIN_WORKSPACE_KEY: "c".repeat(64),
      PI_GONDOLIN_WORKSPACE_ROOT: "/workspace",
      PI_GONDOLIN_POLICY_GENERATION: "b".repeat(64),
      PI_GONDOLIN_IMAGE_GENERATION: "a".repeat(64),
      PI_GONDOLIN_VM_ID: "vm-shared-status",
      PI_GONDOLIN_BUILTIN_TOOLS: "read,bash",
      PI_GONDOLIN_HOST_TOOLS: "",
    },
    auditOptions: { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR },
    async connect() {
      const client = fakeClient();
      return { client, status: await client.status() };
    },
  })(pi);
  pi.events.on(sandboxModule.SANDBOX_LIFECYCLE_EVENT ?? "gondolin-sandbox:lifecycle", (event) => lifecycle.push(event));

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
  assert.ok(statusCalls.some(([key, value]) => key === "gondolin-sandbox" && /sandbox:vm-share/.test(value)));

  const tui = { requestRender() {} };
  const footer = footerFactory(tui, {}, { onBranchChange: () => () => {} });
  const rendered = footer.render(200).join("\n");
  assert.match(rendered, /vm:vm-sha/);

  for (const handler of handlers.get("session_shutdown") ?? []) {
    await handler({ reason: "quit" }, ctx);
  }
  assert.equal(lifecycle.at(-1).health, "stopped");
});
