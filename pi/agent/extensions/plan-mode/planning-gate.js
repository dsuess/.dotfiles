import { analyzeBashMutation } from "./bash-policy.js";

export const PRESENTATION_TOOLS = Object.freeze(["show_plan"]);
export const EXECUTION_TOOLS = Object.freeze(["plan_progress", "complete_plan", "complete_stage"]);
export const WORKFLOW_TOOLS = new Set([...PRESENTATION_TOOLS, ...EXECUTION_TOOLS]);
export const INSPECTION_TOOLS = Object.freeze([
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"ketch_search",
	"ketch_scrape",
	"ketch_code",
	"ketch_docs",
	"ketch_crawl",
	"ask_user_question",
]);
export const DIRECT_MUTATION_TOOLS = new Set([
	"write",
	"edit",
	"apply_patch",
	"patch",
	"notebook_edit",
	"create_file",
	"delete_file",
	"move_file",
]);

export function snapshotActiveTools(activeTools) {
	return activeTools.filter((name) => !WORKFLOW_TOOLS.has(name));
}

export function getPlanningToolNames(allToolNames, options = {}) {
	const available = new Set(allToolNames);
	const inspectionTools = options.fastOptimization === true
		? INSPECTION_TOOLS.filter((name) => name !== "ask_user_question")
		: INSPECTION_TOOLS;
	return [...inspectionTools, "show_plan"].filter((name) => available.has(name));
}

export function getRestorableTools(snapshot, allToolNames) {
	const available = new Set(allToolNames);
	const baseline = snapshotActiveTools(snapshot);
	return {
		restored: baseline.filter((name) => available.has(name)),
		missing: baseline.filter((name) => !available.has(name)),
	};
}

export function composeActiveTools(snapshot, workflowTools, allToolNames) {
	const available = new Set(allToolNames);
	const { restored, missing } = getRestorableTools(snapshot, allToolNames);
	const active = [...restored];
	for (const name of workflowTools) {
		if (available.has(name) && !active.includes(name)) active.push(name);
	}
	return { active, missing };
}

export function evaluatePlanningToolCall(toolName, input, allToolNames, options = {}) {
	if (DIRECT_MUTATION_TOOLS.has(toolName)) return `Planning mode blocks direct mutation tool '${toolName}'.`;
	const allowed = new Set(getPlanningToolNames(allToolNames, options));
	if (!allowed.has(toolName)) return `Planning mode blocks tool '${toolName}'.`;
	if (toolName === "bash") {
		const analysis = analyzeBashMutation(input?.command);
		if (analysis.blocked) {
			return `Planning mode blocked a known-mutating Bash command (${analysis.reason}: ${analysis.detail}). Unknown commands remain fail-open by design.`;
		}
	}
	return null;
}
