import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	EXECUTION_BOUNDARY_MESSAGE,
	EXECUTION_ENTRY,
	buildExecutionBoundaryMessage,
	buildExecutionKickoff,
	buildParallelWorkerPrompt,
	getActiveParallelWave,
	buildStageInstruction,
	getExecutionToolNames,
	isolateExecutionMessages,
	restoreExecutionContract,
} from "../execution-helpers.js";

const state = {
	mode: "normal",
	originalActiveTools: ["read", "subagent", "missing"],
	currentStageId: "2",
	execution: { mode: "staged", active: true, runId: "run-2" },
	plan: { path: "/project/.pi/plans/approved.md", hash: "plan-hash" },
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

test("restores the contract matching the active in-place run, not simply the newest run", () => {
	const older = { ...contract, runId: "run-1", planHash: "old-hash", planPath: "/old.md" };
	assert.equal(restoreExecutionContract([
		{ type: "custom", customType: EXECUTION_ENTRY, data: contract },
		{ type: "custom", customType: EXECUTION_ENTRY, data: older },
	], state).runId, contract.runId);
});

test("rejects an unsupported execution record instead of restoring it", () => {
	assert.equal(restoreExecutionContract([
		{ type: "custom", customType: EXECUTION_ENTRY, data: { runId: "run-2", planPath: state.plan.path, planHash: state.plan.hash, approvedMarkdown: "# Unsupported" } },
	], state), null);
});

test("restores exact original tools plus mode-specific workflow tools", () => {
	assert.deepEqual(getExecutionToolNames(state, ["read", "subagent", "plan_progress", "complete_stage", "complete_plan"]), {
		active: ["read", "subagent", "plan_progress", "complete_stage"],
		missing: ["missing"],
	});
	assert.deepEqual(getExecutionToolNames({ ...state, execution: { ...state.execution, mode: "all" } }, ["read", "plan_progress", "complete_plan"]).active, ["read", "plan_progress", "complete_plan"]);
});

test("in-place kickoff is self-contained and staged instructions enforce a hard boundary", () => {
	const kickoff = buildExecutionKickoff(contract, state);
	assert.match(kickoff, /current visible session/);
	assert.match(kickoff, /earlier planning messages are excluded/i);
	assert.match(kickoff, /Execute only execution stage 2/);
	assert.match(kickoff, /Every execution stage corresponds to exactly one Part/);
	assert.match(kickoff, /# Approved/);
	assert.match(buildStageInstruction(state), /only execution stage 2/);
	assert.match(buildStageInstruction(state), /Do not begin a later stage/);
	assert.match(buildStageInstruction({ ...state, parallelWorkers: [{ workerId: "worker-1", runId: "run-1" }] }), /Resume an existing worker/);
});

test("parallel kickoff exposes one ready wave and complete worker contracts", () => {
	const approvedMarkdown = `# Parallel approved

## Context

The shared context identifies the integration boundary.

## Approach

Run independent work in a safe wave.

### Part A — Update implementation

Change only the implementation boundary. Accept when the focused test passes.

### Part B — Update tests

Change only the test boundary. Accept when the regression test passes.

## Parallel Execution

| Wave | Worker | Part | Source Part | Depends On | Ownership |
|---|---|---|---|---|---|
| 1 | worker-a | A | A | — | implementation boundary |
| 1 | worker-b | B | B | — | test boundary |
`;
	const parallelState = {
		mode: "normal",
		originalActiveTools: ["read", "subagent"],
		execution: { mode: "all", active: true, strategy: "parallel", runId: "parallel-run" },
		ledger: {
			A: { status: "pending", note: null, evidence: null },
			B: { status: "pending", note: null, evidence: null },
		},
		plan: {
			path: "/project/.pi/plans/parallel.md", hash: "parallel-hash",
			stages: [
				{ id: "A", description: "Update implementation", taskIds: ["A"], parallelExecution: { wave: 1, workerId: "worker-a", sourcePartId: "A", dependencies: [], ownership: "implementation boundary" } },
				{ id: "B", description: "Update tests", taskIds: ["B"], parallelExecution: { wave: 1, workerId: "worker-b", sourcePartId: "B", dependencies: [], ownership: "test boundary" } },
			],
		},
	};
	const parallelContract = {
		...contract, runId: "parallel-run", planPath: parallelState.plan.path, planHash: parallelState.plan.hash,
		approvedMarkdown, executionMode: "all", executionStrategy: "parallel", workerModel: "openai-codex/gpt-5.6-terra", workerThinkingLevel: "high",
	};
	assert.deepEqual(getActiveParallelWave(parallelState).map((stage) => stage.id), ["A", "B"]);
	const workerPrompt = buildParallelWorkerPrompt(parallelContract, parallelState, parallelState.plan.stages[0]);
	assert.match(workerPrompt, /^\[PI SUBAGENT ROLE: worker\]\n\[PARALLEL PLAN WORKER\]/);
	assert.match(workerPrompt, /Own only optimized Part A/);
	assert.match(workerPrompt, /implementation boundary/);
	assert.match(workerPrompt, /shared context/);
	assert.match(workerPrompt, /parent ledger/);
	const kickoff = buildExecutionKickoff(parallelContract, parallelState);
	assert.match(kickoff, /current ready wave is 1/);
	assert.match(kickoff, /one subagent call for every Part.*one sibling tool batch/i);
	assert.match(kickoff, /model: openai-codex\/gpt-5\.6-terra/);
	assert.match(kickoff, /thinkingLevel: "high"/);
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

test("missing execution boundaries after compaction reconstruct the contract and retain the execution tail", () => {
	const summary = {
		role: "compactionSummary",
		summary: "Mixed planning and execution history.",
		tokensBefore: 1000,
		timestamp: 10,
	};
	const readPlanCall = {
		role: "assistant",
		content: [{ type: "toolCall", id: "read-plan", name: "read", arguments: { path: contract.planPath } }],
		timestamp: 11,
	};
	const readResult = {
		role: "toolResult",
		toolCallId: "read-plan",
		toolName: "read",
		content: [{ type: "text", text: "# Approved\\n" }],
		isError: false,
		timestamp: 12,
	};
	const progressCall = {
		role: "assistant",
		content: [{ type: "toolCall", id: "progress-B", name: "plan_progress", arguments: { itemId: "B", status: "in_progress" } }],
		timestamp: 13,
	};
	const progressFailure = {
		role: "toolResult",
		toolCallId: "progress-B",
		toolName: "plan_progress",
		content: [{ type: "text", text: "Part B is already in_progress." }],
		isError: true,
		timestamp: 14,
	};
	const queuedContinuation = { role: "user", content: "Continue from the current ledger.", timestamp: 15 };

	const firstPass = isolateExecutionMessages([summary, readPlanCall, readResult], contract, state);
	assert.equal(firstPass[0].customType, EXECUTION_BOUNDARY_MESSAGE);
	assert.deepEqual(firstPass.slice(1), [readPlanCall, readResult]);
	assert.equal(firstPass.some((message) => message.role === "compactionSummary"), false);

	const retainedTail = [readPlanCall, readResult, progressCall, progressFailure, queuedContinuation];
	const secondPass = isolateExecutionMessages([summary, ...retainedTail], contract, state);
	assert.equal(secondPass[0].customType, EXECUTION_BOUNDARY_MESSAGE);
	assert.deepEqual(secondPass.slice(1), retainedTail);
	assert.ok(secondPass.includes(readResult));
	assert.ok(secondPass.includes(progressFailure));
	assert.equal(secondPass.some((message) => message.role === "compactionSummary"), false);
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
