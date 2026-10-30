import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { createPiJiti, piPackageRoot } from "../../../test-helpers.mjs";
import { ArchiveStore, authorizedReferences } from "./archive.js";
import { archiveCompaction } from "./compact.js";
import { verifiedHandoff } from "./handoff.js";

const runtime = await import(pathToFileURL(path.join(piPackageRoot, "dist/index.js")));
const jiti = await createPiJiti(import.meta.url);
const extension = (await jiti.import(new URL("./index.ts", import.meta.url).pathname)).default;
const { SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } = runtime;
const model = { id: "archive-test", provider: "fake", api: "pi-virtual", contextWindow: 32000, maxTokens: 1000, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

export async function setup(dir, manager, factories) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1000, reserveTokens: 2000 } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true, extensionFactories: factories });
  await loader.reload();
  const result = await createAgentSession({ cwd: dir, agentDir: dir, model, settingsManager, resourceLoader: loader, sessionManager: manager, noTools: "builtin" });
  result.session._runDefaultCompaction = () => { throw new Error("UNWANTED SUMMARY REQUEST"); };
  return result.session;
}
export function seed(manager, suffix = "") {
  manager.appendMessage({ role: "user", content: `cobalt otter fact ${suffix}`, timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "canary.txt" } }], api: "test", provider: "fake", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
  manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "call", content: [{ type: "text", text: "long ".repeat(5000) + "EXACT END" }], timestamp: Date.now() });
  manager.appendMessage({ role: "user", content: `recent ${suffix}`, timestamp: Date.now() });
}

test("installed Pi manual, threshold, overflow and repeated ephemeral compactions retain exact history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-runtime-"));
  const manager = SessionManager.inMemory(dir);
  const factory = (pi) => pi.on("session_before_compact", (event, ctx) => archiveCompaction(event, ctx, dir));
  const session = await setup(dir, manager, [factory]);
  try {
    const store = new ArchiveStore(dir);
    for (const reason of ["manual", "threshold", "overflow"]) {
      seed(manager, reason);
      if (reason === "manual") await session.compact();
      else await session._runAutoCompaction(reason, false);
      const reference = authorizedReferences(manager.getBranch()).at(-1);
      assert.ok(reference, reason);
      assert.ok(session.messages.some((m) => m.role === "compactionSummary" && m.summary.includes(reference.archiveId)));
      assert.ok(session.messages.some((m) => m.role === "user" && m.content === `recent ${reason}`));
      assert.equal(store.retrieve({ archiveId: reference.archiveId, operation: "search", query: "cobalt otter fact manual" }, manager.getBranch()).matches.length, 1);
      assert.equal(store.retrieve({ archiveId: reference.archiveId, operation: "search", query: "EXACT END" }, manager.getBranch()).matches.length, ["manual", "threshold", "overflow"].indexOf(reason) + 1);
    }
    const branch = manager.getBranch();
    assert.ok(verifiedHandoff(branch));
    assert.throws(() => store.retrieve({ archiveId: authorizedReferences(branch).at(-1).archiveId, operation: "index" }, SessionManager.inMemory(dir).getBranch()), /current branch/);
    manager.branch(branch[0].id);
    assert.equal(authorizedReferences(manager.getBranch()).length, 0);
    manager.branch(branch.at(-1).id);
    assert.ok(verifiedHandoff(manager.getBranch()));
  } finally { session.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("installed hook dispatcher preserves cancellation in either handler order", async () => {
  for (const cancelFirst of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-cancel-"));
    const manager = SessionManager.inMemory(dir); seed(manager);
    const archive = (pi) => pi.on("session_before_compact", (event, ctx) => archiveCompaction(event, ctx, dir));
    const gate = (pi) => pi.on("session_before_compact", () => ({ cancel: true }));
    const session = await setup(dir, manager, cancelFirst ? [gate, archive] : [archive, gate]);
    try {
      await assert.rejects(session.compact(), /cancelled/);
      assert.equal(manager.getBranch().filter((e) => e.type === "compaction").length, 0);
    } finally { session.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("real extension tool restores references from persisted branches and rejects independent children", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-restore-"));
  try {
    const manager = SessionManager.create(dir, dir); seed(manager);
    const store = new ArchiveStore(dir);
    const snapshot = store.publish({ header: manager.getHeader(), entries: manager.getBranch(), firstKeptEntryId: manager.getBranch().at(-1).id });
    manager.appendCompaction("handoff", snapshot.metadata.firstKeptEntryId, 1000, snapshot.metadata, true);
    // Session files are persisted once an assistant response exists.
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], api: "test", provider: "fake", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const restored = SessionManager.open(manager.getSessionFile());
    assert.equal(store.retrieve({ archiveId: snapshot.metadata.archiveId, operation: "search", query: "cobalt otter" }, restored.getBranch()).matches.length, 1);
    const tools = new Map(); const hooks = new Map();
    extension({ registerTool: (t) => tools.set(t.name, t), on: (n, h) => hooks.set(n, h) });
    assert.ok(tools.has("session_history")); assert.ok(hooks.has("session_before_compact"));
    assert.throws(() => store.retrieve({ archiveId: snapshot.metadata.archiveId, operation: "index" }, []), /current branch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("installed Pi disk failure appends no compaction and never requests a prose summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-disk-failure-"));
  const manager = SessionManager.inMemory(dir); seed(manager);
  fs.writeFileSync(path.join(dir, "session-archives"), "not a directory");
  const session = await setup(dir, manager, [(pi) => pi.on("session_before_compact", (event, ctx) => archiveCompaction(event, ctx, dir))]);
  try {
    const before = manager.getBranch();
    await assert.rejects(session.compact(), /cancelled/);
    assert.deepEqual(manager.getBranch(), before);
    await session._runAutoCompaction("threshold", false);
    assert.deepEqual(manager.getBranch(), before);
    await session._runAutoCompaction("overflow", true);
    assert.deepEqual(manager.getBranch(), before);
  } finally { session.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("installed compaction keeps recent tool-call/result pairs and configured boundary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-pairs-"));
  const manager = SessionManager.inMemory(dir); seed(manager);
  const call = { role: "assistant", content: [{ type: "toolCall", id: "retained-call", name: "read", arguments: { path: "recent.txt" } }], api: "test", provider: "fake", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
  const result = { role: "toolResult", toolCallId: "retained-call", toolName: "read", content: [{ type: "text", text: "recent exact result" }], timestamp: Date.now() };
  manager.appendMessage(call); manager.appendMessage(result);
  let boundary;
  const session = await setup(dir, manager, [(pi) => pi.on("session_before_compact", (event, ctx) => { boundary = event.preparation.firstKeptEntryId; return archiveCompaction(event, ctx, dir); })]);
  try {
    await session.compact();
    assert.equal(authorizedReferences(manager.getBranch()).at(-1).firstKeptEntryId, boundary);
    assert.deepEqual(session.messages.filter((m) => m.role === "assistant" && m.content.some((c) => c.id === "retained-call")), [call]);
    assert.deepEqual(session.messages.filter((m) => m.role === "toolResult" && m.toolCallId === "retained-call"), [result]);
    assert.equal(session.settingsManager.getCompactionSettings(model).keepRecentTokens, 1000);
  } finally { session.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
