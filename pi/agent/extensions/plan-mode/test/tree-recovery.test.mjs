import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createPiJiti, piPackageRoot } from "../../../../test-helpers.mjs";
import { PART_PLAN } from "./fixtures.mjs";

const { SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } = await import(pathToFileURL(path.join(piPackageRoot, "dist/index.js")));
const jiti = await createPiJiti(import.meta.url);
const planMode = (await jiti.import(new URL("../index.ts", import.meta.url).pathname)).default;
const checkpoints = (await jiti.import(new URL("../../git-tree-checkpoints/index.ts", import.meta.url).pathname)).default;
const model = { id: "tree-test", provider: "fake", api: "pi-virtual", contextWindow: 32000, maxTokens: 1000, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function setup({ git = false, restore = false } = {}) {
 const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-plan-tree-"));
 if (git) execFileSync("git", ["init", "-q", cwd]);
 const manager = SessionManager.inMemory(cwd);
 const settingsManager = SettingsManager.inMemory();
 const tools = new Map();
 let context;
 let dialogs = 0;
 const notices = [];
 const factory = (pi) => {
  const registerTool = pi.registerTool.bind(pi);
  pi.registerTool = (tool) => { tools.set(tool.name, tool); registerTool(tool); };
  planMode(pi, { modelDefaults: { load: () => ({}), persist: async () => {} } });
  pi.on("session_start", (_event, ctx) => { context = ctx; });
 };
 const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: git ? [checkpoints, factory] : [factory] });
 await loader.reload();
 const { session } = await createAgentSession({ cwd, agentDir: cwd, model, settingsManager, resourceLoader: loader, sessionManager: manager });
 const ui = { theme: { fg: (_color, text) => text, bold: (text) => text }, notify: (message) => notices.push(message), setStatus() {}, setWidget() {}, select: async (title) => { if (title === "Restore code state?") return restore ? "Restore checkpointed code" : "Keep current code"; if (title === "No code checkpoint for this point") return "Keep current code and navigate"; dialogs++; return undefined; }, confirm: async () => false, input: async () => undefined, editor: async () => undefined };
 await session.bindExtensions({ uiContext: ui, mode: "rpc" });
 const state = () => manager.getBranch().filter(e => e.type === "custom" && e.customType === "plan-mode-state").at(-1)?.data;
 const submit = (markdown = PART_PLAN, progress = []) => tools.get("show_plan").execute("submit", { intent: "tree test", title: "Add Reliable Cache Invalidation", markdown, progress }, undefined, undefined, context);
 const input = async (text) => { await session._extensionRunner.emit({ type: "input", source: "interactive", text, images: [] }); return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }); };
 const checkpoint = () => session._extensionRunner.emit({ type: "before_agent_start", prompt: "test", systemPrompt: "" });
 return { cwd, manager, session, submit, input, checkpoint, state, notices, get dialogs() { return dialogs; }, async cleanup() { session.dispose(); await rm(cwd, { recursive: true, force: true }); } };
}

test("installed tree navigation reopens feedback parent candidate", async () => {
 const h = await setup();
 try {
  await h.session.prompt("/plan");
  const beforeCandidate = h.manager.getLeafId();
  const submitted = await h.submit();
  assert.equal(submitted.details.accepted, true, JSON.stringify(submitted));
  await h.session._extensionRunner.emit({ type: "input", source: "interactive", text: "revise this", images: [] });
  const feedback = h.manager.appendMessage({ role: "user", content: "revise this", timestamp: Date.now() });
  h.manager.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
  const result = await h.session.navigateTree(feedback);
  assert.equal(result.editorText, "revise this");
  assert.equal(h.state().approval, null);
  await h.session.prompt("/plan-actions");
  assert.equal(h.dialogs, 1, h.notices.join("; "));
  assert.equal(h.state().execution, null);
  const reopenedLeaf = h.manager.getLeafId();
  await h.session.navigateTree(beforeCandidate);
  assert.equal(h.state().plan, null);
  await h.session.prompt("/plan-actions");
  assert.equal(h.dialogs, 1, "a branch before presentation has no candidate");
  await h.session.navigateTree(reopenedLeaf);
  assert.equal(h.state().plan.hash, submitted.details.hash);
  assert.equal(h.state().execution, null);
 } finally { await h.cleanup(); }
});

test("older branch complete resubmission allocates without overwriting newer revision", async () => {
 const h = await setup();
 try {
  await h.session.prompt("/plan");
  const first = await h.submit();
  const feedback = await h.input("revise the plan");
  const second = await h.submit(PART_PLAN.replace("cache lifecycle", "cache lifecycle revision"));
  assert.equal(second.details.revision, 2);
  const newer = await readFile(second.details.path, "utf8");
  await h.session.navigateTree(feedback);
  assert.equal(h.state().plan.hash, first.details.hash);
  const third = await h.submit(PART_PLAN.replace("cache lifecycle", "cache lifecycle alternate"));
  assert.equal(third.details.accepted, true, JSON.stringify(third));
  assert.notEqual(third.details.path, second.details.path);
  assert.equal(third.details.revision, 1);
  assert.equal(await readFile(second.details.path, "utf8"), newer);
 } finally { await h.cleanup(); }
});

