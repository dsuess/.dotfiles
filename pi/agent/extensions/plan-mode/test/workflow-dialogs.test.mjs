import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VALID_PLAN } from "./fixtures.mjs";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-ai": `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"typebox": `${root}/node_modules/typebox/build/index.mjs`,
} });
const extension = await jiti.import(new URL("../index.ts", import.meta.url).pathname);
const stateModule = await import(new URL("../state.js", import.meta.url));

const theme = { fg: (_color, text) => text, bold: (text) => text };

async function createHarness({ flag = false, mode = "tui", actions = [], editorValues = [] } = {}) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-plan-dialogs-"));
	const handlers = new Map();
	const eventHandlers = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const tools = new Map();
	const entries = [];
	const timeline = [];
	const sentUserMessages = [];
	const sentMessages = [];
	const notifications = [];
	let activeTools = ["read", "bash", "edit", "write", "custom_tool"];
	const allTools = new Set(activeTools);
	let actionIndex = 0;
	let editorIndex = 0;

	function nextAction() { return actions[actionIndex++] ?? "cancel"; }
	function driveSelection(component, action) {
		const downCounts = { run: 0, staged: 1, change: 2, review: 3, continue: 0, feedback: 1, stop: 3 };
		if (action === "cancel") { component.handleInput("\x1b"); return; }
		for (let index = 0; index < (downCounts[action] ?? 0); index += 1) component.handleInput("\x1b[B");
		component.handleInput("\r");
	}

	const events = {
		on(channel, handler) {
			if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
			eventHandlers.get(channel).push(handler);
			return () => {};
		},
		emit(channel, data) { for (const handler of eventHandlers.get(channel) ?? []) handler(data); },
	};
	const pi = {
		events,
		registerFlag() {}, getFlag() { return flag; }, registerEntryRenderer() {},
		registerCommand(name, definition) { commands.set(name, definition); },
		registerShortcut(shortcut, definition) { shortcuts.set(shortcut, definition); },
		registerTool(definition) { tools.set(definition.name, definition); allTools.add(definition.name); activeTools.push(definition.name); },
		on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); timeline.push({ type: "entry", customType }); },
		getActiveTools() { return [...activeTools]; },
		getAllTools() { return [...allTools].map((name) => ({ name })); },
		setActiveTools(names) { activeTools = [...names]; },
		sendMessage(message, options) {
			sentMessages.push({ message, options });
			entries.push({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
			timeline.push({ type: "message", customType: message.customType });
		},
		sendUserMessage(message, options) { sentUserMessages.push({ message, options }); },
	};
	extension.default(pi);

	const hasUI = mode === "tui" || mode === "rpc";
	const ctx = {
		cwd, mode, hasUI, model: undefined, thinkingLevel: "high", signal: undefined,
		isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
		sessionManager: { getBranch: () => entries, getEntries: () => entries, getSessionFile: () => "/sessions/current.jsonl" },
		ui: {
			theme, notify(message, level) { notifications.push({ message, level }); }, setStatus() {}, setWidget() {},
			async custom(factory) {
				timeline.push({ type: "dialog", mode: "tui" });
				const action = nextAction();
				return new Promise((resolve) => {
					const component = factory({ requestRender() {}, stop() {}, start() {} }, theme, {}, resolve);
					driveSelection(component, action);
				});
			},
			async select(_title, labels) {
				timeline.push({ type: "dialog", mode: "rpc" });
				const action = nextAction();
				if (action === "cancel") return undefined;
				const index = { run: 0, staged: 1, change: 2, review: 3, continue: 0, feedback: 1, stop: 3 }[action];
				return labels[index];
			},
			async editor() { return editorValues[editorIndex++]; }, async confirm() { return false; }, async input() { return undefined; },
		},
	};
	async function emit(name, event = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); }
	await emit("session_start", { reason: "startup" });
	return {
		cwd, handlers, events, commands, shortcuts, tools, entries, timeline, sentUserMessages, sentMessages, notifications, ctx, emit,
		getActiveTools: () => [...activeTools],
		latestState: () => entries.filter((entry) => entry.customType === "plan-mode-state").at(-1)?.data,
		async cleanup() { await rm(cwd, { recursive: true, force: true }); },
	};
}

async function enterThrough(harness, entry) {
	if (entry === "command") await harness.commands.get("plan").handler("", harness.ctx);
	else if (entry === "flag") assert.equal(harness.latestState()?.mode, "planning");
	else if (entry === "keyboard") await harness.shortcuts.get("shift+tab").handler(harness.ctx);
	else if (entry === "palette") harness.events.emit("plan-mode:direct-toggle", undefined);
}

