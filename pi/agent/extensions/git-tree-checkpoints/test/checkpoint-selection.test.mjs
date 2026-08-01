import assert from "node:assert/strict";
import test from "node:test";
import {
	CHECKPOINT_ENTRY_TYPE,
	effectiveDestinationId,
	resolveCheckpointForLeaf,
} from "../index.ts";

function message(id, parentId, role) {
	return { type: "message", id, parentId, message: { role, content: role } };
}

function checkpoint(id, parentId, representedLeafId, marker = id) {
	return {
		type: "custom",
		id,
		parentId,
		customType: CHECKPOINT_ENTRY_TYPE,
		data: { version: 1, representedLeafId, marker },
	};
}

function manager(entries) {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return {
		getEntry(id) { return byId.get(id); },
		getEntries() { return [...entries]; },
	};
}

test("calculates Pi's effective tree destination for every selectable entry family", () => {
	assert.equal(effectiveDestinationId(message("root-user", null, "user")), null);
	assert.equal(effectiveDestinationId(message("nested-user", "assistant", "user")), "assistant");
	assert.equal(effectiveDestinationId({ type: "custom_message", id: "custom", parentId: "tool" }), "tool");
	for (const entry of [
		message("assistant", "user", "assistant"),
		message("tool", "assistant", "toolResult"),
		{ type: "branch_summary", id: "summary", parentId: "user" },
		{ type: "compaction", id: "compact", parentId: "assistant" },
		{ type: "custom", id: "custom-entry", parentId: "assistant" },
		{ type: "model_change", id: "model", parentId: "assistant" },
	]) {
		assert.equal(effectiveDestinationId(entry), entry.id);
	}
});

test("latest explicit leaf association wins before ancestor fallback", () => {
	const entries = [
		message("u1", null, "user"),
		message("a1", "u1", "assistant"),
		checkpoint("cp-old", "a1", "a1", "old"),
		message("u2", "cp-old", "user"),
		message("a2", "u2", "assistant"),
		checkpoint("cp-other-branch", "a1", "a1", "newest-exact"),
	];
	const resolved = resolveCheckpointForLeaf(manager(entries), "a1");
	assert.equal(resolved.entry.id, "cp-other-branch");
	assert.equal(resolved.checkpoint.marker, "newest-exact");
	assert.equal(resolved.match, "exact");
});

test("nearest checkpoint ancestor covers entries within one agent response", () => {
	const entries = [
		message("u1", null, "user"),
		message("a1", "u1", "assistant"),
		checkpoint("cp-before-u2", "a1", "a1"),
		message("u2", "cp-before-u2", "user"),
		message("a2", "u2", "assistant"),
		message("tool", "a2", "toolResult"),
		{ type: "branch_summary", id: "summary", parentId: "tool" },
	];
	const sm = manager(entries);
	for (const leaf of ["u2", "a2", "tool", "summary", "cp-before-u2"]) {
		const resolved = resolveCheckpointForLeaf(sm, leaf);
		assert.equal(resolved.entry.id, "cp-before-u2", leaf);
		assert.equal(resolved.match, "ancestor", leaf);
	}
});

test("supports the empty root leaf and ignores malformed or unrelated custom entries", () => {
	const entries = [
		{ type: "custom", id: "unrelated", parentId: null, customType: "other", data: { representedLeafId: null } },
		{ type: "custom", id: "malformed", parentId: "unrelated", customType: CHECKPOINT_ENTRY_TYPE, data: null },
		checkpoint("root-checkpoint", "malformed", null),
	];
	assert.equal(resolveCheckpointForLeaf(manager(entries), null).entry.id, "root-checkpoint");
	assert.equal(resolveCheckpointForLeaf(manager(entries), "missing"), null);
});
