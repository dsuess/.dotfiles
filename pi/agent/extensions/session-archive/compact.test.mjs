import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fixture } from "./fixtures.mjs";
import { archiveCompaction, enhanceIndex, INDEX_INPUT_CAP } from "./compact.js";
import { buildArtifacts } from "./archive.js";

const usage = { input: 10, output: 5, totalTokens: 15 };
function context(f, complete) {
  return { model: { id: "physical", provider: "fake", api: "fake" }, modelRegistry: { find: () => ({}), complete }, sessionManager: { getHeader: () => f.header }, ui: { notify: () => {} } };
}
function event(f, reason = "manual", signal = new AbortController().signal) {
  return { branchEntries: f.branch, signal, reason, preparation: { firstKeptEntryId: "think", tokensBefore: 25000, messagesToSummarize: [] } };
}

test("all hook reasons preserve boundaries; valid advisory labels and usage", async () => {
  const f = fixture();
  try {
    let requests = 0;
    const ctx = context(f, async (_m, input, options) => {
      requests++;
      assert.ok(input.messages[0].content[0].text.length < INDEX_INPUT_CAP + 1000);
      assert.equal(options.maxTokens, 1000);
      return { content: [{ type: "text", text: JSON.stringify([{ entryId: "early", topic: "fact", terms: ["cobalt"] }, { entryId: "foreign", topic: "bad", terms: [] }]) }], usage, stopReason: "stop" };
    });
    for (const reason of ["manual", "threshold", "overflow"]) {
      const result = await archiveCompaction(event(f, reason), ctx, f.dir);
      assert.equal(result.compaction.firstKeptEntryId, "think");
      assert.equal(result.compaction.tokensBefore, 25000);
      assert.deepEqual(result.compaction.usage, usage);
      assert.match(result.compaction.summary, /session_history/);
      assert.equal(f.store.index(result.compaction.details.archiveId).labels.length, 1);
    }
    assert.equal(requests, 3);
  } finally { f.cleanup(); }
});

test("invalid output, provider error, timeout, missing and virtual model retain structural navigation", async () => {
  const f = fixture();
  try {
    for (const complete of [async () => { throw new Error("provider"); }, async () => ({ content: [{ type: "text", text: "malformed" }], usage }), async () => new Promise(() => {})]) {
      const result = await archiveCompaction(event(f), context(f, complete), f.dir, { timeoutMs: 10 });
      assert.ok(result.compaction);
      assert.equal(f.store.index(result.compaction.details.archiveId).entries.length, f.branch.length);
    }
    for (const model of [undefined, { id: "virtual", api: "pi-virtual" }]) {
      const ctx = context(f, () => { throw new Error("must not call"); }); ctx.model = model;
      assert.ok((await archiveCompaction(event(f), ctx, f.dir)).compaction);
    }
    const { index } = buildArtifacts(f.header, f.entries, "think");
    const prior = [{ entryId: "early", topic: "kept", terms: [], fingerprint: index[0].fingerprint }, { entryId: "large", topic: "stale", terms: [], fingerprint: "wrong" }];
    const ctx = context(f, () => {}); ctx.model = undefined;
    assert.deepEqual((await enhanceIndex(ctx, f.entries, index, new AbortController().signal, prior)).labels.map((l) => l.topic), ["kept"]);
  } finally { f.cleanup(); }
});

test("abort and disk failure cancel explicitly without summary fallback", async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const ctx = context(f, async () => { controller.abort(); return new Promise(() => {}); });
    assert.deepEqual(await archiveCompaction(event(f, "manual", controller.signal), ctx, f.dir, { timeoutMs: 10 }), { cancel: true });
    fs.rmSync(f.store.root, { recursive: true }); fs.writeFileSync(f.store.root, "not a directory");
    ctx.model = undefined;
    assert.deepEqual(await archiveCompaction(event(f), ctx, f.dir), { cancel: true });
  } finally { f.cleanup(); }
});
