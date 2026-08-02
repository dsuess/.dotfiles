import assert from "node:assert/strict";
import test from "node:test";
import {
	CHECKPOINT_ENTRY_TYPE,
	createGitTreeCheckpointsExtension,
} from "../index.ts";

function user(id, parentId, content = id) {
	return { type: "message", id, parentId, message: { role: "user", content } };
}

function assistant(id, parentId) {
	return { type: "message", id, parentId, message: { role: "assistant", content: [] } };
}

function savedCheckpoint(id, parentId, representedLeafId, marker = "destination") {
	return {
		type: "custom",
		id,
		parentId,
		customType: CHECKPOINT_ENTRY_TYPE,
		data: checkpointData({ representedLeafId, marker }),
	};
}

function checkpointData(overrides = {}) {
	return {
		version: 1,
		repositoryRoot: "/repo",
		repositoryCommonDir: "/repo/.git",
		sessionRef: "refs/pi/checkpoints/session-1",
		anchorCommit: "a".repeat(40),
		indexCommit: "b".repeat(40),
		worktreeTree: "c".repeat(40),
		indexTree: "d".repeat(40),
		capturedAt: "2026-01-01T00:00:00.000Z",
		reason: "before-prompt",
		representedLeafId: "a1",
		head: { oid: "e".repeat(40), ref: "refs/heads/main" },
		...overrides,
	};
}

function baseBranch() {
	return [
		user("u1", null),
		assistant("a1", "u1"),
		savedCheckpoint("cp-destination", "a1", "a1"),
		user("u2", "cp-destination"),
		assistant("a2", "u2"),
	];
}

function createHarness(options = {}) {
	const handlers = new Map();
	const commands = [];
	const appended = [];
	const notifications = [];
	const selections = [];
	const entries = [...(options.entries ?? baseBranch())];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let leafId = options.leafId === undefined ? entries.at(-1)?.id ?? null : options.leafId;
	let appendSequence = 0;
	const captureCalls = [];
	const restoreCalls = [];
	const choices = [...(options.choices ?? [])];
	const repository = { root: "/repo", commonDir: "/repo/.git", gitDir: "/repo/.git", bare: false };
	const dependencies = {
		async findGitRepository(cwd) {
			return options.git === false ? null : { ...repository, requestedCwd: cwd };
		},
		async captureCheckpoint(repo, captureOptions) {
			captureCalls.push({ repository: repo, options: captureOptions });
			if (options.captureCheckpoint) return options.captureCheckpoint(repo, captureOptions, captureCalls.length);
			return checkpointData({
				reason: captureOptions.reason,
				representedLeafId: captureOptions.representedLeafId,
				marker: captureOptions.reason === "before-tree-navigation" ? "safety" : `prompt-${captureCalls.length}`,
			});
		},
		async restoreCheckpoint(repo, checkpoint) {
			restoreCalls.push({ repository: repo, checkpoint });
			if (options.restoreCheckpoint) return options.restoreCheckpoint(repo, checkpoint, restoreCalls.length);
		},
	};
	const pi = {
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		appendEntry(customType, data) {
			const entry = {
				type: "custom",
				id: `appended-${++appendSequence}`,
				parentId: leafId,
				customType,
				data,
			};
			entries.push(entry);
			byId.set(entry.id, entry);
			leafId = entry.id;
			appended.push(entry);
		},
		registerCommand(name) { commands.push(name); },
	};
	createGitTreeCheckpointsExtension(dependencies)(pi);
	const sessionManager = {
		getSessionId: () => "session-1",
		getLeafId: () => leafId,
		getLeafEntry: () => leafId === null ? undefined : byId.get(leafId),
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
		cwd: "/repo/subdirectory",
		mode: options.hasUI === false ? "print" : "tui",
		hasUI: options.hasUI !== false,
		sessionManager,
		ui: {
			notify(message, type) { notifications.push({ message, type }); },
			async select(title, values) {
				selections.push({ title, values });
				return choices.shift();
			},
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
		appended, captureCalls, commands, ctx, dependencies, emit, entries, handlers,
		notifications, repository, restoreCalls, selections,
		get leafId() { return leafId; },
	};
}

async function start(harness, reason = "startup") {
	await harness.emit("session_start", { reason });
}

function treeEvent(targetId = "a1", oldLeafId = "a2") {
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

test("captures before every prompt, records the represented leaf, and appends non-context session state", async () => {
	const harness = createHarness({ entries: [user("u1", null), assistant("a1", "u1")], leafId: "a1" });
	await start(harness);
	await harness.emit("before_agent_start", { prompt: "next prompt" });

	assert.equal(harness.captureCalls.length, 1);
	assert.equal(harness.captureCalls[0].options.sessionId, "session-1");
	assert.equal(harness.captureCalls[0].options.reason, "before-prompt");
	assert.equal(harness.captureCalls[0].options.representedLeafId, "a1");
	assert.equal(harness.appended.length, 1);
	assert.equal(harness.appended[0].customType, CHECKPOINT_ENTRY_TYPE);
	assert.equal(harness.appended[0].data.representedLeafId, "a1");
	assert.deepEqual(Object.keys(harness.appended[0]).includes("message"), false);
	assert.deepEqual(harness.commands, [], "does not override the built-in /tree command");
});

test("serializes concurrent prompt captures and appends only completed checkpoints", async () => {
	let active = 0;
	let maxActive = 0;
	const harness = createHarness({
		entries: [user("u1", null), assistant("a1", "u1")], leafId: "a1",
		async captureCheckpoint(_repo, captureOptions, sequence) {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 10));
			active--;
			return checkpointData({ ...captureOptions, marker: sequence });
		},
	});
	await start(harness);
	await Promise.all([
		harness.emit("before_agent_start", { prompt: "one" }),
		harness.emit("before_agent_start", { prompt: "two" }),
	]);
	assert.equal(maxActive, 1);
	assert.equal(harness.captureCalls.length, 2);
	assert.equal(harness.appended.length, 2);
});

