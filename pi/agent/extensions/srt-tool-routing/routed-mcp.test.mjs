import assert from "node:assert/strict";
import test from "node:test";
import { installReviewedMcp } from "./routed-mcp.mjs";
import { SERENA_PROFILE } from "./serena-profile.mjs";

function fixture() {
  let options, facade, receive, planning = false, changes = 0;
  const definitions = new Map(), launches = [];
  const pi = {
    active: ["read"],
    registerTool(definition) { definitions.set(definition.name, definition); if (definition.exposure === "direct" && !this.active.includes(definition.name)) this.active.push(definition.name); },
    getActiveTools() { return this.active; }, setActiveTools(names) { this.active = names; },
    getMcpServers() { return [{ name: "arbitrary", config: { command: "/bin/sh" } }]; },
  };
  const client = { policyGeneration: "a".repeat(64), onTerminal: () => () => {}, openProcess: async (argv, args) => {
    launches.push(argv); receive = args.onEvent;
    return { policyGeneration: client.policyGeneration, send: async () => {}, close: async () => {} };
  } };
  const integration = installReviewedMcp(pi, {
    factory: (given) => { options = given; return (givenPi) => { facade = givenPi; }; },
    connect: async () => client,
    canDeclare: (name) => !planning || name.endsWith("get_symbols_overview"),
    onToolsChanged: () => { changes++; },
  });
  return { pi, integration, definitions, launches, client, options: () => options, facade: () => facade, receive: (...args) => receive(...args), planning: (value) => { planning = value; }, changes: () => changes };
}
const context = { cwd: SERENA_PROFILE.workspace, isProjectTrusted: () => true };

async function connectedFixture() {
  const f = fixture();
  const entry = f.options().loadConfig(context).servers[0];
  const transport = f.options().createTransport(entry, context.cwd);
  await transport.start();
  return { ...f, entry, transport };
}

test("facade excludes arbitrary registrations, unknown tools, resource tools and manager activation", async () => {
  const f = await connectedFixture();
  assert.deepEqual(f.facade().getMcpServers(), []);
  for (const name of ["mcp__serena__execute_shell_command", "mcp__other__find_symbol", "list_mcp_resources", "tool_search"]) f.facade().registerTool({ name, exposure: "direct", parameters: {} });
  assert.equal(f.definitions.size, 0);
  f.facade().setActiveTools(["read", "tool_search", "codemode"]);
  assert.deepEqual(f.pi.active, ["read"]);
  assert.throws(() => f.options().createTransport({ ...f.entry, scope: "extension" }, context.cwd), /provenance/);
  assert.throws(() => f.options().createTransport({ ...f.entry, name: "other" }, context.cwd), /provenance/);
  assert.throws(() => f.options().createTransport(f.entry, context.cwd, {}), /authentication/);
  assert.throws(() => f.options().updateConfig(f.entry, { exposure: "direct" }), /read-only/);
  assert.equal(f.launches.length, 1);
  await f.integration.close();
});

test("actual admitted offerings are bound to the verified live channel; retirement revokes immediately", async () => {
  const f = await connectedFixture();
  const name = "mcp__serena__get_symbols_overview";
  const parameters = {};
  let calls = 0;
  f.facade().registerTool({ name, exposure: "direct", parameters, execute: async () => { calls++; return { content: [{ type: "text", text: "real symbols" }], details: undefined }; } });
  const definition = f.definitions.get(name);
  assert.equal(f.integration.isAdmitted(definition), true);
  assert.equal(f.integration.isAdmitted({ ...definition, parameters: {} }), false);
  assert.equal((await definition.execute()).content[0].text, "real symbols");
  assert.equal(calls, 1);
  f.receive("exit", Buffer.alloc(0));
  assert.equal(f.definitions.get(name).exposure, "hidden");
  assert.equal(f.integration.isAdmitted(definition), false);
  await assert.rejects(definition.execute(), /retired/);
  assert.equal(calls, 1);
});

test("declarations respect a narrow guard without resetting host tools, and withdrawals stay hidden", async () => {
  const f = await connectedFixture();
  f.planning(true);
  const inspect = "mcp__serena__get_symbols_overview", edit = "mcp__serena__replace_symbol_body";
  for (const name of [inspect, edit]) f.facade().registerTool({ name, exposure: "direct", parameters: {}, execute: async () => ({ content: [], details: undefined }) });
  assert.equal(f.definitions.get(inspect).exposure, "direct");
  assert.equal(f.definitions.get(edit).exposure, "hidden");
  assert.ok(f.pi.active.includes("read"));
  f.planning(false); f.integration.syncDeclarations();
  assert.equal(f.definitions.get(edit).exposure, "direct");
  f.facade().registerTool({ ...f.definitions.get(edit), exposure: "hidden" });
  f.integration.syncDeclarations();
  assert.equal(f.definitions.get(edit).exposure, "hidden");
  await f.integration.close();
});

test("untrusted configuration fails closed before a controller process is opened", () => {
  const f = fixture();
  const loaded = f.options().loadConfig({ ...context, isProjectTrusted: () => false });
  assert.deepEqual(loaded.servers, []);
  assert.match(loaded.errors[0], /not trusted/);
  assert.equal(f.launches.length, 0);
});
