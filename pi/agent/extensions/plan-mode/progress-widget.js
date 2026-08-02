export const STATUS_ICON = Object.freeze({
	pending: "☐",
	in_progress: "▶",
	completed: "☑",
	blocked: "⛔",
});

export function getDocumentProgressTasks(document) {
	const tasks = Array.isArray(document?.steps)
		? document.steps
		: (document?.stages ?? []).flatMap((stage) => stage.tasks ?? []);
	return tasks.map((task) => ({ id: task.id, title: task.title, status: task.status }));
}

export function buildStepProgressRows(source) {
	const tasks = source?.plan?.tasks ?? source?.tasks ?? [];
	return tasks.map((task) => {
		const status = source?.ledger?.[task.id]?.status ?? task.status ?? "pending";
		const icon = STATUS_ICON[status];
		if (!icon) throw new Error(`Unknown task status '${status}' for ${task.id}`);
		return `${icon} ${task.title}`;
	});
}

export function buildDocumentStepProgressRows(document) {
	const tasks = getDocumentProgressTasks(document);
	return buildStepProgressRows({ tasks });
}
