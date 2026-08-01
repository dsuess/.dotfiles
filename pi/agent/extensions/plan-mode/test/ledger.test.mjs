import assert from "node:assert/strict";
import test from "node:test";
import { immutablePlanHash, updateLedgerMarkdown } from "../ledger.js";
import { parsePlanDocument } from "../plan-document.js";
import { VALID_PLAN } from "./fixtures.mjs";

test("updates exactly one status and ledger note while preserving canonical parsing", () => {
	const next = updateLedgerMarkdown(VALID_PLAN, VALID_PLAN, "1.1", {
		status: "in_progress", note: "started", evidence: null,
	});
	assert.match(next, /#### 1\.1 \[in_progress\] Define the cache contract/);
	assert.match(next, /- \*\*Ledger:\*\* \{"status":"in_progress","note":"started","evidence":null\}/);
	assert.equal(parsePlanDocument(next).ok, true);
	assert.equal(immutablePlanHash(next), immutablePlanHash(VALID_PLAN));
});

test("serial ledger updates retain prior task updates", () => {
	const first = updateLedgerMarkdown(VALID_PLAN, VALID_PLAN, "1.1", { status: "completed", note: null, evidence: "test" });
	const second = updateLedgerMarkdown(first, VALID_PLAN, "2.1", { status: "in_progress", note: null, evidence: null });
	assert.match(second, /#### 1\.1 \[completed\]/);
	assert.match(second, /#### 2\.1 \[in_progress\]/);
	assert.equal((second.match(/- \*\*Ledger:\*\*/g) ?? []).length, 2);
});

test("rejects non-ledger drift instead of overwriting user edits", () => {
	const drifted = VALID_PLAN.replace("Invalidate stale cache", "Silently delete cache");
	assert.throws(
		() => updateLedgerMarkdown(drifted, VALID_PLAN, "1.1", { status: "in_progress", note: null, evidence: null }),
		/content drifted/,
	);
});
