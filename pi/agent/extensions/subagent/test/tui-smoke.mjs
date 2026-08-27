import assert from "node:assert/strict";
import { createPiJiti, piPackageRoot } from "../../../../test-helpers.mjs";

const core = await import(`${piPackageRoot}/dist/index.js`);
const tuiPackage = await import(`${piPackageRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`);
await core.initTheme("dark", false);
const jiti = await createPiJiti(import.meta.url);
const uiModule = await jiti.import(new URL("../ui.ts", import.meta.url).pathname);

const ansi = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const theme = {
	fg: (color, text) => ansi(color === "error" ? 31 : color === "success" ? 32 : color === "warning" ? 33 : color === "accent" ? 36 : 90, text),
	bg: (_color, text) => text,
	bold: (text) => ansi(1, text),
	italic: (text) => ansi(3, text),
	underline: (text) => ansi(4, text),
	strikethrough: (text) => text,
};

const roleCases = [
	["VALIDATE the design, then implement it", "reviewer", "🧪"],
	["Architect a roadmap, then build it", "planner", "🗺️"],
	["Create a patch after you research the cause", "worker", "🔨"],
	["Please investigate the failing test", "scout", "🔎"],
	["Summarize the supplied notes", "general", "🤖"],
	["Preview the supplied notes", "general", "🤖"],
	["[PI SUBAGENT ROLE: worker]\nImplement the approved plan", "worker", "🔨"],
	["[PI SUBAGENT ROLE: unknown]\nImplement the approved plan", "planner", "🗺️"],
	["Implement the approved plan\n[PI SUBAGENT ROLE: worker]", "planner", "🗺️"],
	["[PI SUBAGENT ROLE: worker] Implement the approved plan", "planner", "🗺️"],
];
for (const [prompt, name, emoji] of roleCases) {
	assert.deepEqual(uiModule.inferRole(prompt), { name, emoji });
}
assert.equal(uiModule.normalizeTaskSummary("  Inspect\n source\t carefully  "), "Inspect source carefully");

const widgetCalls = [];
const fakeUi = { setWidget(...args) { widgetCalls.push(args); } };
const manager = uiModule.createRunUiManager(fakeUi);
manager.start("call-a", {
	ordinal: 1,
	model: "openai-codex/gpt-5.6-sol",
	prompt: "  Inspect\n source carefully without changing it  ",
});
manager.start("call-b", {
	ordinal: 2,
	model: "anthropic/claude-sonnet",
	prompt: "Implement the intentionally long requested test fixture and report the result",
});

