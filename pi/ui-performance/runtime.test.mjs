import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createPiJiti, piPackageRoot } from "../test-helpers.mjs";
import { createRepository } from "../agent/extensions/git-tree-checkpoints/test/fixtures.mjs";
const runtime = await import(pathToFileURL(path.join(piPackageRoot, "dist/index.js")));
const ai = await import(pathToFileURL(path.join(piPackageRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const jiti = await createPiJiti(import.meta.url);
const { createGitTreeCheckpointsExtension } = await jiti.import("../agent/extensions/git-tree-checkpoints/index.ts");
const { captureCheckpoint } = await import("../agent/extensions/git-tree-checkpoints/git-checkpoints.js");

test("installed runtime input-to-agent-start boundary separates preparation from local provider delay", async (t) => {
 const root = await createRepository(t);
 const { SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } = runtime;
 const manager = SessionManager.inMemory(root);
 const model = { id: "latency-fixture", provider: "fixture", api: "openai-completions", contextWindow: 32000, maxTokens: 1000, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
 const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
 let captureDone = false, preparedAt, providerAt;
 const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
  extensionFactories: [createGitTreeCheckpointsExtension({ captureCheckpoint: async (...args) => { const cp = await captureCheckpoint(...args); captureDone = true; return cp; } }), pi => pi.on("agent_start", () => { preparedAt = performance.now(); assert.ok(captureDone); assert.ok(manager.getEntries().some(e => e.customType === "git-tree-checkpoint")); })] });
 await loader.reload();
 const { session } = await createAgentSession({ cwd: root, agentDir: root, model, settingsManager, resourceLoader: loader, sessionManager: manager, noTools: "builtin" });
 try {
  // Replace only local transport authentication; no credentials or network are used.
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.streamFunction = () => {
   providerAt = performance.now();
   const stream = ai.createAssistantMessageEventStream();
   setTimeout(() => {
    const message = { role: "assistant", content: [{ type: "text", text: "local response" }], api: "openai-completions", provider: "fixture", model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    stream.push({ type: "done", reason: "stop", message }); stream.end(message);
   }, 120);
   return stream;
  };
  session.agent.getApiKey = async () => "local-fixture-only";
  await session.bindExtensions({});
  const start = performance.now();
  await session.prompt("fixture prompt");
  const end = performance.now();
  assert.ok(preparedAt - start < 1000, "local preparation exceeded 1s");
  assert.ok(end - providerAt >= 100, "fake provider delay must be separate from preparation");
  assert.equal(session.getLastAssistantText(), "local response");
  console.log(`installed runtime: preparation ${(preparedAt - start).toFixed(1)}ms; fake provider ${(end - providerAt).toFixed(1)}ms`);
 } finally { session.dispose(); }
});
