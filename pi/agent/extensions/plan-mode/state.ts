export type WorkflowMode = "planning" | "normal";
export type WorkflowOutcome = "completed" | "blocked";

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";
export type ExecutionMode = "all" | "staged";
export type ExecutionStrategy = "standard" | "parallel";

export interface ParallelExecutionStageV1 {
	wave: number;
	workerId: string;
	sourcePartId: string;
	dependencies: string[];
	ownership: string;
}

export interface PlanStageV1 {
	id: string;
	description: string;
	taskIds: string[];
	parallelExecution?: ParallelExecutionStageV1;
}

export interface PlanTaskV1 { id: string; title: string; }

export interface PlanReferenceV1 {
	path: string;
	slug: string;
	hash: string;
	title: string;
	intent: string;
	revision: number;
	stageIds: string[];
	taskIds: string[];
	tasks: PlanTaskV1[];
	stages: PlanStageV1[];
	executionStrategy: ExecutionStrategy;
}

export interface ApprovalTokenV1 {
	nonce: string;
	planHash: string;
	revision: number;
	consumed: boolean;
	presented: boolean;
}

export interface FastOptimizationV1 {
	sourceHash: string;
	sourceRevision: number;
	sourceApproval: ApprovalTokenV1;
	sourcePartIds: string[];
}

export interface LedgerItemV1 { status: TaskStatus; note: string | null; evidence: string | null; }
export interface CompletedStageV1 { stageId: string; summary: string; changedFiles: string[]; tests: string[]; blockers: string[]; }
export interface TestEvidenceV1 { command: string; result: "passed" | "failed" | "not_run"; summary: string; }
export interface ParallelWorkerV1 { workerId: string; runId?: string; sessionId?: string; stageIds: string[]; summary?: string; }

export interface PlanModeExecutionV3 {
	mode: ExecutionMode;
	strategy: ExecutionStrategy;
	startedAt: string | null;
	parentSessionPath: string | null;
	runId: string | null;
	paused: boolean;
	/** True only while implementation is allowed to advance the ledger. */
	active: boolean;
}

export interface PlanModeStateV3 {
	version: 3;
	/** Planning gates tools; normal exposes implementation tools when execution is active. */
	mode: WorkflowMode;
	/** Terminal workflow result, independent of the interaction mode. */
	outcome: WorkflowOutcome | null;
	originalActiveTools: string[];
	plan: PlanReferenceV1 | null;
	/** A validated candidate's durable action nonce, independent of the mutation guard. */
	approval: ApprovalTokenV1 | null;
	optimization: FastOptimizationV1 | null;
	execution: PlanModeExecutionV3 | null;
	ledger: Record<string, LedgerItemV1>;
	currentStageId: string | null;
	checkpoint: { nonce: string; stageId: string; consumed: boolean; presented: boolean } | null;
	completedStages: CompletedStageV1[];
	testEvidence: TestEvidenceV1[];
	parallelWorkers: ParallelWorkerV1[];
	counters: { invalidSubmissions: number; reviewRounds: number; recoveryAttempts: number; };
	blockedReason: string | null;
	lastAction: string | null;
}

export type PlanModeState = PlanModeStateV3;
export interface TransitionError { code: string; message: string; }
export type TransitionResult = { ok: true; state: PlanModeState } | { ok: false; state: PlanModeState; error: TransitionError };

export interface PlanSubmission {
	path: string; slug: string; hash: string; title: string; intent: string; approvalNonce: string;
	executionStrategy?: ExecutionStrategy;
	stages: Array<{ id: string; description: string; taskIds: string[]; parallelExecution?: ParallelExecutionStageV1 }>;
	tasks: Array<{ id: string; title: string; status: TaskStatus; note?: string | null; evidence?: string | null }>;
}

export {
	LEGAL_MODE_TRANSITIONS, PLAN_MODE_STATE_ENTRY, PLAN_MODE_STATE_VERSION, TASK_STATUSES, WORKFLOW_MODES,
	acceptFastOptimization, approveExecution, beginFastOptimization, blockWorkflow, completeWorkflow,
	createInitialState, enterPlanning, exitPlanning, getNextNonterminalStageId, getStageTaskIds, hasDurableFeedbackPending,
	hasPendingApproval, isActiveExecution, isPlanModeState, isPlanning, isStagedExecution, migrateState,
	recordInvalidSubmission, recordStageCheckpoint, recordTaskProgress, requestRevision,
	resetInvalidSubmissions, resolveStageCheckpoint, resumeExecution, restoreFastOptimization,
	restoreLatestState, showPlan,
} from "./state.js";
