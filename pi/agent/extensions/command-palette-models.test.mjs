import assert from "node:assert/strict";
import test from "node:test";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-ai": `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
} });
const {
	getCycledModel,
	getSessionModels,
	orderModelsForSelector,
} = await jiti.import(new URL("./command-palette/models.ts", import.meta.url).pathname);

const full = [
	{ provider: "other", id: "unrelated" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
];
const scoped = [
	{ provider: "openai-codex", id: "gpt-5.6-luna" },
	{ provider: "openai-codex", id: "gpt-5.6-terra" },
	{ provider: "zai", id: "glm-5.2" },
];
const context = (scope) => ({
	scopedModels: scope.map((model) => ({ model })),
	modelRegistry: { getAvailable: () => full },
});
const identity = (model) => model && `${model.provider}/${model.id}`;

test("selection uses only the configured session scope", () => {
	assert.deepEqual(getSessionModels(context(scoped)), scoped);
});

test("an empty scope falls back to the authenticated registry", () => {
	assert.deepEqual(getSessionModels(context([])), full);
});

test("selector puts the current scoped model first and sorts the remainder", () => {
	const unordered = [
		{ provider: "zai", id: "glm-5.3" },
		{ provider: "openai-codex", id: "gpt-5.6-terra" },
		{ provider: "openai-codex", id: "gpt-5.6-luna" },
	];
	assert.deepEqual(
		orderModelsForSelector(unordered, unordered[0]).map(identity),
		["zai/glm-5.3", "openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-terra"],
	);
});

test("cycling wraps in both directions inside scope", () => {
	assert.equal(identity(getCycledModel(scoped, scoped[1], "forward")), "zai/glm-5.2");
	assert.equal(identity(getCycledModel(scoped, scoped[0], "backward")), "zai/glm-5.2");
});

test("cycling enters the proper scope edge from an explicit outside model", () => {
	const outside = { provider: "anthropic", id: "claude-opus-5" };
	assert.equal(identity(getCycledModel(scoped, outside, "forward")), "openai-codex/gpt-5.6-luna");
	assert.equal(identity(getCycledModel(scoped, outside, "backward")), "zai/glm-5.2");
});

test("cycling without an active model uses the proper scope edge", () => {
	assert.equal(identity(getCycledModel(scoped, undefined, "forward")), "openai-codex/gpt-5.6-luna");
	assert.equal(identity(getCycledModel(scoped, undefined, "backward")), "zai/glm-5.2");
	assert.equal(getCycledModel([], undefined, "forward"), undefined);
});
