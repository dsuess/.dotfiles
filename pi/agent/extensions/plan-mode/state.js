export const PLAN_MODE_STATE_VERSION = 1;
export const PLAN_MODE_STATE_ENTRY = "plan-mode-state";

export const WORKFLOW_MODES = Object.freeze([
	"off",
	"planning",
	"approval",
	"executing_all",
	"executing_staged",
	"completed",
	"blocked",
]);

export const TASK_STATUSES = Object.freeze(["pending", "in_progress", "completed", "blocked"]);

export const LEGAL_MODE_TRANSITIONS = Object.freeze({
	off: Object.freeze(["planning"]),
	planning: Object.freeze(["off", "approval", "blocked"]),
	approval: Object.freeze(["off", "planning", "executing_all", "executing_staged", "blocked"]),
	executing_all: Object.freeze(["completed", "blocked"]),
	executing_staged: Object.freeze(["completed", "blocked"]),
	completed: Object.freeze(["planning"]),
	blocked: Object.freeze(["planning"]),
});

const MODE_SET = new Set(WORKFLOW_MODES);
const STATUS_SET = new Set(TASK_STATUSES);

function clone(value) {
	return structuredClone(value);
}

export function createInitialState() {
	return {
		version: PLAN_MODE_STATE_VERSION,
		mode: "off",
		originalActiveTools: [],
		plan: null,
		approval: null,
		execution: null,
		ledger: {},
		currentStageId: null,
		checkpoint: null,
		completedStages: [],
		testEvidence: [],
		parallelWorkers: [],
		counters: {
			invalidSubmissions: 0,
			reviewRounds: 0,
			recoveryAttempts: 0,
		},
		blockedReason: null,
		lastAction: null,
	};
}

function success(state) {
	return { ok: true, state };
}

function rejection(state, code, message) {
	return { ok: false, state, error: { code, message } };
}

function apply(state, action, mutate) {
	const next = clone(state);
	mutate(next);
	next.lastAction = action;
	return success(next);
}

function requireMode(state, allowed, action) {
	if (allowed.includes(state.mode)) return null;
	return rejection(
		state,
		"invalid_transition",
		`${action} is not allowed while workflow mode is ${state.mode}`,
	);
}

function requireApproval(state, nonce, action) {
	const invalidMode = requireMode(state, ["approval"], action);
	if (invalidMode) return invalidMode;
	if (!state.approval || state.approval.consumed) {
		return rejection(state, "approval_consumed", "The approval action has already been consumed");
	}
	if (typeof nonce !== "string" || nonce !== state.approval.nonce) {
		return rejection(state, "stale_approval", "The approval token is stale or does not match the active plan");
	}
	if (!state.plan || state.approval.planHash !== state.plan.hash || state.approval.revision !== state.plan.revision) {
		return rejection(state, "stale_approval", "The approval token belongs to an older plan revision");
	}
	return null;
}

export function enterPlanning(state, activeTools) {
	const invalidMode = requireMode(state, ["off", "completed", "blocked"], "enterPlanning");
	if (invalidMode) return invalidMode;
	if (!Array.isArray(activeTools) || activeTools.some((name) => typeof name !== "string" || !name)) {
		return rejection(state, "invalid_tools", "activeTools must be an array of non-empty tool names");
	}
	return apply(state, "enter_planning", (next) => {
		next.mode = "planning";
		next.originalActiveTools = [...activeTools];
		// A new planning run does not reuse the prior active plan reference. The
		// saved Markdown remains on disk, while revision loops enter planning via
		// requestRevision() and therefore retain their current plan metadata.
		next.plan = null;
		next.approval = null;
		next.execution = null;
		next.ledger = {};
		next.currentStageId = null;
		next.checkpoint = null;
		next.completedStages = [];
		next.testEvidence = [];
		next.parallelWorkers = [];
		next.counters = { invalidSubmissions: 0, reviewRounds: 0, recoveryAttempts: 0 };
		next.blockedReason = null;
	});
}

export function exitPlanning(state) {
	const invalidMode = requireMode(state, ["planning", "approval"], "exitPlanning");
	if (invalidMode) return invalidMode;
	return apply(state, "exit_planning", (next) => {
		next.mode = "off";
		next.approval = null;
		next.execution = null;
		next.currentStageId = null;
		next.checkpoint = null;
		next.blockedReason = null;
	});
}

export function recordInvalidSubmission(state) {
	const invalidMode = requireMode(state, ["planning"], "recordInvalidSubmission");
	if (invalidMode) return invalidMode;
	return apply(state, "invalid_submission", (next) => {
		next.counters.invalidSubmissions += 1;
	});
}

