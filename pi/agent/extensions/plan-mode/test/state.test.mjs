import assert from "node:assert/strict";
import test from "node:test";

import {
	LEGAL_MODE_TRANSITIONS,
	PLAN_MODE_STATE_ENTRY,
	acceptFastOptimization,
	approveExecution,
	beginFastOptimization,
	blockWorkflow,
	completeWorkflow,
	createInitialState,
	enterPlanning,
	exitPlanning,
	hasDurableFeedbackPending,
	hasPendingApproval,
	isActiveExecution,
	migrateState,
	recordInvalidSubmission,
	recordStageCheckpoint,
	recordTaskProgress,
	requestRevision,
	resetInvalidSubmissions,
	resolveStageCheckpoint,
	restoreFastOptimization,
	resumeExecution,
	restoreLatestState,
	showPlan,
} from "../state.js";

function submission(overrides = {}) {
	return {
		path: "/project/.pi/plans/cache.md",
		slug: "cache",
		hash: "abc123",
		title: "Cache plan",
		intent: "Fix cache",
		approvalNonce: "nonce-1",
		stages: [
			{ id: "1", description: "Establish the contract.", taskIds: ["1"] },
			{ id: "2", description: "Implement and verify.", taskIds: ["2"] },
		],
		tasks: [
			{ id: "1", title: "Establish the contract", status: "pending" },
			{ id: "2", title: "Implement and verify", status: "pending" },
		],
		...overrides,
	};
}

test("publishes the versioned legal mode-transition contract", () => {
	assert.deepEqual(LEGAL_MODE_TRANSITIONS, {
		planning: ["normal"],
		normal: ["planning"],
	});
});

function planningState() {
	const result = enterPlanning(createInitialState(), ["read", "bash", "custom_tool"]);
	assert.equal(result.ok, true);
	return result.state;
}

function approvalState(overrides = {}) {
	const result = showPlan(planningState(), submission(overrides));
	assert.equal(result.ok, true);
	return result.state;
}

test("workflow follows legal off -> planning -> approval -> execution transitions", () => {
	const initial = createInitialState();
	const planning = enterPlanning(initial, ["read", "custom", "read"]);
	assert.equal(planning.ok, true);
	assert.equal(planning.state.mode, "planning");
	assert.deepEqual(planning.state.originalActiveTools, ["read", "custom", "read"]);
	assert.equal(initial.mode, "normal", "transitions must not mutate their input");

	const approved = showPlan(planning.state, submission());
	assert.equal(approved.ok, true);
	assert.equal(approved.state.mode, "planning");
	assert.equal(approved.state.plan.revision, 1);
	assert.deepEqual(Object.keys(approved.state.ledger), ["1", "2"]);
	assert.deepEqual(approved.state.plan.tasks, [
		{ id: "1", title: "Establish the contract" },
		{ id: "2", title: "Implement and verify" },
	]);
	assert.equal(approved.state.plan.stages[1].description, "Implement and verify.");

	const executing = approveExecution(approved.state, "nonce-1", "staged");
	assert.equal(executing.ok, true);
	assert.equal(executing.state.mode, "normal");
	assert.equal(executing.state.currentStageId, "1");
});

