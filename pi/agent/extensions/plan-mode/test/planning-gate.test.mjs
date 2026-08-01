import assert from "node:assert/strict";
import test from "node:test";

import {
	evaluatePlanningToolCall,
	getPlanningToolNames,
	getRestorableTools,
	snapshotActiveTools,
} from "../planning-gate.js";

const registered = [
	"read", "bash", "edit", "write", "grep", "find", "ls", "custom_mutator",
	"ketch_search", "ask_user_question", "submit_plan", "plan_progress",
];

test("snapshots the exact pre-planning tool sequence except workflow-only tools", () => {
	assert.deepEqual(
		snapshotActiveTools(["custom_mutator", "read", "submit_plan", "read", "plan_progress"]),
		["custom_mutator", "read", "read"],
	);
});

test("planning activates only known inspection, research, question, and submission tools", () => {
	assert.deepEqual(getPlanningToolNames(registered), [
		"read", "grep", "find", "ls", "bash", "ketch_search", "ask_user_question", "submit_plan",
	]);
});

test("restoration uses the exact snapshot intersection and reports disappeared tools", () => {
	assert.deepEqual(getRestorableTools(["custom_mutator", "read", "missing", "read"], registered), {
		restored: ["custom_mutator", "read", "read"],
		missing: ["missing"],
	});
});

test("defense in depth rejects direct, unknown, and known shell mutations", () => {
	assert.match(evaluatePlanningToolCall("edit", {}, registered), /direct mutation tool 'edit'/);
	assert.match(evaluatePlanningToolCall("custom_mutator", {}, registered), /blocks tool 'custom_mutator'/);
	assert.match(evaluatePlanningToolCall("bash", { command: "env rm file" }, registered), /known-mutating Bash/);
	assert.equal(evaluatePlanningToolCall("bash", { command: "git status --short" }, registered), null);
	assert.equal(evaluatePlanningToolCall("acme_unknown", {}, [...registered, "acme_unknown"]), "Planning mode blocks tool 'acme_unknown'.");
});
