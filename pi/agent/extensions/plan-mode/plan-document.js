export const PLAN_DOCUMENT_VERSION = 3;
export const MAX_PLAN_BYTES = 256 * 1024;
export const PLAN_STATUSES = Object.freeze(["pending", "in_progress", "completed", "blocked"]);

const STATUS_SET = new Set(PLAN_STATUSES);
const VERSION_2_REQUIRED_H2 = ["Why", "What", "Stages"];
const VERSION_3_H2 = [
	"Background",
	"Changes",
	"Breaking Changes",
	"Testing Plan",
	"Assumptions / Decisions",
	"Stages",
];
const VERSION_3_REQUIRED_H2 = ["Background", "Changes"];
const LEGACY_REQUIRED_H2 = [
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

function unfencedLineRows(content, startLine = 1) {
	const rows = content.split("\n").map((line, offset) => ({ line, number: startLine + offset }));
	const result = [];
	let fence = null;
	for (const row of rows) {
		const fenceMatch = row.line.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence === null) result.push(row);
	}
	return result;
}

function unfencedTableBlocks(content, startLine) {
	const blocks = [];
	let current = [];
	for (const row of unfencedLineRows(content, startLine)) {
		if (row.line.trim().startsWith("|") && (current.length === 0 || row.number === current.at(-1).number + 1)) {
			current.push(row);
			continue;
		}
		if (current.length > 0) blocks.push(current);
		current = row.line.trim().startsWith("|") ? [row] : [];
	}
	if (current.length > 0) blocks.push(current);
	return blocks;
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

function escapeTableCell(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function validateBodyMetadata(task, errors) {
	const targets = task.body.match(/^- \*\*Targets:\*\*\s*(.+)$/m);
	const tools = task.body.match(/^- \*\*Tools \/ APIs:\*\*\s*(.+)$/m);
	if (!targets?.[1]?.trim()) {
		errors.push(error("missing_targets", `Step ${task.id} must include '- **Targets:** ...'`, task.line));
	}
	if (!tools?.[1]?.trim()) {
		errors.push(error("missing_tools", `Step ${task.id} must include '- **Tools / APIs:** ...'`, task.line));
	}
}

function validateTitle(headings, errors) {
	const titleHeadings = headings.filter((heading) => heading.level === 1);
	if (titleHeadings.length !== 1 || titleHeadings[0].index !== 0 || !titleHeadings[0].text.trim()) {
		errors.push(error("invalid_title", "Plan must start with exactly one non-empty H1 title", titleHeadings[0]?.line));
	}
	return titleHeadings[0];
}

function validateSectionOrder(h2, required, errors) {
	if (h2.length !== required.length || h2.some((heading, index) => heading.text !== required[index])) {
		errors.push(error(
			"invalid_section_order",
			`Required H2 sections, in order: ${required.join("; ")}`,
			h2.find((heading, index) => heading.text !== required[index])?.line,
		));
	}
	const sectionByName = new Map(h2.map((heading) => [heading.text, heading]));
	for (const name of required) {
		if (!sectionByName.has(name)) errors.push(error("missing_section", `Missing section: ${name}`));
	}
	return sectionByName;
}

function parseStagesTable(content, startLine, steps, errors) {
	const tableBlocks = unfencedTableBlocks(content, startLine);
	if (tableBlocks.length !== 1 || tableBlocks[0].length < 3) {
		errors.push(error("invalid_stages", "Stages must contain exactly one contiguous, unfenced Markdown table", startLine));
		return [];
	}
	const tableRows = tableBlocks[0];
	const header = splitTableRow(tableRows[0].line);
	if (!header || header.map((cell) => cell.toLowerCase()).join("|") !== "stage|description|steps") {
		errors.push(error("invalid_stages", "Stages table header must be Stage, Description, Steps", tableRows[0].number));
	}
	const separator = splitTableRow(tableRows[1].line);
	if (!separator || separator.length !== 3 || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
		errors.push(error("invalid_stages", "Stages table separator is malformed", tableRows[1].number));
	}

	const knownSteps = new Set(steps.map((step) => step.id));
	const assignedSteps = new Set();
	const stages = [];
	for (const [index, row] of tableRows.slice(2).entries()) {
		const cells = splitTableRow(row.line);
		if (!cells || cells.length !== 3 || !/^\d+$/.test(cells[0]) || !cells[1] || !cells[2]) {
			errors.push(error("invalid_stage_row", "Each stage row needs a numeric ID, description, and step list", row.number));
			continue;
		}
		const [id, description, rawSteps] = cells;
		if (id !== String(index + 1)) {
			errors.push(error("stage_order", `Expected Stage ${index + 1}, found Stage ${id}`, row.number));
		}
		const stepIds = rawSteps.split(",").map((value) => value.trim()).filter(Boolean);
		if (stepIds.length === 0 || stepIds.some((stepId) => !/^\d+$/.test(stepId))) {
			errors.push(error("invalid_stage_steps", `Stage ${id} must list numeric step IDs separated by commas`, row.number));
		}
		for (const stepId of stepIds) {
			if (!knownSteps.has(stepId)) errors.push(error("unknown_step", `Stage ${id} references unknown Step ${stepId}`, row.number));
			if (assignedSteps.has(stepId)) errors.push(error("duplicate_step_assignment", `Step ${stepId} belongs to more than one stage`, row.number));
			assignedSteps.add(stepId);
		}
		stages.push({ id, description, stepIds });
	}
	for (const step of steps) {
		if (!assignedSteps.has(step.id)) errors.push(error("unassigned_step", `Step ${step.id} is not assigned to a stage`, step.line));
	}
	return stages;
}

function parseVersion2Document(lines, headings, titleHeading, errors) {
	const h2 = headings.filter((heading) => heading.level === 2);
	const sectionByName = validateSectionOrder(h2, VERSION_2_REQUIRED_H2, errors);
	if (errors.some((item) => item.code === "invalid_section_order" || item.code === "missing_section")) {
		return { ok: false, errors };
	}

	const whyHeading = sectionByName.get("Why");
	const whatHeading = sectionByName.get("What");
	const stagesHeading = sectionByName.get("Stages");
	const why = contentBetween(lines, whyHeading.index + 1, whatHeading.index);
	if (!why) errors.push(error("empty_section", "Section cannot be empty: Why", whyHeading.line));

	const stepHeadings = headings.filter(
		(heading) => heading.level === 3 && heading.index > whatHeading.index && heading.index < stagesHeading.index,
	);
	const what = contentBetween(lines, whatHeading.index + 1, stepHeadings[0]?.index ?? stagesHeading.index);
	if (!what) errors.push(error("empty_section", "What must summarize the solution before its steps", whatHeading.line));
	if (stepHeadings.length === 0) errors.push(error("no_steps", "What must contain at least one executable step"));

	const unexpected = headings.filter((heading) => {
		if (heading.level === 4) return true;
		if (heading.level !== 3) return false;
		return !stepHeadings.includes(heading);
	});
	for (const heading of unexpected) {
		errors.push(error("unexpected_heading", `Unexpected heading: ${heading.text}`, heading.line));
	}

	const steps = [];
	const stepIds = new Set();
	for (const [index, heading] of stepHeadings.entries()) {
		const match = heading.text.match(/^Step (\d+) \[([^\]]+)\] (.+)$/);
		if (!match) {
			errors.push(error("malformed_step_heading", "Step headings must use '### Step N [status] Title'", heading.line));
			continue;
		}
		const [, id, status, title] = match;
		if (id !== String(index + 1)) errors.push(error("step_order", `Expected Step ${index + 1}, found Step ${id}`, heading.line));
		if (stepIds.has(id)) errors.push(error("duplicate_step", `Duplicate Step ${id}`, heading.line));
		stepIds.add(id);
		if (!STATUS_SET.has(status)) errors.push(error("invalid_status", `Step ${id} has invalid status '${status}'`, heading.line));
		const end = stepHeadings[index + 1]?.index ?? stagesHeading.index;
		const step = {
			id,
			status,
			title: title.trim(),
			body: contentBetween(lines, heading.index + 1, end),
			line: heading.line,
		};
		if (!step.body) errors.push(error("empty_step", `Step ${id} must have a body`, heading.line));
		validateBodyMetadata(step, errors);
		steps.push(step);
	}

	const stagesContent = contentBetween(lines, stagesHeading.index + 1, lines.length);
	const stages = parseStagesTable(stagesContent, stagesHeading.index + 2, steps, errors);
	if (stages.length === 0) errors.push(error("no_stages", "Plan must contain at least one stage"));
	if (errors.length > 0) return { ok: false, errors };

	const normalizedSteps = steps.map(({ line: _line, ...step }) => step);
	const stepById = new Map(normalizedSteps.map((step) => [step.id, step]));
	return {
		ok: true,
		document: {
			version: 2,
			title: titleHeading.text.trim(),
			why,
			what,
			steps: normalizedSteps,
			stages: stages.map((stage) => ({
				...stage,
				tasks: stage.stepIds.map((stepId) => stepById.get(stepId)),
			})),
		},
	};
}

function validateVersion3SectionOrder(h2, errors) {
	const sectionByName = new Map();
	let lastOrder = -1;
	for (const heading of h2) {
		const order = VERSION_3_H2.indexOf(heading.text);
		if (order < 0) {
			errors.push(error("invalid_section_order", `Unexpected H2 section: ${heading.text}`, heading.line));
			continue;
		}
		if (sectionByName.has(heading.text)) {
			errors.push(error("invalid_section_order", `Duplicate H2 section: ${heading.text}`, heading.line));
			continue;
		}
		if (order <= lastOrder) {
			errors.push(error(
				"invalid_section_order",
				`H2 sections must follow this order when present: ${VERSION_3_H2.join("; ")}`,
				heading.line,
			));
		}
		lastOrder = Math.max(lastOrder, order);
		sectionByName.set(heading.text, heading);
	}
	for (const name of VERSION_3_REQUIRED_H2) {
		if (!sectionByName.has(name)) errors.push(error("missing_section", `Missing section: ${name}`));
	}
	return sectionByName;
}

function parseVersion3Document(lines, headings, titleHeading, errors) {
	const h2 = headings.filter((heading) => heading.level === 2);
	const sectionByName = validateVersion3SectionOrder(h2, errors);
	if (errors.some((item) => item.code === "invalid_section_order" || item.code === "missing_section")) {
		return { ok: false, errors };
	}

	const sectionEnd = (heading) => h2.find((candidate) => candidate.index > heading.index)?.index ?? lines.length;
	const sectionContent = (name) => {
		const heading = sectionByName.get(name);
		return heading ? contentBetween(lines, heading.index + 1, sectionEnd(heading)) : undefined;
	};
	const backgroundHeading = sectionByName.get("Background");
	const changesHeading = sectionByName.get("Changes");
	const changesEnd = sectionEnd(changesHeading);
	const background = sectionContent("Background");
	if (!background) errors.push(error("empty_section", "Section cannot be empty: Background", backgroundHeading.line));

	const stepHeadings = headings.filter(
		(heading) => heading.level === 3 && heading.index > changesHeading.index && heading.index < changesEnd,
	);
	const changes = contentBetween(lines, changesHeading.index + 1, stepHeadings[0]?.index ?? changesEnd);
	if (!changes) errors.push(error("empty_section", "Changes must summarize the proposal before its steps", changesHeading.line));
	if (stepHeadings.length === 0) errors.push(error("no_steps", "Changes must contain at least one high-level step"));

	const unexpected = headings.filter((heading) => {
		if (heading.level === 4) return true;
		if (heading.level !== 3) return false;
		return !stepHeadings.includes(heading);
	});
	for (const heading of unexpected) errors.push(error("unexpected_heading", `Unexpected heading: ${heading.text}`, heading.line));

	const steps = [];
	const stepIds = new Set();
	for (const [index, heading] of stepHeadings.entries()) {
		const match = heading.text.match(/^Step (\d+) \[([^\]]+)\] (.+)$/);
		if (!match) {
			errors.push(error("malformed_step_heading", "Step headings must use '### Step N [status] Title'", heading.line));
			continue;
		}
		const [, id, status, title] = match;
		if (id !== String(index + 1)) errors.push(error("step_order", `Expected Step ${index + 1}, found Step ${id}`, heading.line));
		if (stepIds.has(id)) errors.push(error("duplicate_step", `Duplicate Step ${id}`, heading.line));
		stepIds.add(id);
		if (!STATUS_SET.has(status)) errors.push(error("invalid_status", `Step ${id} has invalid status '${status}'`, heading.line));
		const end = stepHeadings[index + 1]?.index ?? changesEnd;
		const step = {
			id,
			status,
			title: title.trim(),
			body: contentBetween(lines, heading.index + 1, end),
			line: heading.line,
		};
		if (!step.body) errors.push(error("empty_step", `Step ${id} must have a body`, heading.line));
		if (unfencedLineRows(step.body).some((row) => /^- \*\*(?:Targets|Tools \/ APIs):\*\*/.test(row.line))) {
			errors.push(error("disallowed_metadata", `Step ${id} must not list target files or tools/APIs`, heading.line));
		}
		steps.push(step);
	}

	const optionalContent = {};
	for (const [name, property] of [
		["Breaking Changes", "breakingChanges"],
		["Testing Plan", "testingPlan"],
		["Assumptions / Decisions", "assumptionsDecisions"],
	]) {
		if (!sectionByName.has(name)) continue;
		const value = sectionContent(name);
		if (!value) errors.push(error("empty_section", `Section cannot be empty: ${name}`, sectionByName.get(name).line));
		else optionalContent[property] = value;
	}

	const stagesHeading = sectionByName.get("Stages");
	const explicitStages = stagesHeading !== undefined;
	let stages;
	if (explicitStages) {
		const stagesContent = sectionContent("Stages");
		if (!stagesContent) errors.push(error("empty_section", "Section cannot be empty: Stages", stagesHeading.line));
		stages = parseStagesTable(stagesContent ?? "", stagesHeading.index + 2, steps, errors);
		if (stages.length === 0) errors.push(error("no_stages", "An explicit Stages section must contain at least one stage"));
	} else {
		stages = [{ id: "1", description: "Complete the planned changes.", stepIds: steps.map((step) => step.id) }];
	}
	if (errors.length > 0) return { ok: false, errors };

	const normalizedSteps = steps.map(({ line: _line, ...step }) => step);
	const stepById = new Map(normalizedSteps.map((step) => [step.id, step]));
	return {
		ok: true,
		document: {
			version: PLAN_DOCUMENT_VERSION,
			title: titleHeading.text.trim(),
			background,
			changes,
			...optionalContent,
			steps: normalizedSteps,
			explicitStages,
			stages: stages.map((stage) => ({
				...stage,
				tasks: stage.stepIds.map((stepId) => stepById.get(stepId)),
			})),
		},
	};
}

