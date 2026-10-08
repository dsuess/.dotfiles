import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectInventory, readConfig, MAX_FILE_BYTES, MAX_SERVERS } from "./inventory.js";
import { createPiJiti } from "../../../test-helpers.mjs";

const SECRET = "DO_NOT_EXPOSE_SECRET";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const user = path.join(agentDir, "mcp.json");
  const project = path.join(cwd, ".pi", "mcp.json");
  const write = (file, mcpServers) => fs.writeFileSync(file, JSON.stringify({ mcpServers }));
  const options = { agentDir, ctx: { cwd, isProjectTrusted: () => true }, getMcpServers: () => [] };
  return { user, project, write, options };
}

test("fresh session trust, including session-only trust, gates project reads", (t) => {
  const f = fixture(t);
  f.write(f.user, { global: { command: "unused" } });
  f.write(f.project, { local: { command: "unused" } });
  let trusted = false;
  const reads = [];
  f.options.ctx.isProjectTrusted = () => trusted;
  f.options.read = (file) => { reads.push(file); return readConfig(file); };
  assert.equal(collectInventory(f.options).projectConfiguration, "skipped-untrusted");
  assert.deepEqual(reads, [f.user]);
  trusted = true; // No persisted trust record: the session's decision is authoritative.
  assert.deepEqual(collectInventory(f.options).servers.map((s) => s.name), ["global", "local"]);
  f.write(f.project, { changed: { url: "https://unused.invalid" } });
  assert.deepEqual(collectInventory(f.options).servers.map((s) => s.name), ["changed", "global"]);
  for (const trust of [undefined, () => { throw Error(SECRET); }, () => "true"]) {
    f.options.ctx.isProjectTrusted = trust;
    reads.length = 0;
    assert.equal(collectInventory(f.options).projectConfiguration, "skipped-untrusted");
    assert.deepEqual(reads, [f.user]);
  }
});

test("file-over-registration, project-over-user and normalized-name precedence include disabled entries", (t) => {
  const f = fixture(t);
  f.options.getMcpServers = () => [
    { name: "same-name", config: { command: "unused" }, extensionPath: "/canonical/extension.ts" },
    { name: "registered", config: { url: "https://unused.invalid", type: "streamable-http" }, extensionPath: "/canonical/extension.ts" },
  ];
  f.write(f.user, { same_name: { url: "https://unused.invalid" }, disabled: { command: "unused", enabled: false } });
  f.write(f.project, { same_name: { command: "unused", enabled: false } });
  const out = collectInventory(f.options);
  assert.equal(out.inventoryOnly, true);
  assert.deepEqual(out.servers.map((s) => [s.name, s.enabled, s.transport, s.source.scope]), [
    ["disabled", false, "stdio", "user"], ["registered", true, "http", "extension"], ["same_name", false, "stdio", "project"],
  ]);
  assert.equal(out.servers[2].source.path, f.project);
});

test("secrets and configuration expressions never reach any output channel or execute", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.options.agentDir, "executed");
  const secretConfig = {
    command: SECRET, args: [SECRET], cwd: SECRET, description: SECRET,
    headers: { Authorization: SECRET }, env: { KEY: `!touch ${marker}` },
    oauth: { clientSecret: SECRET },
  };
  f.write(f.user, { safe: secretConfig, remote: { ...secretConfig, command: undefined, url: `https://${SECRET}.invalid` } });
  const jiti = await createPiJiti(import.meta.url);
  const extension = (await jiti.import(new URL("./index.ts", import.meta.url).pathname)).default;
  let tool;
  extension({ registerTool: (value) => { tool = value; }, getMcpServers: () => [] });
  assert.equal(tool.name, "mcp_list");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties, {});
  assert.equal(tool.annotations.readOnlyHint, true);
  // Tool uses getAgentDir(), not arguments. Point that public resolver at the fixture.
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.options.agentDir;
  try {
    const result = await tool.execute("id", {}, undefined, undefined, f.options.ctx);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.deepEqual(result.details, result.structuredContent);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    assert.equal(result.details.servers.length, 2);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
});

