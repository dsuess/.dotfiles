import assert from "node:assert/strict";
import test from "node:test";

import {
	MAX_PLAN_BYTES,
	parsePlanDocument,
	renderPlanDocument,
	replaceManagedProgressReport,
	splitManagedProgressReport,
	validatePlanDocument,
} from "../plan-document.js";
import {
	LEGACY_PLAN,
	PART_MINIMAL_PLAN,
	PART_PLAN,
	SMALL_PLAN,
	VALID_PLAN,
	VERSION_2_PLAN,
} from "./fixtures.mjs";

function errorCodes(markdown) {
	return validatePlanDocument(markdown).map((item) => item.code);
}

test("parses Context and Approach Parts into pending one-Part execution stages", () => {
	const result = parsePlanDocument(PART_PLAN);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.document.version, 4);
	assert.match(result.document.context, /src\/cache\.ts/);
	assert.match(result.document.criticalFiles, /read-only terminology reference/);
	assert.match(result.document.verification, /failure signal/);
	assert.deepEqual(result.document.parts.map((part) => part.id), ["A", "B", "C"]);
	assert.deepEqual(result.document.parts.map((part) => part.status), ["pending", "pending", "pending"]);
	assert.deepEqual(result.document.stages.map((stage) => stage.id), ["A", "B", "C"]);
	assert.deepEqual(result.document.stages.map((stage) => stage.stepIds), [["A"], ["B"], ["C"]]);
	assert.deepEqual(result.document.stages.map((stage) => stage.description), result.document.parts.map((part) => part.title));
});

