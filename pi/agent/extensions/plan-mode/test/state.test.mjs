import assert from "node:assert/strict";
import test from "node:test";

import {
	LEGAL_MODE_TRANSITIONS,
	PLAN_MODE_STATE_ENTRY,
	approveExecution,
	blockWorkflow,
	completeWorkflow,
	createInitialState,
	enterPlanning,
	exitPlanning,
	recordInvalidSubmission,
	recordStageCheckpoint,
	recordTaskProgress,
	requestRevision,
	resetInvalidSubmissions,
	resolveStageCheckpoint,
	resumeExecution,
	restoreLatestState,
	submitPlan,
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
		off: ["planning"],
		planning: ["off", "approval", "blocked"],
		approval: ["off", "planning", "executing_all", "executing_staged", "blocked"],
		executing_all: ["completed", "blocked"],
		executing_staged: ["completed", "blocked"],
		completed: ["planning"],
		blocked: ["planning"],
	});
});

function planningState() {
	const result = enterPlanning(createInitialState(), ["read", "bash", "custom_tool"]);
	assert.equal(result.ok, true);
	return result.state;
}

function approvalState(overrides = {}) {
	const result = submitPlan(planningState(), submission(overrides));
	assert.equal(result.ok, true);
	return result.state;
}

test("workflow follows legal off -> planning -> approval -> execution transitions", () => {
	const initial = createInitialState();
	const planning = enterPlanning(initial, ["read", "custom", "read"]);
	assert.equal(planning.ok, true);
	assert.equal(planning.state.mode, "planning");
	assert.deepEqual(planning.state.originalActiveTools, ["read", "custom", "read"]);
	assert.equal(initial.mode, "off", "transitions must not mutate their input");

	const approved = submitPlan(planning.state, submission());
	assert.equal(approved.ok, true);
	assert.equal(approved.state.mode, "approval");
	assert.equal(approved.state.plan.revision, 1);
	assert.deepEqual(Object.keys(approved.state.ledger), ["1", "2"]);
	assert.deepEqual(approved.state.plan.tasks, [
		{ id: "1", title: "Establish the contract" },
		{ id: "2", title: "Implement and verify" },
	]);
	assert.equal(approved.state.plan.stages[1].description, "Implement and verify.");

	const executing = approveExecution(approved.state, "nonce-1", "staged");
	assert.equal(executing.ok, true);
	assert.equal(executing.state.mode, "executing_staged");
	assert.equal(executing.state.currentStageId, "1");
});

