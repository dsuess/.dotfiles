import { createHash } from "node:crypto";

export const EXECUTION_ENTRY = "plan-mode-execution";
export const EXECUTION_BOUNDARY_MESSAGE = "plan-mode-execution-boundary";

export function isInPlaceExecutionContract(value) {
	return value?.version === 2 && value.handoff === "in_place" &&
		typeof value.runId === "string" && value.runId.length > 0;
}

function isLegacyExecutionContract(value) {
	return value?.version === 1 && typeof value.approvedMarkdown === "string" && typeof value.planPath === "string";
}

export function restoreExecutionContract(branch, state) {
	const activeRunId = state?.execution?.runId;
	const restoringLegacyExecution = state !== undefined && state.execution !== null && !activeRunId;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== EXECUTION_ENTRY) continue;
		const contract = entry.data;
		if (activeRunId) {
			if (
				isInPlaceExecutionContract(contract) && typeof contract.boundaryHash === "string" && contract.boundaryHash.length > 0 &&
				contract.runId === activeRunId && contract.planPath === state?.plan?.path && contract.planHash === state?.plan?.hash
			) return contract;
			continue;
		}
		if (
			isLegacyExecutionContract(contract) &&
			(state === undefined || (restoringLegacyExecution && contract.planPath === state?.plan?.path && contract.planHash === state?.plan?.hash))
		) return contract;
		if (state === undefined && isInPlaceExecutionContract(contract) && typeof contract.boundaryHash === "string" && contract.boundaryHash.length > 0) return contract;
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
	const handoffDescription = isInPlaceExecutionContract(contract)
		? "Implementation continues in the current visible session. Earlier planning messages are excluded from model context but remain visible to the user. The complete approved plan below is the execution contract."
		: "This is a fresh implementation session. No planning conversation was copied here. The complete approved plan is below and is the execution contract.";
	return `[APPROVED PLAN EXECUTION]
${handoffDescription}

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

export function hashExecutionBoundary(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

export function buildExecutionBoundaryMessage(contract, state) {
	const content = buildExecutionKickoff(contract, state);
	return {
		role: "custom",
		customType: EXECUTION_BOUNDARY_MESSAGE,
		content,
		display: false,
		details: {
			version: 1,
			contractVersion: contract.version,
			runId: contract.runId,
			planHash: contract.planHash,
			boundaryHash: contract.boundaryHash,
		},
		timestamp: Date.now(),
	};
}

function isMatchingBoundary(message, contract) {
	if (
		message?.role !== "custom" || message.customType !== EXECUTION_BOUNDARY_MESSAGE ||
		message.details?.contractVersion !== 2 || message.details?.runId !== contract.runId ||
		message.details?.planHash !== contract.planHash || message.details?.boundaryHash !== contract.boundaryHash ||
		typeof message.content !== "string"
	) return false;
	return hashExecutionBoundary(message.content) === contract.boundaryHash;
}

export function isolateExecutionMessages(messages, contract, state) {
	if (!isInPlaceExecutionContract(contract)) return messages;
	const boundaryIndex = messages.findIndex((message) => isMatchingBoundary(message, contract));
	if (boundaryIndex >= 0) return messages.slice(boundaryIndex);
	return [buildExecutionBoundaryMessage(contract, state)];
}

export function buildStageInstruction(state) {
	const workers = (state.parallelWorkers ?? []).map((worker) =>
		`${worker.workerId}${worker.runId ? ` run=${worker.runId}` : ""}${worker.sessionId ? ` session=${worker.sessionId}` : ""}`,
	).join(", ");
	return `[STAGED EXECUTION CONTINUE]
Execute only Stage ${state.currentStageId}. Re-read the saved plan and current ledger. Update every task through plan_progress, run the stage tests, then call complete_stage. Do not begin a later stage before the user checkpoint.${workers ? `\nReusable parallel workers: ${workers}. Resume an existing worker for dependent follow-up; create a fresh worker only for explicitly independent work.` : ""}`;
}
