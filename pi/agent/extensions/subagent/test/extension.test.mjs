import assert from "node:assert/strict";
import test from "node:test";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-ai": `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"typebox": `${root}/node_modules/typebox/build/index.mjs`,
} });
const extensionModule = await jiti.import(new URL("../index.ts", import.meta.url).pathname);

function createHarness({ runChild, env = {} } = {}) {
	const handlers = new Map();
	const tools = [];
	const widgetCalls = [];
	let activeTools = [
		"read", "bash", "subagent", "submit_plan", "plan_progress", "complete_plan", "complete_stage",
	];
	const pi = {
		registerTool(definition) { tools.push(definition); },
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names) { activeTools = [...names]; },
	};
	extensionModule.createSubagentExtension({ runChild, env })(pi);
	const theme = {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		italic: (text) => text,
		underline: (text) => text,
		strikethrough: (text) => text,
	};
	const ctx = {
		cwd: "/workspace/project",
		mode: "tui",
		hasUI: true,
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		thinkingLevel: "xhigh",
		getSystemPrompt: () => "prefix\n[PI PLANNING MODE ACTIVE]\nread-only planning",
		ui: {
			theme,
			setWidget(...args) { widgetCalls.push(args); },
		},
	};
	return { handlers, tools, widgetCalls, pi, ctx, setActiveTools(names) { activeTools = [...names]; } };
}

test("registers exactly one strict prompt/model/thinkingLevel subagent tool schema", () => {
	const harness = createHarness({ runChild: async () => { throw new Error("not called"); } });
	assert.equal(harness.tools.length, 1);
	const tool = harness.tools[0];
	assert.equal(tool.name, "subagent");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["prompt", "model", "thinkingLevel"]);
	assert.deepEqual(tool.parameters.required, ["prompt"]);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.parameters.properties.prompt.type, "string");
	assert.ok(tool.parameters.properties.model.anyOf?.some((item) => item.type === "string") || tool.parameters.properties.model.type === "string");
	const thinkingProperty = tool.parameters.properties.thinkingLevel;
	const thinkingValues = thinkingProperty.enum
		?? thinkingProperty.anyOf?.find((item) => item.anyOf)?.anyOf?.map((item) => item.const)
		?? thinkingProperty.anyOf?.map((item) => item.const)
		?? [];
	assert.deepEqual(thinkingValues, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.equal(tool.parameters.properties.role, undefined);
	assert.equal(tool.parameters.properties.tools, undefined);
});