export function resetInvalidSubmissions(state) {
	const invalidMode = requireMode(state, ["planning"], "resetInvalidSubmissions");
	if (invalidMode) return invalidMode;
	if (state.counters.invalidSubmissions === 0) return success(state);
	return apply(state, "user_resumed_planning", (next) => {
		next.counters.invalidSubmissions = 0;
	});
}

export function submitPlan(state, submission) {
	const invalidMode = requireMode(state, ["planning"], "submitPlan");
	if (invalidMode) return invalidMode;
	const requiredStrings = ["path", "slug", "hash", "title", "intent", "approvalNonce"];
	for (const key of requiredStrings) {
		if (typeof submission?.[key] !== "string" || !submission[key].trim()) {
			return rejection(state, "invalid_plan_metadata", `${key} must be a non-empty string`);
		}
	}
	if (!Array.isArray(submission.stages) || submission.stages.length === 0) {
		return rejection(state, "invalid_plan_metadata", "stages must contain at least one stage");
	}
	if (!Array.isArray(submission.tasks) || submission.tasks.length === 0) {
		return rejection(state, "invalid_plan_metadata", "tasks must contain at least one task");
	}
	const taskIds = new Set();
	const tasks = [];
	const ledger = {};
	for (const task of submission.tasks) {
		if (
			!task || typeof task.id !== "string" || !task.id || taskIds.has(task.id) ||
			typeof task.title !== "string" || !task.title.trim() || !STATUS_SET.has(task.status)
		) {
			return rejection(state, "invalid_plan_metadata", "tasks must have unique IDs, non-empty titles, and valid statuses");
		}
		taskIds.add(task.id);
		tasks.push({ id: task.id, title: task.title.trim() });
		ledger[task.id] = { status: task.status, note: null, evidence: null };
	}
	const stageIds = new Set();
	const assignedTaskIds = new Set();
	const stages = [];
	for (const stage of submission.stages) {
		if (!stage || typeof stage.id !== "string" || !stage.id || stageIds.has(stage.id)) {
			return rejection(state, "invalid_plan_metadata", "stages must have unique, non-empty IDs");
		}
		stageIds.add(stage.id);
		const description = typeof stage.description === "string" && stage.description.trim()
			? stage.description.trim()
			: `Stage ${stage.id}`;
		const mappedTaskIds = Array.isArray(stage.taskIds)
			? [...stage.taskIds]
			: [...taskIds].filter((taskId) => taskId.startsWith(`${stage.id}.`));
		if (mappedTaskIds.length === 0) {
			return rejection(state, "invalid_plan_metadata", `Stage ${stage.id} must contain at least one task`);
		}
		for (const taskId of mappedTaskIds) {
			if (!taskIds.has(taskId) || assignedTaskIds.has(taskId)) {
				return rejection(state, "invalid_plan_metadata", "Every task must belong to exactly one valid stage");
			}
			assignedTaskIds.add(taskId);
		}
		stages.push({ id: stage.id, description, taskIds: mappedTaskIds });
	}
	if (assignedTaskIds.size !== taskIds.size) {
		return rejection(state, "invalid_plan_metadata", "Every task must belong to exactly one stage");
	}
	const priorRevision = state.plan?.path === submission.path ? state.plan.revision : 0;
	const revision = priorRevision + 1;
	return apply(state, "submit_plan", (next) => {
		next.mode = "approval";
		next.plan = {
			path: submission.path,
			slug: submission.slug,
			hash: submission.hash,
			title: submission.title,
			intent: submission.intent,
			revision,
			stageIds: [...stageIds],
			taskIds: [...taskIds],
			tasks,
			stages,
		};
		next.approval = {
			nonce: submission.approvalNonce,
			planHash: submission.hash,
			revision,
			consumed: false,
			presented: false,
		};
		next.execution = null;
		next.ledger = ledger;
		next.currentStageId = null;
		next.checkpoint = null;
		next.completedStages = [];
		next.testEvidence = [];
		next.parallelWorkers = [];
		next.counters.invalidSubmissions = 0;
		next.blockedReason = null;
	});
}

export function requestRevision(state, nonce, source = "change") {
	const approvalError = requireApproval(state, nonce, "requestRevision");
	if (approvalError) return approvalError;
	if (source !== "change" && source !== "review") {
		return rejection(state, "invalid_revision_source", "Revision source must be change or review");
	}
	return apply(state, `request_${source}`, (next) => {
		next.mode = "planning";
		next.approval.consumed = true;
		next.approval = null;
		next.counters.reviewRounds += 1;
	});
}