test("prompt checkpoint failures warn without blocking the prompt or appending false metadata", async () => {
	const harness = createHarness({ captureCheckpoint: async () => { throw new Error("index is unmerged"); } });
	await start(harness);
	assert.equal(await harness.emit("before_agent_start", { prompt: "continue anyway" }), undefined);
	assert.equal(harness.appended.length, 0);
	assert.match(harness.notifications.at(-1).message, /checkpoint.*index is unmerged/i);
	assert.equal(harness.notifications.at(-1).type, "warning");
});

test("reload resolves durable checkpoint entries rather than relying on in-memory state", async () => {
	const persistedEntries = baseBranch();
	const harness = createHarness({ entries: persistedEntries, choices: ["Restore checkpointed code"] });
	await start(harness, "reload");
	const result = await harness.emit("session_before_tree", treeEvent());
	assert.equal(result, undefined);
	assert.equal(harness.restoreCalls[0].checkpoint.marker, "destination");
});

test("keep current code is the default; explicit restore captures safety state and permits navigation", async () => {
	const harness = createHarness({ choices: ["Restore checkpointed code"] });
	await start(harness);
	const result = await harness.emit("session_before_tree", treeEvent());

	assert.equal(result, undefined);
	assert.deepEqual(harness.selections[0], {
		title: "Restore code state?",
		values: ["Keep current code", "Restore checkpointed code", "Cancel navigation"],
	});
	assert.equal(harness.captureCalls.at(-1).options.reason, "before-tree-navigation");
	assert.equal(harness.captureCalls.at(-1).options.representedLeafId, "a2");
	assert.equal(harness.appended.at(-1).data.marker, "safety");
	assert.equal(harness.restoreCalls.length, 1);
	assert.equal(harness.restoreCalls[0].checkpoint.marker, "destination");
});

test("keep choice takes a safety checkpoint but deliberately leaves code unchanged", async () => {
	const harness = createHarness({ choices: ["Keep current code"] });
	await start(harness);
	assert.equal(await harness.emit("session_before_tree", treeEvent()), undefined);
	assert.equal(harness.captureCalls.length, 1);
	assert.equal(harness.captureCalls[0].options.reason, "before-tree-navigation");
	assert.equal(harness.restoreCalls.length, 0);
});

