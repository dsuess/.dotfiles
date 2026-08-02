import assert from "node:assert/strict";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const tuiPackage = await import(`${root}/node_modules/@earendil-works/pi-tui/dist/index.js`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-ai": `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"typebox": `${root}/node_modules/typebox/build/index.mjs`,
} });
const planMode = await jiti.import(new URL("../index.ts", import.meta.url).pathname);
const stateModule = await jiti.import(new URL("../state.ts", import.meta.url).pathname);
const commandPalette = await jiti.import(new URL("../../command-palette.ts", import.meta.url).pathname);
const statusbar = await jiti.import(new URL("../../statusbar.ts", import.meta.url).pathname);

const lifecycleHandlers = new Map();
const eventHandlers = new Map();
const commands = new Map();
const shortcuts = new Map();
const appended = [];
const queued = [];
const notifications = [];
let activeTools = ["read", "bash", "edit", "write", "custom_tool"];
let footerComponent;
let footerRenderRequests = 0;
const originalActiveTools = [...activeTools];
const allTools = new Set(activeTools);
let thinkingLevel = "high";

const events = {
	on(channel, handler) {
		if (!eventHandlers.has(channel)) eventHandlers.set(channel, []);
		eventHandlers.get(channel).push(handler);
		return () => {};
	},
	emit(channel, data) {
		for (const handler of eventHandlers.get(channel) ?? []) handler(data);
	},
};

const pi = {
	events,
	registerFlag() {},
	getFlag() { return false; },
	registerEntryRenderer() {},
	registerCommand(name, definition) { commands.set(name, definition); },
	registerShortcut(shortcut, definition) { shortcuts.set(shortcut, definition); },
	registerTool(definition) {
		allTools.add(definition.name);
		activeTools.push(definition.name);
	},
	on(name, handler) {
		if (!lifecycleHandlers.has(name)) lifecycleHandlers.set(name, []);
		lifecycleHandlers.get(name).push(handler);
	},
	appendEntry(customType, data) { appended.push({ type: "custom", customType, data }); },
	getActiveTools() { return [...activeTools]; },
	getAllTools() { return [...allTools].map((name) => ({ name })); },
	setActiveTools(names) { activeTools = [...names]; },
	getCommands() {
		return [...commands.keys()].map((name) => ({ name, source: "extension" }));
	},
	sendUserMessage(message, options) { queued.push({ message, options }); },
	getThinkingLevel() { return thinkingLevel; },
	setThinkingLevel(level) { thinkingLevel = level; },
	async setModel() { return true; },
};

commandPalette.default(pi);
planMode.default(pi);
statusbar.default(pi);

const theme = { fg: (_color, text) => text, bold: (text) => text };
const ctx = {
	cwd: process.cwd(),
	mode: "tui",
	hasUI: true,
	model: undefined,
	modelRegistry: { getAvailable: () => [] },
	sessionManager: { getBranch: () => appended, getSessionFile: () => "/sessions/palette.jsonl" },
	isProjectTrusted: () => true,
	isIdle: () => true,
	hasPendingMessages: () => false,
	getContextUsage: () => undefined,
	ui: {
		theme,
		notify(message, level) { notifications.push({ message, level }); },
		setStatus() {},
		setWidget() {},
		setFooter(factory) {
			footerComponent?.dispose?.();
			footerComponent = factory(
				{ requestRender() { footerRenderRequests += 1; } },
				theme,
				{ onBranchChange() { return () => {}; } },
			);
		},
		async custom(factory) {
			return new Promise((resolve) => {
				const component = factory(
					{ requestRender() {} },
					theme,
					{ getKeys: () => [] },
					resolve,
				);
				for (const key of "/plan") component.handleInput(key);
				component.handleInput("\r");
			});
		},
	},
};

const MAUVE_BG = "\x1b[48;2;203;166;247m";
const PEACH_BG = "\x1b[48;2;250;179;135m";
const PLANNING_MARKER = "[PLANNING]";

function renderFooter(width = 120) {
	assert.ok(footerComponent, "statusbar footer is installed");
	const lines = footerComponent.render(width);
	assert.equal(lines.length, 1, "statusbar remains a single row");
	assert.ok(lines.every((line) => tuiPackage.visibleWidth(line) <= width), `footer exceeded width ${width}`);
	return lines[0];
}

function assertNormalFooter(message) {
	const line = renderFooter();
	assert.ok(line.includes(MAUVE_BG), `${message}: CWD is mauve`);
	assert.ok(!line.includes(PEACH_BG), `${message}: CWD is not peach`);
	assert.ok(!line.includes(PLANNING_MARKER), `${message}: marker is hidden`);
}

