import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PART_PARALLEL_PLAN, PART_PLAN, VALID_PLAN } from "./fixtures.mjs";

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

async function createHarness({
	flag = false, mode = "tui", actions = [], editorValues = [], reviewResults = [], confirmValues = [],
	initialTools = ["read", "bash", "edit", "write", "custom_tool"], model = undefined,
} = {}) {
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
	const reviewInvocations = [];
	const workflowStates = [];
	let activeTools = [...initialTools];
	const allTools = new Set(activeTools);
	let activeModel = model;
	const models = [model, { provider: "openai-codex", id: "gpt-5.6-terra" }].filter(Boolean);
	let actionIndex = 0;
	let editorIndex = 0;
	let reviewIndex = 0;
	let confirmIndex = 0;

	function nextAction() { return actions[actionIndex++] ?? "cancel"; }
	function driveSelection(component, action) {
		const downCounts = { run: 0, fast: 1, staged: 2, change: 3, review: 4, continue: 0, feedback: 1, stop: 3 };
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
		emit(channel, data) {
			if (channel === "plan-mode:workflow-state") workflowStates.push(data);
			for (const handler of eventHandlers.get(channel) ?? []) handler(data);
		},
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
		getThinkingLevel() { return "high"; },
		setThinkingLevel() {},
		async setModel(nextModel) { activeModel = nextModel; return true; },
		sendMessage(message, options) {
			sentMessages.push({ message, options });
			entries.push({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
			timeline.push({ type: "message", customType: message.customType });
		},
		sendUserMessage(message, options) { sentUserMessages.push({ message, options }); },
	};
	extension.default(pi, {
		async runPlanReview(_ctx, planPath, validatedPlan) {
			reviewInvocations.push({ planPath, validatedPlan });
			return reviewResults[reviewIndex++] ?? { ok: false, error: "No fake review result", level: "warning" };
		},
	});

	const hasUI = mode === "tui" || mode === "rpc";
	const ctx = {
		cwd, mode, hasUI, get model() { return activeModel; }, thinkingLevel: "high", signal: undefined,
		modelRegistry: {
			find(provider, id) { return models.find((candidate) => candidate.provider === provider && candidate.id === id); },
			getAvailable() { return models; },
		},
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
				const index = { run: 0, fast: 1, staged: 2, change: 3, review: 4, continue: 0, feedback: 1, stop: 3 }[action];
				return labels[index];
			},
			async editor() { return editorValues[editorIndex++]; }, async confirm() { return confirmValues[confirmIndex++] ?? false; }, async input() { return undefined; },
		},
	};
	async function emit(name, event = {}) { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); }
	await emit("session_start", { reason: "startup" });
	return {
		cwd, handlers, events, commands, shortcuts, tools, entries, timeline, sentUserMessages, sentMessages, notifications, reviewInvocations, workflowStates, ctx, emit,
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
		assert.equal(harness.workflowStates.at(-1).feedbackPending, true);
		await harness.emit("session_tree");
		assert.equal(harness.workflowStates.at(-1).feedbackPending, true, "restoration retains the durable approval wait");
		await harness.commands.get("plan-actions").handler("", harness.ctx);
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 2);
	} finally { await harness.cleanup(); }
});

test("fast approval starts an equivalent optimizer revision and queues direct parallel execution", async () => {
	const harness = await createHarness({
		actions: ["fast"],
		initialTools: ["read", "bash", "edit", "write", "subagent", "custom_tool"],
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
	});
	try {
		await enterThrough(harness, "command");
		await submit(harness, PART_PLAN);
		await harness.emit("agent_settled");
		assert.equal(harness.latestState().mode, "planning");
		assert.ok(harness.latestState().optimization);
		assert.equal(harness.sentUserMessages.length, 1);
		assert.match(harness.sentUserMessages[0].message, /FAST PLAN OPTIMIZATION ACTIVE/);
		assert.match(harness.sentUserMessages[0].message, /Do not ask questions/);
		const optimized = await submit(harness, PART_PARALLEL_PLAN);
		assert.equal(optimized.details.accepted, true);
		assert.equal(optimized.details.fast, true);
		assert.equal(harness.latestState().mode, "executing_all");
		assert.equal(harness.latestState().approval, null);
		assert.equal(harness.latestState().execution.strategy, "parallel");
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 1);
		const contract = harness.entries.filter((entry) => entry.customType === "plan-mode-execution").at(-1).data;
		assert.equal(contract.executionStrategy, "parallel");
		assert.equal(contract.workerModel, "openai-codex/gpt-5.6-terra");
		assert.equal(contract.workerThinkingLevel, "high");
		assert.equal(harness.sentMessages.length, 1);
		assert.match(harness.sentMessages[0].message.content, /one sibling tool batch/i);
	} finally { await harness.cleanup(); }
});

