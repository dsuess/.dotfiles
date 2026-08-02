import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const handlers = new Map();
const commands = new Map();
const tools = new Map();
const appended = [];
const queued = [];
const boundaryMessages = [];
let activeTools = ["read", "bash", "edit", "write", "custom_tool"];
const allTools = new Set(activeTools);
const pi = {
	events: { on() { return () => {}; }, emit() {} },
	registerFlag() {}, getFlag() { return false; }, registerShortcut() {}, registerEntryRenderer() {},
	registerCommand(name, definition) { commands.set(name, definition); },
	registerTool(definition) { tools.set(definition.name, definition); allTools.add(definition.name); activeTools.push(definition.name); },
	on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
	appendEntry(customType, data) { appended.push({ type: "custom", customType, data }); },
	getActiveTools() { return [...activeTools]; },
	getAllTools() { return [...allTools].map((name) => ({ name })); },
	setActiveTools(names) { activeTools = [...names]; },
	sendMessage(message, options) {
		boundaryMessages.push({ message, options });
		appended.push({ type: "custom_message", customType: message.customType, content: message.content, display: message.display, details: message.details });
	},
	sendUserMessage(message, options) { queued.push({ message, options }); },
};
extension.default(pi);

const project = await mkdtemp(path.join(os.tmpdir(), "pi-plan-mock-"));
const theme = { fg: (_color, text) => text, bold: (text) => text };
let ledgerWidget;
const ctx = {
	cwd: project, mode: "tui", hasUI: true, model: undefined, thinkingLevel: "high",
	isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false,
	sessionManager: { getBranch: () => appended, getSessionFile: () => "/sessions/planning.jsonl" },
	ui: {
		theme, notify() {}, setStatus() {}, setWidget(name, value) { if (name === "plan-mode-ledger") ledgerWidget = value; },
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
	assert.equal(activeTools.includes("edit"), false);
	const planningPrompt = await handlers.get("before_agent_start")[0]({ systemPrompt: "base" }, ctx);
	assert.match(planningPrompt.systemPrompt, /do not ask while any useful, safe read-only progress remains/i);
	assert.match(planningPrompt.systemPrompt, /ask all currently known blockers together in one ask_user_question call/i);
	assert.doesNotMatch(planningPrompt.systemPrompt, /Ask unresolved design questions one at a time/i);
	assert.match(planningPrompt.systemPrompt, /"Background" is required/);
	assert.match(planningPrompt.systemPrompt, /"Changes" is required/);
	assert.match(planningPrompt.systemPrompt, /Add "Testing Plan" when verification is applicable/);
	assert.match(planningPrompt.systemPrompt, /Add "Assumptions \/ Decisions" only for material assumptions or decisions the user made/);
	assert.match(planningPrompt.systemPrompt, /Add "Stages" only for a larger change/);
	assert.match(planningPrompt.systemPrompt, /Do not list target files, internal symbol names, tools, or API call details/);
	assert.doesNotMatch(planningPrompt.systemPrompt, /Stages Overview/);
	const blocked = await handlers.get("tool_call")[0]({ toolName: "edit", input: {}, toolCallId: "edit-1" }, ctx);
	assert.equal(blocked.block, true);

	const submitted = await tools.get("submit_plan").execute("submit-1", {
		intent: "Add reliable cache invalidation", title: "Add Reliable Cache Invalidation", markdown: VALID_PLAN,
	}, undefined, undefined, ctx);
	assert.equal(submitted.details.accepted, true);
	assert.equal(submitted.terminate, true);
	assert.equal(appended.filter((entry) => entry.customType === "plan-mode-plan-display").length, 1);
	assert.equal(queued.length, 0, "approval commands are not sent to the model");

	await rm(submitted.details.path);
	await handlers.get("agent_settled")[0]({}, ctx);
	const recovered = await readFile(submitted.details.path, "utf8");
	assert.match(recovered, /# Add Reliable Cache Invalidation/, "approval recovers a missing plan from the durable display entry");
	assert.match(recovered, /pi-plan-mode:progress:start/, "recovery retains the canonical managed progress report");
	const executionState = appended.filter((entry) => entry.customType === "plan-mode-state").at(-1).data;
	assert.equal(executionState.mode, "executing_all");
	assert.equal(executionState.approval.consumed, true);
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
		"☐ Define the cache behavior",
		"▶ Add reliable invalidation",
		"⛔ Cover boundary conditions",
	]);

	const progress = tools.get("plan_progress");
	await progress.execute("p1", { taskId: "1", status: "in_progress" }, undefined, undefined, ctx);
	await progress.execute("p2", { taskId: "1", status: "completed", evidence: "contract tests passed" }, undefined, undefined, ctx);
	await progress.execute("p3", { taskId: "2", status: "completed", evidence: "implementation test passed" }, undefined, undefined, ctx);
	await progress.execute("p4", { taskId: "3", status: "in_progress", note: "retrying blocker" }, undefined, undefined, ctx);
	await progress.execute("p5", { taskId: "3", status: "completed", evidence: "edge tests passed" }, undefined, undefined, ctx);
	assert.deepEqual(ledgerWidget, [
		"☑ Define the cache behavior",
		"☑ Add reliable invalidation",
		"☑ Cover boundary conditions",
	]);
	const saved = await readFile(submitted.details.path, "utf8");
	assert.match(saved, /## Step Progress[\s\S]*- ☑ Define the cache behavior[\s\S]*- ☑ Add reliable invalidation[\s\S]*- ☑ Cover boundary conditions/);
	const completed = await tools.get("complete_plan").execute("done", {
		summary: "all stages complete", tests: ["node --test"], allowBlockedStoppingCriterion: false,
	}, undefined, undefined, ctx);
	assert.equal(completed.terminate, true);
	assert.equal(appended.filter((entry) => entry.customType === "plan-mode-state").at(-1).data.mode, "completed");
} finally {
	await rm(project, { recursive: true, force: true });
}