async function submit(harness, markdown = VALID_PLAN) {
	return harness.tools.get("submit_plan").execute("submit", {
		intent: "Make approval reliable", title: "Add Reliable Cache Invalidation", markdown,
	}, undefined, undefined, harness.ctx);
}

for (const entry of ["command", "flag", "keyboard", "palette"]) {
	test(`${entry} planning entry renders once before opening approval`, async () => {
		const harness = await createHarness({ flag: entry === "flag", actions: ["cancel"] });
		try {
			await enterThrough(harness, entry);
			const result = await submit(harness);
			assert.equal(result.details.accepted, true);
			assert.equal(harness.timeline.some((item) => item.type === "dialog"), false);
			await harness.emit("agent_settled");
			await harness.emit("agent_settled");
			const displayIndex = harness.timeline.findIndex((item) => item.customType === "plan-mode-plan-display");
			const dialogs = harness.timeline.flatMap((item, index) => item.type === "dialog" ? [index] : []);
			assert.equal(dialogs.length, 1);
			assert.ok(displayIndex >= 0 && displayIndex < dialogs[0]);
			assert.equal(harness.latestState().approval.presented, true);
			assert.equal(harness.sentUserMessages.some(({ message }) => /^\/plan(?:-stage)?-actions\b/.test(message)), false);
		} finally { await harness.cleanup(); }
	});
}

test("Escape keeps approval pending and manual reopening remains available", async () => {
	const harness = await createHarness({ actions: ["cancel", "cancel"] });
	try {
		await enterThrough(harness, "command"); await submit(harness); await harness.emit("agent_settled");
		assert.equal(harness.latestState().approval.consumed, false);
		await harness.commands.get("plan-actions").handler("", harness.ctx);
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 2);
	} finally { await harness.cleanup(); }
});

test("requested changes can be resubmitted and receive one fresh approval", async () => {
	const harness = await createHarness({ actions: ["change", "cancel"], editorValues: ["Tighten verification."] });
	try {
		await enterThrough(harness, "keyboard"); await submit(harness); await harness.emit("agent_settled");
		assert.equal(harness.latestState().mode, "planning");
		const revised = VALID_PLAN.replace("Exercise successful and failed writes", "Exercise and document successful and failed writes");
		await submit(harness, revised); await harness.emit("agent_settled");
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 2);
		assert.equal(harness.latestState().plan.revision, 2);
	} finally { await harness.cleanup(); }
});

test("stale approval tokens do not open or consume the active decision", async () => {
	const harness = await createHarness();
	try {
		await enterThrough(harness, "command"); await submit(harness);
		await harness.commands.get("plan-actions").handler("stale", harness.ctx);
		assert.equal(harness.timeline.some((item) => item.type === "dialog"), false);
		assert.equal(harness.latestState().approval.consumed, false);
	} finally { await harness.cleanup(); }
});

test("RPC hosts receive the state-driven approval dialog", async () => {
	const harness = await createHarness({ mode: "rpc", actions: ["cancel"] });
	try {
		await enterThrough(harness, "palette"); await submit(harness); await harness.emit("agent_settled");
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 1);
	} finally { await harness.cleanup(); }
});

for (const mode of ["print", "json"]) {
	test(`${mode} mode saves without prompting or executing`, async () => {
		const harness = await createHarness({ flag: true, mode });
		try {
			const result = await submit(harness); await harness.emit("agent_settled");
			assert.equal(result.details.accepted, true);
			assert.equal(harness.timeline.some((item) => item.type === "dialog"), false);
			assert.equal(harness.latestState().mode, "approval");
			assert.equal(harness.sentMessages.length, 0);
		} finally { await harness.cleanup(); }
	});
}

test("restored unpresented approval opens without requiring another agent turn", async () => {
	const harness = await createHarness({ actions: ["cancel"] });
	try {
		const planning = stateModule.enterPlanning(stateModule.createInitialState(), ["read", "bash"]).state;
		const approval = stateModule.submitPlan(planning, {
			path: path.join(harness.cwd, ".pi/plans/restored.md"), slug: "restored", hash: "hash", title: "Restored", intent: "Restored", approvalNonce: "approval",
			stages: [{ id: "1", description: "Only", taskIds: ["1"] }],
			tasks: [{ id: "1", title: "Only task", status: "pending" }],
		}).state;
		harness.entries.push({ type: "custom", customType: "plan-mode-state", data: approval });
		await harness.emit("session_tree");
		await Promise.resolve();
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 1);
		await harness.emit("agent_settled");
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 1);
	} finally { await harness.cleanup(); }
});

