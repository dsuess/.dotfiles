import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import extension, { CHECKPOINT_ENTRY_TYPE, effectiveDestinationId } from "../index.ts";
import { createRepository, diff, exists, git, headState, read, runCommand, status, write } from "./fixtures.mjs";

function user(id, parentId, content = id) {
	return { type: "message", id, parentId, message: { role: "user", content } };
}

function assistant(id, parentId) {
	return { type: "message", id, parentId, message: { role: "assistant", content: [] } };
}

function createRealHarness(root) {
	const handlers = new Map();
	const entries = [user("u1", null), assistant("a1", "u1")];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const choices = [];
	const notifications = [];
	let leafId = "a1";
	let sequence = 0;
	const append = (entry) => {
		entries.push(entry);
		byId.set(entry.id, entry);
		leafId = entry.id;
		return entry;
	};
	const pi = {
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		appendEntry(customType, data) {
			append({ type: "custom", id: `checkpoint-${++sequence}`, parentId: leafId, customType, data });
		},
		exec(command, args, options = {}) {
			return runCommand(command, args, { cwd: options.cwd ?? root, signal: options.signal });
		},
	};
	extension(pi);
	const sessionManager = {
		getSessionId: () => "integration-session",
		getLeafId: () => leafId,
		getLeafEntry: () => byId.get(leafId),
		getEntry: (id) => byId.get(id),
		getEntries: () => [...entries],
		getBranch(fromId = leafId) {
			const branch = [];
			let current = fromId === null ? undefined : byId.get(fromId);
			while (current) {
				branch.push(current);
				current = current.parentId === null ? undefined : byId.get(current.parentId);
			}
			return branch.reverse();
		},
	};
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		sessionManager,
		ui: {
			notify(message, type) { notifications.push({ message, type }); },
			async select() { return choices.shift(); },
		},
	};
	async function emit(name, event = {}) {
		let result;
		for (const handler of handlers.get(name) ?? []) {
			const next = await handler(event, ctx);
			if (next !== undefined) result = next;
		}
		return result;
	}
	return {
		choices, ctx, emit, entries, notifications,
		appendUser(id, content) { return append(user(id, leafId, content)); },
		appendAssistant(id) { return append(assistant(id, leafId)); },
		navigateTo(targetId) { leafId = effectiveDestinationId(byId.get(targetId)); },
		get leafId() { return leafId; },
	};
}

function treeEvent(targetId, oldLeafId) {
	return {
		preparation: {
			targetId,
			oldLeafId,
			commonAncestorId: "a1",
			entriesToSummarize: [],
			userWantsSummary: false,
		},
		signal: new AbortController().signal,
	};
}

test("real engine keep and cancel choices leave code untouched", async (t) => {
	const root = await createRepository(t);
	const harness = createRealHarness(root);
	await harness.emit("session_start", { reason: "startup" });
	await harness.emit("before_agent_start", { prompt: "create branch" });
	harness.appendUser("u2", "create branch");
	harness.appendAssistant("a2");
	await write(root, "tracked.txt", "current worktree\n");
	await write(root, "later-untracked.txt", "current untracked\n");
	const current = { status: await status(root), head: await headState(root) };

	harness.choices.push("Keep current code");
	assert.equal(await harness.emit("session_before_tree", treeEvent("a1", "a2")), undefined);
	assert.equal(await status(root), current.status);
	assert.deepEqual(await headState(root), current.head);
	const checkpointCount = harness.entries.filter((entry) => entry.customType === CHECKPOINT_ENTRY_TYPE).length;
	harness.navigateTo("a1");

	harness.choices.push("Cancel navigation");
	assert.deepEqual(await harness.emit("session_before_tree", treeEvent("a2", "a1")), { cancel: true });
	assert.equal(await status(root), current.status);
	assert.deepEqual(await headState(root), current.head);
	assert.equal(
		harness.entries.filter((entry) => entry.customType === CHECKPOINT_ENTRY_TYPE).length,
		checkpointCount,
		"cancel must not capture another safety checkpoint",
	);
});

test("real engine round-trips code and staging across an abandoned conversation branch", async (t) => {
	const root = await createRepository(t);
	const harness = createRealHarness(root);
	await harness.emit("session_start", { reason: "startup" });

	await write(root, "partial.txt", "target staged\n");
	await git(root, ["add", "partial.txt"]);
	await write(root, "partial.txt", "target worktree\n");
	await write(root, "unstaged.txt", "target unstaged\n");
	await write(root, "target-untracked.txt", "target untracked\n");
	await write(root, "cache.ignored", "ignored target\n");
	const targetState = {
		status: await status(root),
		cached: await diff(root, { cached: true }),
		worktree: await diff(root),
	};
	await harness.emit("before_agent_start", { prompt: "produce later code" });
	const promptCheckpoint = harness.entries.at(-1);
	assert.equal(promptCheckpoint.customType, CHECKPOINT_ENTRY_TYPE);
	assert.equal(promptCheckpoint.data.representedLeafId, "a1");
	harness.appendUser("u2", "produce later code");
	harness.appendAssistant("a2");

	await git(root, ["add", "-A"]);
	await write(root, "tracked.txt", "later staged\n");
	await git(root, ["add", "tracked.txt"]);
	await write(root, "tracked.txt", "later worktree\n");
	await unlink(path.join(root, "target-untracked.txt"));
	await write(root, "later-untracked.txt", "later untracked\n");
	await write(root, "cache.ignored", "ignored later\n");
	const laterState = {
		status: await status(root),
		cached: await diff(root, { cached: true }),
		worktree: await diff(root),
		head: await headState(root),
	};

	harness.choices.push("Restore checkpointed code");
	assert.equal(await harness.emit("session_before_tree", treeEvent("a1", "a2")), undefined);
	harness.navigateTo("a1");
	assert.equal(await status(root), targetState.status);
	assert.equal(await diff(root, { cached: true }), targetState.cached);
	assert.equal(await diff(root), targetState.worktree);
	assert.equal(await read(root, "target-untracked.txt"), "target untracked\n");
	assert.equal(await exists(root, "later-untracked.txt"), false);
	assert.equal(await read(root, "cache.ignored"), "ignored later\n");
	assert.deepEqual(await headState(root), laterState.head);

	harness.choices.push("Restore checkpointed code");
	assert.equal(await harness.emit("session_before_tree", treeEvent("a2", "a1")), undefined);
	harness.navigateTo("a2");
	assert.equal(await status(root), laterState.status);
	assert.equal(await diff(root, { cached: true }), laterState.cached);
	assert.equal(await diff(root), laterState.worktree);
	assert.equal(await read(root, "tracked.txt"), "later worktree\n");
	assert.equal(await read(root, "later-untracked.txt"), "later untracked\n");
	assert.equal(await exists(root, "target-untracked.txt"), false);
	assert.equal(await read(root, "cache.ignored"), "ignored later\n");
	assert.deepEqual(await headState(root), laterState.head);
	assert.equal(harness.notifications.filter((item) => item.type === "error").length, 0);
});