function parseLegacyOverview(content, startLine, errors) {
	const tableBlocks = unfencedTableBlocks(content, startLine);
	if (tableBlocks.length !== 1 || tableBlocks[0].length < 3) {
		errors.push(error("invalid_overview", "Stages Overview must contain exactly one contiguous, unfenced Markdown table", startLine));
		return [];
	}
	const tableRows = tableBlocks[0];
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

function parseLegacyDocument(lines, headings, titleHeading, errors) {
	const h2 = headings.filter((heading) => heading.level === 2);
	const sectionByName = validateSectionOrder(h2, LEGACY_REQUIRED_H2, errors);
	if (errors.some((item) => item.code === "invalid_section_order" || item.code === "missing_section")) {
		return { ok: false, errors };
	}

	const sectionContent = {};
	for (let index = 0; index < h2.length; index += 1) {
		const heading = h2[index];
		const end = h2[index + 1]?.index ?? lines.length;
		sectionContent[heading.text] = contentBetween(lines, heading.index + 1, end);
		if (!sectionContent[heading.text]) errors.push(error("empty_section", `Section cannot be empty: ${heading.text}`, heading.line));
	}

	const overviewHeading = sectionByName.get("Stages Overview");
	const stagesEnd = sectionByName.get("Conditional Logic and Edge Cases").index;
	const stageHeadings = headings.filter(
		(heading) => heading.level === 3 && heading.index > overviewHeading.index && heading.index < stagesEnd,
	);
	const overviewEnd = stageHeadings[0]?.index ?? stagesEnd;
	const overview = parseLegacyOverview(contentBetween(lines, overviewHeading.index + 1, overviewEnd), overviewHeading.index + 2, errors);
	for (const heading of headings.filter((item) => item.level === 3 && !stageHeadings.includes(item))) {
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
		if (id !== String(stageIndex + 1)) errors.push(error("stage_order", `Expected Stage ${stageIndex + 1}, found Stage ${id}`, heading.line));
		const end = stageHeadings[stageIndex + 1]?.index ?? stagesEnd;
		const taskHeadings = headings.filter((item) => item.level === 4 && item.index > heading.index && item.index < end);
		const tasks = [];
		for (let taskIndex = 0; taskIndex < taskHeadings.length; taskIndex += 1) {
			const taskHeading = taskHeadings[taskIndex];
			const taskMatch = taskHeading.text.match(/^(\d+)\.(\d+) \[([^\]]+)\] (.+)$/);
			if (!taskMatch) {
				errors.push(error("malformed_task_heading", "Task headings must use '#### N.M [status] Title'", taskHeading.line));
				continue;
			}
			const [, taskStage, taskNumber, status, taskTitle] = taskMatch;
			const taskId = `${taskStage}.${taskNumber}`;
			if (taskStage !== id || Number(taskNumber) !== taskIndex + 1) errors.push(error("task_order", `Expected task ${id}.${taskIndex + 1}, found ${taskId}`, taskHeading.line));
			if (!STATUS_SET.has(status)) errors.push(error("invalid_status", `Task ${taskId} has invalid status '${status}'`, taskHeading.line));
			if (taskIds.has(taskId)) errors.push(error("duplicate_task", `Duplicate task ID ${taskId}`, taskHeading.line));
			taskIds.add(taskId);
			const taskEnd = taskHeadings[taskIndex + 1]?.index ?? end;
			const task = { id: taskId, stageId: id, status, title: taskTitle.trim(), body: contentBetween(lines, taskHeading.index + 1, taskEnd), line: taskHeading.line };
			if (!task.body) errors.push(error("empty_task", `Task ${taskId} must have a body`, taskHeading.line));
			validateBodyMetadata(task, errors);
			tasks.push(task);
		}
		if (tasks.length === 0) errors.push(error("empty_stage", `Stage ${id} has no executable tasks`, heading.line));
		stages.push({ id, name: name.trim(), tasks });
	}

	if (overview.length !== stages.length) errors.push(error("stage_mismatch", "Stages Overview and stage sections must contain the same stages"));
	for (let index = 0; index < Math.min(overview.length, stages.length); index += 1) {
		if (overview[index].id !== stages[index].id || overview[index].name !== stages[index].name) errors.push(error("stage_mismatch", `Overview row ${index + 1} does not match its stage section`));
	}
	if (taskIds.size === 0) errors.push(error("no_tasks", "Plan must contain at least one executable task"));
	if (errors.length > 0) return { ok: false, errors };

	return {
		ok: true,
		document: {
			version: 1,
			title: titleHeading.text.trim(),
			objective: sectionContent["Objective / Goal Statement"],
			stages: stages.map((stage, index) => ({
				...stage,
				purpose: overview[index].purpose,
				description: overview[index].purpose,
				stepIds: stage.tasks.map((task) => task.id),
				tasks: stage.tasks.map(({ line: _line, ...task }) => task),
			})),
			conditionalLogic: sectionContent["Conditional Logic and Edge Cases"],
			parallelSubagents: sectionContent["Parallel Subagent Recommendations"],
			testingRequirements: sectionContent["Testing Requirements and Edge Cases"],
			stoppingCriteria: sectionContent["Stopping Criteria / Guardrails"],
		},
	};
}

