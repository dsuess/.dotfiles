import assert from "node:assert/strict";
import test from "node:test";
import { computePlanComparison, parseDocumentSections, diffLines } from "../plan-comparison.ts";
import { stripLedgerMutationsWithMap, authoredPlanHash } from "../ledger.js";

const BASE_PLAN = `# Cache Refactor

## Context
Initial context line 1.
Initial context line 2.

## Questions & Answers
| Question | Answer |
|---|---|
| Invalidate on error? | No. |

## Approach
Preamble approach text.

### Part A — Cache core
Implementation details for Part A.

### Part B — Invalidation
Implementation details for Part B.

## Verification
Run tests.
`;

test("first candidate shows no comparison statistics", () => {
	const comp = computePlanComparison(null, BASE_PLAN, undefined, 1);
	assert.equal(comp.status, "none");
	assert.equal(comp.headerSubtitle, "Plan candidate — revision 1");
	assert.equal(comp.affectedSections, undefined);
});

test("identical authored content reports no authored changes", () => {
	const comp = computePlanComparison(BASE_PLAN, BASE_PLAN, 1, 2);
	assert.equal(comp.status, "identical");
	assert.equal(comp.message, "No authored changes since revision 1");
	assert.equal(comp.headerSubtitle, "Plan candidate — revision 2 (no authored changes since revision 1)");
});

test("progress-only differences report identical authored content", () => {
	const withProgress = `${BASE_PLAN}\n<!-- pi-plan-mode:progress:start -->\n## Part Progress\n\n- ☐ Cache core\n- ☐ Invalidation\n<!-- pi-plan-mode:progress:end -->\n`;
	const withLedger = BASE_PLAN.replace(
		"### Part A — Cache core\n",
		"### Part A — Cache core\n- **Ledger:** {\"status\":\"in_progress\"}\n",
	);
	const comp = computePlanComparison(withProgress, withLedger, 1, 2);
	assert.equal(comp.status, "identical");
});

test("missing or corrupted baseline reports comparison unavailable", () => {
	const comp = computePlanComparison("<!-- pi-plan-mode:progress:start -->\nmalformed\n", BASE_PLAN, 1, 2);
	assert.equal(comp.status, "unavailable");
	assert.equal(comp.message, "Comparison unavailable");
	assert.equal(comp.headerSubtitle, "Plan candidate — revision 2 (comparison unavailable)");
});

test("detects added, modified, and deleted sections in document order", () => {
	// Baseline has Questions & Answers.
	// Current removes Questions & Answers, modifies Context, adds lines to Part A, and adds Part C.
	const revised = `# Cache Refactor

## Context
Initial context line 1.
Edited context line 2.
Added context line 3.

## Approach
Preamble approach text.

### Part A — Cache core
Implementation details for Part A.
Extra line for Part A.

### Part B — Invalidation
Implementation details for Part B.

### Part C — Metrics
New Part C details.

## Verification
Run tests.
`;

	const comp = computePlanComparison(BASE_PLAN, revised, 1, 2);
	assert.equal(comp.status, "compared");
	assert.equal(comp.headerSubtitle, "Plan candidate — revision 2 (compared with revision 1)");
	assert.ok(comp.affectedSections);

	const labels = comp.affectedSections.map((s) => s.label);
	assert.ok(labels.includes("Context"));
	assert.ok(labels.includes("Questions & Answers"));
	assert.ok(labels.includes("Part A"));
	assert.ok(labels.includes("Part C"));

	const qaSec = comp.affectedSections.find((s) => s.label === "Questions & Answers");
	assert.equal(qaSec?.status, "removed");
	assert.ok(qaSec?.removed > 0);

	const partCSec = comp.affectedSections.find((s) => s.label === "Part C");
	assert.equal(partCSec?.status, "added");
	assert.ok(partCSec?.added > 0);

	assert.ok(comp.changeMapLines && comp.changeMapLines.length > 0);
	assert.match(comp.changeMapLines[0], /Change map \(vs rev 1\):/);
});

test("headings inside fenced code blocks are not treated as section boundaries", () => {
	const planWithFence = `# Plan With Code

## Context
Here is sample code:
\`\`\`markdown
## Fake Heading
### Part Z — Fake Part
\`\`\`
More context.
`;
	const sections = parseDocumentSections(planWithFence.split("\n"));
	assert.equal(sections.length, 2); // Title, Context
	assert.equal(sections[0].label, "Title");
	assert.equal(sections[1].label, "Context");
});

test("deletion-only revision surfaces deletion in change map and keeps current blocks clean", () => {
	const reduced = BASE_PLAN.replace("Initial context line 2.\n", "");
	const comp = computePlanComparison(BASE_PLAN, reduced, 1, 2);
	assert.equal(comp.status, "compared");
	const contextSec = comp.affectedSections?.find((s) => s.label === "Context");
	assert.ok(contextSec);
	assert.equal(contextSec?.removed, 1);
	assert.equal(contextSec?.added, 0);

	// Check that current blocks do not contain the deleted line
	assert.ok(comp.currentBlocks?.every((b) => !b.text.includes("Initial context line 2.")));
});
