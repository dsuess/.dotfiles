import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const {
  createHostAdapterManifest,
  isSrtToolRoutingReplacement,
  isTrustedHostAdapter,
  verifyToolInventory,
} = await jiti.import(new URL("./host-adapters.ts", import.meta.url).pathname);
const { registerSandboxTools, SRT_ROUTING_BUILTIN_NAMES } = await jiti.import(
  new URL("./tools.ts", import.meta.url).pathname,
);
const { splitChildCapabilities } = await import("./child-capabilities.js");
const pi0842 = await import(
  new URL("../../packages/ask-user-question/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)
);

const AGENT_DIR = fileURLToPath(new URL("../../", import.meta.url));
const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

function replacementSource(overrides = {}) {
  return {
    path: EXTENSION_PATH,
    source: "auto",
    scope: "user",
    origin: "top-level",
    baseDir: AGENT_DIR,
    ...overrides,
  };
}

function replacementTools() {
  return SRT_ROUTING_BUILTIN_NAMES.map((name) => ({
    name,
    parameters: { schemaMayEvolve: name },
    sourceInfo: replacementSource(),
  }));
}

function packageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srt-host-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  const packageDir = path.join(agentDir, "npm", "node_modules", "pi-ketch");
  const sourcePath = path.join(packageDir, "src", "index.ts");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "export default function ketch() {}\n");
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "pi-ketch", version: "99.4.0" }));
  return { agentDir, packageDir, sourcePath };
}

test("canonical SRT ownership accepts Pi 0.84.2 and current Bash parameter contracts", () => {
  const current = new Map();
  registerSandboxTools(
    { registerTool(tool) { current.set(tool.name, tool); } },
    { cwd: "/workspace", getClient() { throw new Error("not used"); } },
  );
  const schemas = [
    pi0842.createBashTool("/workspace").parameters,
    current.get("bash").parameters,
  ];
  assert.notDeepEqual(schemas[0], schemas[1], "the regression must exercise distinct Bash contracts");
  for (const parameters of schemas) {
    assert.equal(isSrtToolRoutingReplacement({
      name: "bash",
      parameters,
      sourceInfo: replacementSource(),
    }, { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR }), true);
  }
});

test("trusted package provenance accepts package source and metadata version drift", (t) => {
  const fixture = packageFixture(t);
  const manifest = createHostAdapterManifest({ agentDir: fixture.agentDir });
  const tool = {
    name: "ketch_search",
    parameters: { independentlyVersioned: true },
    sourceInfo: {
      path: fixture.sourcePath,
      source: "npm:pi-ketch@99.4.0",
      scope: "user",
      origin: "package",
      baseDir: fixture.packageDir,
    },
  };
  assert.equal(isTrustedHostAdapter(tool, manifest), true);
});

test("show_plan retains trusted parent-host provenance", () => {
  const manifest = createHostAdapterManifest({ agentDir: AGENT_DIR });
  const sourceInfo = {
    path: path.join(AGENT_DIR, "extensions", "plan-mode", "index.ts"),
    source: "auto",
    scope: "user",
    origin: "top-level",
    baseDir: AGENT_DIR,
  };
  assert.equal(isTrustedHostAdapter({ name: "show_plan", parameters: {}, sourceInfo }, manifest), true);
  assert.equal(isTrustedHostAdapter({
    name: "show_plan",
    parameters: {},
    sourceInfo: { ...sourceInfo, scope: "project" },
  }, manifest), false);

  const verified = verifyToolInventory([
    ...replacementTools(),
    { name: "show_plan", parameters: {}, sourceInfo },
  ], { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR, manifest });
  assert.equal(verified.allowedNames.has("show_plan"), true);
});

test("workflow tools are parent-only child capabilities", () => {
  const capabilities = splitChildCapabilities([
    "read", "show_plan", "plan_progress", "complete_plan", "complete_stage", "ketch_search",
  ]);
  assert.deepEqual(capabilities.builtins, ["read"]);
  assert.deepEqual(capabilities.hostAdapters, ["ketch_search"]);
  assert.deepEqual(capabilities.rejected, ["show_plan", "plan_progress", "complete_plan", "complete_stage"]);
});