export function parsePlanDocument(markdown, options = {}) {
	const maxBytes = options.maxBytes ?? MAX_PLAN_BYTES;
	if (typeof markdown !== "string") return { ok: false, errors: [error("invalid_input", "Plan must be a Markdown string")] };
	if (Buffer.byteLength(markdown, "utf8") > maxBytes) return { ok: false, errors: [error("plan_too_large", `Plan exceeds the ${maxBytes}-byte limit`)] };
	const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
	if (!normalized) return { ok: false, errors: [error("empty_plan", "Plan cannot be empty")] };

	const lines = normalized.split("\n");
	const headings = scanHeadings(lines);
	const errors = [];
	const titleHeading = validateTitle(headings, errors);
	if (!titleHeading) return { ok: false, errors };
	const h2Texts = headings.filter((heading) => heading.level === 2).map((heading) => heading.text);
	if (h2Texts.some((text) => LEGACY_REQUIRED_H2.includes(text))) {
		return parseLegacyDocument(lines, headings, titleHeading, errors);
	}
	if (h2Texts.includes("Why") || h2Texts.includes("What")) {
		return parseVersion2Document(lines, headings, titleHeading, errors);
	}
	return parseVersion3Document(lines, headings, titleHeading, errors);
}

function renderVersion2Document(document) {
	const lines = [
		`# ${document.title.trim()}`,
		"",
		"## Why",
		"",
		document.why.trim(),
		"",
		"## What",
		"",
		document.what.trim(),
	];
	for (const step of document.steps) {
		lines.push("", `### Step ${step.id} [${step.status}] ${step.title}`, "", step.body.trim());
	}
	lines.push("", "## Stages", "", "| Stage | Description | Steps |", "|---|---|---|");
	for (const stage of document.stages) {
		lines.push(`| ${stage.id} | ${escapeTableCell(stage.description)} | ${stage.stepIds.join(", ")} |`);
	}
	lines.push("");
	return lines.join("\n");
}

