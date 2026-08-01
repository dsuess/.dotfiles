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

test("registers exactly one strict two-field subagent tool schema", () => {
	const harness = createHarness({ runChild: async () => { throw new Error("not called"); } });
	assert.equal(harness.tools.length, 1);
	const tool = harness.tools[0];
	assert.equal(tool.name, "subagent");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["prompt", "model"]);
	assert.deepEqual(tool.parameters.required, ["prompt"]);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(tool.parameters.properties.prompt.type, "string");
	assert.ok(tool.parameters.properties.model.anyOf?.some((item) => item.type === "string") || tool.parameters.properties.model.type === "string");
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
		activeTools: ["read", "bash"],
		cwd: "/workspace/project",
		planningMode: true,
		signal: undefined,
		onActivity: request.onActivity,
	});
	assert.equal(result.content[0].text, "Report back");
	assert.equal(result.details.status, "completed");
	assert.deepEqual(result.usage, request ? result.details.usage : null);
	assert.ok(updates.some((update) => update.details?.status === "running"));
	assert.ok(harness.widgetCalls.some(([, , options]) => options?.placement === "belowEditor"));
	assert.equal(harness.widgetCalls.at(-1)[1], undefined, "widget clears when the run leaves the map");
});

test("a supplied model overrides only the model while parent thinking and restrictions remain inherited", async () => {
	let request;
	const harness = createHarness({ runChild: async (options) => {
		request = options;
		return {
			output: "ok",
			details: { status: "completed", model: "anthropic/claude-sonnet", activity: [], finalText: "ok" },
			usage: undefined,
		};
	} });
	await harness.tools[0].execute("call-override", {
		prompt: "Review",
		model: "anthropic/claude-sonnet",
	}, undefined, undefined, harness.ctx);
	assert.equal(request.model, "anthropic/claude-sonnet");
	assert.equal(request.thinkingLevel, "xhigh");
	assert.deepEqual(request.activeTools, ["read", "bash"]);
	assert.equal(request.planningMode, true);
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
	release.reject(new Error("cancelled by shutdown"));
	await assert.rejects(pending, /cancelled by shutdown/);
});