test("trusted host adapters reject every provenance-boundary mismatch", (t) => {
  const fixture = packageFixture(t);
  const manifest = createHostAdapterManifest({ agentDir: fixture.agentDir });
  const otherPath = path.join(fixture.packageDir, "src", "other.ts");
  const otherBase = path.join(fixture.agentDir, "npm", "node_modules", "other");
  fs.writeFileSync(otherPath, "export default function other() {}\n");
  fs.mkdirSync(otherBase, { recursive: true });
  const sourceInfo = {
    path: fixture.sourcePath,
    source: "npm:pi-ketch@99.4.0",
    scope: "user",
    origin: "package",
    baseDir: fixture.packageDir,
  };
  for (const [label, overrides] of [
    ["path", { path: otherPath }],
    ["package identity", { source: "npm:not-ketch@99.4.0" }],
    ["scope", { scope: "project" }],
    ["origin", { origin: "top-level" }],
    ["base directory", { baseDir: otherBase }],
  ]) {
    assert.equal(isTrustedHostAdapter({
      name: "ketch_search",
      parameters: {},
      sourceInfo: { ...sourceInfo, ...overrides },
    }, manifest), false, label);
  }
  fs.rmSync(fixture.sourcePath);
  assert.equal(isTrustedHostAdapter({
    name: "ketch_search",
    parameters: {},
    sourceInfo,
  }, manifest), false, "missing canonical source");
});

test("inventory rejects missing, source-spoofed, and unknown tool slots", () => {
  const options = { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR };
  const unknown = {
    name: "unknown_host_tool",
    parameters: {},
    sourceInfo: replacementSource(),
  };
  const accepted = verifyToolInventory([...replacementTools(), unknown], options);
  assert.deepEqual(accepted.replacementErrors, []);
  assert.equal(accepted.allowedNames.has("bash"), true);
  assert.deepEqual(accepted.untrusted.map((tool) => tool.name), ["unknown_host_tool"]);

  const missing = verifyToolInventory(
    replacementTools().filter((tool) => tool.name !== "bash"),
    options,
  );
  assert.match(missing.replacementErrors.join("; "), /built-in slot 'bash' is missing/);

  const spoofed = replacementTools();
  spoofed.find((tool) => tool.name === "bash").sourceInfo = replacementSource({ source: "another-extension" });
  const rejected = verifyToolInventory(spoofed, options);
  assert.match(rejected.replacementErrors.join("; "), /built-in slot 'bash'.*trusted SRT tool-routing extension provenance/);
  assert.equal(rejected.allowedNames.has("bash"), false);
});

test("MCP inventory admits only canonical user provenance, never server tools", (t) => {
  const manifest = createHostAdapterManifest({ agentDir: AGENT_DIR });
  const sourceInfo = {
    path: path.join(AGENT_DIR, "extensions", "mcp-inventory", "index.ts"),
    source: "auto", scope: "user", origin: "top-level", baseDir: AGENT_DIR,
  };
  const tool = { name: "mcp_list", parameters: {}, sourceInfo };
  assert.equal(isTrustedHostAdapter(tool, manifest), true);
  const spoof = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-spoof-"));
  t.after(() => fs.rmSync(spoof, { recursive: true, force: true }));
  const copy = path.join(spoof, "index.ts");
  fs.copyFileSync(sourceInfo.path, copy);
  for (const overrides of [
    { scope: "project" }, { scope: "temporary" }, { source: "forged" },
    { origin: "package" }, { path: copy }, { baseDir: spoof },
  ]) {
    assert.equal(isTrustedHostAdapter({ ...tool, sourceInfo: { ...sourceInfo, ...overrides } }, manifest), false);
  }
  const result = verifyToolInventory([
    ...replacementTools(), tool, { ...tool, name: "mcp__serena__execute" },
  ], { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR, manifest });
  assert.deepEqual(result.replacementErrors, []);
  assert.equal(result.allowedNames.has("mcp_list"), true);
  assert.deepEqual(result.untrusted.map((t) => t.name), ["mcp__serena__execute"]);
  const child = splitChildCapabilities(["read", "mcp_list", "mcp__serena__execute", "plan_progress"]);
  assert.deepEqual(child.hostAdapters, ["mcp_list"]);
  assert.deepEqual(child.rejected, ["mcp__serena__execute", "plan_progress"]);
});
