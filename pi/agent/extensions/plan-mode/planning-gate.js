import { analyzeBashMutation } from "./bash-policy.js";

export const WORKFLOW_TOOLS = new Set(["submit_plan", "plan_progress", "complete_plan", "complete_stage"]);
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

export function getPlanningToolNames(allToolNames) {
	const available = new Set(allToolNames);
	return [...INSPECTION_TOOLS, "submit_plan"].filter((name) => available.has(name));
}

export function getRestorableTools(snapshot, allToolNames) {
	const available = new Set(allToolNames);
	return {
		restored: snapshot.filter((name) => available.has(name)),
		missing: snapshot.filter((name) => !available.has(name)),
	};
}

export function evaluatePlanningToolCall(toolName, input, allToolNames) {
	if (DIRECT_MUTATION_TOOLS.has(toolName)) return `Planning mode blocks direct mutation tool '${toolName}'.`;
	const allowed = new Set(getPlanningToolNames(allToolNames));
	if (!allowed.has(toolName)) return `Planning mode blocks tool '${toolName}'.`;
	if (toolName === "bash") {
		const analysis = analyzeBashMutation(input?.command);
		if (analysis.blocked) {
			return `Planning mode blocked a known-mutating Bash command (${analysis.reason}: ${analysis.detail}). Unknown commands remain fail-open by design.`;
		}
	}
	return null;
}
