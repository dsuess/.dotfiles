export const PLAN_DOCUMENT_VERSION = 1;
export const MAX_PLAN_BYTES = 256 * 1024;
export const PLAN_STATUSES = Object.freeze(["pending", "in_progress", "completed", "blocked"]);

const STATUS_SET = new Set(PLAN_STATUSES);
const REQUIRED_H2 = [
	"Objective / Goal Statement",
	"Stages Overview",
	"Conditional Logic and Edge Cases",
	"Parallel Subagent Recommendations",
	"Testing Requirements and Edge Cases",
	"Stopping Criteria / Guardrails",
];

function error(code, message, line) {
	return { code, message, ...(line ? { line } : {}) };
}

function contentBetween(lines, start, end) {
	return lines.slice(start, end).join("\n").trim();
}

function scanHeadings(lines) {
	const headings = [];
	let fence = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (match) headings.push({ level: match[1].length, text: match[2], index, line: index + 1 });
	}
	return headings;
}

function splitTableRow(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
	const cells = [];
	let value = "";
	let escaped = false;
	for (const character of trimmed.slice(1, -1)) {
		if (escaped) {
			value += character;
			escaped = false;
		} else if (character === "\\") {
			escaped = true;
		} else if (character === "|") {
			cells.push(value.trim());
			value = "";
		} else {
			value += character;
		}
	}
	if (escaped) value += "\\";
	cells.push(value.trim());
	return cells;
}

function parseOverview(content, startLine, errors) {
	const rows = content.split("\n").map((line, offset) => ({ line, number: startLine + offset }));
	const tableRows = rows.filter((row) => row.line.trim().startsWith("|"));
	if (tableRows.length < 3) {
		errors.push(error("invalid_overview", "Stages Overview must contain a Markdown table", startLine));
		return [];
	}
	const header = splitTableRow(tableRows[0].line);
	if (!header || header.map((cell) => cell.toLowerCase()).join("|") !== "stage|name|purpose") {
		errors.push(error("invalid_overview", "Stages Overview table header must be Stage, Name, Purpose", tableRows[0].number));
	}
	const separator = splitTableRow(tableRows[1].line);
	if (!separator || separator.length !== 3 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
		errors.push(error("invalid_overview", "Stages Overview table separator is malformed", tableRows[1].number));
	}
	const stages = [];
	const seen = new Set();
	for (const row of tableRows.slice(2)) {
		const cells = splitTableRow(row.line);
		if (!cells || cells.length !== 3 || !/^\d+$/.test(cells[0]) || !cells[1] || !cells[2]) {
			errors.push(error("invalid_overview_row", "Each stage row needs a numeric ID, name, and purpose", row.number));
			continue;
		}
		if (seen.has(cells[0])) {
			errors.push(error("duplicate_stage", `Duplicate stage ID ${cells[0]} in overview`, row.number));
			continue;
		}
		seen.add(cells[0]);
		stages.push({ id: cells[0], name: cells[1], purpose: cells[2] });
	}
	return stages;
}