test("accepts both optional sections independently or omits them cleanly", () => {
	for (const markdown of [
		PART_MINIMAL_PLAN,
		PART_PLAN.replace(/\n## Critical Files[\s\S]*?(?=\n## Verification)/, ""),
		PART_PLAN.replace(/\n## Verification[\s\S]*$/, "\n"),
	]) {
		const result = parsePlanDocument(markdown);
		assert.equal(result.ok, true, JSON.stringify(result.errors));
		assert.doesNotMatch(renderPlanDocument(result.document), /\n## undefined/);
	}
});

test("uses a canonical Part progress report for version 4", () => {
	const managed = replaceManagedProgressReport(PART_PLAN, [
		"☐ Define cache consistency",
		"☐ Implement reliable invalidation",
		"☐ Cover boundary behavior",
	]);
	assert.equal(splitManagedProgressReport(managed).report.heading, "## Part Progress");
	const parsed = parsePlanDocument(managed);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
	assert.equal(renderPlanDocument(parsed.document), managed);
	const wrongHeading = managed.replace("## Part Progress", "## Step Progress");
	assert.ok(errorCodes(wrongHeading).includes("invalid_progress_heading"));
});

test("round-trips version 4 while preserving selective paths and interfaces as content", () => {
	const first = parsePlanDocument(PART_PLAN);
	assert.equal(first.ok, true);
	const rendered = renderPlanDocument(first.document);
	assert.match(rendered, /`src\/cache\.ts`/);
	assert.match(rendered, /public interface/);
	const second = parsePlanDocument(rendered);
	assert.equal(second.ok, true, JSON.stringify(second.errors));
	assert.deepEqual(second.document, first.document);
});

test("continues stable Part identities beyond Z", () => {
	const headings = Array.from({ length: 27 }, (_, index) => {
		const id = index < 26 ? String.fromCharCode(65 + index) : "AA";
		return `### Part ${id} — Handle boundary ${index + 1}\n\nDescribe and accept boundary ${index + 1}.`;
	}).join("\n\n");
	const result = parsePlanDocument(`# Handle Many Boundaries\n\n## Context\n\nThe change has many independently reviewable boundaries.\n\n## Approach\n\nHandle every boundary in stable order.\n\n${headings}\n`);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.document.parts.at(-1).id, "AA");
});

test("rejects malformed version 4 ordering, identities, hierarchy, and empty content", () => {
	assert.ok(errorCodes(PART_PLAN.replace("## Critical Files", "## Unsupported")).includes("unsupported_heading"));
	assert.ok(errorCodes(PART_PLAN.replace("## Critical Files", "## Verification\n\nDuplicate check\n\n## Critical Files")).includes("invalid_section_order"));
	assert.ok(errorCodes(PART_PLAN.replace("### Part B —", "### Part C —")).includes("part_order"));
	assert.ok(errorCodes(PART_PLAN.replace("### Part B —", "### Part A —")).includes("duplicate_part"));
	assert.ok(errorCodes(PART_PLAN.replace("### Part B —", "### Part 2 —")).includes("malformed_part_heading"));
	assert.ok(errorCodes(PART_PLAN.replace("### Part B —", "### Part B [pending] —")).includes("malformed_part_heading"));
	assert.ok(errorCodes(PART_PLAN.replace("### Part B — Implement reliable invalidation", "#### Part B — Implement reliable invalidation")).includes("unsupported_heading"));
	assert.ok(errorCodes(PART_MINIMAL_PLAN.replace("The cache lifecycle is difficult for maintainers to understand in the wider data-access flow.", "")).includes("empty_section"));
	assert.ok(errorCodes(PART_MINIMAL_PLAN.replace("Explain the existing behavior without changing runtime behavior.\n\n", "")).includes("empty_section"));
	assert.ok(errorCodes(PART_MINIMAL_PLAN.replace("Describe writes, expiry, and ownership using repository terminology. The work is accepted when the documentation explains the lifecycle without introducing a new contract.", "")).includes("empty_part"));
	assert.ok(errorCodes(PART_MINIMAL_PLAN.replace(/\n### Part A[\s\S]*$/, "")).includes("no_parts"));
});

test("rejects legacy inventory metadata but accepts rationale-driven anchors", () => {
	assert.equal(parsePlanDocument(PART_PLAN).ok, true);
	const targets = PART_MINIMAL_PLAN.replace(
		"Describe writes, expiry, and ownership",
		"- **Targets:** `src/cache.ts`\n\nDescribe writes, expiry, and ownership",
	);
	assert.ok(errorCodes(targets).includes("disallowed_metadata"));
});

test("parses high-level changes independently from their optional stage mapping", () => {
	const result = parsePlanDocument(VALID_PLAN);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.document.version, 3);
	assert.equal(result.document.title, "Add Reliable Cache Invalidation");
	assert.match(result.document.background, /within the repository/);
	assert.match(result.document.testingPlan, /successful and failed writes/);
	assert.match(result.document.assumptionsDecisions, /user decided/);
	assert.equal(result.document.breakingChanges, undefined);
	assert.equal(result.document.explicitStages, true);
	assert.deepEqual(result.document.steps.map((step) => step.id), ["1", "2", "3"]);
	assert.deepEqual(result.document.steps.map((step) => step.status), ["pending", "in_progress", "blocked"]);
	assert.deepEqual(result.document.stages.map((stage) => stage.stepIds), [["1"], ["2", "3"]]);
});

test("parses an applicable breaking-changes section", () => {
	const markdown = VALID_PLAN.replace(
		"## Testing Plan",
		"## Breaking Changes\n\nExisting consumers must migrate to the new cache lifecycle.\n\n## Testing Plan",
	);
	const result = parsePlanDocument(markdown);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.match(result.document.breakingChanges, /must migrate/);
});

test("accepts a small plan without optional sections or an explicit stages section", () => {
	const result = parsePlanDocument(SMALL_PLAN);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
	assert.equal(result.document.explicitStages, false);
	assert.equal(result.document.testingPlan, undefined);
	assert.equal(result.document.assumptionsDecisions, undefined);
	assert.deepEqual(result.document.stages.map((stage) => stage.stepIds), [["1"]]);
	assert.equal(result.document.stages[0].description, "Complete the planned changes.");
	assert.doesNotMatch(renderPlanDocument(result.document), /## Stages/);
});

test("parse/render round-trip preserves the execution contract", () => {
	for (const markdown of [VALID_PLAN, SMALL_PLAN]) {
		const first = parsePlanDocument(markdown);
		assert.equal(first.ok, true);
		const rendered = renderPlanDocument(first.document);
		const second = parsePlanDocument(rendered);
		assert.equal(second.ok, true, JSON.stringify(second.errors));
		assert.deepEqual(second.document, first.document);
	}
});

test("recognizes and canonically renders one trailing managed Step report", () => {
	const parsed = parsePlanDocument(VALID_PLAN);
	assert.equal(parsed.ok, true);
	const managed = replaceManagedProgressReport(VALID_PLAN, [
		"☐ Define the cache behavior",
		"▶ Add reliable invalidation",
		"⛔ Cover boundary conditions",
	]);
	const withReport = parsePlanDocument(managed);
	assert.equal(withReport.ok, true, JSON.stringify(withReport.errors));
	assert.equal(withReport.document.managedProgressReport, true);
	assert.deepEqual(splitManagedProgressReport(managed).report.rows, [
		"☐ Define the cache behavior",
		"▶ Add reliable invalidation",
		"⛔ Cover boundary conditions",
	]);
	assert.equal(renderPlanDocument(withReport.document), managed);
});

test("rendering regenerates stale well-formed report rows without duplication", () => {
	const managed = replaceManagedProgressReport(VALID_PLAN, ["☑ Stale row"]);
	const parsed = parsePlanDocument(managed);
	assert.equal(parsed.ok, true);
	const rendered = renderPlanDocument(parsed.document);
	assert.deepEqual(splitManagedProgressReport(rendered).report.rows, [
		"☐ Define the cache behavior",
		"▶ Add reliable invalidation",
		"⛔ Cover boundary conditions",
	]);
	assert.equal((rendered.match(/pi-plan-mode:progress:start/g) ?? []).length, 1);
});

test("rejects malformed, ambiguous, or non-trailing managed report regions", () => {
	const managed = replaceManagedProgressReport(VALID_PLAN, ["☐ Define the cache behavior"]);
	assert.deepEqual(errorCodes(managed.replace("## Step Progress", "## Progress")), ["malformed_progress_report"]);
	assert.deepEqual(errorCodes(`${managed}\nnot managed`), ["malformed_progress_report"]);
	assert.deepEqual(errorCodes(`${managed}\n${managed.slice(managed.indexOf("<!-- pi-plan-mode:progress:start -->"))}`), ["ambiguous_progress_report"]);
});

test("accepts version 2 and legacy plans for active-session compatibility", () => {
	const version2 = parsePlanDocument(VERSION_2_PLAN);
	assert.equal(version2.ok, true, JSON.stringify(version2.errors));
	assert.equal(version2.document.version, 2);
	assert.match(renderPlanDocument(version2.document), /## Why/);

	const legacy = parsePlanDocument(LEGACY_PLAN);
	assert.equal(legacy.ok, true, JSON.stringify(legacy.errors));
	assert.equal(legacy.document.version, 1);
	assert.deepEqual(legacy.document.stages.map((stage) => stage.id), ["1", "2"]);
	assert.deepEqual(legacy.document.stages[1].tasks.map((task) => task.id), ["2.1", "2.2"]);
});

test("requires Background and Changes and keeps optional sections in canonical order", () => {
	const missing = VALID_PLAN.replace("## Background", "## Motivation");
	assert.ok(errorCodes(missing).includes("missing_section"));

	const reordered = VALID_PLAN
		.replace("## Testing Plan", "## TEMP")
		.replace("## Assumptions / Decisions", "## Testing Plan")
		.replace("## TEMP", "## Assumptions / Decisions");
	assert.ok(errorCodes(reordered).includes("invalid_section_order"));

	const empty = VALID_PLAN.replace(
		/## Assumptions \/ Decisions\n\n[\s\S]*?(?=\n## Stages)/,
		"## Assumptions / Decisions\n",
	);
	assert.ok(errorCodes(empty).includes("empty_section"));
});

test("rejects malformed stage ordering, mappings, and duplicate assignments", () => {
	assert.ok(errorCodes(VALID_PLAN.replace("| 2 | Implement", "| 3 | Implement")).includes("stage_order"));
	assert.ok(errorCodes(VALID_PLAN.replace("| 2 | Implement and verify the behavior; the two changes may proceed together once Stage 1 is settled. | 2, 3 |", "| 2 | Implement and verify the behavior; the two changes may proceed together once Stage 1 is settled. | 2, 4 |")).includes("unknown_step"));
	assert.ok(errorCodes(VALID_PLAN.replace("| 1 | Establish expected behavior before implementation. | 1 |", "| 1 | Establish expected behavior before implementation. | 1, 2 |")).includes("duplicate_step_assignment"));
});

test("rejects duplicate, missing, and invalid step IDs/statuses", () => {
	assert.ok(errorCodes(VALID_PLAN.replace("### Step 3 [blocked]", "### Step 2 [blocked]")).includes("duplicate_step"));
	assert.ok(errorCodes(VALID_PLAN.replace(/### Step 1 \[pending\][\s\S]*?(?=\n### Step 2)/, "")).includes("step_order"));
	assert.ok(errorCodes(VALID_PLAN.replace("### Step 1 [pending]", "### Step 1 [done]")).includes("invalid_status"));
});

test("rejects target-file and tool/API metadata in version 3", () => {
	const withTargets = VALID_PLAN.replace(
		"Clarify ownership, expiry, and invalidation behavior",
		"- **Targets:** `src/cache.ts`\n\nClarify ownership, expiry, and invalidation behavior",
	);
	assert.ok(errorCodes(withTargets).includes("disallowed_metadata"));

	const withTools = VALID_PLAN.replace(
		"Clarify ownership, expiry, and invalidation behavior",
		"- **Tools / APIs:** edit, cache API\n\nClarify ownership, expiry, and invalidation behavior",
	);
	assert.ok(errorCodes(withTools).includes("disallowed_metadata"));
});

test("requires a high-level Changes summary before its steps", () => {
	const withoutSummary = SMALL_PLAN.replace(
		"Clarify the lifecycle at a repository-facing level without prescribing implementation details.\n\n",
		"",
	);
	assert.ok(errorCodes(withoutSummary).includes("empty_section"));
});

test("rejects a stages table that exists only inside a fenced code block", () => {
	const fenced = VALID_PLAN.replace(
		"| Stage | Description | Steps |\n|---|---|---|\n| 1 | Establish expected behavior before implementation. | 1 |\n| 2 | Implement and verify the behavior; the two changes may proceed together once Stage 1 is settled. | 2, 3 |",
		"```md\n| Stage | Description | Steps |\n|---|---|---|\n| 1 | Fake stage. | 1, 2, 3 |\n```",
	);
	assert.ok(errorCodes(fenced).includes("invalid_stages"));
});

test("ignores heading-like text inside fenced code blocks", () => {
	const withFence = VALID_PLAN.replace(
		"Clarify ownership, expiry, and invalidation behavior at the cache boundary, including the expected outcome of successful and failed writes.",
		"Clarify ownership and expiry behavior.\n\n```md\n### Step 99 [completed] Example only\n## Not a real section\n```",
	);
	const result = parsePlanDocument(withFence);
	assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("rejects empty plans, plans with no steps, and oversized plans", () => {
	assert.deepEqual(errorCodes(""), ["empty_plan"]);
	const noSteps = SMALL_PLAN.replace(/\n### Step[\s\S]*$/, "");
	assert.ok(errorCodes(noSteps).includes("no_steps"));

	const oversized = `${VALID_PLAN}${"x".repeat(MAX_PLAN_BYTES)}`;
	assert.deepEqual(errorCodes(oversized), ["plan_too_large"]);
});

test("reports malformed step heading levels instead of guessing", () => {
	const malformed = VALID_PLAN.replace("### Step 2 [in_progress]", "#### Step 2 [in_progress]");
	assert.ok(errorCodes(malformed).includes("unexpected_heading"));
});