test("inherits model, thinking, effective prompt, active tools, and planning mode automatically", async () => {
	let request;
	const updates = [];
	const harness = createHarness({
		runChild: async (options) => {
			request = options;
			options.onActivity({ kind: "reading", emoji: "📖", label: "reading", action: "/workspace/project/README.md" });
			return {
				output: "Report back",
				details: {
					status: "completed", model: "openai-codex/gpt-5.6-sol", activity: [], finalText: "Report back",
					usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
				usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
		},
	});
	const result = await harness.tools[0].execute(
		"call-1",
		{ prompt: "Inspect README" },
		undefined,
		(update) => updates.push(update),
		harness.ctx,
	);
	assert.deepEqual(request, {
		prompt: "Inspect README",
		model: "openai-codex/gpt-5.6-sol",
		thinkingLevel: "xhigh",
		systemPrompt: "prefix\n[PI PLANNING MODE ACTIVE]\nread-only planning",
		activeTools: [
			"read", "bash", "subagent", "submit_plan", "plan_progress", "complete_plan", "complete_stage",
		],
		cwd: "/workspace/project",
		planningMode: true,
		signal: request.signal,
		onActivity: request.onActivity,
	});
	assert.ok(request.signal instanceof AbortSignal);
	assert.equal(request.signal.aborted, false);
	assert.equal(result.content[0].text, "Report back");
	assert.equal(result.details.status, "completed");
	assert.deepEqual(result.usage, request ? result.details.usage : null);
	assert.ok(updates.some((update) => update.details?.status === "running"));
	assert.equal(updates.at(-1).content[0].text, "reading");
	assert.doesNotMatch(updates.at(-1).content[0].text, /📖/, "streamed partial activity is plain text");
	const activeWidgetCall = harness.widgetCalls.find(([, value]) => typeof value === "function");
	assert.equal(activeWidgetCall[2].placement, "belowEditor");
	const activeRows = activeWidgetCall[1]({ requestRender() {} }, harness.ctx.ui.theme).render(120).join("\n");
	assert.match(activeRows, /🔎.*scout/);
	assert.match(activeRows, /Inspect README/);
	assert.doesNotMatch(activeRows, /📖|reading|README\.md/, "activity does not replace the fixed role/task row");
	assert.equal(harness.widgetCalls.at(-1)[1], undefined, "widget clears when the run leaves the map");
});

test("model and thinking overrides are independent of inherited defaults and restrictions", async (t) => {
	async function capture(params) {
		let request;
		const harness = createHarness({ runChild: async (options) => {
			request = options;
			return {
				output: "ok",
				details: { status: "completed", model: options.model, activity: [], finalText: "ok" },
				usage: undefined,
			};
		} });
		await harness.tools[0].execute("call-override", params, undefined, undefined, harness.ctx);
		return request;
	}

	await t.test("model only", async () => {
		const request = await capture({ prompt: "Review", model: "anthropic/claude-sonnet" });
		assert.equal(request.model, "anthropic/claude-sonnet");
		assert.equal(request.thinkingLevel, "xhigh");
		assert.deepEqual(request.activeTools, [
			"read", "bash", "subagent", "submit_plan", "plan_progress", "complete_plan", "complete_stage",
		]);
		assert.equal(request.planningMode, true);
	});

	await t.test("thinking only", async () => {
		const request = await capture({ prompt: "Review", thinkingLevel: "low" });
		assert.equal(request.model, "openai-codex/gpt-5.6-sol");
		assert.equal(request.thinkingLevel, "low");
	});

	await t.test("model and thinking", async () => {
		const request = await capture({
			prompt: "Review",
			model: "anthropic/claude-sonnet",
			thinkingLevel: "medium",
		});
		assert.equal(request.model, "anthropic/claude-sonnet");
		assert.equal(request.thinkingLevel, "medium");
	});
});

test("rejects a blank prompt before child execution", async () => {
	let called = false;
	const harness = createHarness({ runChild: async () => { called = true; } });
	await assert.rejects(
		harness.tools[0].execute("blank-prompt", { prompt: " \n\t " }, undefined, undefined, harness.ctx),
		/prompt.*blank|nonblank prompt/i,
	);
	assert.equal(called, false);
});

test("fails before spawning when neither an override nor parent model exists", async () => {
	let called = false;
	const harness = createHarness({ runChild: async () => { called = true; } });
	harness.ctx.model = undefined;
	await assert.rejects(
		harness.tools[0].execute("missing-model", { prompt: "Inspect" }, undefined, undefined, harness.ctx),
		/no parent model|model override/i,
	);
	assert.equal(called, false);
});

test("defense in depth rejects nested delegation before child execution", async () => {
	let called = false;
	const harness = createHarness({ env: { PI_SUBAGENT_CHILD: "1" }, runChild: async () => { called = true; } });
	await assert.rejects(
		harness.tools[0].execute("nested", { prompt: "Delegate again" }, undefined, undefined, harness.ctx),
		/nested delegation|cannot invoke subagent/i,
	);
	assert.equal(called, false);
});

test("concurrent siblings keep launch order and remove only the child that settles", async () => {
	const releases = new Map();
	const harness = createHarness({ runChild: (options) => new Promise((resolve, reject) => {
		releases.set(options.prompt, { resolve, reject, options });
	}) });
	const first = harness.tools[0].execute("call-first", { prompt: "Inspect first" }, undefined, undefined, harness.ctx);
	const second = harness.tools[0].execute("call-second", { prompt: "Implement second" }, undefined, undefined, harness.ctx);
	assert.equal(releases.size, 2);
	const activeFactory = harness.widgetCalls.at(-1)[1];
	const activeRows = activeFactory({ requestRender() {} }, harness.ctx.ui.theme).render(120).join("\n");
	assert.match(activeRows, /subagent #1/);
	assert.match(activeRows, /subagent #2/);

	releases.get("Implement second").resolve({
		output: "second done",
		details: { status: "completed", model: "openai-codex/gpt-5.6-sol", activity: [], finalText: "second done" },
	});
	await second;
	const remainingFactory = harness.widgetCalls.at(-1)[1];
	const remainingRows = remainingFactory({ requestRender() {} }, harness.ctx.ui.theme).render(120).join("\n");
	assert.match(remainingRows, /subagent #1/);
	assert.doesNotMatch(remainingRows, /subagent #2/);

	releases.get("Inspect first").resolve({
		output: "first done",
		details: { status: "completed", model: "openai-codex/gpt-5.6-sol", activity: [], finalText: "first done" },
	});
	await first;
	assert.equal(harness.widgetCalls.at(-1)[1], undefined);
});

test("JSON mode executes without installing a component-factory widget", async () => {
	const harness = createHarness({ runChild: async () => ({
		output: "ok",
		details: { status: "completed", model: "openai-codex/gpt-5.6-sol", activity: [], finalText: "ok" },
	}) });
	harness.ctx.mode = "json";
	harness.ctx.hasUI = false;
	const result = await harness.tools[0].execute("json-call", { prompt: "Inspect" }, undefined, undefined, harness.ctx);
	assert.equal(result.content[0].text, "ok");
	assert.equal(harness.widgetCalls.length, 0);
});

test("session shutdown clears active rows and aborts owned child processes", async () => {
	let release;
	const harness = createHarness({ runChild: (options) => new Promise((resolve, reject) => {
		release = { resolve, reject, options };
	}) });
	const pending = harness.tools[0].execute("call-shutdown", { prompt: "Wait" }, undefined, undefined, harness.ctx);
	for (let i = 0; i < 50 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.ok(release);
	for (const handler of harness.handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, harness.ctx);
	assert.equal(harness.widgetCalls.at(-1)[1], undefined);
	assert.equal(release.options.signal.aborted, true);
	release.reject(new Error("cancelled by shutdown"));
	await assert.rejects(pending, /cancelled by shutdown/);
});