test("alphabetic Part IDs pause at one derived execution stage per Part", () => {
	const partSubmission = {
		stages: [
			{ id: "A", description: "Define behavior", taskIds: ["A"] },
			{ id: "B", description: "Implement behavior", taskIds: ["B"] },
		],
		tasks: [
			{ id: "A", title: "Define behavior", status: "pending" },
			{ id: "B", title: "Implement behavior", status: "pending" },
		],
	};
	const approved = approvalState(partSubmission);
	let state = approveExecution(approved, "nonce-1", "staged").state;
	assert.equal(state.currentStageId, "A");
	assert.equal(recordTaskProgress(state, { itemId: "B", status: "in_progress" }).error.code, "future_stage");
	state = recordTaskProgress(state, { itemId: "A", status: "in_progress" }).state;
	state = recordTaskProgress(state, { itemId: "A", status: "completed", evidence: "contract checked" }).state;
	state = recordStageCheckpoint(state, { stageId: "A", nonce: "part-a", tests: [] }).state;
	state = resolveStageCheckpoint(state, "part-a", "continue").state;
	assert.equal(state.currentStageId, "B");

	let full = approveExecution(approvalState(partSubmission), "nonce-1", "all").state;
	assert.equal(recordTaskProgress(full, { itemId: "B", status: "in_progress" }).error.code, "future_stage");
	full = recordTaskProgress(full, { itemId: "A", status: "in_progress" }).state;
	full = recordTaskProgress(full, { itemId: "A", status: "completed", evidence: "contract checked" }).state;
	assert.equal(recordTaskProgress(full, { itemId: "B", status: "in_progress" }).ok, true);
});

test("staged execution starts at and advances to the next nonterminal Part", () => {
	const approved = approvalState({
		stages: [
			{ id: "A", description: "Already complete", taskIds: ["A"] },
			{ id: "B", description: "Resume work", taskIds: ["B"] },
			{ id: "C", description: "Known blocker", taskIds: ["C"] },
			{ id: "D", description: "Future work", taskIds: ["D"] },
		],
		tasks: [
			{ id: "A", title: "Already complete", status: "completed", evidence: "A passed" },
			{ id: "B", title: "Resume work", status: "in_progress", note: "work started", evidence: "partial check" },
			{ id: "C", title: "Known blocker", status: "blocked", note: "dependency absent", evidence: "probe failed" },
			{ id: "D", title: "Future work", status: "pending" },
		],
	});
	let execution = approveExecution(approved, "nonce-1", "staged").state;
	assert.equal(execution.currentStageId, "B");
	assert.equal(recordTaskProgress(execution, { itemId: "D", status: "in_progress" }).error.code, "future_stage");
	execution = recordTaskProgress(execution, { itemId: "B", status: "completed", evidence: "B passed" }).state;
	execution = recordStageCheckpoint(execution, { stageId: "B", nonce: "stage-b", tests: ["focused test"] }).state;
	execution = resolveStageCheckpoint(execution, "stage-b", "continue").state;
	assert.equal(execution.currentStageId, "D", "later terminal Parts are skipped at the checkpoint");
	assert.equal(execution.ledger.A.evidence, "A passed");
	assert.equal(execution.ledger.C.evidence, "probe failed");
});

test("parallel execution allows siblings and blocks future waves until their predecessors are terminal", () => {
	const schedule = (wave, dependencies = []) => ({ wave, workerId: `worker-${wave}-${dependencies.length}`, sourcePartId: "A", dependencies, ownership: `${wave}-${dependencies.length} boundary` });
	const approved = approvalState({
		executionStrategy: "parallel",
		stages: [
			{ id: "A", description: "First sibling", taskIds: ["A"], parallelExecution: schedule(1) },
			{ id: "B", description: "Second sibling", taskIds: ["B"], parallelExecution: schedule(1) },
			{ id: "C", description: "Dependent Part", taskIds: ["C"], parallelExecution: schedule(2, ["A"]) },
		],
		tasks: [
			{ id: "A", title: "First sibling", status: "pending" },
			{ id: "B", title: "Second sibling", status: "pending" },
			{ id: "C", title: "Dependent Part", status: "pending" },
		],
	});
	let execution = approveExecution(approved, "nonce-1", "all").state;
	assert.equal(recordTaskProgress(execution, { itemId: "C", status: "in_progress" }).error.code, "future_wave");
	execution = recordTaskProgress(execution, { itemId: "A", status: "in_progress" }).state;
	execution = recordTaskProgress(execution, { itemId: "B", status: "in_progress" }).state;
	execution = recordTaskProgress(execution, { itemId: "A", status: "completed", evidence: "worker A passed" }).state;
	assert.equal(recordTaskProgress(execution, { itemId: "C", status: "in_progress" }).error.code, "future_wave");
	execution = recordTaskProgress(execution, { itemId: "B", status: "completed", evidence: "worker B passed" }).state;
	assert.equal(recordTaskProgress(execution, { itemId: "C", status: "in_progress" }).ok, true);
});

