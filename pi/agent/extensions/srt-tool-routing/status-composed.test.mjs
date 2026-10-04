import assert from "node:assert/strict";
import test from "node:test";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const sandboxModule = await jiti.import(new URL("./index.ts", import.meta.url).pathname);
const statusbarModule = await jiti.import(new URL("../statusbar.ts", import.meta.url).pathname);
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");

const AGENT_DIR = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const EXTENSION_PATH = new URL("./index.ts", import.meta.url).pathname;

function fakeClient(overrides) {
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
        ...overrides,
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
  const commands = new Map();
  const messages = [];
  const notifications = [];
  const colors = [];
  const controller = {};
  const sourceInfo = {
    path: EXTENSION_PATH,
    source: "auto",
    scope: "user",
    origin: "top-level",
    baseDir: AGENT_DIR,
  };
  let active = [];
  let footerFactory;
  let control;
  const menus = [];
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
    registerCommand(name, definition) { commands.set(name, definition); },
    sendMessage(message) { messages.push(message); },
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
    statusIntervalMs: 5,
    onControl(value) { control = value; },
    async connect() {
      const client = fakeClient(controller);
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
      theme: { fg: (color, value) => { colors.push(color); return value; } },
      setStatus: (...args) => statusCalls.push(args),
      async select(_title, options) { menus.push(options); return undefined; },
      setFooter(factory) { footerFactory = factory; },
      notify(...args) { notifications.push(args); },
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
  assert.ok(statusCalls.some(([key, value]) => key === "srt-tool-routing" && /● sandbox: on/.test(value)));

  let repaintCount = 0;
  const tui = { requestRender() { repaintCount += 1; } };
  const footer = footerFactory(tui, {}, { onBranchChange: () => () => {} });
  const rendered = footer.render(200).join("\n");
  assert.match(rendered, /● sandbox: on/);
  await commands.get("sandbox").handler("", ctx);
  assert.deepEqual(menus.at(-1).filter((row) => row.startsWith("Turn sandbox")), ["Turn sandbox off — host access"]);
  assert.doesNotMatch(rendered, /srt:|vm-sha/);
  assert.equal(colors.at(-1), "success");
  assert.ok(rendered.includes("\x1b[38;2;166;227;161m ● sandbox: on"));
  controller.sidecarId = null;
  controller.dockerHealthy = false;
  await commands.get("sandbox").handler("status", ctx);
  assert.match(footer.render(200).join("\n"), /● sandbox: on/);

  // The real producer and consumer must agree on labels, colors, and repaint.
  for (const [health, blockedReason, suffix, color, rgb] of [
    ["healthy", "activation failed", "blocked", "error", "243;139;168"],
    ["failed", null, "failed", "error", "243;139;168"],
    ...["starting", "restarting", "stopped"].map((health) => [health, null, health, "warning", "250;179;135"]),
  ]) {
    const before = repaintCount;
    controller.health = health;
    control.blockSandbox(blockedReason ?? "");
    await commands.get("sandbox").handler("status", ctx);
    assert.equal(statusCalls.at(-1)[1], `◌ sandbox: on — ${suffix}`);
    assert.equal(colors.at(-1), color);
    const line = footer.render(200).join("\n");
    assert.ok(line.includes(`\x1b[38;2;${rgb}m ◌ sandbox: on — ${suffix}`));
    assert.doesNotMatch(line, /● sandbox: on|srt:ready/);
    assert.ok(repaintCount > before);
    for (const mode of ["normal", "planning"]) {
      pi.events.emit("plan-mode:workflow-state", { mode });
      for (let width = 0; width <= 200; width += 1) {
        for (const line of footer.render(width)) assert.ok(visibleWidth(line) <= width);
      }
      assert.equal((footer.render(200).join("\n").match(/sandbox: on/g) ?? []).length, 1);
    }
    pi.events.emit("plan-mode:workflow-state", { mode: "normal" });
  }
  controller.health = "healthy";
  control.blockSandbox("");
  await commands.get("sandbox").handler("status", ctx);

  await commands.get("sandbox").handler("off", ctx);
  await commands.get("sandbox").handler("", ctx);
  assert.deepEqual(menus.at(-1).filter((row) => row.startsWith("Turn sandbox")), ["Turn sandbox on"]);
  assert.equal(lifecycle.at(-1).mode, "off");
  assert.match(statusCalls.at(-1)[1], /● sandbox: off — host access/);
  assert.match(footer.render(200).join("\n"), /● sandbox: off — host access/);
  assert.match(footer.render(17).join("\n"), /sandbox: off/);
  assert.match(footer.render(3).join("\n"), /off/);
  pi.events.emit("plan-mode:workflow-state", { mode: "planning" });
  assert.match(footer.render(17).join("\n"), /sandbox: off/);
  for (const mode of ["normal", "planning"]) {
    pi.events.emit("plan-mode:workflow-state", { mode });
    for (let width = 0; width <= 200; width += 1) {
      const lines = footer.render(width);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
      if (width >= 3) assert.match(lines.join("\n"), /off/);
      assert.ok((lines.join("\n").match(/sandbox: off/g) ?? []).length <= 1);
    }
  }
  assert.match(footer.render(200).join("\n"), /\[PLANNING\]/);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(lifecycle.at(-1).health, "healthy");
  assert.equal(lifecycle.at(-1).mode, "off", "healthy polling cannot clear off");
  assert.match(statusCalls.at(-1)[1], /● sandbox: off — host access/);
  assert.doesNotMatch(footer.render(200).join("\n"), /srt:ready|srt:vm/);
  assert.equal(colors.at(-1), "error");
  assert.match(notifications.find(([message]) => message.startsWith("Sandbox OFF"))[0], /host-user files, credentials, and Docker/);
  assert.equal((footer.render(200).join("\n").match(/sandbox: off/g) ?? []).length, 1);
  assert.doesNotMatch(footer.render(200).join("\n"), /OFF — host access/);
  controller.health = "failed";
  await commands.get("sandbox").handler("status", ctx);
  assert.equal(lifecycle.at(-1).mode, "off");
  assert.equal(lifecycle.at(-1).health, "failed");
  assert.equal(colors.at(-1), "error");
  assert.match(footer.render(200).join("\n"), /● sandbox: off — host access/);
  controller.health = "healthy";
  await commands.get("sandbox").handler("on", ctx);
  assert.match(footer.render(200).join("\n"), /● sandbox: on/);
  assert.match(footer.render(200).join("\n"), /\[PLANNING\]/);
  assert.equal(messages.at(-1).customType, "sandbox-mode");
  assert.match(messages.at(-1).content, /does not authorize/);

  for (const handler of handlers.get("session_shutdown") ?? []) {
    await handler({ reason: "quit" }, ctx);
  }
  assert.equal(lifecycle.at(-1).health, "stopped");
});