function escapeTableCell(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function validateBodyMetadata(task, errors) {
	const targets = task.body.match(/^- \*\*Targets:\*\*\s*(.+)$/m);
	const tools = task.body.match(/^- \*\*Tools \/ APIs:\*\*\s*(.+)$/m);
	if (!targets?.[1]?.trim()) {
		errors.push(error("missing_targets", `Task ${task.id} must include '- **Targets:** ...'`, task.line));
	}
	if (!tools?.[1]?.trim()) {
		errors.push(error("missing_tools", `Task ${task.id} must include '- **Tools / APIs:** ...'`, task.line));
	}
}

export function parsePlanDocument(markdown, options = {}) {
	const maxBytes = options.maxBytes ?? MAX_PLAN_BYTES;
	const errors = [];
	if (typeof markdown !== "string") {
		return { ok: false, errors: [error("invalid_input", "Plan must be a Markdown string")] };
	}
	if (Buffer.byteLength(markdown, "utf8") > maxBytes) {
		return { ok: false, errors: [error("plan_too_large", `Plan exceeds the ${maxBytes}-byte limit`)] };
	}
	const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
	if (!normalized) return { ok: false, errors: [error("empty_plan", "Plan cannot be empty")] };

	const lines = normalized.split("\n");
	const headings = scanHeadings(lines);
	const titleHeadings = headings.filter((heading) => heading.level === 1);
	if (titleHeadings.length !== 1 || titleHeadings[0].index !== 0 || !titleHeadings[0].text.trim()) {
		errors.push(error("invalid_title", "Plan must start with exactly one non-empty H1 title", titleHeadings[0]?.line));
	}

	const h2 = headings.filter((heading) => heading.level === 2);
	if (h2.length !== REQUIRED_H2.length || h2.some((heading, index) => heading.text !== REQUIRED_H2[index])) {
		errors.push(
			error(
				"invalid_section_order",
				`Required H2 sections, in order: ${REQUIRED_H2.join("; ")}`,
				h2.find((heading, index) => heading.text !== REQUIRED_H2[index])?.line,
			),
		);
	}
	const sectionByName = new Map(h2.map((heading) => [heading.text, heading]));
	for (const name of REQUIRED_H2) {
		if (!sectionByName.has(name)) errors.push(error("missing_section", `Missing section: ${name}`));
	}
	if (errors.some((item) => item.code === "invalid_section_order" || item.code === "missing_section")) {
		return { ok: false, errors };
	}

	const sectionContent = {};
	for (let index = 0; index < h2.length; index += 1) {
		const heading = h2[index];
		const end = h2[index + 1]?.index ?? lines.length;
		sectionContent[heading.text] = contentBetween(lines, heading.index + 1, end);
		if (!sectionContent[heading.text]) {
			errors.push(error("empty_section", `Section cannot be empty: ${heading.text}`, heading.line));
		}
	}

	const overviewHeading = sectionByName.get("Stages Overview");
	const stagesEnd = sectionByName.get("Conditional Logic and Edge Cases").index;
	const stageHeadings = headings.filter(
		(heading) => heading.level === 3 && heading.index > overviewHeading.index && heading.index < stagesEnd,
	);
	const overviewEnd = stageHeadings[0]?.index ?? stagesEnd;
	const overviewContent = contentBetween(lines, overviewHeading.index + 1, overviewEnd);
	const overview = parseOverview(overviewContent, overviewHeading.index + 2, errors);
	const unexpectedH3 = headings.filter(
		(heading) => heading.level === 3 && !stageHeadings.includes(heading),
	);
	for (const heading of unexpectedH3) {
		errors.push(error("unexpected_heading", `Unexpected H3 heading: ${heading.text}`, heading.line));
	}
	if (stageHeadings.length === 0) errors.push(error("no_stages", "Plan must contain at least one stage section"));

	const stages = [];
	const taskIds = new Set();
	for (let stageIndex = 0; stageIndex < stageHeadings.length; stageIndex += 1) {
		const heading = stageHeadings[stageIndex];
		const match = heading.text.match(/^Stage (\d+) — (.+)$/);
		if (!match) {
			errors.push(error("malformed_stage_heading", "Stage headings must use '### Stage N — Name'", heading.line));
			continue;
		}
		const [, id, name] = match;
		const expectedId = String(stageIndex + 1);
		if (id !== expectedId) {
			errors.push(error("stage_order", `Expected Stage ${expectedId}, found Stage ${id}`, heading.line));
		}
		const end = stageHeadings[stageIndex + 1]?.index ?? stagesEnd;
		const taskHeadings = headings.filter(
			(item) => item.level === 4 && item.index > heading.index && item.index < end,
		);
		const tasks = [];
		for (let taskIndex = 0; taskIndex < taskHeadings.length; taskIndex += 1) {
			const taskHeading = taskHeadings[taskIndex];
			const taskMatch = taskHeading.text.match(/^(\d+)\.(\d+) \[([^\]]+)\] (.+)$/);
			if (!taskMatch) {
				errors.push(error("malformed_task_heading", "Task headings must use '#### N.M [status] Title'", taskHeading.line));
				continue;
			}
			const [, taskStage, taskNumber, status, title] = taskMatch;
			const taskId = `${taskStage}.${taskNumber}`;
			if (taskStage !== id || Number(taskNumber) !== taskIndex + 1) {
				errors.push(error("task_order", `Expected task ${id}.${taskIndex + 1}, found ${taskId}`, taskHeading.line));
			}
			if (!STATUS_SET.has(status)) {
				errors.push(error("invalid_status", `Task ${taskId} has invalid status '${status}'`, taskHeading.line));
			}
			if (taskIds.has(taskId)) {
				errors.push(error("duplicate_task", `Duplicate task ID ${taskId}`, taskHeading.line));
			}
			taskIds.add(taskId);
			const taskEnd = taskHeadings[taskIndex + 1]?.index ?? end;
			const task = {
				id: taskId,
				stageId: id,
				status,
				title: title.trim(),
				body: contentBetween(lines, taskHeading.index + 1, taskEnd),
				line: taskHeading.line,
			};
			if (!task.body) errors.push(error("empty_task", `Task ${taskId} must have a body`, taskHeading.line));
			validateBodyMetadata(task, errors);
			tasks.push(task);
		}
		if (tasks.length === 0) errors.push(error("empty_stage", `Stage ${id} has no executable tasks`, heading.line));
		stages.push({ id, name: name.trim(), tasks });
	}

	const unexpectedH4 = headings.filter((heading) => {
		if (heading.level !== 4) return false;
		return !stageHeadings.some((stage, index) => {
			const end = stageHeadings[index + 1]?.index ?? stagesEnd;
			return heading.index > stage.index && heading.index < end;
		});
	});
	for (const heading of unexpectedH4) {
		errors.push(error("unexpected_heading", `Task heading is outside a stage: ${heading.text}`, heading.line));
	}

	if (overview.length !== stages.length) {
		errors.push(error("stage_mismatch", "Stages Overview and stage sections must contain the same stages"));
	}
	for (let index = 0; index < Math.min(overview.length, stages.length); index += 1) {
		if (overview[index].id !== stages[index].id || overview[index].name !== stages[index].name) {
			errors.push(error("stage_mismatch", `Overview row ${index + 1} does not match its stage section`));
		}
	}
	if (taskIds.size === 0) errors.push(error("no_tasks", "Plan must contain at least one executable task"));
	if (errors.length > 0) return { ok: false, errors };

	return {
		ok: true,
		document: {
			version: PLAN_DOCUMENT_VERSION,
			title: titleHeadings[0].text.trim(),
			objective: sectionContent["Objective / Goal Statement"],
			stages: stages.map((stage, index) => ({
				...stage,
				purpose: overview[index].purpose,
				tasks: stage.tasks.map(({ line: _line, ...task }) => task),
			})),
			conditionalLogic: sectionContent["Conditional Logic and Edge Cases"],
			parallelSubagents: sectionContent["Parallel Subagent Recommendations"],
			testingRequirements: sectionContent["Testing Requirements and Edge Cases"],
			stoppingCriteria: sectionContent["Stopping Criteria / Guardrails"],
		},
	};
}