test("fast optimization preserves source progress and evidence across optimized Parts", () => {
	const source = approvalState({
		stages: [{ id: "A", description: "Source Part", taskIds: ["A"] }],
		tasks: [{ id: "A", title: "Source Part", status: "in_progress", note: "implementation started", evidence: "baseline passed" }],
	});
	const optimizing = beginFastOptimization(source, "nonce-1", ["A"]).state;
	const accepted = acceptFastOptimization(optimizing, submission({
		hash: "split-fast",
		approvalNonce: "split-nonce",
		stages: [
			{ id: "A", description: "First split", taskIds: ["A"], parallelExecution: { wave: 1, workerId: "worker-a", sourcePartId: "A", dependencies: [], ownership: "first boundary" } },
			{ id: "B", description: "Second split", taskIds: ["B"], parallelExecution: { wave: 1, workerId: "worker-b", sourcePartId: "A", dependencies: [], ownership: "second boundary" } },
		],
		tasks: [
			{ id: "A", title: "First split", status: "pending" },
			{ id: "B", title: "Second split", status: "completed", evidence: "invented" },
		],
	}));
	assert.equal(accepted.ok, true);
	assert.deepEqual(accepted.state.ledger, {
		A: { status: "in_progress", note: "implementation started", evidence: "baseline passed" },
		B: { status: "in_progress", note: "implementation started", evidence: "baseline passed" },
	});
	assert.equal(accepted.state.currentStageId, "A");
});

test("fast optimization retains a recoverable approval and hands off directly to parallel execution", () => {
	const source = approvalState({
		stages: [{ id: "A", description: "Source Part", taskIds: ["A"] }],
		tasks: [{ id: "A", title: "Source Part", status: "pending" }],
	});
	const optimizing = beginFastOptimization(source, "nonce-1", ["A"]);
	assert.equal(optimizing.ok, true);
	assert.equal(optimizing.state.mode, "planning");
	assert.equal(optimizing.state.approval, null);
	assert.deepEqual(optimizing.state.optimization.sourcePartIds, ["A"]);
	const restored = restoreFastOptimization(optimizing.state);
	assert.equal(restored.ok, true);
	assert.equal(restored.state.mode, "planning");
	assert.equal(restored.state.approval.nonce, "nonce-1");
	assert.equal(restored.state.approval.presented, false);

	const accepted = acceptFastOptimization(optimizing.state, submission({
		hash: "fast456",
		approvalNonce: "fast-nonce",
		stages: [{
			id: "A", description: "Optimized Part", taskIds: ["A"],
			parallelExecution: { wave: 1, workerId: "worker-a", sourcePartId: "A", dependencies: [], ownership: "cache implementation" },
		}],
		tasks: [{ id: "A", title: "Optimized Part", status: "pending" }],
	}));
	assert.equal(accepted.ok, true);
	assert.equal(accepted.state.mode, "normal");
	assert.equal(accepted.state.approval, null);
	assert.equal(accepted.state.optimization, null);
	assert.equal(accepted.state.execution.strategy, "parallel");
	assert.equal(accepted.state.plan.executionStrategy, "parallel");
	assert.equal(accepted.state.plan.executionStrategy, "parallel");
});

