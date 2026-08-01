const STATUS_ICON = Object.freeze({
	pending: "☐",
	in_progress: "▶",
	completed: "☑",
	blocked: "⛔",
});

function restoredStages(plan) {
	if (Array.isArray(plan?.stages) && plan.stages.length > 0) return plan.stages;
	return (plan?.stageIds ?? []).map((id) => ({
		id,
		description: `Stage ${id}`,
		taskIds: (plan?.taskIds ?? []).filter((taskId) => taskId.startsWith(`${id}.`)),
	}));
}

export function getStageStatus(stage, ledger) {
	const statuses = (stage.taskIds ?? []).map((taskId) => ledger?.[taskId]?.status ?? "pending");
	if (statuses.includes("blocked")) return "blocked";
	if (statuses.length > 0 && statuses.every((status) => status === "completed")) return "completed";
	if (statuses.some((status) => status === "in_progress" || status === "completed")) return "in_progress";
	return "pending";
}

export function buildStageProgressRows(state) {
	return restoredStages(state.plan).map((stage) => {
		const status = getStageStatus(stage, state.ledger);
		return `${STATUS_ICON[status]} Stage ${stage.id} — ${stage.description}`;
	});
}
