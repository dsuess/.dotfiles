export const STATUS_ICON = Object.freeze({
	pending: "☐",
	in_progress: "▶",
	completed: "☑",
	blocked: "⛔",
});

export function getDocumentProgressTasks(document) {
	return (document?.parts ?? []).map((part) => ({ id: part.id, title: part.title, status: part.status }));
}

export function buildProgressRows(source) {
	const tasks = source?.plan?.tasks ?? source?.tasks ?? [];
	return tasks.map((task) => {
		const status = source?.ledger?.[task.id]?.status ?? task.status ?? "pending";
		const icon = STATUS_ICON[status];
		if (!icon) throw new Error(`Unknown plan-item status '${status}' for ${task.id}`);
		return `${icon} ${task.title}`;
	});
}

export function buildDocumentProgressRows(document) {
	const tasks = getDocumentProgressTasks(document);
	return buildProgressRows({ tasks });
}
