import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installReviewedMcp } from "./routed-mcp.mjs";
import { createWorkspaceApproval, WorkspaceApprovalStore, readWorkspaceServers } from "./workspace-approval.mjs";

async function fixture(t, servers = { one: { command: "node" }, two: { command: "node", exposure: "deferred", toolExposure: { secret: "hidden" } } }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-routed-mcp-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project"); fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const write = (value) => fs.writeFileSync(path.join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: value })); write(servers);
  const ctx = { cwd, hasUI: true, mode: "tui", isProjectTrusted: () => true, ui: { confirm: async () => true, notify() {} } };
  const store = new WorkspaceApprovalStore(root);
  await store.approve(readWorkspaceServers(ctx));
  const approval = createWorkspaceApproval({ store }); await approval.initialize(ctx);
  let options, facade, planning = false, changes = 0;
  const definitions = new Map(), launches = [], handlers = new Map(), commands = new Map();
  const pi = {
    active: ["read", "ketch_search"],
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(definition) { definitions.set(definition.name, definition); if (definition.exposure === "direct" && !this.active.includes(definition.name)) this.active.push(definition.name); if (definition.exposure === "hidden") this.active = this.active.filter((name) => name !== definition.name); },
    getActiveTools() { return this.active; }, setActiveTools(names) { this.active = names; },
    getMcpServers() { return [{ name: "arbitrary", config: { command: "/bin/sh" } }]; },
  };
  const client = { policyGeneration: "a".repeat(64), onTerminal: () => () => {}, openProcess: async (argv, args) => {
    if (launches.filter((item) => !item.closed).length >= 2) throw new Error("stdio process capacity exceeded (2)");
    const launch = { argv, receive: args.onEvent, closed: false }; launches.push(launch);
    return { policyGeneration: client.policyGeneration, send: async () => {}, close: async () => { launch.closed = true; } };
  } };
  const integration = installReviewedMcp(pi, {
    factory: (given) => { options = given; return (givenPi) => { facade = givenPi; facade.registerCommand("mcp", { handler: async () => {} }); }; },
    approval, connect: async () => client,
    canDeclare: (_name, reviewed) => !planning || reviewed,
    onToolsChanged: () => { changes++; },
  });
  const loaded = options.loadConfig(ctx);
  const connect = async (name) => { const entry = loaded.servers.find((entry) => entry.name === name); const transport = options.createTransport(entry, ctx.cwd); await transport.start(); return transport; };
  t.after(() => integration.close());
  return { pi, integration, definitions, launches, client, options, facade, planning: (value) => { planning = value; }, changes: () => changes, connect, loaded, ctx, store, write, commands };
}

const offering = (name, execute = async () => ({ content: [], details: undefined })) => ({ name, exposure: "direct", parameters: {}, execute });

test("independent servers normalize eligible exposure without discovery or host loadout resets", async (t) => {
  const f = await fixture(t); await f.connect("one"); await f.connect("two");
  assert.deepEqual(f.facade.getMcpServers(), []);
  assert.equal(f.loaded.servers[1].config.exposure, "direct");
  assert.equal(f.loaded.servers[1].config.toolExposure.secret, "hidden");
  f.facade.registerTool(offering("mcp__one__inspect")); f.facade.registerTool(offering("mcp__two__inspect"));
  for (const name of ["mcp__arbitrary__find_symbol", "list_mcp_resources", "tool_search"]) f.facade.registerTool(offering(name));
  assert.equal(f.definitions.size, 2);
  f.facade.setActiveTools(["mcp__one__inspect"]);
  assert.deepEqual(f.pi.active, ["read", "ketch_search", "mcp__one__inspect", "mcp__two__inspect"]);
  assert.throws(() => f.options.createTransport({ ...f.loaded.servers[0], scope: "extension" }, f.ctx.cwd), /provenance/);
  assert.throws(() => f.options.createTransport(f.loaded.servers[0], f.ctx.cwd, {}), /authentication/);
  assert.throws(() => f.options.updateConfig(), /read-only/);
});

