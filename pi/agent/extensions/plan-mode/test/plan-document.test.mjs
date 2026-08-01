import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_PLAN_BYTES,
	parsePlanDocument,
	renderPlanDocument,
	validatePlanDocument,
} from "../plan-document.js";
import { VALID_PLAN } from "./fixtures.mjs";

function errorCodes(markdown) {
	return validatePlanDocument(markdown).map((item) => item.code);
}

test("parses the canonical plan schema and stage/task boundaries", () => {
	const result = parsePlanDocument(VALID_PLAN);
	assert.equal(result.ok, true);
	assert.equal(result.document.title, "Add Reliable Cache Invalidation");
	assert.deepEqual(result.document.stages.map((stage) => stage.id), ["1", "2"]);
	assert.deepEqual(result.document.stages[1].tasks.map((task) => task.id), ["2.1", "2.2"]);
	assert.deepEqual(result.document.stages[1].tasks.map((task) => task.status), ["in_progress", "blocked"]);
});

test("parse/render round-trip preserves the execution contract", () => {
	const first = parsePlanDocument(VALID_PLAN);
	assert.equal(first.ok, true);
	const rendered = renderPlanDocument(first.document);
	const second = parsePlanDocument(rendered);
	assert.equal(second.ok, true, JSON.stringify(second.errors));
	assert.deepEqual(second.document, first.document);
});

test("rejects missing and out-of-order required sections", () => {
	const missing = VALID_PLAN.replace("## Testing Requirements and Edge Cases", "## Testing");
	assert.ok(errorCodes(missing).includes("invalid_section_order"));

	const reordered = VALID_PLAN
		.replace("## Parallel Subagent Recommendations", "## TEMP")
		.replace("## Testing Requirements and Edge Cases", "## Parallel Subagent Recommendations")
		.replace("## TEMP", "## Testing Requirements and Edge Cases");
	assert.ok(errorCodes(reordered).includes("invalid_section_order"));
});

test("rejects malformed stage ordering and overview mismatches", () => {
	const reorderedStage = VALID_PLAN.replace("### Stage 2 — Implementation", "### Stage 3 — Implementation");
	const codes = errorCodes(reorderedStage);
	assert.ok(codes.includes("stage_order"));
	assert.ok(codes.includes("stage_mismatch"));
});

test("rejects duplicate, missing, and invalid task IDs/statuses", () => {
	const duplicate = VALID_PLAN.replace("#### 2.2 [blocked] Verify edge cases", "#### 2.1 [blocked] Verify edge cases");
	assert.ok(errorCodes(duplicate).includes("duplicate_task"));

	const missing = VALID_PLAN.replace(/#### 1\.1 \[pending\][\s\S]*?(?=\n### Stage 2)/, "");
	assert.ok(errorCodes(missing).includes("empty_stage"));

	const invalidStatus = VALID_PLAN.replace("#### 1.1 [pending]", "#### 1.1 [done]");
	assert.ok(errorCodes(invalidStatus).includes("invalid_status"));
});

test("rejects tasks without explicit target or tool metadata", () => {
	const noTargets = VALID_PLAN.replace("- **Targets:** `src/cache.ts`, `test/cache.test.ts`", "- Files are not known yet.");
	assert.ok(errorCodes(noTargets).includes("missing_targets"));

	const noTools = VALID_PLAN.replace("- **Tools / APIs:** read, edit, Node test runner", "- Use normal tools.");
	assert.ok(errorCodes(noTools).includes("missing_tools"));
});

test("ignores heading-like text inside fenced code blocks", () => {
	const withFence = VALID_PLAN.replace(
		"Document key ownership and expected expiry behavior.",
		"Document key ownership and expected expiry behavior.\n\n```md\n#### 9.9 [done] Example only\n## Not a real section\n```",
	);
	const result = parsePlanDocument(withFence);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("rejects empty plans, plans with no tasks, and oversized plans", () => {
	assert.deepEqual(errorCodes(""), ["empty_plan"]);
	const noTasks = VALID_PLAN.replace(/\n#### [\s\S]*?(?=\n## Conditional Logic)/, "");
	const noTaskCodes = errorCodes(noTasks);
	assert.ok(noTaskCodes.includes("empty_stage"));
	assert.ok(noTaskCodes.includes("no_tasks"));

	const oversized = `${VALID_PLAN}${"x".repeat(MAX_PLAN_BYTES)}`;
	assert.deepEqual(errorCodes(oversized), ["plan_too_large"]);
});

test("reports malformed heading levels instead of guessing", () => {
	const malformed = VALID_PLAN.replace("#### 2.1 [in_progress]", "### 2.1 [in_progress]");
	const codes = errorCodes(malformed);
	assert.ok(codes.includes("malformed_stage_heading"));
});
