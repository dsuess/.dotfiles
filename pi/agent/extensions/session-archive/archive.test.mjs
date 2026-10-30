import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OUTPUT_CAP } from "./archive.js";

import { fixture } from "./fixtures.mjs";

test("complete raw branch, exact bounded retrieval, annotations and pagination", () => {
  const f = fixture();
  try {
    const id = f.snapshot.metadata.archiveId;
    const raw = f.store.artifact(id, "raw.jsonl").trim().split("\n").map(JSON.parse);
    assert.deepEqual(raw, [f.header, ...f.entries]);
    const text = f.store.artifact(id, "transcript.txt");
    assert.doesNotMatch(text, /BINARY|SECRET-SIGNATURE/);
    assert.match(text, /omitted from current context/);
    const search = f.store.retrieve({ archiveId: id, operation: "search", query: "EXACT-LATE-PASSAGE" }, f.branch);
    assert.equal(search.matches[0].entryId, "large");
    const read = f.store.retrieve({ archiveId: id, operation: "read", start: search.matches[0].start, length: 18 }, f.branch);
    assert.equal(read.text, text.slice(read.start, read.end));
    let params = { archiveId: id, operation: "index", limit: 1 };
    const ids = [];
    do { const page = f.store.retrieve(params, f.branch); ids.push(...page.entries.map((e) => e.entryId)); params = page.next; } while (params);
    assert.deepEqual(ids, f.entries.map((e) => e.id));
    params = { archiveId: id, operation: "read", length: 3000 };
    let recovered = "";
    do { const page = f.store.retrieve(params, f.branch); assert.ok(JSON.stringify(page).length <= OUTPUT_CAP); recovered += page.text; params = page.next; } while (params);
    assert.equal(recovered, text);
    assert.deepEqual(f.store.retrieve({ archiveId: id, operation: "search", query: "absent" }, f.branch).matches, []);
    for (const params of [{ operation: "read", length: -1 }, { operation: "index", offset: 0.5 }, { operation: "search", query: "" }]) assert.throws(() => f.store.retrieve({ archiveId: id, ...params }, f.branch));
    assert.throws(() => f.store.retrieve({ archiveId: id, operation: "index" }, []), /current branch/);
    const next = f.store.publish({ header: f.header, entries: f.branch, firstKeptEntryId: "think" });
    const branch = [...f.branch, { type: "compaction", firstKeptEntryId: "think", details: next.metadata }];
    assert.equal(f.store.retrieve({ archiveId: next.metadata.archiveId, operation: "search", query: "cobalt otter" }, branch).matches[0].entryId, "early");
  } finally { f.cleanup(); }
});

test("traversal, symlinks, missing archives, aborted publication", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.artifact("../escape", "index.json"), /Invalid/);
    const id = f.snapshot.metadata.archiveId;
    const file = path.join(f.store.root, id, "transcript.txt");
    fs.unlinkSync(file); fs.symlinkSync("/etc/passwd", file);
    assert.throws(() => f.store.artifact(id, "transcript.txt"));
    fs.rmSync(path.join(f.store.root, id), { recursive: true });
    assert.throws(() => f.store.retrieve({ archiveId: id, operation: "index" }, f.branch), /unavailable/);
    const cyclic = {}; cyclic.self = cyclic;
    assert.throws(() => f.store.publish({ header: cyclic, entries: [], firstKeptEntryId: "x" }));
    assert.deepEqual(fs.readdirSync(f.store.root), []);
    fs.rmdirSync(f.store.root); fs.symlinkSync(os.tmpdir(), f.store.root);
    assert.throws(() => f.store.publish({ header: f.header, entries: [], firstKeptEntryId: "x" }), /Unsafe/);
  } finally { f.cleanup(); }
});