export function renderPlanDocument(document) {
	const lines = [
		`# ${document.title.trim()}`,
		"",
		"## Objective / Goal Statement",
		"",
		document.objective.trim(),
		"",
		"## Stages Overview",
		"",
		"| Stage | Name | Purpose |",
		"|---|---|---|",
	];
	for (const stage of document.stages) {
		lines.push(`| ${stage.id} | ${escapeTableCell(stage.name)} | ${escapeTableCell(stage.purpose)} |`);
	}
	for (const stage of document.stages) {
		lines.push("", `### Stage ${stage.id} — ${stage.name}`);
		for (const task of stage.tasks) {
			lines.push("", `#### ${task.id} [${task.status}] ${task.title}`, "", task.body.trim());
		}
	}
	lines.push(
		"",
		"## Conditional Logic and Edge Cases",
		"",
		document.conditionalLogic.trim(),
		"",
		"## Parallel Subagent Recommendations",
		"",
		document.parallelSubagents.trim(),
		"",
		"## Testing Requirements and Edge Cases",
		"",
		document.testingRequirements.trim(),
		"",
		"## Stopping Criteria / Guardrails",
		"",
		document.stoppingCriteria.trim(),
		"",
	);
	return lines.join("\n");
}

export function validatePlanDocument(markdown, options) {
	const result = parsePlanDocument(markdown, options);
	return result.ok ? [] : result.errors;
}
