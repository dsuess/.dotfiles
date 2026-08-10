import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const PLAN_MODE_MODEL_ROUTING_ENTRY = "plan-mode-model-routing";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelProfile {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

export interface ModelRoutingState {
	version: 1;
	planning: ModelProfile;
	inference: ModelProfile;
}

export function captureModelProfile(model: Model<Api> | undefined, thinkingLevel: ThinkingLevel): ModelProfile | null {
	if (!model) return null;
	return { provider: model.provider, modelId: model.id, thinkingLevel };
}

export function resolveInferenceProfile(
	planning: ModelProfile,
	registry: ModelRegistry,
): { profile: ModelProfile; fallback?: string } {
	if (planning.provider === "openai-codex" || planning.provider === "openai") {
		const modelId = "gpt-5.6-terra";
		if (registry.find(planning.provider, modelId)) {
			return { profile: { provider: planning.provider, modelId, thinkingLevel: "high" } };
		}
		return {
			profile: { ...planning, thinkingLevel: "high" },
			fallback: `${planning.provider}/${modelId} is unavailable; inference will keep ${planning.provider}/${planning.modelId}`,
		};
	}

	if (planning.provider === "anthropic") {
		const sonnet = registry.getAvailable()
			.filter((model) => model.provider === "anthropic" && /sonnet/i.test(model.id))
			.sort((left, right) => right.id.localeCompare(left.id, undefined, { numeric: true }))[0];
		if (sonnet) {
			return { profile: { provider: sonnet.provider, modelId: sonnet.id, thinkingLevel: "high" } };
		}
		return {
			profile: { ...planning, thinkingLevel: "high" },
			fallback: `No authenticated Anthropic Sonnet model is available; inference will keep anthropic/${planning.modelId}`,
		};
	}

	return {
		profile: { ...planning, thinkingLevel: "high" },
		fallback: `No balanced inference mapping is configured for provider ${planning.provider}; inference will keep ${planning.provider}/${planning.modelId}`,
	};
}

export function createModelRoutingState(
	planning: ModelProfile,
	registry: ModelRegistry,
): { state: ModelRoutingState; fallback?: string } {
	const resolved = resolveInferenceProfile(planning, registry);
	return {
		state: { version: 1, planning, inference: resolved.profile },
		fallback: resolved.fallback,
	};
}

function isModelProfile(value: unknown): value is ModelProfile {
	if (!value || typeof value !== "object") return false;
	const profile = value as Partial<ModelProfile>;
	return typeof profile.provider === "string"
		&& typeof profile.modelId === "string"
		&& ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.thinkingLevel ?? "");
}

export function restoreLatestModelRouting(branch: readonly unknown[]): ModelRoutingState | null {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== PLAN_MODE_MODEL_ROUTING_ENTRY) continue;
		const data = entry.data as Partial<ModelRoutingState> | undefined;
		if (data?.version === 1 && isModelProfile(data.planning) && isModelProfile(data.inference)) {
			return data as ModelRoutingState;
		}
	}
	return null;
}
