import { createHash } from "node:crypto";
import { parsePlanDocument } from "./plan-document.js";

export const EXECUTION_ENTRY = "plan-mode-execution";
export const EXECUTION_BOUNDARY_MESSAGE = "plan-mode-execution-boundary";

export function isInPlaceExecutionContract(value) {
	return value?.handoff === "in_place" && typeof value.runId === "string" && value.runId.length > 0 &&
		typeof value.planPath === "string" && typeof value.planHash === "string" &&
		typeof value.boundaryHash === "string" && value.boundaryHash.length > 0;
}

export function restoreExecutionContract(branch, state) {
	const activeRunId = state?.execution?.runId;
	if (!activeRunId) return null;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== EXECUTION_ENTRY) continue;
		const contract = entry.data;
		if (isInPlaceExecutionContract(contract) && contract.runId === activeRunId &&
			contract.planPath === state?.plan?.path && contract.planHash === state?.plan?.hash) return contract;
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

function isTerminal(status) {
	return status === "completed" || status === "blocked";
}

export function getActiveParallelWave(state) {
	const scheduledStages = (state?.plan?.stages ?? [])
		.filter((stage) => stage.parallelExecution)
		.sort((left, right) => left.parallelExecution.wave - right.parallelExecution.wave);
	for (const stage of scheduledStages) {
		if (stage.taskIds.some((id) => !isTerminal(state.ledger?.[id]?.status))) {
			const wave = stage.parallelExecution.wave;
			return scheduledStages.filter((candidate) => candidate.parallelExecution.wave === wave);
		}
	}
	return [];
}

export function buildParallelWorkerPrompt(contract, state, stage) {
	const schedule = stage.parallelExecution;
	const parsed = parsePlanDocument(contract.approvedMarkdown);
	const part = parsed.ok ? parsed.document.parts?.find((candidate) => candidate.id === stage.id) : undefined;
	const predecessorSummaries = schedule.dependencies.map((id) => {
		const item = state.ledger?.[id];
		return `- Part ${id}: ${item?.status ?? "unknown"}${item?.evidence ? ` — ${item.evidence}` : item?.note ? ` — ${item.note}` : ""}`;
	});
	return `[PARALLEL PLAN WORKER]
Own only optimized Part ${stage.id} (${part?.title ?? stage.description}). Your exclusive mutation boundary is: ${schedule.ownership}.
Source Part: ${schedule.sourcePartId}. Do not modify unrelated boundaries, do not start another Part, and do not update the parent ledger or call parent workflow tools.

Relevant approved context:
${parsed.ok ? parsed.document.context : "Read the approved plan at the supplied path for context."}

Your Part requirements and acceptance outcomes:
${part?.body ?? "Read the assigned Part in the approved plan."}

Predecessor summaries:
${predecessorSummaries.length ? predecessorSummaries.join("\n") : "- None; this is a first-wave Part."}

Implement and verify only this Part. Return a concise report with changed files, tests, acceptance evidence, blockers, and any integration risk for the parent coordinator.`;
}

function buildParallelCoordinatorInstructions(contract, state) {
	const wave = getActiveParallelWave(state);
	if (wave.length === 0) return "All scheduled waves are terminal. Reconcile the reports, run final regression checks, then call complete_plan.";
	const waveId = wave[0].parallelExecution.wave;
	const workers = wave.map((stage) => `${stage.id} → ${stage.parallelExecution.workerId} (${stage.parallelExecution.ownership})`).join("; ");
	const model = contract.workerModel ?? "the persisted inference model";
	const thinkingLevel = contract.workerThinkingLevel ?? "high";
	return `Parallel strategy is active. The current ready wave is ${waveId}: ${workers}.
1. Before implementation, call plan_progress to move every pending Part in this wave to in_progress. Do not begin a later wave.
2. On the next model turn, issue one subagent call for every Part in this wave in one sibling tool batch. Each call must use model: ${model} and thinkingLevel: "${thinkingLevel}". Its prompt must be built from the assigned Part, exclusive ownership boundary, approved context, acceptance outcomes, and predecessor summaries. Use buildParallelWorkerPrompt's required content below as the contract.
3. Wait for every sibling result. Reconcile reports and shared integration points yourself. Record each Part's terminal evidence through parent-owned plan_progress. A failed child may be retried without advancing this wave.
4. Only after all wave ${waveId} Parts are terminal may you begin the next wave. Pass predecessor summaries from terminal ledger evidence to later workers. Run final regression checks before complete_plan.

Worker prompt template requirements:
${wave.map((stage) => buildParallelWorkerPrompt(contract, state, stage)).join("\n\n---\n\n")}`;
}

export function buildExecutionKickoff(contract, state) {
	const staged = contract.executionMode === "staged";
	const parallel = contract.executionStrategy === "parallel" || state?.execution?.strategy === "parallel";
	const handoffDescription = "Implementation continues in the current visible session. Earlier planning messages are excluded from model context but remain visible to the user. The complete approved plan below is the execution contract.";
	return `[APPROVED PLAN EXECUTION]
${handoffDescription}

Execution rules:
- Read the saved plan before acting and execute its Parts in the derived execution order, except that an active parallel schedule controls dependency-wave order.
- Before work on each plan item, call plan_progress with its stable ID to move it pending → in_progress.
- After work, call plan_progress with completed evidence, or blocked with a reason and evidence.
- The parent implementation agent is the only plan-ledger writer. Parallel workers report results; they never edit the plan ledger.
- Use parallel subagents only where the plan explicitly says work is safe, only if subagent was in the restored tool snapshot, and preserve worker IDs for dependent later work.
- Run the specified tests. Do not claim completion without ledger evidence.
${parallel
	? `- ${buildParallelCoordinatorInstructions(contract, state)}`
	: staged
		? `- Execute only execution stage ${state.currentStageId}. Every execution stage corresponds to exactly one Part. Call complete_stage when its plan item is completed or blocked, then stop for the mandatory user checkpoint.`
		: "- Continue across ordinary stage boundaries. Call complete_plan only when every plan item is terminal and any applicable verification has evidence."}

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
		message.details?.runId !== contract.runId ||
		message.details?.planHash !== contract.planHash || message.details?.boundaryHash !== contract.boundaryHash ||
		typeof message.content !== "string"
	) return false;
	return hashExecutionBoundary(message.content) === contract.boundaryHash;
}

export function isolateExecutionMessages(messages, contract, state) {
	const boundaryIndex = messages.findIndex((message) => isMatchingBoundary(message, contract));
	if (boundaryIndex >= 0) return messages.slice(boundaryIndex);
	const compactionSummaryIndex = messages.findLastIndex((message) => message?.role === "compactionSummary");
	if (compactionSummaryIndex >= 0) return [buildExecutionBoundaryMessage(contract, state), ...messages.slice(compactionSummaryIndex + 1)];
	return [buildExecutionBoundaryMessage(contract, state)];
}

export function buildStageInstruction(state) {
	const workers = (state.parallelWorkers ?? []).map((worker) =>
		`${worker.workerId}${worker.runId ? ` run=${worker.runId}` : ""}${worker.sessionId ? ` session=${worker.sessionId}` : ""}`,
	).join(", ");
	return `[STAGED EXECUTION CONTINUE]
Execute only execution stage ${state.currentStageId}; every execution stage corresponds to exactly one Part. Re-read the saved plan and current ledger. Update every plan item through plan_progress, run the stage checks, then call complete_stage. Do not begin a later stage before the user checkpoint.${workers ? `\nReusable parallel workers: ${workers}. Resume an existing worker for dependent follow-up; create a fresh worker only for explicitly independent work.` : ""}`;
}