function assertPlanningFooter(message) {
	const line = renderFooter();
	assert.ok(line.includes(PEACH_BG), `${message}: CWD is peach`);
	assert.ok(!line.includes(MAUVE_BG), `${message}: CWD is not mauve`);
	assert.ok(line.includes(PLANNING_MARKER), `${message}: marker is visible`);
	assert.match(line, /\x1b\[0m\x1b\[38;2;108;112;134m\[PLANNING\]\x1b\[0m$/, `${message}: marker is reset, dark gray, and rightmost`);
}

for (const handler of lifecycleHandlers.get("session_start") ?? []) {
	await handler({ reason: "startup" }, ctx);
}
assert.deepEqual(activeTools, originalActiveTools, "workflow tools start hidden");
assertNormalFooter("normal startup");
assert.match(renderFooter(), /unknown.*\[high\]/, "statusbar shows the current thinking level after the model name");

const openPalette = shortcuts.get("ctrl+p")?.handler;
assert.ok(openPalette, "command palette shortcut is registered");
assert.ok(shortcuts.get("shift+tab")?.handler, "planning toggle is registered on Shift+Tab");

assert.equal(shortcuts.has("ctrl+="), false, "Ctrl+= thinking shortcut is not registered");
assert.equal(shortcuts.has("ctrl+shift+="), false, "Ctrl++ thinking shortcut is not registered");
assert.equal(shortcuts.has("ctrl+-"), false, "Ctrl+- thinking shortcut is not registered");
const rendersBeforeThinkingChange = footerRenderRequests;
thinkingLevel = "xhigh";
for (const handler of lifecycleHandlers.get("thinking_level_select") ?? []) {
	await handler({ level: thinkingLevel, previousLevel: "high" }, ctx);
}
assert.ok(footerRenderRequests > rendersBeforeThinkingChange, "thinking changes request a footer render");
assert.match(renderFooter(), /unknown.*\[xhigh\]/, "statusbar updates the thinking level after the model name");

await openPalette(ctx);
assert.equal(queued.some(({ message }) => message === "/plan"), false, "palette selection does not queue /plan");
let states = appended.filter((entry) => entry.customType === "plan-mode-state");
assert.equal(states.at(-1)?.data.mode, "planning", "palette Plan selection enters planning immediately");
assert.equal(activeTools.includes("edit"), false, "planning selection gates mutation tools");
assert.equal(activeTools.includes("submit_plan"), true, "planning selection enables submit_plan");
assertPlanningFooter("direct planning entry");
assert.ok(footerRenderRequests > 0, "workflow changes request a footer render");
for (const width of [0, 1, 9, 10, 11, 24, 80]) {
	const line = renderFooter(width);
	if (width >= PLANNING_MARKER.length) {
		assert.ok(line.includes(PLANNING_MARKER), `full marker fits at width ${width}`);
		assert.equal(tuiPackage.visibleWidth(line), width, `marker ends at the rightmost column for width ${width}`);
	}
}

await openPalette(ctx);
states = appended.filter((entry) => entry.customType === "plan-mode-state");
assert.equal(states.at(-1)?.data.mode, "off", "second palette Plan selection disables planning");
assert.deepEqual(activeTools, originalActiveTools, "second selection restores the original tools");
assert.equal(queued.some(({ message }) => message === "/plan"), false, "direct toggling never queues /plan");
assertNormalFooter("direct planning exit");

const planningState = stateModule.enterPlanning(stateModule.createInitialState(), originalActiveTools).state;
const approvalState = stateModule.submitPlan(planningState, {
	path: "/project/.pi/plans/palette.md",
	slug: "palette",
	hash: "hash",
	title: "Palette",
	intent: "Test palette",
	approvalNonce: "nonce",
	stages: [{ id: "1", description: "Stage 1", taskIds: ["1"] }],
	tasks: [{ id: "1", title: "Palette task", status: "pending" }],
}).state;
appended.push({ type: "custom", customType: "plan-mode-state", data: approvalState });
for (const handler of lifecycleHandlers.get("session_tree") ?? []) {
	await handler({ reason: "tree" }, ctx);
}
assertPlanningFooter("restored approval");
await openPalette(ctx);
states = appended.filter((entry) => entry.customType === "plan-mode-state");
assert.equal(states.at(-1)?.data.mode, "off", "palette selection exits pending approval");
assert.deepEqual(activeTools, originalActiveTools, "exiting approval restores the original tools");
assertNormalFooter("approval exit");

const executionState = stateModule.approveExecution(approvalState, "nonce", "all").state;
appended.push({ type: "custom", customType: "plan-mode-state", data: executionState });
for (const handler of lifecycleHandlers.get("session_tree") ?? []) {
	await handler({ reason: "tree" }, ctx);
}
assertNormalFooter("execution restoration");
const entryCountBeforeExecutionToggle = appended.length;
notifications.length = 0;
await openPalette(ctx);
assert.equal(appended.length, entryCountBeforeExecutionToggle, "execution rejection does not persist a transition");
assert.equal(activeTools.includes("plan_progress"), true, "execution tools remain active after rejection");
assert.equal(
	notifications.some(({ message, level }) => level === "warning" && /not allowed while workflow mode is executing_all/.test(message)),
	true,
	"execution selection surfaces the existing invalid-transition warning",
);
assert.equal(queued.some(({ message }) => message === "/plan"), false, "edge-case toggles never queue /plan");

appended.push({ type: "custom", customType: "plan-mode-state", data: stateModule.createInitialState() });
for (const handler of lifecycleHandlers.get("session_tree") ?? []) {
	await handler({ reason: "tree" }, ctx);
}
await commands.get("plan").handler("", ctx);
assert.equal(appended.at(-1)?.data.mode, "planning", "explicit /plan still enters planning");
assertPlanningFooter("explicit planning entry");
await commands.get("plan").handler("off", ctx);
assert.equal(appended.at(-1)?.data.mode, "off", "explicit /plan off still exits planning");
assertNormalFooter("explicit planning exit");
