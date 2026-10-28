import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const {
  createHostAdapterManifest,
  isSrtToolRoutingReplacement,
  isHostAdapter,
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

test("known host adapters do not require a manual provenance manifest", () => {
  const manifest = createHostAdapterManifest();
  const options = { extensionPath: EXTENSION_PATH, agentDir: AGENT_DIR, manifest };
  for (const name of manifest.keys()) {
    for (const sourceInfo of [undefined, replacementSource(), {
      path: "/changed/package/index.ts", source: "changed", scope: "project", origin: "package",
    }]) {
      const tool = { name, parameters: { independentlyVersioned: true }, sourceInfo };
      assert.equal(isHostAdapter(tool, manifest), true, name);
      const result = verifyToolInventory([...replacementTools(), tool], options);
      assert.equal(result.allowedNames.has(name), true, name);
      assert.deepEqual(result.replacementErrors, []);
    }
  }
  const withoutAdapters = verifyToolInventory(replacementTools(), options);
  assert.deepEqual(withoutAdapters.replacementErrors, []);
  assert.deepEqual([...withoutAdapters.allowedNames], [...SRT_ROUTING_BUILTIN_NAMES]);
});

test("workflow tools are parent-only child capabilities", () => {
  const capabilities = splitChildCapabilities([
    "read", "show_plan", "plan_progress", "complete_plan", "complete_stage", "ketch_search",
  ]);
  assert.deepEqual(capabilities.builtins, ["read"]);
  assert.deepEqual(capabilities.hostAdapters, ["ketch_search"]);
  assert.deepEqual(capabilities.rejected, ["show_plan", "plan_progress", "complete_plan", "complete_stage"]);
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

test("MCP inventory is a host adapter, but server tools require separate admission", () => {
  const manifest = createHostAdapterManifest();
  const tool = {
    name: "mcp_list", parameters: {},
    sourceInfo: {
      path: path.join(AGENT_DIR, "extensions", "mcp-inventory", "index.ts"),
      source: "auto", scope: "user", origin: "top-level", baseDir: AGENT_DIR,
    },
  };
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
