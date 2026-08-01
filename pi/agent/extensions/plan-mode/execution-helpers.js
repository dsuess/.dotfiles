export const EXECUTION_ENTRY = "plan-mode-execution";

export function restoreExecutionContract(branch) {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type === "custom" && entry.customType === EXECUTION_ENTRY && entry.data?.version === 1) return entry.data;
	}
	return null;
}

export function getExecutionToolNames(state, allToolNames) {
	const available = new Set(allToolNames);
	const missing = state.originalActiveTools.filter((name) => !available.has(name));
	const active = state.originalActiveTools.filter((name) => available.has(name));
	for (const name of ["plan_progress", state.mode === "executing_staged" ? "complete_stage" : "complete_plan"]) {
		if (available.has(name) && !active.includes(name)) active.push(name);
	}
	if (state.mode === "executing_staged" && state.currentStageId === null && available.has("complete_plan") && !active.includes("complete_plan")) active.push("complete_plan");
	return { active, missing };
}

export function buildExecutionKickoff(contract, state) {
	const staged = contract.executionMode === "staged";
	return `[APPROVED PLAN EXECUTION]
This is a fresh implementation session. No planning conversation was copied here. The complete approved plan is below and is the execution contract.

Execution rules:
- Read the saved plan before acting and execute dependencies in stage order.
- Before work on each task, call plan_progress to move it pending → in_progress.
- After work, call plan_progress with completed evidence, or blocked with a reason and evidence.
- The parent implementation agent is the only plan-ledger writer. Parallel workers report results; they never edit the plan ledger.
- Use parallel subagents only where the plan explicitly says work is safe, only if subagent was in the restored tool snapshot, and preserve worker IDs for dependent later work.
- Run the specified tests. Do not claim completion without ledger evidence.
${staged
	? `- Execute only Stage ${state.currentStageId}. Call complete_stage when every task in that stage is completed or blocked, then stop for the mandatory user checkpoint.`
	: "- Continue across ordinary stage boundaries. Call complete_plan only when every task is terminal and required tests have evidence."}

Saved plan: ${contract.planPath}

${contract.approvedMarkdown}`;
}

export function buildStageInstruction(state) {
	const workers = (state.parallelWorkers ?? []).map((worker) =>
		`${worker.workerId}${worker.runId ? ` run=${worker.runId}` : ""}${worker.sessionId ? ` session=${worker.sessionId}` : ""}`,
	).join(", ");
	return `[STAGED EXECUTION CONTINUE]
Execute only Stage ${state.currentStageId}. Re-read the saved plan and current ledger. Update every task through plan_progress, run the stage tests, then call complete_stage. Do not begin a later stage before the user checkpoint.${workers ? `\nReusable parallel workers: ${workers}. Resume an existing worker for dependent follow-up; create a fresh worker only for explicitly independent work.` : ""}`;
}