function renderVersion3Document(document) {
	const lines = [
		`# ${document.title.trim()}`,
		"",
		"## Background",
		"",
		document.background.trim(),
		"",
		"## Changes",
	];
	if (document.changes?.trim()) lines.push("", document.changes.trim());
	for (const step of document.steps) {
		lines.push("", `### Step ${step.id} [${step.status}] ${step.title}`, "", step.body.trim());
	}
	for (const [heading, property] of [
		["Breaking Changes", "breakingChanges"],
		["Testing Plan", "testingPlan"],
		["Assumptions / Decisions", "assumptionsDecisions"],
	]) {
		if (document[property]?.trim()) lines.push("", `## ${heading}`, "", document[property].trim());
	}
	if (document.explicitStages) {
		lines.push("", "## Stages", "", "| Stage | Description | Steps |", "|---|---|---|");
		for (const stage of document.stages) {
			lines.push(`| ${stage.id} | ${escapeTableCell(stage.description)} | ${stage.stepIds.join(", ")} |`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

function renderLegacyDocument(document) {
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
	for (const stage of document.stages) lines.push(`| ${stage.id} | ${escapeTableCell(stage.name)} | ${escapeTableCell(stage.purpose)} |`);
	for (const stage of document.stages) {
		lines.push("", `### Stage ${stage.id} — ${stage.name}`);
		for (const task of stage.tasks) lines.push("", `#### ${task.id} [${task.status}] ${task.title}`, "", task.body.trim());
	}
	lines.push(
		"", "## Conditional Logic and Edge Cases", "", document.conditionalLogic.trim(),
		"", "## Parallel Subagent Recommendations", "", document.parallelSubagents.trim(),
		"", "## Testing Requirements and Edge Cases", "", document.testingRequirements.trim(),
		"", "## Stopping Criteria / Guardrails", "", document.stoppingCriteria.trim(), "",
	);
	return lines.join("\n");
}

export function renderPlanDocument(document) {
	if (document.version === 1) return renderLegacyDocument(document);
	if (document.version === 2) return renderVersion2Document(document);
	return renderVersion3Document(document);
}

export function validatePlanDocument(markdown, options) {
	const result = parsePlanDocument(markdown, options);
	return result.ok ? [] : result.errors;
}