test("definition identity, live generation and per-server retirement bind authority", async (t) => {
  const f = await fixture(t); const first = await f.connect("one"); await f.connect("two");
  let calls = 0;
  f.facade.registerTool(offering("mcp__one__inspect", async () => { calls++; return { content: [{ type: "text", text: "real result" }] }; }));
  f.facade.registerTool(offering("mcp__two__inspect"));
  const definition = f.definitions.get("mcp__one__inspect");
  assert.equal(f.integration.isAdmitted(definition), true);
  assert.equal(f.integration.isAdmitted({ ...definition, parameters: {} }), false);
  await definition.execute(); assert.equal(calls, 1);
  await first.close();
  assert.equal(f.definitions.get(definition.name).exposure, "hidden");
  assert.equal(f.definitions.get("mcp__two__inspect").exposure, "direct");
  await assert.rejects(definition.execute(), /retired/); assert.equal(calls, 1);
  f.client.policyGeneration = "b".repeat(64); f.integration.validateCurrent();
  assert.equal(f.definitions.get("mcp__two__inspect").exposure, "hidden");
});

test("revocation and config changes retire before calls or reconnect and never replay", async (t) => {
  const f = await fixture(t); await f.connect("one");
  let calls = 0; f.facade.registerTool(offering("mcp__one__edit", async () => { calls++; }));
  const definition = f.definitions.get("mcp__one__edit");
  await f.store.revoke(f.ctx.cwd);
  await assert.rejects(definition.execute(), /approval/);
  await f.integration.ensureConnected(f.ctx); assert.equal(f.launches.length, 1); assert.equal(calls, 0);
  assert.throws(() => f.options.createTransport(f.loaded.servers[0], f.ctx.cwd), /provenance/);
  await f.store.approve(readWorkspaceServers(f.ctx));
  assert.throws(() => f.options.createTransport({ ...f.loaded.servers[0], config: { command: "other" } }, f.ctx.cwd), /provenance/);
  f.write({ one: { command: "other" } });
  assert.throws(() => f.options.createTransport(f.loaded.servers[0], f.ctx.cwd), /provenance/);
});

test("Serena-name spoof stays blocked in planning; late tools return only outside guard", async (t) => {
  const f = await fixture(t, { serena: { command: "node", toolExposure: { get_symbols_overview: "direct" } } });
  await f.connect("serena"); f.planning(true);
  const name = "mcp__serena__get_symbols_overview";
  f.facade.registerTool(offering(name));
  assert.equal(f.definitions.get(name).exposure, "hidden");
  assert.equal(f.integration.isInspection(name), false);
  await assert.rejects(f.definitions.get(name).execute(), /Planning mode/);
  f.planning(false); f.integration.syncDeclarations(); assert.equal(f.definitions.get(name).exposure, "direct");
  f.facade.registerTool({ ...offering(name), exposure: "hidden" }); f.integration.syncDeclarations();
  assert.equal(f.definitions.get(name).exposure, "hidden");
});

test("capacity is enforced without host fallback; connection loss never replays", async (t) => {
  const f = await fixture(t, { one: { command: "node" }, two: { command: "node" }, three: { command: "node" } });
  const first = await f.connect("one"); await f.connect("two");
  await assert.rejects(f.connect("three"), /capacity/);
  assert.equal(f.launches.length, 2);
  let calls = 0; f.facade.registerTool(offering("mcp__one__edit", async () => { calls++; first.receive("exit", Buffer.alloc(0)); throw new Error("connection lost"); }));
  const definition = f.definitions.get("mcp__one__edit");
  await assert.rejects(definition.execute(), /connection lost/);
  await assert.rejects(definition.execute(), /retired/); assert.equal(calls, 1);
});

test("untrusted configuration opens no process and revocation command retires tools", async (t) => {
  const f = await fixture(t);
  await f.connect("one"); f.facade.registerTool(offering("mcp__one__edit"));
  await f.commands.get("mcp").handler("revoke", f.ctx);
  assert.equal(f.definitions.get("mcp__one__edit").exposure, "hidden");
  const loaded = f.options.loadConfig({ ...f.ctx, isProjectTrusted: () => false });
  assert.deepEqual(loaded.servers, []); assert.equal(f.launches.length, 1);
});