test("rejects duplicate, stale, and out-of-order actions deterministically", () => {
	const initial = createInitialState();
	const first = enterPlanning(initial, ["read"]);
	const duplicate = enterPlanning(first.state, ["read"]);
	assert.equal(duplicate.ok, false);
	assert.equal(duplicate.error.code, "invalid_transition");
	assert.strictEqual(duplicate.state, first.state);

	const approval = showPlan(first.state, submission()).state;
	const stale = approveExecution(approval, "older-nonce", "all");
	assert.equal(stale.ok, false);
	assert.equal(stale.error.code, "stale_approval");

	const execution = approveExecution(approval, "nonce-1", "all");
	assert.equal(execution.ok, true);
	const repeated = approveExecution(execution.state, "nonce-1", "all");
	assert.equal(repeated.ok, false);
	assert.equal(repeated.error.code, "approval_consumed");
});

test("change/review returns to planning and increments revision only after valid resubmission", () => {
	const approval = approvalState();
	const review = requestRevision(approval, "nonce-1", "review");
	assert.equal(review.ok, true);
	assert.equal(review.state.mode, "planning");
	assert.equal(review.state.counters.reviewRounds, 1);
	assert.equal(review.state.plan.revision, 1);

	const invalid = recordInvalidSubmission(review.state);
	assert.equal(invalid.ok, true);
	assert.equal(invalid.state.counters.invalidSubmissions, 1);
	assert.equal(invalid.state.plan.revision, 1);

	const revised = showPlan(invalid.state, submission({ hash: "def456", approvalNonce: "nonce-2" }));
	assert.equal(revised.ok, true);
	assert.equal(revised.state.plan.revision, 2);
	assert.equal(revised.state.counters.invalidSubmissions, 0);
});

test("guard toggles preserve pending approval and all durable workflow facts", () => {
	const approval = approvalState();
	const exited = exitPlanning(approval);
	assert.equal(exited.ok, true);
	assert.equal(exited.state.mode, "normal");
	assert.equal(hasPendingApproval(exited.state), true);
	for (const key of [
		"outcome", "plan", "approval", "optimization", "execution", "ledger", "currentStageId",
		"checkpoint", "completedStages", "testEvidence", "parallelWorkers", "counters", "blockedReason",
	]) {
		assert.deepEqual(exited.state[key], approval[key], key);
	}

	const restarted = enterPlanning(exited.state, ["read"]);
	assert.equal(restarted.ok, true);
	assert.equal(restarted.state.mode, "planning");
	assert.equal(restarted.state.plan.path, "/project/.pi/plans/cache.md");
	assert.equal(restarted.state.approval.nonce, "nonce-1");
	assert.deepEqual(restarted.state.ledger, approval.ledger);
});

test("guard toggles temporarily gate an active execution without ending it", () => {
	const execution = approveExecution(approvalState(), "nonce-1", "staged").state;
	const entered = enterPlanning(execution, ["read", "show_plan"]);
	assert.equal(entered.ok, true);
	assert.equal(entered.state.mode, "planning");
	assert.equal(isActiveExecution(entered.state), true);
	assert.deepEqual(entered.state.execution, execution.execution);
	assert.deepEqual(entered.state.ledger, execution.ledger);

	const exited = exitPlanning(entered.state);
	assert.equal(exited.ok, true);
	assert.equal(exited.state.mode, "normal");
	assert.equal(isActiveExecution(exited.state), true);
	assert.deepEqual(exited.state.execution, execution.execution);
	assert.equal(exited.state.currentStageId, "1");
});

test("approval actions remain valid after the guard is disabled", () => {
	const unguarded = exitPlanning(approvalState()).state;
	assert.equal(hasPendingApproval(unguarded), true);
	const execution = approveExecution(unguarded, "nonce-1", "all");
	assert.equal(execution.ok, true);
	assert.equal(isActiveExecution(execution.state), true);

	const discussion = requestRevision(exitPlanning(approvalState()).state, "nonce-1", "discuss");
	assert.equal(discussion.ok, true);
	assert.equal(discussion.state.mode, "normal", "discussion preserves the user's disabled guard");
	assert.equal(discussion.state.counters.reviewRounds, 1);
});

