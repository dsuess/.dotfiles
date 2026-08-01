import assert from "node:assert/strict";
import test from "node:test";
import {
	EXECUTION_ENTRY,
	buildExecutionKickoff,
	buildStageInstruction,
	getExecutionToolNames,
	restoreExecutionContract,
} from "../execution-helpers.js";

const state = {
	mode: "executing_staged",
	originalActiveTools: ["read", "subagent", "missing"],
	currentStageId: "2",
};
const contract = {
	version: 1,
	approvedMarkdown: "# Approved\n",
	planPath: "/project/.pi/plans/approved.md",
	executionMode: "staged",
};

test("restores only the latest execution contract on the active branch", () => {
	const older = { ...contract, planPath: "/old.md" };
	assert.equal(restoreExecutionContract([
		{ type: "custom", customType: EXECUTION_ENTRY, data: older },
		{ type: "custom", customType: "other", data: contract },
		{ type: "custom", customType: EXECUTION_ENTRY, data: contract },
	]).planPath, contract.planPath);
});

test("restores exact original tools plus mode-specific workflow tools", () => {
	assert.deepEqual(getExecutionToolNames(state, ["read", "subagent", "plan_progress", "complete_stage", "complete_plan"]), {
		active: ["read", "subagent", "plan_progress", "complete_stage"],
		missing: ["missing"],
	});
	assert.deepEqual(getExecutionToolNames({ ...state, mode: "executing_all" }, ["read", "plan_progress", "complete_plan"]).active, ["read", "plan_progress", "complete_plan"]);
});

test("kickoff is self-contained and staged instructions enforce a hard boundary", () => {
	const kickoff = buildExecutionKickoff(contract, state);
	assert.match(kickoff, /fresh implementation session/);
	assert.match(kickoff, /Execute only Stage 2/);
	assert.match(kickoff, /# Approved/);
	assert.match(buildStageInstruction(state), /only Stage 2/);
	assert.match(buildStageInstruction(state), /Do not begin a later stage/);
	assert.match(buildStageInstruction({ ...state, parallelWorkers: [{ workerId: "worker-1", runId: "run-1" }] }), /Resume an existing worker/);
});
