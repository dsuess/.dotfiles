import assert from "node:assert/strict";
import test from "node:test";

import {
	composeActiveTools,
	evaluatePlanningToolCall,
	getPlanningToolNames,
	getRestorableTools,
	snapshotActiveTools,
} from "../planning-gate.js";

const registered = [
	"read", "bash", "edit", "write", "grep", "find", "ls", "custom_mutator",
	"ketch_search", "ask_user_question", "show_plan", "plan_progress",
];

test("snapshots the exact pre-planning tool sequence except workflow-only tools", () => {
	assert.deepEqual(
		snapshotActiveTools(["custom_mutator", "read", "show_plan", "read", "plan_progress"]),
		["custom_mutator", "read", "read"],
	);
});

test("planning activates only known inspection, research, question, and submission tools", () => {
	assert.deepEqual(getPlanningToolNames(registered), [
		"read", "grep", "find", "ls", "bash", "ketch_search", "ask_user_question", "show_plan",
	]);
});

test("fast optimization removes questions while retaining read-only inspection and submission", () => {
	assert.deepEqual(getPlanningToolNames(registered, { fastOptimization: true }), [
		"read", "grep", "find", "ls", "bash", "ketch_search", "show_plan",
	]);
	assert.match(
		evaluatePlanningToolCall("ask_user_question", {}, registered, { fastOptimization: true }),
		/blocks tool 'ask_user_question'/,
	);
});

test("restoration uses only the implementation baseline and reports disappeared tools", () => {
	assert.deepEqual(getRestorableTools([
		"custom_mutator", "show_plan", "read", "plan_progress", "missing", "read", "complete_plan",
	], registered), {
		restored: ["custom_mutator", "read", "read"],
		missing: ["missing"],
	});
});

test("composition keeps presentation tools separate from the implementation baseline", () => {
	assert.deepEqual(composeActiveTools(
		["custom_mutator", "show_plan", "read", "plan_progress", "missing"],
		["show_plan"],
		registered,
	), {
		active: ["custom_mutator", "read", "show_plan"],
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

test("planning admits only the routing-verified reviewed inspection subset, never a server hint", () => {
	const inspection = ["search_for_pattern", "get_symbols_overview", "find_symbol", "find_referencing_symbols"].map((name) => `mcp__serena__${name}`);
	const edits = ["replace_symbol_body", "insert_after_symbol", "insert_before_symbol", "rename_symbol", "safe_delete_symbol"].map((name) => `mcp__serena__${name}`);
	const tools = [...registered, ...inspection, ...edits, "mcp__serena__execute_shell_command"];
	assert.ok(inspection.every((name) => !getPlanningToolNames(tools).includes(name)), "names alone grant nothing");
	const options = { routedInspectionTools: [...inspection, ...edits, "mcp__serena__execute_shell_command"] };
	for (const name of inspection) assert.equal(evaluatePlanningToolCall(name, {}, tools, options), null);
	for (const name of [...edits, "mcp__serena__execute_shell_command"]) assert.match(evaluatePlanningToolCall(name, {}, tools, options), /blocks tool/);
});

test("MCP inventory survives normal, fast planning and restoration without server calls", () => {
	const tools = [...registered, "mcp_list", "mcp__serena__execute"];
	for (const fastOptimization of [false, true]) {
		assert.ok(getPlanningToolNames(tools, { fastOptimization }).includes("mcp_list"));
		assert.equal(evaluatePlanningToolCall("mcp_list", {}, tools, { fastOptimization }), null);
		assert.match(evaluatePlanningToolCall("mcp__serena__execute", {}, tools, { fastOptimization }), /blocks tool/);
	}
	const snapshot = snapshotActiveTools(["read", "mcp_list", "show_plan"]);
	assert.deepEqual(composeActiveTools(snapshot, ["plan_progress"], tools).active, ["read", "mcp_list", "plan_progress"]);
	assert.deepEqual(getRestorableTools(snapshot, tools).restored, ["read", "mcp_list"]);
});