test("guard toggles preserve a terminal outcome until a replacement is presented", () => {
	const terminal = approveExecution(approvalState(), "nonce-1", "all").state;
	for (const item of Object.values(terminal.ledger)) item.status = "completed";
	const completed = completeWorkflow(terminal).state;
	const guarded = enterPlanning(completed, ["read"]).state;
	assert.equal(guarded.outcome, "completed");
	assert.deepEqual(guarded.testEvidence, completed.testEvidence);
	const unguarded = exitPlanning(guarded).state;
	assert.equal(unguarded.outcome, "completed");
	assert.deepEqual(unguarded.ledger, completed.ledger);
});

test("a replacement candidate explicitly supersedes the prior execution", () => {
	const execution = approveExecution(approvalState(), "nonce-1", "all").state;
	const guarded = enterPlanning(execution, ["read"]).state;
	const replacement = showPlan(guarded, submission({
		path: "/project/.pi/plans/replacement.md",
		slug: "replacement",
		hash: "replacement-hash",
		approvalNonce: "replacement-nonce",
	}));
	assert.equal(replacement.ok, true);
	assert.equal(replacement.state.lastAction, "supersede_execution");
	assert.equal(replacement.state.execution, null);
	assert.equal(isActiveExecution(replacement.state), false);
	assert.equal(hasPendingApproval(replacement.state), true);
	assert.equal(replacement.state.plan.path, "/project/.pi/plans/replacement.md");
	assert.equal(execution.execution.active, true, "the prior durable state remains historical evidence");
});

test("candidate presentation works without a pre-enabled guard and retains validated initial evidence", () => {
	const presented = showPlan(createInitialState(), submission({
		tasks: [
			{ id: "1", title: "Establish the contract", status: "completed", evidence: "Contract review passed" },
			{ id: "2", title: "Implement and verify", status: "blocked", note: "API unavailable", evidence: "Access probe returned 403" },
		],
	}));
	assert.equal(presented.ok, true);
	assert.equal(presented.state.mode, "planning");
	assert.deepEqual(presented.state.ledger, {
		1: { status: "completed", note: null, evidence: "Contract review passed" },
		2: { status: "blocked", note: "API unavailable", evidence: "Access probe returned 403" },
	});
	const execution = approveExecution(presented.state, "nonce-1", "staged");
	assert.equal(execution.ok, true);
	assert.equal(execution.state.currentStageId, null, "terminal initial progress skips all execution stages");
});

test("initial terminal progress requires evidence and blocked progress requires a note", () => {
	assert.equal(showPlan(createInitialState(), submission({
		tasks: [{ id: "1", title: "Establish", status: "completed" }, { id: "2", title: "Implement", status: "pending" }],
	})).error.code, "missing_evidence");
	assert.equal(showPlan(createInitialState(), submission({
		tasks: [{ id: "1", title: "Establish", status: "blocked", evidence: "Probe failed" }, { id: "2", title: "Implement", status: "pending" }],
	})).error.code, "missing_note");
});

test("new user input resets consecutive invalid-submission counting", () => {
	const once = recordInvalidSubmission(planningState()).state;
	const twice = recordInvalidSubmission(once).state;
	assert.equal(twice.counters.invalidSubmissions, 2);
	const reset = resetInvalidSubmissions(twice);
	assert.equal(reset.ok, true);
	assert.equal(reset.state.counters.invalidSubmissions, 0);
	assert.equal(reset.state.lastAction, "user_resumed_planning");
});