export function approveExecution(state, nonce, executionMode) {
	const approvalError = requireApproval(state, nonce, "approveExecution");
	if (approvalError) return approvalError;
	if (executionMode !== "all" && executionMode !== "staged") {
		return rejection(state, "invalid_execution_mode", "Execution mode must be all or staged");
	}
	return apply(state, `approve_${executionMode}`, (next) => {
		next.mode = executionMode === "all" ? "executing_all" : "executing_staged";
		next.approval.consumed = true;
		next.execution = {
			mode: executionMode,
			startedAt: null,
			parentSessionPath: null,
			runId: null,
			paused: false,
		};
		next.currentStageId = next.plan.stageIds[0] ?? null;
		next.checkpoint = null;
		next.blockedReason = null;
	});
}

export function getStageTaskIds(state, stageId) {
	const stage = state.plan?.stages?.find((item) => item.id === stageId);
	if (stage && Array.isArray(stage.taskIds)) return [...stage.taskIds];
	return (state.plan?.taskIds ?? []).filter((taskId) => taskId.startsWith(`${stageId}.`));
}

export function recordTaskProgress(state, update) {
	const invalidMode = requireMode(state, ["executing_all", "executing_staged"], "recordTaskProgress");
	if (invalidMode) return invalidMode;
	const current = state.ledger[update?.taskId];
	if (!current) return rejection(state, "unknown_task", `Unknown plan task: ${update?.taskId ?? ""}`);
	if (!STATUS_SET.has(update?.status)) return rejection(state, "invalid_status", "Task status is invalid");
	if (state.mode === "executing_staged" && !getStageTaskIds(state, state.currentStageId).includes(update.taskId)) {
		return rejection(state, "future_stage", `Task ${update.taskId} is outside current stage ${state.currentStageId}`);
	}
	const allowed = {
		pending: ["in_progress"],
		in_progress: ["completed", "blocked"],
		blocked: ["in_progress"],
		completed: ["in_progress"],
	};
	if (!allowed[current.status].includes(update.status)) {
		return rejection(state, "invalid_task_transition", `${current.status} → ${update.status} is not allowed for ${update.taskId}`);
	}
	if (["completed", "blocked"].includes(update.status) && (typeof update.evidence !== "string" || !update.evidence.trim())) {
		return rejection(state, "missing_evidence", `Evidence is required when marking ${update.taskId} ${update.status}`);
	}
	if (update.status === "blocked" && (typeof update.note !== "string" || !update.note.trim())) {
		return rejection(state, "missing_note", `A blocker note is required for ${update.taskId}`);
	}
	if (current.status === "completed" && update.status === "in_progress" && (typeof update.reopenReason !== "string" || !update.reopenReason.trim())) {
		return rejection(state, "missing_reopen_reason", `A user-feedback reopen reason is required for ${update.taskId}`);
	}
	return apply(state, `task_${update.taskId}_${update.status}`, (next) => {
		next.ledger[update.taskId] = {
			status: update.status,
			note: update.note?.trim() || update.reopenReason?.trim() || null,
			evidence: update.evidence?.trim() || null,
		};
	});
}

export function recordStageCheckpoint(state, payload) {
	const invalidMode = requireMode(state, ["executing_staged"], "recordStageCheckpoint");
	if (invalidMode) return invalidMode;
	if (state.checkpoint && !state.checkpoint.consumed) return rejection(state, "checkpoint_pending", "A stage checkpoint is already pending");
	if (payload?.stageId !== state.currentStageId) return rejection(state, "stage_order", `Expected current stage ${state.currentStageId}`);
	if (typeof payload.nonce !== "string" || !payload.nonce) return rejection(state, "invalid_checkpoint", "Checkpoint nonce is required");
	const taskIds = getStageTaskIds(state, payload.stageId);
	const nonterminal = taskIds.filter((id) => !["completed", "blocked"].includes(state.ledger[id]?.status));
	if (nonterminal.length > 0) return rejection(state, "nonterminal_stage", `Stage tasks are nonterminal: ${nonterminal.join(", ")}`);
	return apply(state, `complete_stage_${payload.stageId}`, (next) => {
		next.completedStages = next.completedStages.filter((item) => item.stageId !== payload.stageId);
		next.completedStages.push({
			stageId: payload.stageId,
			summary: payload.summary?.trim() || "",
			changedFiles: [...(payload.changedFiles ?? [])],
			tests: [...(payload.tests ?? [])],
			blockers: [...(payload.blockers ?? [])],
		});
		const workers = new Map(next.parallelWorkers.map((worker) => [worker.workerId, worker]));
		for (const worker of payload.parallelWorkers ?? []) workers.set(worker.workerId, worker);
		next.parallelWorkers = [...workers.values()];
		next.checkpoint = { nonce: payload.nonce, stageId: payload.stageId, consumed: false, presented: false };
	});
}