test("cancel choice and Escape cancel navigation before taking a safety checkpoint", async () => {
	for (const choice of ["Cancel navigation", undefined]) {
		const harness = createHarness({ choices: [choice] });
		await start(harness);
		assert.deepEqual(await harness.emit("session_before_tree", treeEvent()), { cancel: true });
		assert.equal(harness.captureCalls.length, 0);
		assert.equal(harness.restoreCalls.length, 0);
	}
});

test("missing destination checkpoints offer conversation-only navigation or cancellation", async () => {
	for (const [choice, expected] of [
		["Keep current code and navigate", undefined],
		["Cancel navigation", { cancel: true }],
		[undefined, { cancel: true }],
	]) {
		const harness = createHarness({
			entries: [user("u1", null), assistant("a1", "u1"), user("u2", "a1"), assistant("a2", "u2")],
			choices: [choice],
		});
		await start(harness);
		assert.deepEqual(await harness.emit("session_before_tree", treeEvent()), expected);
		assert.deepEqual(harness.selections[0].values, ["Keep current code and navigate", "Cancel navigation"]);
		assert.equal(harness.restoreCalls.length, 0);
		assert.equal(harness.captureCalls.length, choice === "Keep current code and navigate" ? 1 : 0);
	}
});

test("non-UI navigation never restores implicitly but still records recoverable departure state", async () => {
	const harness = createHarness({ hasUI: false });
	await start(harness);
	assert.equal(await harness.emit("session_before_tree", treeEvent()), undefined);
	assert.equal(harness.selections.length, 0);
	assert.equal(harness.captureCalls.length, 1);
	assert.equal(harness.captureCalls[0].options.reason, "before-tree-navigation");
	assert.equal(harness.restoreCalls.length, 0);
});

test("target restore failure recovers safety state and cancels conversation navigation", async () => {
	const harness = createHarness({
		choices: ["Restore checkpointed code"],
		async restoreCheckpoint(_repo, checkpoint) {
			if (checkpoint.marker === "destination") throw new Error("target restore failed");
		},
	});
	await start(harness);
	assert.deepEqual(await harness.emit("session_before_tree", treeEvent()), { cancel: true });
	assert.deepEqual(harness.restoreCalls.map((call) => call.checkpoint.marker), ["destination", "safety"]);
	assert.match(harness.notifications.at(-1).message, /target restore failed.*safety.*restored/i);
	assert.equal(harness.notifications.at(-1).type, "error");
});

test("failed safety recovery reports both errors urgently and cancels navigation", async () => {
	const harness = createHarness({
		choices: ["Restore checkpointed code"],
		async restoreCheckpoint(_repo, checkpoint) {
			throw new Error(checkpoint.marker === "destination" ? "target exploded" : "safety exploded");
		},
	});
	await start(harness);
	assert.deepEqual(await harness.emit("session_before_tree", treeEvent()), { cancel: true });
	assert.match(harness.notifications.at(-1).message, /target exploded/i);
	assert.match(harness.notifications.at(-1).message, /safety exploded/i);
	assert.equal(harness.notifications.at(-1).type, "error");
});

test("safety capture failure cancels navigation because rollback would be unavailable", async () => {
	const harness = createHarness({
		choices: ["Restore checkpointed code"],
		captureCheckpoint: async () => { throw new Error("cannot anchor safety state"); },
	});
	await start(harness);
	assert.deepEqual(await harness.emit("session_before_tree", treeEvent()), { cancel: true });
	assert.equal(harness.restoreCalls.length, 0);
	assert.match(harness.notifications.at(-1).message, /navigation.*cannot anchor safety state/i);
});

test("outside Git disables only checkpoint behavior and emits at most one concise notice", async () => {
	const harness = createHarness({ git: false, choices: ["Restore checkpointed code"] });
	await start(harness);
	await start(harness, "reload");
	await harness.emit("before_agent_start", { prompt: "ordinary prompt" });
	assert.equal(await harness.emit("session_before_tree", treeEvent()), undefined);
	assert.equal(harness.captureCalls.length, 0);
	assert.equal(harness.restoreCalls.length, 0);
	assert.equal(harness.selections.length, 0);
	assert.ok(harness.notifications.length <= 1);
	assert.match(harness.notifications[0].message, /outside.*Git|not.*Git/i);
});
