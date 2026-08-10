import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	EXECUTION_BOUNDARY_MESSAGE,
	EXECUTION_ENTRY,
	buildExecutionBoundaryMessage,
	buildExecutionKickoff,
	buildStageInstruction,
	getExecutionToolNames,
	isolateExecutionMessages,
	restoreExecutionContract,
} from "../execution-helpers.js";

const state = {
	mode: "executing_staged",
	originalActiveTools: ["read", "subagent", "missing"],
	currentStageId: "2",
	execution: { mode: "staged", runId: "run-2" },
	plan: { path: "/project/.pi/plans/approved.md", hash: "plan-hash" },
};
const legacyContract = {
	version: 1,
	approvedMarkdown: "# Legacy approved\n",
	planPath: "/legacy.md",
	planHash: "legacy-hash",
	executionMode: "all",
	originalActiveTools: ["read"],
	parentSessionPath: "/sessions/planning.jsonl",
};
const contract = {
	version: 2,
	handoff: "in_place",
	runId: "run-2",
	approvedMarkdown: "# Approved\n",
	planPath: "/project/.pi/plans/approved.md",
	planHash: "plan-hash",
	executionMode: "staged",
	originalActiveTools: ["read", "subagent", "missing"],
	sessionPath: "/sessions/current.jsonl",
	boundaryHash: "",
};
contract.boundaryHash = createHash("sha256").update(buildExecutionKickoff(contract, state), "utf8").digest("hex");

function boundaryEntry(activeContract = contract, activeState = state) {
	const message = buildExecutionBoundaryMessage(activeContract, activeState);
	return {
		type: "custom_message",
		customType: message.customType,
		content: message.content,
		display: message.display,
		details: message.details,
	};
}

test("restores the contract matching the active in-place run, not simply the newest historical run", () => {
	const older = { ...contract, runId: "run-1", planHash: "old-hash", planPath: "/old.md" };
	assert.equal(restoreExecutionContract([
		{ type: "custom", customType: EXECUTION_ENTRY, data: legacyContract },
		{ type: "custom", customType: EXECUTION_ENTRY, data: contract },
		{ type: "custom", customType: EXECUTION_ENTRY, data: older },
	], state).runId, contract.runId);
});

test("keeps legacy fresh-session contracts readable without treating them as in-place runs", () => {
	const legacyState = { ...state, execution: { mode: "all" }, plan: { path: legacyContract.planPath, hash: legacyContract.planHash } };
	assert.equal(restoreExecutionContract([
		{ type: "custom", customType: EXECUTION_ENTRY, data: contract },
		{ type: "custom", customType: EXECUTION_ENTRY, data: legacyContract },
	], legacyState), legacyContract);
	const messages = [{ role: "user", content: "legacy kickoff", timestamp: 1 }];
	assert.strictEqual(isolateExecutionMessages(messages, legacyContract, legacyState), messages);
	assert.equal(restoreExecutionContract([
		{ type: "custom", customType: EXECUTION_ENTRY, data: legacyContract },
	], { ...legacyState, mode: "approval", execution: null }), null, "an old child contract is not attached to a newer non-executing workflow state");
});

test("restores exact original tools plus mode-specific workflow tools", () => {
	assert.deepEqual(getExecutionToolNames(state, ["read", "subagent", "plan_progress", "complete_stage", "complete_plan"]), {
		active: ["read", "subagent", "plan_progress", "complete_stage"],
		missing: ["missing"],
	});
	assert.deepEqual(getExecutionToolNames({ ...state, mode: "executing_all" }, ["read", "plan_progress", "complete_plan"]).active, ["read", "plan_progress", "complete_plan"]);
});

test("in-place kickoff is self-contained and staged instructions enforce a hard boundary", () => {
	const kickoff = buildExecutionKickoff(contract, state);
	assert.match(kickoff, /current visible session/);
	assert.match(kickoff, /earlier planning messages are excluded/i);
	assert.match(kickoff, /Execute only execution stage 2/);
	assert.match(kickoff, /every execution stage corresponds to exactly one Part/);
	assert.match(kickoff, /# Approved/);
	assert.match(buildExecutionKickoff(legacyContract, { ...state, mode: "executing_all" }), /fresh implementation session/);
	assert.match(buildStageInstruction(state), /only execution stage 2/);
	assert.match(buildStageInstruction(state), /Do not begin a later stage/);
	assert.match(buildStageInstruction({ ...state, parallelWorkers: [{ workerId: "worker-1", runId: "run-1" }] }), /Resume an existing worker/);
});

test("execution boundary excludes planning context and retains all later implementation messages", () => {
	const boundary = buildExecutionBoundaryMessage(contract, state);
	assert.equal(boundary.customType, EXECUTION_BOUNDARY_MESSAGE);
	assert.equal(boundary.display, false);
	const planning = { role: "user", content: "planning discussion", timestamp: 1 };
	const implementation = { role: "assistant", content: [{ type: "text", text: "implementation" }], timestamp: 3 };
	const followUp = { role: "user", content: "follow-up", timestamp: 4 };
	const isolated = isolateExecutionMessages([planning, boundary, implementation, followUp], contract, state);
	assert.deepEqual(isolated, [boundary, implementation, followUp]);
});

test("missing or mismatched boundaries fail closed to the approved execution contract", () => {
	const planning = { role: "user", content: "planning discussion", timestamp: 1 };
	const wrongBoundary = buildExecutionBoundaryMessage({ ...contract, runId: "older-run" }, { ...state, execution: { mode: "staged", runId: "older-run" } });
	for (const messages of [[planning], [planning, wrongBoundary]]) {
		const isolated = isolateExecutionMessages(messages, contract, state);
		assert.equal(isolated.length, 1);
		assert.equal(isolated[0].customType, EXECUTION_BOUNDARY_MESSAGE);
		assert.match(isolated[0].content, /# Approved/);
	}
});

test("a matching durable boundary remains discoverable after reload and branch restoration", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "plan", timestamp: 1 } },
		{ type: "custom", customType: EXECUTION_ENTRY, data: contract },
		boundaryEntry(),
		{ type: "message", message: { role: "assistant", content: [], timestamp: 3 } },
	];
	assert.equal(restoreExecutionContract(branch, state), contract);
	const messages = branch.flatMap((entry) => entry.type === "message"
		? [entry.message]
		: entry.type === "custom_message"
			? [{ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: 2 }]
			: []);
	assert.equal(isolateExecutionMessages(messages, contract, state).length, 2);
});
