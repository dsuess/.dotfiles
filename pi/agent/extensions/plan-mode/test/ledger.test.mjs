import assert from "node:assert/strict";
import test from "node:test";
import { immutablePlanHash, synchronizeLedgerMarkdown, updateLedgerMarkdown } from "../ledger.js";
import { parsePlanDocument, renderPlanDocument, replaceManagedProgressReport, splitManagedProgressReport } from "../plan-document.js";
import { PART_PLAN, PART_PLAN_WITH_QUESTIONS } from "./fixtures.mjs";

test("persists Part status only in extension-owned metadata and Part Progress", () => {
	const next = updateLedgerMarkdown(PART_PLAN, PART_PLAN, "A", { status: "in_progress", note: "started", evidence: null });
	assert.match(next, /### Part A — Define cache consistency\n- \*\*Ledger:\*\* \{"status":"in_progress"/);
	assert.doesNotMatch(next, /Part A \[in_progress\]/);
	const parsed = parsePlanDocument(next);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
	assert.equal(parsed.document.parts[0].status, "in_progress");
	assert.equal(renderPlanDocument(parsed.document), next);
	assert.deepEqual(splitManagedProgressReport(next).report.rows, ["▶ Define cache consistency", "☐ Implement reliable invalidation", "☐ Cover boundary behavior"]);
	assert.equal(immutablePlanHash(next), immutablePlanHash(PART_PLAN));
});

test("serial Part updates retain immutable authored content and answered questions", () => {
	const next = synchronizeLedgerMarkdown(PART_PLAN_WITH_QUESTIONS, PART_PLAN_WITH_QUESTIONS, {
		A: { status: "completed", note: null, evidence: "contract verified" },
		B: { status: "blocked", note: "race unresolved", evidence: "canary failed" },
	});
	assert.equal((next.match(/- \*\*Ledger:\*\*/g) ?? []).length, 2);
	assert.deepEqual(splitManagedProgressReport(next).report.rows, ["☑ Define cache consistency", "⛔ Implement reliable invalidation"]);
	assert.match(next, /\| Should failed writes invalidate a valid cache entry\? \| No\. Retain the last valid value\. \|/);
	assert.equal(immutablePlanHash(next), immutablePlanHash(PART_PLAN_WITH_QUESTIONS));
});

test("regenerates stale reports but rejects drift, forged parts, and malformed markers", () => {
	const stale = replaceManagedProgressReport(PART_PLAN, ["☑ Stale generated row"]);
	const next = updateLedgerMarkdown(stale, replaceManagedProgressReport(PART_PLAN, ["☐ Approved row"]), "A", { status: "in_progress", note: null, evidence: null });
	assert.deepEqual(splitManagedProgressReport(next).report.rows, ["▶ Define cache consistency", "☐ Implement reliable invalidation", "☐ Cover boundary behavior"]);
	assert.throws(() => updateLedgerMarkdown(PART_PLAN.replace("stale entries", "changed entries"), PART_PLAN, "A", { status: "in_progress", note: null, evidence: null }), /content drifted/);
	assert.throws(() => updateLedgerMarkdown(PART_PLAN, PART_PLAN, "1", { status: "in_progress", note: null, evidence: null }), /Unknown Part ID/);
	assert.throws(() => immutablePlanHash(`${stale}\n<!-- pi-plan-mode:progress:start -->\n`), /at most one managed progress report/);
});
