import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_PLAN_BYTES,
	parsePlanDocument,
	renderPlanDocument,
	validatePlanDocument,
} from "../plan-document.js";
import { LEGACY_PLAN, VALID_PLAN } from "./fixtures.mjs";

function errorCodes(markdown) {
	return validatePlanDocument(markdown).map((item) => item.code);
}

test("parses why/what steps independently from their stage mapping", () => {
	const result = parsePlanDocument(VALID_PLAN);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.document.version, 2);
	assert.equal(result.document.title, "Add Reliable Cache Invalidation");
	assert.deepEqual(result.document.steps.map((step) => step.id), ["1", "2", "3"]);
	assert.deepEqual(result.document.steps.map((step) => step.status), ["pending", "in_progress", "blocked"]);
	assert.deepEqual(result.document.stages.map((stage) => stage.stepIds), [["1"], ["2", "3"]]);
	assert.equal(result.document.stages[1].description, "Implement invalidation and verify edge cases.");
});

test("parse/render round-trip preserves the execution contract", () => {
	const first = parsePlanDocument(VALID_PLAN);
	assert.equal(first.ok, true);
	const rendered = renderPlanDocument(first.document);
	const second = parsePlanDocument(rendered);
	assert.equal(second.ok, true, JSON.stringify(second.errors));
	assert.deepEqual(second.document, first.document);
});

test("accepts legacy stage-grouped plans for active-session compatibility", () => {
	const result = parsePlanDocument(LEGACY_PLAN);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.document.version, 1);
	assert.deepEqual(result.document.stages.map((stage) => stage.id), ["1", "2"]);
	assert.deepEqual(result.document.stages[1].tasks.map((task) => task.id), ["2.1", "2.2"]);
});

test("requires exactly the Why, What, and Stages sections in order", () => {
	const missing = VALID_PLAN.replace("## Why", "## Motivation");
	assert.ok(errorCodes(missing).includes("invalid_section_order"));

	const reordered = VALID_PLAN
		.replace("## Why", "## TEMP")
		.replace("## What", "## Why")
		.replace("## TEMP", "## What");
	assert.ok(errorCodes(reordered).includes("invalid_section_order"));
});

test("rejects malformed stage ordering, mappings, and duplicate assignments", () => {
	assert.ok(errorCodes(VALID_PLAN.replace("| 2 | Implement", "| 3 | Implement")).includes("stage_order"));
	assert.ok(errorCodes(VALID_PLAN.replace("| 2 | Implement invalidation and verify edge cases. | 2, 3 |", "| 2 | Implement invalidation and verify edge cases. | 2, 4 |")).includes("unknown_step"));
	assert.ok(errorCodes(VALID_PLAN.replace("| 1 | Freeze the cache behavior and executable contract. | 1 |", "| 1 | Freeze the cache behavior and executable contract. | 1, 2 |")).includes("duplicate_step_assignment"));
});

test("rejects duplicate, missing, and invalid step IDs/statuses", () => {
	assert.ok(errorCodes(VALID_PLAN.replace("### Step 3 [blocked]", "### Step 2 [blocked]")).includes("duplicate_step"));
	assert.ok(errorCodes(VALID_PLAN.replace(/### Step 1 \[pending\][\s\S]*?(?=\n### Step 2)/, "")).includes("step_order"));
	assert.ok(errorCodes(VALID_PLAN.replace("### Step 1 [pending]", "### Step 1 [done]")).includes("invalid_status"));
});

test("rejects steps without explicit target or tool metadata", () => {
	const noTargets = VALID_PLAN.replace("- **Targets:** `src/cache.ts`, `test/cache.test.ts`", "- Files are not known yet.");
	assert.ok(errorCodes(noTargets).includes("missing_targets"));

	const noTools = VALID_PLAN.replace("- **Tools / APIs:** read, edit, Node test runner", "- Use normal tools.");
	assert.ok(errorCodes(noTools).includes("missing_tools"));
});

test("ignores heading-like text inside fenced code blocks", () => {
	const withFence = VALID_PLAN.replace(
		"Document key ownership and expected expiry behavior.",
		"Document key ownership and expected expiry behavior.\n\n```md\n### Step 99 [completed] Example only\n## Not a real section\n```",
	);
	const result = parsePlanDocument(withFence);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("rejects empty plans, plans with no steps, and oversized plans", () => {
	assert.deepEqual(errorCodes(""), ["empty_plan"]);
	const noSteps = VALID_PLAN.replace(/\n### Step[\s\S]*?(?=\n## Stages)/, "");
	assert.ok(errorCodes(noSteps).includes("no_steps"));

	const oversized = `${VALID_PLAN}${"x".repeat(MAX_PLAN_BYTES)}`;
	assert.deepEqual(errorCodes(oversized), ["plan_too_large"]);
});

test("reports malformed step heading levels instead of guessing", () => {
	const malformed = VALID_PLAN.replace("### Step 2 [in_progress]", "#### Step 2 [in_progress]");
	assert.ok(errorCodes(malformed).includes("unexpected_heading"));
});
