import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { OUTPUT_CAP } from "./archive.js";
import { fixture } from "./fixtures.mjs";
import { archiveCompaction } from "./compact.js";

function snapshot(f, content) {
  const entry = { type: "message", id: "adversarial", timestamp: "now", message: { role: "user", content } };
  const result = f.store.publish({ header: f.header, entries: [entry], firstKeptEntryId: entry.id });
  return { id: result.metadata.archiveId, branch: [entry, { type: "compaction", firstKeptEntryId: entry.id, details: result.metadata }] };
}

test("escaped control characters, Unicode, huge messages and search pages reconstruct exactly under cap", () => {
  const f = fixture();
  try {
    const content = ("\u0000\u0001\n\\\"🌍e\u0301 literal phrase ").repeat(3000);
    const { id, branch } = snapshot(f, content);
    const transcript = f.store.artifact(id, "transcript.txt");
    let params = { archiveId: id, operation: "read", length: 6000 }, restored = "", pages = 0;
    do {
      const result = f.store.retrieve(params, branch);
      assert.ok(JSON.stringify(result).length <= OUTPUT_CAP);
      assert.equal(result.start, restored.length);
      restored += result.text; params = result.next; pages++;
    } while (params);
    assert.ok(pages > 10); assert.equal(restored, transcript);
    params = { archiveId: id, operation: "search", query: "literal phrase", limit: 10 };
    let count = 0;
    do {
      const result = f.store.retrieve(params, branch);
      for (const match of result.matches) {
        assert.equal(transcript.slice(match.start, match.end), "literal phrase");
        assert.equal(match.entryId, "adversarial"); count++;
      }
      params = result.next;
    } while (params);
    assert.equal(count, 3000);
    for (const operation of ["read", "index", "search"]) {
      for (const value of [-1, NaN, Infinity, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => f.store.retrieve({ archiveId: id, operation, query: "phrase", offset: value }, branch));
      }
    }
    assert.equal(f.store.retrieve({ archiveId: id, operation: "read", start: transcript.length }, branch).next, null);
    assert.throws(() => f.store.retrieve({ archiveId: id, operation: "read", start: transcript.length + 1 }, branch));
    const other = snapshot(f, "unrelated secret");
    assert.throws(() => f.store.retrieve({ archiveId: other.id, operation: "index" }, branch), /current branch/);
  } finally { f.cleanup(); }
});

test("private permissions, immutable snapshots, directory and index symlinks fail closed", () => {
  const f = fixture();
  try {
    const id = f.snapshot.metadata.archiveId, dir = path.join(f.store.root, id);
    assert.equal(fs.statSync(f.store.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const name of ["raw.jsonl", "transcript.txt", "index.json"]) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
    const before = f.store.artifact(id, "raw.jsonl"); snapshot(f, "new snapshot");
    assert.equal(f.store.artifact(id, "raw.jsonl"), before);
    fs.chmodSync(path.join(dir, "index.json"), 0o644);
    assert.throws(() => f.store.retrieve({ archiveId: id, operation: "index" }, f.branch), /Unsafe/);
    fs.chmodSync(path.join(dir, "index.json"), 0o600);
    const saved = path.join(f.root ?? f.dir, "saved"); fs.renameSync(dir, saved); fs.symlinkSync(saved, dir);
    assert.throws(() => f.store.retrieve({ archiveId: id, operation: "index" }, f.branch), /Unsafe/);
    fs.unlinkSync(dir); fs.renameSync(saved, dir);
    fs.unlinkSync(path.join(dir, "index.json")); fs.symlinkSync("/etc/passwd", path.join(dir, "index.json"));
    assert.throws(() => f.store.retrieve({ archiveId: id, operation: "index" }, f.branch), /unavailable/);
  } finally { f.cleanup(); }
});

test("model catalog failure is optional, not an archive cancellation", async () => {
  const f = fixture();
  try {
    const ctx = { model: { id: "missing", provider: "fake", api: "fake" }, modelRegistry: { find() { throw new Error("catalog unavailable"); } }, sessionManager: { getHeader: () => f.header }, ui: { notify() {} } };
    const result = await archiveCompaction({ branchEntries: f.branch, preparation: { firstKeptEntryId: "think", tokensBefore: 1000 }, signal: new AbortController().signal }, ctx, f.dir);
    assert.ok(result.compaction);
  } finally { f.cleanup(); }
});

test("literal search includes overlapping occurrences across response pages", () => {
  const f = fixture();
  try {
    const { id, branch } = snapshot(f, "aaaaa");
    const first = f.store.retrieve({ archiveId: id, operation: "search", query: "aaa", limit: 1 }, branch);
    const second = f.store.retrieve(first.next, branch);
    const third = f.store.retrieve(second.next, branch);
    assert.equal(second.matches[0].start, first.matches[0].start + 1);
    assert.equal(third.matches[0].start, first.matches[0].start + 2);
    assert.equal(third.next, null);
  } finally { f.cleanup(); }
});