test("an optimizer that ends before submission restores the original approval", async () => {
	const harness = await createHarness({
		actions: ["fast"],
		initialTools: ["read", "bash", "edit", "write", "subagent", "custom_tool"],
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
	});
	try {
		await enterThrough(harness, "command"); await submit(harness, PART_PLAN); await harness.emit("agent_settled");
		assert.equal(harness.latestState().mode, "planning");
		await harness.emit("agent_settled");
		assert.equal(harness.latestState().mode, "approval");
		assert.equal(harness.latestState().approval.consumed, false);
		assert.equal(harness.latestState().approval.presented, false);
		assert.equal(harness.latestState().optimization, null);
	} finally { await harness.cleanup(); }
});

test("fast approval leaves the source approval pending when subagent support is absent", async () => {
	const harness = await createHarness({ actions: ["fast"] });
	try {
		await enterThrough(harness, "command"); await submit(harness); await harness.emit("agent_settled");
		assert.equal(harness.latestState().mode, "approval");
		assert.equal(harness.latestState().approval.consumed, false);
		assert.equal(harness.sentUserMessages.length, 0);
		assert.equal(harness.notifications.some(({ message }) => /requires subagent/.test(message)), true);
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

test("failed tuicr attempts remain pending and a later valid comment set consumes approval once", async () => {
	const comments = [
		{ id: "review", location: { kind: "review", path: null, startLine: null, endLine: null, side: null }, commentType: null, lifecycleState: "local_draft", content: "Clarify the overall outcome." },
		{ id: "file", location: { kind: "file", path: "/plan.md", startLine: null, endLine: null, side: null }, commentType: "note", lifecycleState: "local_draft", content: "Keep terminology consistent." },
		{ id: "line", location: { kind: "line", path: "/plan.md", startLine: 8, endLine: 8, side: "new" }, commentType: "issue", lifecycleState: "local_draft", content: "Support this claim with repository evidence." },
		{ id: "range", location: { kind: "range", path: "/plan.md", startLine: 12, endLine: 15, side: "new" }, commentType: "suggestion", lifecycleState: "local_draft", content: "Combine these acceptance outcomes." },
	];
	const harness = await createHarness({
		actions: ["review", "review"],
		reviewResults: [
			{ ok: false, error: "No saved tuicr comments were found; approval remains pending", level: "info" },
			{ ok: true, comments },
		],
	});
	try {
		await enterThrough(harness, "command");
		const submitted = await submit(harness);
		await harness.emit("agent_settled");
		const state = harness.latestState();
		assert.equal(state.mode, "planning");
		assert.equal(state.counters.reviewRounds, 1);
		assert.equal(harness.reviewInvocations.length, 2);
		assert.equal(harness.reviewInvocations[0].planPath, submitted.details.path);
		assert.equal(harness.reviewInvocations[0].validatedPlan, await readFile(submitted.details.path, "utf8"));
		assert.match(harness.reviewInvocations[0].validatedPlan, /# Add Reliable Cache Invalidation/);
		assert.equal(harness.sentUserMessages.length, 1);
		const prompt = harness.sentUserMessages[0].message;
		assert.match(prompt, /\[PLAN REVIEW COMMENTS\]/);
		assert.match(prompt, /Clarify the overall outcome/);
		assert.match(prompt, /"kind": "range"/);
		assert.match(prompt, /types are advisory context/i);
		assert.match(prompt, /collect-then-batch clarification workflow/i);
		assert.match(prompt, /submit_plan exactly once/i);
		assert.doesNotMatch(prompt, /resolve every \?|cleaned edited draft|direct edits present/i);
		assert.equal(harness.notifications.some(({ message, level }) => level === "info" && /approval remains pending/.test(message)), true);
		const revised = VALID_PLAN.replace("Exercise successful and failed writes", "Exercise, document, and compare successful and failed writes");
		const resubmitted = await submit(harness, revised);
		assert.equal(resubmitted.details.accepted, true);
		assert.equal(harness.latestState().mode, "approval");
		assert.equal(harness.latestState().plan.revision, 2);
		assert.equal(harness.latestState().approval.consumed, false);
		assert.equal(harness.latestState().counters.reviewRounds, 1);
	} finally { await harness.cleanup(); }
});

test("RPC approval omits the TUI-only Review action", async () => {
	const harness = await createHarness({ mode: "rpc", actions: ["review"] });
	try {
		await enterThrough(harness, "command"); await submit(harness); await harness.emit("agent_settled");
		assert.equal(harness.latestState().mode, "approval");
		assert.equal(harness.latestState().approval.consumed, false);
		assert.equal(harness.reviewInvocations.length, 0);
	} finally { await harness.cleanup(); }
});

test("review confirmation beyond ten rounds leaves approval pending until explicitly accepted", async () => {
	const harness = await createHarness({
		actions: ["review", "cancel", "review"],
		confirmValues: [false, true],
		reviewResults: [{ ok: true, comments: [{
			id: "late", location: { kind: "review", path: null, startLine: null, endLine: null, side: null },
			commentType: null, lifecycleState: "local_draft", content: "One final refinement.",
		}] }],
	});
	try {
		const planPath = path.join(harness.cwd, ".pi/plans/late.md");
		await mkdir(path.dirname(planPath), { recursive: true });
		await writeFile(planPath, VALID_PLAN, "utf8");
		const hash = createHash("sha256").update(VALID_PLAN).digest("hex");
		const planning = stateModule.enterPlanning(stateModule.createInitialState(), ["read", "bash"]).state;
		const approval = stateModule.submitPlan(planning, {
			path: planPath, slug: "late", hash, title: "Late", intent: "Late", approvalNonce: "approval",
			stages: [{ id: "1", description: "Only", taskIds: ["1"] }],
			tasks: [{ id: "1", title: "Only task", status: "pending" }],
		}).state;
		approval.counters.reviewRounds = 10;
		approval.approval.presented = true;
		harness.entries.push({ type: "custom", customType: "plan-mode-state", data: approval });
		await harness.emit("session_tree");
		await harness.commands.get("plan-actions").handler("", harness.ctx);
		assert.equal(harness.latestState().mode, "approval");
		assert.equal(harness.latestState().counters.reviewRounds, 10);
		assert.equal(harness.reviewInvocations.length, 0);
		await harness.commands.get("plan-actions").handler("", harness.ctx);
		assert.equal(harness.latestState().mode, "planning");
		assert.equal(harness.latestState().counters.reviewRounds, 11);
		assert.equal(harness.reviewInvocations.length, 1);
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
		assert.equal(harness.workflowStates.at(-1).feedbackPending, true);
		assert.equal(harness.sentUserMessages.some(({ message }) => /^\/plan-stage-actions\b/.test(message)), false);
		await harness.emit("session_tree");
		assert.equal(harness.workflowStates.at(-1).feedbackPending, true, "restoration retains the durable checkpoint wait");
		await harness.commands.get("plan-stage-actions").handler("", harness.ctx);
		assert.equal(harness.timeline.filter((item) => item.type === "dialog").length, 2);
	} finally { await harness.cleanup(); }
});

test("the context hook retains post-compaction execution messages without exposing the mixed summary", async () => {
	const harness = await createHarness({ actions: ["run"] });
	try {
		await enterThrough(harness, "command");
		await submit(harness);
		await harness.emit("agent_settled");
		const summary = { role: "compactionSummary", summary: "Planning history", tokensBefore: 1000, timestamp: 1 };
		const readResult = {
			role: "toolResult", toolCallId: "read-plan", toolName: "read", content: [{ type: "text", text: "# Approved\\n" }], isError: false, timestamp: 3,
		};
		const progressFailure = {
			role: "toolResult", toolCallId: "progress-1", toolName: "plan_progress", content: [{ type: "text", text: "Task 1 is already in_progress." }], isError: true, timestamp: 5,
		};
		const retainedTail = [
			{ role: "assistant", content: [{ type: "toolCall", id: "read-plan", name: "read", arguments: { path: "/project/.pi/plans/approved.md" } }], timestamp: 2 },
			readResult,
			{ role: "assistant", content: [{ type: "toolCall", id: "progress-1", name: "plan_progress", arguments: { taskId: "1", status: "in_progress" } }], timestamp: 4 },
			progressFailure,
			{ role: "user", content: "Continue from the current ledger.", timestamp: 6 },
		];
		const context = await harness.handlers.get("context")[0]({ messages: [summary, ...retainedTail] }, harness.ctx);
		assert.equal(context.messages[0].customType, "plan-mode-execution-boundary");
		assert.deepEqual(context.messages.slice(1), retainedTail);
		assert.ok(context.messages.includes(readResult));
		assert.ok(context.messages.includes(progressFailure));
		assert.equal(context.messages.some((message) => message.role === "compactionSummary"), false);
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
