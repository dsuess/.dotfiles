import assert from "node:assert/strict";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const core = await import(`${root}/dist/index.js`);
const tuiPackage = await import(`${root}/node_modules/@earendil-works/pi-tui/dist/index.js`);
await core.initTheme("dark", false);
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"typebox": `${root}/node_modules/typebox/build/index.mjs`,
} });
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

const callComponent = uiModule.renderSubagentCall({
	prompt: "Inspect a very long repository path and report concise findings without changing files ".repeat(4),
	model: "anthropic/claude-sonnet",
}, theme);
for (const width of [24, 40, 80]) {
	assert.ok(callComponent.render(width).every((line) => tuiPackage.visibleWidth(line) <= width), `call renderer exceeded ${width}`);
}

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
	assert.match(text, /completed/);
	assert.match(text, /claude-sonnet/);
	assert.doesNotMatch(text, /RAW PRIVATE CHAIN OF THOUGHT/);
	if (expanded) {
		assert.match(text, /Final answer/);
		assert.match(text, /file-1\.ts/);
		assert.match(text, /1\.2k|1200/);
	} else {
		assert.doesNotMatch(text, /file-1\.ts/, "collapsed view keeps only recent bounded activity");
		assert.match(text, /file-17\.ts/);
	}
}

const partial = uiModule.renderSubagentResult({
	content: [{ type: "text", text: "running" }],
	details: { status: "running", model: "test/model", activity: activity.slice(-3) },
}, { expanded: false, isPartial: true }, theme, core.getMarkdownTheme());
assert.match(partial.render(80).join("\n"), /running/);