test("ledger enforces legal transitions, evidence, stage scope, and explicit reopening", () => {
	let execution = approveExecution(approvalState(), "nonce-1", "staged").state;
	assert.equal(recordTaskProgress(execution, { taskId: "1", status: "completed", evidence: "test" }).error.code, "invalid_task_transition");
	execution = recordTaskProgress(execution, { taskId: "1", status: "in_progress" }).state;
	assert.equal(recordTaskProgress(execution, { taskId: "1", status: "completed", evidence: "" }).error.code, "missing_evidence");
	execution = recordTaskProgress(execution, { taskId: "1", status: "completed", evidence: "unit test passed" }).state;
	assert.equal(recordTaskProgress(execution, { taskId: "1", status: "in_progress" }).error.code, "missing_reopen_reason");
	execution = recordTaskProgress(execution, { taskId: "1", status: "in_progress", reopenReason: "user requested fix" }).state;
	assert.equal(execution.ledger["1"].note, "user requested fix");
	assert.equal(recordTaskProgress(execution, { taskId: "2", status: "in_progress" }).error.code, "future_stage");
});

test("durable feedback waits remain pending through Escape and restoration until consumed", () => {
	const approval = approvalState();
	assert.equal(hasDurableFeedbackPending(approval), true);
	const dismissedApproval = structuredClone(approval);
	dismissedApproval.approval.presented = true;
	assert.equal(hasDurableFeedbackPending(dismissedApproval), true, "Escape changes presentation, not the pending decision");
	assert.equal(hasDurableFeedbackPending(restoreLatestState([{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: dismissedApproval }])), true);
	assert.equal(hasDurableFeedbackPending(requestRevision(approval, "nonce-1").state), false);
	assert.equal(hasDurableFeedbackPending(approveExecution(approval, "nonce-1", "all").state), false);
	assert.equal(hasDurableFeedbackPending(blockWorkflow(approval, "stop the workflow").state), false);

	let execution = approveExecution(approval, "nonce-1", "staged").state;
	execution = recordTaskProgress(execution, { taskId: "1", status: "in_progress" }).state;
	execution = recordTaskProgress(execution, { taskId: "1", status: "completed", evidence: "done" }).state;
	const checkpoint = recordStageCheckpoint(execution, {
		stageId: "1", nonce: "stage-nonce", summary: "done", changedFiles: [], tests: ["npm test"], blockers: [],
	});
	assert.equal(checkpoint.ok, true);
	assert.equal(hasDurableFeedbackPending(checkpoint.state), true);
	const dismissedCheckpoint = structuredClone(checkpoint.state);
	dismissedCheckpoint.checkpoint.presented = true;
	assert.equal(hasDurableFeedbackPending(dismissedCheckpoint), true);
	assert.equal(hasDurableFeedbackPending(restoreLatestState([{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: dismissedCheckpoint }])), true);
	assert.equal(resolveStageCheckpoint(checkpoint.state, "stale", "continue").error.code, "stale_checkpoint");
	const continued = resolveStageCheckpoint(checkpoint.state, "stage-nonce", "continue");
	assert.equal(continued.state.currentStageId, "2");
	assert.equal(hasDurableFeedbackPending(continued.state), false);

	for (const action of ["feedback", "stop"]) {
		const resolved = resolveStageCheckpoint(structuredClone(checkpoint.state), "stage-nonce", action).state;
		assert.equal(hasDurableFeedbackPending(resolved), false, action);
	}
	const paused = resolveStageCheckpoint(structuredClone(checkpoint.state), "stage-nonce", "stop");
	assert.equal(paused.state.execution.paused, true);
	assert.equal(resumeExecution(paused.state).state.execution.paused, false);
});

test("completion requires every ledger task to be completed", () => {
	const execution = approveExecution(approvalState(), "nonce-1", "all").state;
	const early = completeWorkflow(execution);
	assert.equal(early.ok, false);
	assert.equal(early.error.code, "nonterminal_tasks");

	const done = structuredClone(execution);
	for (const item of Object.values(done.ledger)) item.status = "completed";
	const completed = completeWorkflow(done);
	assert.equal(completed.ok, true);
	assert.equal(completed.state.mode, "normal");
});