export function resolveStageCheckpoint(state, nonce, action) {
	const invalidMode = requireMode(state, ["executing_staged"], "resolveStageCheckpoint");
	if (invalidMode) return invalidMode;
	if (!state.checkpoint || state.checkpoint.consumed || state.checkpoint.nonce !== nonce) {
		return rejection(state, "stale_checkpoint", "The stage checkpoint token is stale");
	}
	if (!["continue", "feedback", "stop"].includes(action)) return rejection(state, "invalid_checkpoint_action", "Checkpoint action is invalid");
	return apply(state, `checkpoint_${action}`, (next) => {
		const stageId = next.checkpoint.stageId;
		next.checkpoint.consumed = true;
		next.checkpoint = null;
		if (action === "continue") {
			const currentIndex = next.plan.stageIds.indexOf(stageId);
			next.currentStageId = next.plan.stageIds[currentIndex + 1] ?? null;
		} else if (action === "feedback") {
			next.completedStages = next.completedStages.filter((item) => item.stageId !== stageId);
		} else {
			next.execution.paused = true;
		}
	});
}

export function resumeExecution(state) {
	const invalidMode = requireMode(state, ["executing_all", "executing_staged"], "resumeExecution");
	if (invalidMode) return invalidMode;
	if (!state.execution?.paused) return success(state);
	return apply(state, "resume_execution", (next) => { next.execution.paused = false; });
}

export function blockWorkflow(state, reason) {
	const invalidMode = requireMode(
		state,
		["planning", "approval", "executing_all", "executing_staged"],
		"blockWorkflow",
	);
	if (invalidMode) return invalidMode;
	if (typeof reason !== "string" || !reason.trim()) {
		return rejection(state, "missing_reason", "A blocking reason is required");
	}
	return apply(state, "block_workflow", (next) => {
		next.mode = "blocked";
		next.blockedReason = reason.trim();
	});
}

export function completeWorkflow(state, options = {}) {
	const invalidMode = requireMode(state, ["executing_all", "executing_staged"], "completeWorkflow");
	if (invalidMode) return invalidMode;
	const acceptedStatuses = options.allowBlocked === true ? ["completed", "blocked"] : ["completed"];
	const nonterminal = Object.entries(state.ledger).filter(([, item]) => !acceptedStatuses.includes(item.status));
	if (nonterminal.length > 0) {
		return rejection(
			state,
			"nonterminal_tasks",
			`Cannot complete while tasks are nonterminal: ${nonterminal.map(([id]) => id).join(", ")}`,
		);
	}
	return apply(state, "complete_workflow", (next) => {
		next.mode = "completed";
		next.currentStageId = null;
		next.checkpoint = null;
		next.blockedReason = null;
	});
}

export function isPlanModeState(value) {
	if (!value || typeof value !== "object" || value.version !== PLAN_MODE_STATE_VERSION) return false;
	if (!MODE_SET.has(value.mode) || !Array.isArray(value.originalActiveTools)) return false;
	if (!value.counters || typeof value.counters.invalidSubmissions !== "number") return false;
	if (!value.ledger || typeof value.ledger !== "object" || Array.isArray(value.ledger)) return false;
	return Object.values(value.ledger).every((item) => item && STATUS_SET.has(item.status));
}

export function migrateState(value) {
	if (!isPlanModeState(value)) return null;
	const migrated = { ...createInitialState(), ...clone(value) };
	migrated.counters = { ...createInitialState().counters, ...value.counters };
	if (migrated.execution) migrated.execution = { runId: null, paused: false, ...migrated.execution };
	if (migrated.approval) migrated.approval = { presented: false, ...migrated.approval };
	if (migrated.checkpoint) migrated.checkpoint = { presented: false, ...migrated.checkpoint };
	if (migrated.plan && !Array.isArray(migrated.plan.stages)) {
		migrated.plan.stages = (migrated.plan.stageIds ?? []).map((id) => ({
			id,
			description: `Stage ${id}`,
			taskIds: (migrated.plan.taskIds ?? []).filter((taskId) => taskId.startsWith(`${id}.`)),
		}));
	}
	if (migrated.plan && !Array.isArray(migrated.plan.tasks)) migrated.plan.tasks = [];
	return migrated;
}

export function restoreLatestState(branchEntries, customType = PLAN_MODE_STATE_ENTRY) {
	if (!Array.isArray(branchEntries)) return createInitialState();
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (entry?.type !== "custom" || entry.customType !== customType) continue;
		const restored = migrateState(entry.data);
		if (restored) return restored;
	}
	return createInitialState();
}