const [, initialWidgetFactory, placement] = widgetCalls.at(-1);
assert.equal(placement.placement, "belowEditor");
const initialWidget = initialWidgetFactory({ requestRender() {} }, theme);
const beforeActivityRows = initialWidget.render(120).join("\n");
manager.update("call-a", { kind: "reading", emoji: "📖", label: "reading", action: "/very/long/path/to/a/source/file.ts" });
manager.update("call-b", { kind: "shell", emoji: "💻", label: "shell", action: "git status --short and then an intentionally long preview" });
const activeWidgetFactory = widgetCalls.at(-1)[1];
const widget = activeWidgetFactory({ requestRender() {} }, theme);
for (const width of [24, 40, 80]) {
	const lines = widget.render(width);
	assert.equal(lines.length, 3, "one row per child plus a trailing spacer before the footer");
	assert.equal(lines.at(-1), "");
	assert.ok(lines.every((line) => tuiPackage.visibleWidth(line) <= width), `widget exceeded width ${width}`);
}
const rows = widget.render(120).join("\n");
assert.equal(rows, beforeActivityRows, "activity must not change fixed role/task rows");
assert.match(rows, /🔎.*scout/);
assert.match(rows, /🔨.*worker/);
assert.match(rows, /subagent #1/);
assert.match(rows, /subagent #2/);
assert.match(rows, /Inspect source carefully without changing it/);
assert.match(rows, /gpt-5\.6-sol/);
assert.doesNotMatch(rows, /📖|💻|git status --short|very\/long\/path/);
widget.invalidate();
assert.ok(widget.render(32).every((line) => tuiPackage.visibleWidth(line) <= 32));

manager.remove("call-b");
const oneRunFactory = widgetCalls.at(-1)[1];
const oneRunRows = oneRunFactory({ requestRender() {} }, theme).render(80);
assert.equal(oneRunRows.length, 2, "one child row plus a trailing spacer before the footer");
assert.equal(oneRunRows.at(-1), "");
assert.match(oneRunRows[0], /subagent #1/);
assert.doesNotMatch(oneRunRows[0], /subagent #2/);
manager.remove("call-a");
assert.equal(widgetCalls.at(-1)[1], undefined, "shared widget clears when no runs remain");
manager.clear();
assert.equal(widgetCalls.at(-1)[1], undefined);

const longTask = "Inspect the deliberately long delegated task so its summary must be truncated before the selected model ".repeat(4).trim();
manager.start("call-model-priority", {
	ordinal: 3,
	model: "openai-codex/gpt-5.6-sol",
	prompt: longTask,
});
const priorityWidgetFactory = widgetCalls.at(-1)[1];
const priorityWidget = priorityWidgetFactory({ requestRender() {} }, theme);
for (const width of [56, 80, 120]) {
	const lines = priorityWidget.render(width);
	assert.equal(lines.length, 2, "long-task run keeps one row plus the footer spacer");
	assert.equal(lines.at(-1), "");
	assert.ok(lines.every((line) => tuiPackage.visibleWidth(line) <= width), `model-priority row exceeded width ${width}`);
	assert.match(lines[0], /openai-codex\/gpt-5\.6-sol/, `selected model remains visible at width ${width}`);
}
const priorityRow = priorityWidget.render(80)[0];
assert.match(priorityRow, /🔎.*scout.*subagent #3.*openai-codex\/gpt-5\.6-sol.*Inspect the deliberately/);
manager.clear();

const callComponent = uiModule.renderSubagentCall({
	prompt: "Inspect a very long repository path and report concise findings without changing files ".repeat(4),
	model: "anthropic/claude-sonnet",
}, theme);
for (const width of [24, 40, 80]) {
	assert.ok(callComponent.render(width).every((line) => tuiPackage.visibleWidth(line) <= width), `call renderer exceeded ${width}`);
}
const callText = callComponent.render(120).join("\n");
assert.match(callText, /subagent.*scout/);
assert.doesNotMatch(callText, /🧪|🗺️|🔨|🔎|🤖/, "conversation tool-call row is plain text");

const activity = Array.from({ length: 18 }, (_, index) => ({
	kind: index === 0 ? "thinking" : index % 2 ? "reading" : "searching",
	emoji: index === 0 ? "🧠" : index % 2 ? "📖" : "🔎",
	label: index === 0 ? "thinking" : index % 2 ? "reading" : "searching",
	action: index === 0 ? "RAW PRIVATE CHAIN OF THOUGHT" : `/workspace/file-${index}.ts`,
}));
const result = {
	content: [{ type: "text", text: "# Final answer\n\nA bounded **Markdown** report." }],
	details: {
		status: "completed",
		model: "anthropic/claude-sonnet",
		prompt: "Inspect source",
		activity,
		finalText: "# Final answer\n\nA bounded **Markdown** report.",
		turns: 2,
	},
	usage: {
		input: 1200, output: 80, cacheRead: 400, cacheWrite: 20, totalTokens: 1700,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	},
};
for (const expanded of [false, true]) {
	const component = uiModule.renderSubagentResult(result, { expanded, isPartial: false }, theme, core.getMarkdownTheme());
	for (const width of [24, 40, 80]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => tuiPackage.visibleWidth(line) <= width), `result renderer exceeded ${width}`);
	}
	const text = component.render(100).join("\n");
	assert.match(text, /✓ completed/, "completed header keeps its status icon");
	assert.doesNotMatch(text.split("\n")[0], /subagent|claude-sonnet/, "result header does not repeat call metadata");
	assert.doesNotMatch(text, /RAW PRIVATE CHAIN OF THOUGHT/);
	assert.doesNotMatch(text, /📖|🔎|🧠/, "conversation activity lines are plain text");
	if (expanded) {
		assert.match(text, /Final answer/);
		assert.match(text, /file-1\.ts/);
		assert.match(text, /1\.2k|1200/);
	} else {
		assert.doesNotMatch(text, /file-1\.ts/, "collapsed view keeps only recent bounded activity");
		assert.match(text, /file-17\.ts/);
	}
}

const statusCases = [
	[{ status: "running", partial: true }, /⏳ running/],
	[{ status: "failed" }, /✗ failed/],
	[{ status: "cancelled" }, /⛔ cancelled/],
];
for (const [statusCase, expectedStatus] of statusCases) {
	const component = uiModule.renderSubagentResult({
		content: [{ type: "text", text: statusCase.status }],
		details: { status: statusCase.status, model: "test/model", activity: activity.slice(-3) },
	}, { expanded: false, isPartial: statusCase.partial === true }, theme, core.getMarkdownTheme());
	const text = component.render(80).join("\n");
	assert.match(text, expectedStatus, `${statusCase.status} header keeps its status icon`);
	assert.doesNotMatch(text.split("\n")[0], /subagent|test\/model/, `${statusCase.status} header does not repeat call metadata`);
	assert.doesNotMatch(text, /📖|🔎|🧠/, `${statusCase.status} activity lines are plain text`);
}