test("alphabetic Part IDs pause at one derived execution stage per Part", () => {
	const partSubmission = {
		sequentialStages: true,
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

test("rejects duplicate, stale, and out-of-order actions deterministically", () => {
	const initial = createInitialState();
	const first = enterPlanning(initial, ["read"]);
	const duplicate = enterPlanning(first.state, ["read"]);
	assert.equal(duplicate.ok, false);
	assert.equal(duplicate.error.code, "invalid_transition");
	assert.strictEqual(duplicate.state, first.state);

	const approval = submitPlan(first.state, submission()).state;
	const stale = approveExecution(approval, "older-nonce", "all");
	assert.equal(stale.ok, false);
	assert.equal(stale.error.code, "stale_approval");

	const execution = approveExecution(approval, "nonce-1", "all");
	assert.equal(execution.ok, true);
	const repeated = approveExecution(execution.state, "nonce-1", "all");
	assert.equal(repeated.ok, false);
	assert.equal(repeated.error.code, "invalid_transition");
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

	const revised = submitPlan(invalid.state, submission({ hash: "def456", approvalNonce: "nonce-2" }));
	assert.equal(revised.ok, true);
	assert.equal(revised.state.plan.revision, 2);
	assert.equal(revised.state.counters.invalidSubmissions, 0);
});

test("exit retains the saved reference while a new planning run starts a fresh active draft", () => {
	const approval = approvalState();
	const exited = exitPlanning(approval);
	assert.equal(exited.ok, true);
	assert.equal(exited.state.mode, "off");
	assert.equal(exited.state.plan.path, "/project/.pi/plans/cache.md");
	assert.deepEqual(exited.state.originalActiveTools, ["read", "bash", "custom_tool"]);

	const restarted = enterPlanning(exited.state, ["read"]);
	assert.equal(restarted.ok, true);
	assert.equal(restarted.state.plan, null);
	assert.deepEqual(restarted.state.ledger, {});
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

test("staged checkpoints are nonce-guarded, ordered, pausable, and resumable", () => {
	let execution = approveExecution(approvalState(), "nonce-1", "staged").state;
	execution = recordTaskProgress(execution, { taskId: "1", status: "in_progress" }).state;
	execution = recordTaskProgress(execution, { taskId: "1", status: "completed", evidence: "done" }).state;
	const checkpoint = recordStageCheckpoint(execution, {
		stageId: "1", nonce: "stage-nonce", summary: "done", changedFiles: [], tests: ["npm test"], blockers: [],
	});
	assert.equal(checkpoint.ok, true);
	assert.equal(resolveStageCheckpoint(checkpoint.state, "stale", "continue").error.code, "stale_checkpoint");
	const continued = resolveStageCheckpoint(checkpoint.state, "stage-nonce", "continue");
	assert.equal(continued.state.currentStageId, "2");

	const pausedBase = structuredClone(checkpoint.state);
	const paused = resolveStageCheckpoint(pausedBase, "stage-nonce", "stop");
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
	assert.equal(completed.state.mode, "completed");
});

test("blocking requires a reason and is legal only from active workflow modes", () => {
	const planning = planningState();
	assert.equal(blockWorkflow(planning, "").error.code, "missing_reason");
	const blocked = blockWorkflow(planning, "Missing required API access");
	assert.equal(blocked.ok, true);
	assert.equal(blocked.state.mode, "blocked");
	assert.equal(blocked.state.blockedReason, "Missing required API access");
	assert.equal(blockWorkflow(blocked.state, "again").error.code, "invalid_transition");
});

test("restore uses only the latest valid state on the supplied active branch", () => {
	const older = planningState();
	const active = approvalState();
	const abandoned = { ...active, mode: "completed", lastAction: "abandoned" };
	const branch = [
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: older },
		{ type: "message", message: { role: "user", content: "branch point" } },
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: active },
		{ type: "custom", customType: "other-extension", data: abandoned },
	];
	const restored = restoreLatestState(branch);
	assert.equal(restored.mode, "approval");
	assert.equal(restored.plan.hash, "abc123");

	const abandonedBranch = [branch[0], { type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: abandoned }];
	assert.equal(restoreLatestState(abandonedBranch).mode, "completed");
});

test("restore migrates stage metadata for legacy persisted plans", () => {
	const legacy = approvalState({
		stages: [{ id: "1" }, { id: "2" }],
		tasks: [
			{ id: "1.1", title: "First legacy task", status: "pending" },
			{ id: "2.1", title: "Second legacy task", status: "pending" },
		],
	});
	delete legacy.plan.stages;
	delete legacy.plan.tasks;
	const restored = restoreLatestState([{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: legacy }]);
	assert.deepEqual(restored.plan.stages, [
		{ id: "1", description: "Stage 1", taskIds: ["1.1"] },
		{ id: "2", description: "Stage 2", taskIds: ["2.1"] },
	]);
	assert.deepEqual(restored.plan.tasks, []);
});

test("restore ignores malformed or unsupported state entries", () => {
	const state = planningState();
	const branch = [
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: state },
		{ type: "custom", customType: PLAN_MODE_STATE_ENTRY, data: { version: 99, mode: "planning" } },
	];
	assert.equal(restoreLatestState(branch).mode, "planning");
	assert.equal(restoreLatestState([]).mode, "off");
});