test("blocking requires a reason and is legal only from active workflow modes", () => {
	const planning = planningState();
	assert.equal(blockWorkflow(planning, "").error.code, "missing_reason");
	const blocked = blockWorkflow(planning, "Missing required API access");
	assert.equal(blocked.ok, true);
	assert.equal(blocked.state.mode, "normal");
	assert.equal(blocked.state.blockedReason, "Missing required API access");
	assert.equal(blockWorkflow(blocked.state, "again").error.code, "invalid_transition");
});

test("restore uses only the latest valid state on the supplied active branch", () => {
	const older = planningState();
	const active = approvalState();
	const abandoned = { ...active, mode: "normal", outcome: "completed", lastAction: "abandoned" };
	const branch = [
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: older },
		{ type: "message", message: { role: "user", content: "branch point" } },
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: active },
		{ type: "custom", customType: "other-extension", data: abandoned },
	];
	const restored = restoreLatestState(branch);
	assert.equal(restored.mode, "planning");
	assert.equal(restored.plan.hash, "abc123");

	const abandonedBranch = [branch[0], { type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: abandoned }];
	assert.equal(restoreLatestState(abandonedBranch).mode, "normal");
});



test("restore blocks stale fast optimization records instead of reusing their approval nonce", () => {
	const optimizing = beginFastOptimization(approvalState(), "nonce-1", ["A", "B"]).state;
	optimizing.optimization.sourceHash = "stale-source";
	const restored = restoreLatestState([{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: optimizing }]);
	assert.equal(restored.mode, "normal");
	assert.equal(restored.optimization, null);
	assert.equal(restored.approval, null);
	assert.match(restored.blockedReason, /stale/);
});

test("restore ignores malformed or unsupported state entries", () => {
	const state = planningState();
	const branch = [
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: state },
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: { version: 99, mode: "planning" } },
	];
	assert.equal(restoreLatestState(branch).mode, "planning");
	assert.equal(restoreLatestState([]).mode, "normal");
});

test("migrates every legacy workflow phase without inventing concurrent workflows", () => {
	const base = showPlan(enterPlanning(createInitialState(), ["read"]).state, submission()).state;
	for (const legacyMode of ["off", "planning", "approval", "executing_all", "executing_staged", "completed", "blocked"]) {
		const legacy = structuredClone(base);
		legacy.version = 1;
		legacy.mode = legacyMode;
		delete legacy.outcome;
		if (legacyMode.startsWith("executing_")) legacy.execution = { mode: legacyMode === "executing_staged" ? "staged" : "all", strategy: "standard", startedAt: null, parentSessionPath: null, runId: null, paused: false };
		const restored = restoreLatestState([{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: legacy }]);
		assert.equal(restored.version, 3, legacyMode);
		assert.ok(["planning", "normal"].includes(restored.mode), legacyMode);
		assert.equal(hasPendingApproval(restored), legacyMode === "approval", legacyMode);
		assert.equal(isActiveExecution(restored), legacyMode.startsWith("executing_"), legacyMode);
		if (legacyMode === "approval") assert.equal(restored.approval?.nonce, "nonce-1");
		if (legacyMode === "executing_staged") assert.equal(restored.execution?.mode, "staged");
		if (legacyMode === "completed") assert.equal(restored.outcome, "completed");
		if (legacyMode === "blocked") assert.equal(restored.outcome, "blocked");
	}
});

test("migrates current two-mode records while preserving guard-independent execution", () => {
	const execution = approveExecution(approvalState(), "nonce-1", "staged").state;
	const guardedExecution = structuredClone(execution);
	guardedExecution.version = 2;
	guardedExecution.mode = "planning";
	guardedExecution.execution.paused = true;
	guardedExecution.counters.recoveryAttempts = 2;

	const migrated = migrateState(guardedExecution);
	assert.equal(migrated.version, 3);
	assert.equal(migrated.mode, "planning");
	assert.equal(isActiveExecution(migrated), true);
	assert.equal(migrated.execution.paused, true);
	assert.equal(migrated.currentStageId, "1");
	assert.equal(migrated.counters.recoveryAttempts, 2);
});
