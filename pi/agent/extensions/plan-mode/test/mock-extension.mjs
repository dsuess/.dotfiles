import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PART_PLAN_WITH_QUESTIONS } from "./fixtures.mjs";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-ai": `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"typebox": `${root}/node_modules/typebox/build/index.mjs`,
} });
const extension = await jiti.import(new URL("../index.ts", import.meta.url).pathname);

const handlers = new Map();
const commands = new Map();
const tools = new Map();
const appended = [];
const queued = [];
const boundaryMessages = [];
const models = [
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
	{ provider: "openai-codex", id: "gpt-5.6-terra" },
	{ provider: "anthropic", id: "claude-sonnet-5" },
];
let activeModel = models[0];
let thinkingLevel = "high";
let modelSwitchAllowed = true;
let activeTools = ["read", "bash", "edit", "write", "custom_tool"];
const allTools = new Set(activeTools);
const persistedDefaults = [];
const gondolinCompositionStages = [];
const busHandlers = new Map();
let defaultWriteAllowed = true;
const modelDefaults = {
	load() {
		return { profiles: {
			planning: { provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "high" },
			inference: { provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: "high" },
		} };
	},
	async persist(profiles) {
		if (!defaultWriteAllowed) throw new Error("simulated settings failure");
		persistedDefaults.push(structuredClone(profiles));
	},
};
const pi = {
	events: {
		on(name, handler) {
			if (!busHandlers.has(name)) busHandlers.set(name, []);
			busHandlers.get(name).push(handler);
			return () => {};
		},
		emit(name, payload) {
			if (name === "gondolin-sandbox:verify-tools") gondolinCompositionStages.push(payload.stage);
			for (const handler of busHandlers.get(name) ?? []) handler(payload);
		},
	},
	registerFlag() {}, getFlag() { return false; }, registerShortcut() {}, registerEntryRenderer() {},
	registerCommand(name, definition) { commands.set(name, definition); },
	registerTool(definition) { tools.set(definition.name, definition); allTools.add(definition.name); activeTools.push(definition.name); },
	on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
	appendEntry(customType, data) { appended.push({ type: "custom", customType, data }); },
	getActiveTools() { return [...activeTools]; },
	getAllTools() { return [...allTools].map((name) => ({ name })); },
	setActiveTools(names) { activeTools = [...names]; },
	getThinkingLevel() { return thinkingLevel; },
	setThinkingLevel(level) { thinkingLevel = level; },
	async setModel(model) {
		if (!modelSwitchAllowed) return false;
		activeModel = model;
		return true;
	},
	sendMessage(message, options) {
		boundaryMessages.push({ message, options });
		appended.push({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
	},
	sendUserMessage(message, options) { queued.push({ message, options }); },
};
extension.default(pi, { modelDefaults });

const project = await mkdtemp(path.join(os.tmpdir(), "pi-plan-mock-"));
const theme = { fg: (_color, text) => text, bold: (text) => text };
let ledgerWidget;
const notifications = [];
const ctx = {
	cwd: project, mode: "tui", hasUI: true,
	get model() { return activeModel; },
	get thinkingLevel() { return thinkingLevel; },
	modelRegistry: {
		find(provider, id) { return models.find((model) => model.provider === provider && model.id === id); },
		getAvailable() { return models; },
	},
	isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
	sessionManager: { getBranch: () => appended, getSessionFile: () => "/sessions/planning.jsonl" },
	ui: {
		theme, notify() {}, setStatus() {}, setWidget(name, value) { if (name === "plan-mode-ledger") ledgerWidget = value; },
		notify(message, level) { notifications.push({ message, level }); },
		async custom(factory) {
			return new Promise((resolve) => {
				const component = factory({ requestRender() {} }, theme, {}, resolve);
				component.handleInput("\r");
			});
		},
		async editor() { return undefined; }, async confirm() { return true; }, async input() { return "declared stop"; },
	},
};

try {
	for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
	assert.equal(tools.has("submit_plan"), true);
	assert.equal(activeTools.includes("submit_plan"), false, "workflow tools start hidden");

	await commands.get("plan").handler("", ctx);
	assert.deepEqual(appended.at(-1).data.originalActiveTools, ["read", "bash", "edit", "write", "custom_tool"]);
	assert.equal(appended.at(-1).data.mode, "planning");
	assert.equal(activeModel.id, "gpt-5.6-sol");
	assert.equal(thinkingLevel, "high");
	assert.equal(activeTools.includes("edit"), false);
	const userBashPreflight = { command: "touch blocked-in-planning", result: undefined };
	pi.events.emit("gondolin-sandbox:before-user-bash", userBashPreflight);
	assert.equal(userBashPreflight.result.result.exitCode, 126, "known user Bash mutation is blocked before sandbox execution");
	const planningPrompt = await handlers.get("before_agent_start")[0]({ systemPrompt: "base" }, ctx);
	assert.match(planningPrompt.systemPrompt, /do not ask while any useful, safe read-only progress remains/i);
	assert.match(planningPrompt.systemPrompt, /ask all currently known blockers together in one ask_user_question call/i);
	assert.doesNotMatch(planningPrompt.systemPrompt, /Ask unresolved design questions one at a time/i);
	assert.match(planningPrompt.systemPrompt, /required "Context", optional "Questions & Answers", required "Approach"/);
	assert.match(planningPrompt.systemPrompt, /Record every answered clarification/);
	assert.match(planningPrompt.systemPrompt, /Do not add unresolved blockers, invented entries, or a no-questions placeholder/);
	assert.match(planningPrompt.systemPrompt, /### Part A — Action-oriented title/);
	assert.match(planningPrompt.systemPrompt, /Do not add an author-written status marker/);
	assert.match(planningPrompt.systemPrompt, /selective implementation anchors/);
	assert.match(planningPrompt.systemPrompt, /not an exhaustive target-file inventory/);
	assert.match(planningPrompt.systemPrompt, /Add "Verification" whenever the planned result can be meaningfully checked/);
	assert.match(planningPrompt.systemPrompt, /Omit optional sections cleanly/); // small fixes and documentation-only work
	assert.match(planningPrompt.systemPrompt, /cross-file or integration context/); // cross-file refactors
	assert.match(planningPrompt.systemPrompt, /external interfaces/); // uncertain integrations
	assert.match(planningPrompt.systemPrompt, /failure signals for uncertain assumptions/);
	assert.match(planningPrompt.systemPrompt, /every execution stage corresponds to exactly one Part|Each Part is one coherent executable and staged-delivery boundary/); // multi-Part staged work
	assert.doesNotMatch(planningPrompt.systemPrompt, /Stages Overview/);
	const blocked = await handlers.get("tool_call")[0]({ toolName: "edit", input: {}, toolCallId: "edit-1" }, ctx);
	assert.equal(blocked.block, true);

	const submitted = await tools.get("submit_plan").execute("submit-1", {
		intent: "Add reliable cache invalidation", title: "Add Reliable Cache Invalidation", markdown: PART_PLAN_WITH_QUESTIONS,
	}, undefined, undefined, ctx);
	assert.equal(submitted.details.accepted, true);
	assert.equal(submitted.terminate, true);
	const displayEntry = appended.filter((entry) => entry.customType === "plan-mode-plan-display").at(-1);
	assert.match(displayEntry.data.markdown, /## Questions & Answers[\s\S]*Should failed writes invalidate a valid cache entry\?[\s\S]*No\. Retain the last valid value\./);
	assert.equal(queued.length, 0, "approval commands are not sent to the model");

	await rm(submitted.details.path);
	await handlers.get("agent_settled")[0]({}, ctx);
	const recovered = await readFile(submitted.details.path, "utf8");
	assert.match(recovered, /# Add Reliable Cache Invalidation/, "approval recovers a missing plan from the durable display entry");
	assert.match(recovered, /## Context[\s\S]*## Questions & Answers[\s\S]*## Approach[\s\S]*### Part A/);
	assert.match(recovered, /\| Must the public cache interface change\? \| No\. Preserve compatibility\. \|/);
	assert.match(recovered, /## Verification[\s\S]*Exercise successful and failed writes/);
	assert.match(recovered, /## Part Progress/, "recovery retains the canonical managed progress report");
	const executionState = appended.filter((entry) => entry.customType === "plan-mode-state").at(-1).data;
	assert.equal(executionState.mode, "executing_all");
	assert.equal(executionState.approval.consumed, true);
	assert.equal(activeModel.id, "gpt-5.6-terra");
	assert.equal(thinkingLevel, "high");
	assert.ok(executionState.execution.runId);
	const contract = appended.filter((entry) => entry.customType === "plan-mode-execution").at(-1).data;
	assert.equal(contract.version, 2);
	assert.equal(contract.handoff, "in_place");
	assert.equal(contract.runId, executionState.execution.runId);
	assert.equal(boundaryMessages.length, 1);
	assert.equal(boundaryMessages[0].message.display, false);
	assert.match(boundaryMessages[0].message.content, /current visible session/);
	assert.match(boundaryMessages[0].message.content, /# Add Reliable Cache Invalidation/);
	assert.ok(activeTools.includes("plan_progress"));
	assert.ok(activeTools.includes("complete_plan"));
	assert.equal(activeTools.includes("complete_stage"), false);
	assert.deepEqual(ledgerWidget, [
		"☐ Define cache consistency",
		"☐ Implement reliable invalidation",
	]);

	const progress = tools.get("plan_progress");
	await progress.execute("p1", { itemId: "A", status: "in_progress" }, undefined, undefined, ctx);
	await progress.execute("p2", { itemId: "A", status: "completed", evidence: "contract tests passed" }, undefined, undefined, ctx);
	await progress.execute("p3", { itemId: "B", status: "in_progress" }, undefined, undefined, ctx);
	await progress.execute("p4", { itemId: "B", status: "completed", evidence: "implementation test passed" }, undefined, undefined, ctx);
	assert.deepEqual(ledgerWidget, [
		"☑ Define cache consistency",
		"☑ Implement reliable invalidation",
	]);
	const saved = await readFile(submitted.details.path, "utf8");
	assert.match(saved, /## Questions & Answers[\s\S]*\| Question \| Answer \|[\s\S]*## Part Progress[\s\S]*- ☑ Define cache consistency[\s\S]*- ☑ Implement reliable invalidation/);
	assert.doesNotMatch(saved, /Part [A-B] \[(?:pending|in_progress|completed|blocked)\]/);
	const completed = await tools.get("complete_plan").execute("done", {
		summary: "all stages complete", tests: ["node --test"], allowBlockedStoppingCriterion: false,
	}, undefined, undefined, ctx);
	assert.equal(completed.terminate, true);
	assert.equal(appended.filter((entry) => entry.customType === "plan-mode-state").at(-1).data.mode, "completed");

	await commands.get("plan").handler("", ctx);
	assert.equal(activeModel.id, "gpt-5.6-sol", "a new planning run restores the planner model");
	assert.equal(thinkingLevel, "high", "a new planning run restores planner thinking");
	await commands.get("plan").handler("off", ctx);
	assert.equal(activeModel.id, "gpt-5.6-terra", "/plan off restores the inference model");
	assert.equal(thinkingLevel, "high", "/plan off restores inference thinking");
	assert.deepEqual(persistedDefaults.at(-1), {
		planning: { provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "high" },
		inference: { provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: "high" },
	}, "automatic Sol/Terra workflow switches reconcile without changing either durable default");

	modelSwitchAllowed = false;
	await commands.get("plan").handler("", ctx);
	assert.equal(activeModel.id, "gpt-5.6-terra", "an unavailable planner leaves the active model unchanged");
	const routing = appended.filter((entry) => entry.customType === "plan-mode-model-routing").at(-1).data;
	assert.equal(routing.planning.modelId, "gpt-5.6-sol", "a failed restore does not overwrite the saved planner");
	await commands.get("plan").handler("off", ctx);

	modelSwitchAllowed = true;
	await commands.get("plan").handler("", ctx);
	activeModel = models[1];
	await handlers.get("model_select")[0]({ model: activeModel, source: "set" }, ctx);
	assert.deepEqual(persistedDefaults.at(-1), {
		planning: { provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: "high" },
		inference: { provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: "high" },
	}, "/model in planning persists only the planning default");
	activeModel = models[0];
	await handlers.get("model_select")[0]({ model: activeModel, source: "cycle" }, ctx);
	assert.equal(persistedDefaults.at(-1).planning.modelId, "gpt-5.6-sol", "Ctrl+P persists planning choices");
	assert.equal(persistedDefaults.at(-1).inference.modelId, "gpt-5.6-terra");
	await commands.get("plan").handler("off", ctx);
	activeModel = models[2];
	await handlers.get("model_select")[0]({ model: activeModel, source: "set" }, ctx);
	assert.deepEqual(persistedDefaults.at(-1), {
		planning: { provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "high" },
		inference: { provider: "anthropic", modelId: "claude-sonnet-5", thinkingLevel: "high" },
	}, "/model in implementation persists only the implementation default, including provider changes");
	defaultWriteAllowed = false;
	activeModel = models[1];
	await handlers.get("model_select")[0]({ model: activeModel, source: "cycle" }, ctx);
	assert.match(notifications.at(-1).message, /defaults could not be saved/i, "settings failures warn instead of claiming persistence");
	assert.ok(gondolinCompositionStages.includes("planning gate"), "planning transitions request source-aware Gondolin verification");
	assert.ok(gondolinCompositionStages.includes("execution-tool transition"), "execution transitions request source-aware Gondolin verification");
	assert.ok(gondolinCompositionStages.includes("original-tool restore"), "original-tool restoration requests source-aware Gondolin verification");
} finally {
	await rm(project, { recursive: true, force: true });
}
