import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

function isSameModel(left: Model<Api> | undefined, right: Model<Api>): boolean {
	return !!left && left.provider === right.provider && left.id === right.id;
}

/** Return the session scope in its configured order, or the full registry when unscoped. */
export function getSessionModels(ctx: ExtensionContext): Model<Api>[] {
	return ctx.scopedModels.length > 0
		? ctx.scopedModels.map((entry) => entry.model)
		: [...ctx.modelRegistry.getAvailable()];
}

/** Keep the active model first in the selector while retaining deterministic ordering. */
export function orderModelsForSelector(
	models: readonly Model<Api>[],
	current: Model<Api> | undefined,
): Model<Api>[] {
	return [...models].sort((left, right) => {
		const leftIsCurrent = isSameModel(current, left);
		const rightIsCurrent = isSameModel(current, right);
		if (leftIsCurrent !== rightIsCurrent) return leftIsCurrent ? -1 : 1;
		return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
	});
}

/** Resolve one deterministic cycle step, including an active model outside the scope. */
export function getCycledModel(
	models: readonly Model<Api>[],
	current: Model<Api> | undefined,
	direction: "forward" | "backward",
): Model<Api> | undefined {
	if (models.length === 0) return undefined;
	const currentIndex = current
		? models.findIndex((model) => isSameModel(current, model))
		: -1;
	if (currentIndex < 0) return direction === "forward" ? models[0] : models[models.length - 1];
	const offset = direction === "forward" ? 1 : -1;
	return models[(currentIndex + offset + models.length) % models.length];
}
