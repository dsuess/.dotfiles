import assert from "node:assert/strict";
import test from "node:test";
import { immutablePlanHash, updateLedgerMarkdown } from "../ledger.js";
import { parsePlanDocument } from "../plan-document.js";
import { VALID_PLAN, VERSION_2_PLAN } from "./fixtures.mjs";

test("updates exactly one status and ledger note while preserving canonical parsing", () => {
	const next = updateLedgerMarkdown(VALID_PLAN, VALID_PLAN, "1", {
		status: "in_progress", note: "started", evidence: null,
	});
	assert.match(next, /### Step 1 \[in_progress\] Define the cache behavior/);
	assert.match(next, /- \*\*Ledger:\*\* \{"status":"in_progress","note":"started","evidence":null\}/);
	assert.equal(parsePlanDocument(next).ok, true);
	assert.equal(immutablePlanHash(next), immutablePlanHash(VALID_PLAN));
});

test("retains the metadata anchor for version 2 plans", () => {
	const next = updateLedgerMarkdown(VERSION_2_PLAN, VERSION_2_PLAN, "1", {
		status: "in_progress", note: null, evidence: "verified",
	});
	assert.match(next, /- \*\*Tools \/ APIs:\*\* edit, `Map.delete`\n- \*\*Ledger:\*\*/);
	assert.equal(parsePlanDocument(next).document.version, 2);
	assert.equal(immutablePlanHash(next), immutablePlanHash(VERSION_2_PLAN));
});

test("serial ledger updates retain prior task updates", () => {
	const first = updateLedgerMarkdown(VALID_PLAN, VALID_PLAN, "1", { status: "completed", note: null, evidence: "test" });
	const second = updateLedgerMarkdown(first, VALID_PLAN, "2", { status: "in_progress", note: null, evidence: null });
	assert.match(second, /### Step 1 \[completed\]/);
	assert.match(second, /### Step 2 \[in_progress\]/);
	assert.equal((second.match(/- \*\*Ledger:\*\*/g) ?? []).length, 2);
});

test("ignores fenced step examples and treats their status as immutable content", () => {
	const withExample = VALID_PLAN.replace(
		"Make invalidation an explicit part of successful writes while preserving the last valid cached value after failed writes.",
		"Make invalidation an explicit part of successful writes while preserving the last valid cached value after failed writes.\n\n```md\n### Step 1 [pending] Example only\n- **Ledger:** example\n```",
	);
	const next = updateLedgerMarkdown(withExample, withExample, "1", {
		status: "in_progress", note: "started", evidence: null,
	});
	assert.match(next, /```md\n### Step 1 \[pending\] Example only\n- \*\*Ledger:\*\* example\n```/);
	assert.match(next, /### Step 1 \[in_progress\] Define the cache behavior/);
	assert.throws(
		() => updateLedgerMarkdown(withExample.replace("### Step 1 [pending] Example only", "### Step 1 [completed] Example only"), withExample, "1", {
			status: "in_progress", note: null, evidence: null,
		}),
		/content drifted/,
	);
});

test("rejects non-ledger drift instead of overwriting user edits", () => {
	const drifted = VALID_PLAN.replace("Stale cache entries survive", "Cache entries survive");
	assert.throws(
		() => updateLedgerMarkdown(drifted, VALID_PLAN, "1", { status: "in_progress", note: null, evidence: null }),
		/content drifted/,
	);
});