test("categorical diagnostics for malformed, oversized, unsupported and unreadable metadata", (t) => {
  const f = fixture(t);
  assert.deepEqual(collectInventory(f.options).diagnostics, []);
  for (const [raw, code] of [
    [`{${SECRET}`, "malformed"],
    [" ".repeat(MAX_FILE_BYTES + 1), "oversized"],
    [JSON.stringify([SECRET]), "unsupported-shape"],
    [JSON.stringify({ mcpServers: [] }), "unsupported-shape"],
  ]) {
    fs.writeFileSync(f.user, raw);
    const result = collectInventory(f.options);
    assert.deepEqual(result.diagnostics, [{ scope: "user", code }]);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  fs.rmSync(f.user);
  fs.mkdirSync(f.user);
  assert.deepEqual(collectInventory(f.options).diagnostics, [{ scope: "user", code: "unreadable" }]);
});

test("unsafe scalar types, ambiguous transports and names never echo raw values", (t) => {
  const f = fixture(t);
  f.write(f.user, {
    [`bad ${SECRET}`]: { command: SECRET },
    scalar: SECRET,
    enabled: { command: SECRET, enabled: SECRET },
    url: { url: { secret: SECRET } },
    command: { command: [SECRET] },
    ambiguous: { command: SECRET, url: SECRET },
    unsupported: { type: "sse", url: SECRET },
    mismatch: { type: "http", command: SECRET },
    "dupe-name": { command: SECRET },
    dupe_name: { command: SECRET },
  });
  const result = collectInventory(f.options);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(result.servers.map((s) => s.name), ["dupe-name"]);
  assert.deepEqual(result.diagnostics.map((d) => d.code), ["unsupported-metadata", "ambiguous-name"]);
});

test("bounded input, count, paths and serialized output", (t) => {
  const f = fixture(t);
  f.write(f.user, Object.fromEntries(Array.from({ length: MAX_SERVERS + 1 }, (_, i) => [`s${i}`, { command: SECRET }])));
  assert.deepEqual(collectInventory(f.options).diagnostics, [{ scope: "user", code: "server-limit" }]);
  fs.rmSync(f.user);
  f.options.getMcpServers = () => Array.from({ length: MAX_SERVERS }, (_, i) => ({
    name: `${"n".repeat(120)}${i}`, extensionPath: "/" + "p".repeat(511), config: { command: SECRET },
  }));
  const result = collectInventory(f.options);
  assert.equal(result.servers.length, MAX_SERVERS);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024);
  f.options.agentDir = "/" + "p".repeat(513);
  assert.ok(collectInventory(f.options).diagnostics.some((d) => d.code === "path-limit"));
  f.options.getMcpServers = () => { throw Error(SECRET); };
  assert.equal(JSON.stringify(collectInventory(f.options)).includes(SECRET), false);
});

test("file namespace clashes retain the first definition and output bytes stay bounded", (t) => {
  const f = fixture(t);
  f.write(f.user, { "same-name": { command: "unused" } });
  f.write(f.project, { same_name: { url: "https://unused.invalid" } });
  assert.equal(collectInventory(f.options).servers[0].source.scope, "user");
  assert.deepEqual(collectInventory(f.options).diagnostics, [{ scope: "project", code: "ambiguous-name" }]);
  fs.rmSync(f.user);
  fs.rmSync(f.project);
  f.options.getMcpServers = () => Array.from({ length: MAX_SERVERS }, (_, i) => ({
    name: `s${i}`, extensionPath: "\u0001".repeat(512), config: { command: "unused" },
  }));
  const out = collectInventory(f.options);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 32 * 1024);
  assert.ok(out.diagnostics.some((d) => d.code === "output-limit"));
});

test("a child inventory uses child trust rather than parent trust", (t) => {
  const f = fixture(t);
  f.write(f.project, { parent_only: { command: "unused" } });
  assert.equal(collectInventory(f.options).servers.length, 1);
  const reads = [];
  const child = { ...f.options, ctx: { cwd: f.options.ctx.cwd, isProjectTrusted: () => false },
    read: (file) => { reads.push(file); return readConfig(file); } };
  assert.deepEqual(collectInventory(child).servers, []);
  assert.deepEqual(reads, [f.user]);
});