test("actions recover exact older branch candidate on a fresh file", async () => {
 const h = await setup();
 try {
  await h.session.prompt("/plan");
  const first = await h.submit();
  const original = await readFile(first.details.path, "utf8");
  const feedback = await h.input("revise the plan");
  const second = await h.submit(PART_PLAN.replace("cache lifecycle", "cache lifecycle revision"));
  const newer = await readFile(second.details.path, "utf8");
  const newerLeaf = h.manager.getLeafId();
  await h.session.navigateTree(feedback);
  await h.session.prompt("/plan-actions");
  assert.equal(h.dialogs, 1, h.notices.join("; "));
  assert.notEqual(h.state().plan.path, second.details.path);
  assert.equal(h.state().plan.revision, 1);
  assert.equal(await readFile(h.state().plan.path, "utf8"), original);
  assert.equal(await readFile(second.details.path, "utf8"), newer);
  assert.match(h.notices.join("; "), /Recovered.*\.md/);
  assert.equal(h.state().execution, null);
  await h.session.navigateTree(newerLeaf);
  assert.equal(h.state().plan.hash, second.details.hash);
 } finally { await h.cleanup(); }
});

for (const restore of [false, true]) {
 test(`installed Git checkpoints with ${restore ? "restore" : "keep current code"}`, async () => {
  const h = await setup({ git: true, restore });
  try {
   await h.session.prompt("/plan");
   const first = await h.submit();
   const original = await readFile(first.details.path, "utf8");
   await h.session._extensionRunner.emit({ type: "input", source: "interactive", text: "feedback", images: [] });
   await h.checkpoint();
   const feedback = h.manager.appendMessage({ role: "user", content: "feedback", timestamp: Date.now() });
   const second = await h.submit(PART_PLAN.replace("cache lifecycle", "cache lifecycle revision"));
   const newer = await readFile(second.details.path, "utf8");
   const newerLeaf = h.manager.getLeafId();
   const result = await h.session.navigateTree(feedback);
   assert.equal(result.cancelled, false, h.notices.join("; "));
   assert.equal(result.editorText, "feedback");
   assert.equal(h.state().plan.hash, first.details.hash);
   assert.equal(await readFile(first.details.path, "utf8"), restore ? original : newer);
   await h.session.prompt("/plan-actions");
   assert.equal(h.dialogs, 1, h.notices.join("; "));
   assert.equal(h.state().execution, null);
   if (restore) assert.equal(h.state().plan.path, first.details.path);
   else {
    assert.notEqual(h.state().plan.path, first.details.path);
    assert.equal(await readFile(first.details.path, "utf8"), newer);
   }
   assert.equal(await readFile(h.state().plan.path, "utf8"), original);
   const back = await h.session.navigateTree(newerLeaf);
   assert.equal(back.cancelled, false, h.notices.join("; "));
   assert.equal(h.state().plan.hash, second.details.hash);
  } finally { await h.cleanup(); }
 });
}

test("recovery preserves ledger evidence and later revision lineage", async () => {
 const h = await setup();
 try {
  await h.session.prompt("/plan");
  const first = await h.submit(PART_PLAN, [{ partId: "A", status: "completed", evidence: "contract verified" }]);
  const original = await readFile(first.details.path, "utf8");
  const feedback = await h.input("review");
  const second = await h.submit(PART_PLAN.replace("cache lifecycle", "cache lifecycle revision"));
  const newer = await readFile(second.details.path, "utf8");
  await h.session.navigateTree(feedback);
  await h.session.prompt("/plan-actions");
  assert.deepEqual(h.state().ledger.A, { status: "completed", note: null, evidence: "contract verified" });
  assert.equal(await readFile(h.state().plan.path, "utf8"), original);
  const recoveredPath = h.state().plan.path;
  await h.input("revise again");
  const revised = await h.submit(PART_PLAN.replace("cache lifecycle", "cache lifecycle corrected"));
  assert.equal(revised.details.path, recoveredPath);
  assert.equal(revised.details.revision, 2);
  assert.equal(await readFile(second.details.path, "utf8"), newer);
 } finally { await h.cleanup(); }
});

test("missing candidate is restored at its existing path", async () => {
 const h = await setup();
 try {
  await h.session.prompt("/plan");
  const first = await h.submit();
  const original = await readFile(first.details.path, "utf8");
  await h.input("discuss");
  await rm(first.details.path);
  await h.session.prompt("/plan-actions");
  assert.equal(h.dialogs, 1, h.notices.join("; "));
  assert.equal(h.state().plan.path, first.details.path);
  assert.equal(await readFile(first.details.path, "utf8"), original);
 } finally { await h.cleanup(); }
});

test("recovery rejects a missing durable display without replacing workflow", async () => {
 const h = await setup();
 try {
  await h.session.prompt("/plan");
  const first = await h.submit();
  await h.input("discuss");
  const before = structuredClone(h.state());
  const display = h.manager.getBranch().find(e => e.type === "custom" && e.customType === "plan-mode-plan-display");
  display.data.markdown = "tampered";
  await h.session.prompt("/plan-actions");
  assert.equal(h.dialogs, 0);
  assert.deepEqual(h.state(), before);
  assert.match(h.notices.join("; "), /No matching validated candidate/);
  assert.equal(await readFile(first.details.path, "utf8") !== "tampered", true);
 } finally { await h.cleanup(); }
});

test("pending approval recovers a changed file before offering actions", async () => {
 const h = await setup();
 try {
  await h.session.prompt("/plan");
  const first = await h.submit();
  const original = await readFile(first.details.path, "utf8");
  await writeFile(first.details.path, "manual changes");
  await h.session.prompt("/plan-actions");
  assert.equal(h.dialogs, 1, h.notices.join("; "));
  assert.notEqual(h.state().plan.path, first.details.path);
  assert.equal(await readFile(first.details.path, "utf8"), "manual changes");
  assert.equal(await readFile(h.state().plan.path, "utf8"), original);
 } finally { await h.cleanup(); }
});
