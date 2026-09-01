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

function controllerStatus(overrides = {}) {
  return {
    health: "healthy",
    workspaceKey: HEX_C,
    workspaceRoot: "/physical/workspace",
    policyGeneration: HEX_B,
    runtimeGeneration: HEX_A,
    attachedRoots: 1,
    brokerHealthy: true,
    sidecarId: null,
    dockerHealthy: false,
    pendingRestart: false,
    ...overrides,
  };
}

test("/sandbox reports live controller state without settings or lifecycle mutation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srt-sandbox-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const commands = new Map();
  const definitions = new Map();
  const notifications = [];
  const mutations = [];
  const sourceInfo = { path: EXTENSION_PATH, source: "auto", scope: "user", origin: "top-level", baseDir: AGENT_DIR };
  let active = [];
  let currentStatus = controllerStatus();
  let statusCalls = 0;
  const client = {
    async status() { statusCalls += 1; return currentStatus; },
    async reload() { mutations.push("reload"); },
    async reset() { mutations.push("reset"); },
    destroy() {},
    async access() {}, async mkdir() {}, async listDir() { return []; },
    async stat() { return { mode: 0o40755, size: 0, mtimeMs: 1, isFile: false, isDirectory: true, isSymbolicLink: false }; },
    async readFile() { return { data: Buffer.alloc(0), truncated: false }; },
    async writeFile() {},
    async exec() { return { exitCode: 0, signal: null, outputBytes: 0, sidecarId: null }; },
  };
  const pi = {
    registerTool(definition) { definitions.set(definition.name, definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
    events: { on() { return () => {}; }, emit() {} },
    getAllTools() {
      return [...definitions].map(([name, definition]) => ({
        name, description: definition.description, parameters: definition.parameters,
        promptGuidelines: definition.promptGuidelines, sourceInfo,
      }));
    },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; },
  };
  extensionModule.createSrtToolRoutingSandboxExtension({
    env: {
      PI_SRT_ROUTING: "1", PI_SRT_ROUTING_SOCKET: path.join(root, "controller.sock"), PI_SRT_ROUTING_LEASE: HEX_A,
      PI_SRT_ROUTING_WORKSPACE_KEY: HEX_C, PI_SRT_ROUTING_WORKSPACE_ROOT: "/physical/workspace",
      PI_SRT_ROUTING_POLICY_GENERATION: HEX_B, PI_SRT_ROUTING_IMAGE_GENERATION: HEX_A,
      PI_SRT_ROUTING_BUILTIN_TOOLS: "read,bash", PI_SRT_ROUTING_HOST_TOOLS: "",
    },
    auditOptions: { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR },
    async connect() { return { client, status: currentStatus }; },
  })(pi);
  const ctx = {
    hasUI: true, mode: "tui", cwd: "/physical/workspace",
    ui: {
      theme: { fg: (_color, value) => value }, setStatus() {},
      notify: (...args) => notifications.push(args),
    },
    shutdown() {},
  };
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  assert.equal(fs.existsSync(path.join(root, "settings.json")), false, "the fake controller has no settings file");

  await commands.get("sandbox").handler("", ctx);
  assert.equal(statusCalls, 1, "the command reads only controller status");
  assert.deepEqual(mutations, []);
  let [message] = notifications.at(-1);
  assert.match(message, /Health: healthy/);
  assert.match(message, /Workspace: \/physical\/workspace/);
  assert.match(message, /Attached clients: 1/);
  assert.match(message, /Policy generation: b{12}/);
  assert.match(message, /Runtime generation: a{12}/);
  assert.match(message, /Broker: healthy/);
  assert.match(message, /Sidecar: not created/);
  assert.match(message, /Docker: not created/);
  assert.match(message, /pi-sbx/);

  currentStatus = controllerStatus({ sidecarId: "sidecar-healthy-123456", dockerHealthy: true });
  await commands.get("sandbox").handler("", ctx);
  assert.equal(statusCalls, 2);
  assert.deepEqual(mutations, []);
  [message] = notifications.at(-1);
  assert.match(message, /Sidecar: sidecar-heal/);
  assert.doesNotMatch(message, /sidecar-healthy-123456/);
  assert.match(message, /Docker: healthy/);
});
