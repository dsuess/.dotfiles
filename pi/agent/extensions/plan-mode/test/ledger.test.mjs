import assert from "node:assert/strict";
import test from "node:test";
import { immutablePlanHash, synchronizeLedgerMarkdown, updateLedgerMarkdown } from "../ledger.js";
import { parsePlanDocument, renderPlanDocument, replaceManagedProgressReport, splitManagedProgressReport } from "../plan-document.js";
import { PART_PLAN, VALID_PLAN, VERSION_2_PLAN } from "./fixtures.mjs";

test("updates exactly one status and ledger note while preserving canonical parsing", () => {
	const next = updateLedgerMarkdown(VALID_PLAN, VALID_PLAN, "1", {
		status: "in_progress", note: "started", evidence: null,
	});
	assert.match(next, /### Step 1 \[in_progress\] Define the cache behavior/);
	assert.match(next, /- \*\*Ledger:\*\* \{"status":"in_progress","note":"started","evidence":null\}/);
	assert.equal(parsePlanDocument(next).ok, true);
	assert.equal(immutablePlanHash(next), immutablePlanHash(VALID_PLAN));
});

test("persists Part status only in managed metadata and a Part progress report", () => {
	const next = updateLedgerMarkdown(PART_PLAN, PART_PLAN, "A", {
		status: "in_progress", note: "started", evidence: null,
	});
	assert.match(next, /### Part A — Define cache consistency\n- \*\*Ledger:\*\* \{"status":"in_progress"/);
	assert.doesNotMatch(next, /Part A \[in_progress\]/);
	const parsed = parsePlanDocument(next);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
	assert.equal(parsed.document.parts[0].status, "in_progress");
	assert.equal(renderPlanDocument(parsed.document), next);
	assert.equal(splitManagedProgressReport(next).report.heading, "## Part Progress");
	assert.deepEqual(splitManagedProgressReport(next).report.rows, [
		"▶ Define cache consistency",
		"☐ Implement reliable invalidation",
		"☐ Cover boundary behavior",
	]);
	assert.equal(immutablePlanHash(next), immutablePlanHash(PART_PLAN));
});

test("serial Part updates preserve headings and immutable approved content", () => {
	const next = synchronizeLedgerMarkdown(PART_PLAN, PART_PLAN, {
		A: { status: "completed", note: null, evidence: "contract verified" },
		B: { status: "in_progress", note: null, evidence: null },
		C: { status: "blocked", note: "race unresolved", evidence: "canary failed" },
	});
	assert.match(next, /### Part A — Define cache consistency/);
	assert.match(next, /### Part B — Implement reliable invalidation/);
	assert.match(next, /### Part C — Cover boundary behavior/);
	assert.equal((next.match(/- \*\*Ledger:\*\*/g) ?? []).length, 3);
	assert.deepEqual(splitManagedProgressReport(next).report.rows, [
		"☑ Define cache consistency",
		"▶ Implement reliable invalidation",
		"⛔ Cover boundary behavior",
	]);
	assert.equal(immutablePlanHash(next), immutablePlanHash(PART_PLAN));
});

test("uses the shared Step projection for the trailing report", () => {
	const next = updateLedgerMarkdown(VALID_PLAN, VALID_PLAN, "1", {
		status: "completed", note: null, evidence: "verified",
	});
	assert.deepEqual(splitManagedProgressReport(next).report.rows, [
		"☑ Define the cache behavior",
		"▶ Add reliable invalidation",
		"⛔ Cover boundary conditions",
	]);
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

test("synchronizes every durable ledger item and safely backfills a missing report", () => {
	const next = synchronizeLedgerMarkdown(VALID_PLAN, VALID_PLAN, {
		1: { status: "completed", note: null, evidence: "first done" },
		2: { status: "blocked", note: "waiting", evidence: "access denied" },
		3: { status: "in_progress", note: "reopened", evidence: null },
	});
	assert.match(next, /### Step 1 \[completed\]/);
	assert.match(next, /### Step 2 \[blocked\]/);
	assert.match(next, /### Step 3 \[in_progress\]/);
	assert.equal((next.match(/- \*\*Ledger:\*\*/g) ?? []).length, 3);
	assert.deepEqual(splitManagedProgressReport(next).report.rows, [
		"☑ Define the cache behavior",
		"⛔ Add reliable invalidation",
		"▶ Cover boundary conditions",
	]);
});

test("regenerates a well-formed mutable report but rejects malformed or ambiguous markers", () => {
	const stale = replaceManagedProgressReport(VALID_PLAN, ["☑ Stale generated row"]);
	const next = updateLedgerMarkdown(stale, replaceManagedProgressReport(VALID_PLAN, ["☐ Approved row"]), "1", {
		status: "in_progress", note: null, evidence: null,
	});
	assert.deepEqual(splitManagedProgressReport(next).report.rows, [
		"▶ Define the cache behavior",
		"▶ Add reliable invalidation",
		"⛔ Cover boundary conditions",
	]);
	assert.throws(
		() => immutablePlanHash(`${stale}\n<!-- pi-plan-mode:progress:start -->\n`),
		/at most one managed progress report/,
	);
});

test("rejects non-ledger drift instead of overwriting user edits", () => {
	const drifted = VALID_PLAN.replace("Stale cache entries survive", "Cache entries survive");
	assert.throws(
		() => updateLedgerMarkdown(drifted, VALID_PLAN, "1", { status: "in_progress", note: null, evidence: null }),
		/content drifted/,
	);
});