test("mandatory staged checkpoints open from state without synthetic commands", async () => {
	const harness = await createHarness({ actions: ["cancel", "cancel"] });
	try {
		const planning = stateModule.enterPlanning(stateModule.createInitialState(), ["read", "bash", "edit", "write"]).state;
		const approval = stateModule.submitPlan(planning, {
			path: path.join(harness.cwd, ".pi/plans/staged.md"), slug: "staged", hash: "hash", title: "Staged", intent: "Staged", approvalNonce: "approval",
			stages: [{ id: "1", description: "First", taskIds: ["1"] }, { id: "2", description: "Second", taskIds: ["2"] }],
			tasks: [{ id: "1", title: "First task", status: "pending" }, { id: "2", title: "Second task", status: "pending" }],
		}).state;
		let execution = stateModule.approveExecution(approval, "approval", "staged").state;
		execution = stateModule.recordTaskProgress(execution, { taskId: "1", status: "in_progress" }).state;
		execution = stateModule.recordTaskProgress(execution, { taskId: "1", status: "completed", evidence: "test" }).state;
		execution = stateModule.recordStageCheckpoint(execution, { stageId: "1", nonce: "checkpoint", summary: "done", changedFiles: [], tests: ["npm test"], blockers: [] }).state;
		harness.entries.push({ type: "custom", customType: "plan-mode-state", data: execution });
		await harness.emit("session_tree"); await Promise.resolve();
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 1);
		await harness.emit("agent_settled"); await harness.emit("agent_settled");
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 1);
		assert.equal(harness.latestState().checkpoint.presented, true);
		assert.equal(harness.sentUserMessages.some(({ message }) => /^\/plan-stage-actions\b/.test(message)), false);
		await harness.commands.get("plan-stage-actions").handler("", harness.ctx);
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 2);
	} finally { await harness.cleanup(); }
});

for (const [action, entry, expectedMode, completionTool] of [
	["run", "keyboard", "executing_all", "complete_plan"],
	["staged", "palette", "executing_staged", "complete_stage"],
]) {
	test(`${action} starts isolated in-place execution from a direct planning entry`, async () => {
		const harness = await createHarness({ actions: [action] });
		try {
			await enterThrough(harness, entry);
			const submitted = await submit(harness);
			if (action === "run") await rm(submitted.details.path);
			await harness.emit("agent_settled");
			if (action === "run") assert.match(await readFile(submitted.details.path, "utf8"), /# Add Reliable Cache Invalidation/);
			assert.equal(harness.latestState().mode, expectedMode);
			assert.equal(harness.latestState().execution.parentSessionPath, null);
			assert.ok(harness.latestState().execution.runId);
			const contract = harness.entries.findLast((entry) => entry.type === "custom" && entry.customType === "plan-mode-execution").data;
			assert.equal(contract.version, 2);
			assert.equal(contract.handoff, "in_place");
			assert.equal(contract.runId, harness.latestState().execution.runId);
			assert.equal(harness.getActiveTools().includes("plan_progress"), true);
			assert.equal(harness.getActiveTools().includes(completionTool), true);
			assert.equal(harness.sentMessages.length, 1);
			assert.equal(harness.sentMessages[0].message.display, false);
			assert.equal(harness.sentMessages[0].options.triggerTurn, true);
			assert.match(harness.sentMessages[0].message.content, /current visible session/);
			await harness.emit("session_tree", { reason: "tree" });
			await harness.emit("session_start", { reason: "reload" });
			assert.equal(harness.sentMessages.length, 1, "reload and tree restoration do not duplicate the boundary");
			const boundary = { role: "custom", ...harness.sentMessages[0].message, timestamp: 2 };
			const context = await harness.handlers.get("context")[0]({ messages: [
				{ role: "user", content: "planning", timestamp: 1 }, boundary,
				{ role: "assistant", content: [{ type: "text", text: "implementation" }], timestamp: 3 },
				{ role: "user", content: "follow-up", timestamp: 4 },
			] }, harness.ctx);
			assert.equal(context.messages.length, 3);
			assert.equal(context.messages[0].customType, "plan-mode-execution-boundary");
			assert.equal(context.messages.at(-1).content, "follow-up");
		} finally { await harness.cleanup(); }
	});
}
