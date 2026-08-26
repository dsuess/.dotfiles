import assert from "node:assert/strict";
import test from "node:test";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const planMode = await jiti.import(new URL("../plan-mode/index.ts", import.meta.url).pathname);
const { createHostAdapterManifest, schemaSha256 } = await jiti.import(new URL("./host-adapters.ts", import.meta.url).pathname);

const PLAN_WORKFLOW_TOOLS = ["submit_plan", "plan_progress", "complete_plan", "complete_stage"];

test("actual plan workflow schemas match the reviewed Gondolin adapter manifest", () => {
  const tools = new Map();
  const activeTools = [];
  const pi = {
    events: { on() { return () => {}; }, emit() {} },
    registerFlag() {}, registerEntryRenderer() {}, registerCommand() {}, registerShortcut() {},
    registerTool(tool) { tools.set(tool.name, tool); activeTools.push(tool.name); },
    on() {}, appendEntry() {}, getActiveTools() { return activeTools; },
    getAllTools() { return activeTools.map((name) => ({ name })); }, setActiveTools() {},
    sendMessage() {}, sendUserMessage() {},
  };
  planMode.default(pi);

  const manifest = createHostAdapterManifest({ agentDir: new URL("../", import.meta.url).pathname });
  for (const name of PLAN_WORKFLOW_TOOLS) {
    assert.ok(tools.has(name), `${name} is registered by plan mode`);
    assert.equal(schemaSha256(tools.get(name).parameters), manifest.get(name).schemaSha256, name);
  }
});
