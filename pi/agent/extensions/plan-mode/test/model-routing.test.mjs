import assert from "node:assert/strict";
import test from "node:test";
import { createPiJiti } from "../../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const {
	PLAN_MODE_MODEL_ROUTING_ENTRY,
	createModelRoutingState,
	resolveInferenceProfile,
	restoreLatestModelRouting,
} = await jiti.import(new URL("../model-routing.ts", import.meta.url).pathname);

function registry(models) {
	return {
		find(provider, id) { return models.find((model) => model.provider === provider && model.id === id); },
		getAvailable() { return models; },
	};
}

test("maps Codex planning to Terra/high without changing the planning profile", () => {
	const models = [
		{ provider: "openai-codex", id: "gpt-5.6-sol" },
		{ provider: "openai-codex", id: "gpt-5.6-terra" },
	];
	const planning = { provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" };
	const resolved = createModelRoutingState(planning, registry(models));
	assert.deepEqual(resolved.state.planning, planning);
	assert.deepEqual(resolved.state.inference, {
		provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: "high",
	});
	assert.equal(resolved.fallback, undefined);
});

test("selects the latest authenticated Anthropic Sonnet", () => {
	const models = [
		{ provider: "anthropic", id: "claude-opus-4-7" },
		{ provider: "anthropic", id: "claude-sonnet-4-5" },
		{ provider: "anthropic", id: "claude-sonnet-4-6" },
		{ provider: "anthropic", id: "claude-haiku-4-5" },
	];
	const resolved = resolveInferenceProfile(
		{ provider: "anthropic", modelId: "claude-opus-4-7", thinkingLevel: "max" },
		registry(models),
	);
	assert.deepEqual(resolved.profile, {
		provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "high",
	});
});

test("restores only the latest valid branch-local routing entry", () => {
	const first = {
		version: 1,
		planning: { provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: "high" },
		inference: { provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: "high" },
	};
	const latest = structuredClone(first);
	latest.planning.thinkingLevel = "xhigh";
	const restored = restoreLatestModelRouting([
		{ type: "custom", customType: PLAN_MODE_MODEL_ROUTING_ENTRY, data: first },
		{ type: "custom", customType: PLAN_MODE_MODEL_ROUTING_ENTRY, data: { version: 99 } },
		{ type: "custom", customType: PLAN_MODE_MODEL_ROUTING_ENTRY, data: latest },
	]);
	assert.deepEqual(restored, latest);
});
