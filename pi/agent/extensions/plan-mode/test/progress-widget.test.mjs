import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDocumentStepProgressRows,
	buildStepProgressRows,
	getDocumentProgressTasks,
} from "../progress-widget.js";
import { parsePlanDocument } from "../plan-document.js";
import { SMALL_PLAN, VALID_PLAN } from "./fixtures.mjs";

const tasks = [
	{ id: "1", title: "Not started" },
	{ id: "2", title: "Work underway" },
	{ id: "3", title: "Verified" },
	{ id: "4", title: "Waiting on access" },
];

const ledger = {
	1: { status: "pending" },
	2: { status: "in_progress" },
	3: { status: "completed" },
	4: { status: "blocked" },
};

test("shows every step in plan order with title-only labels and all status icons", () => {
	assert.deepEqual(buildStepProgressRows({ plan: { tasks }, ledger }), [
		"☐ Not started",
		"▶ Work underway",
		"☑ Verified",
		"⛔ Waiting on access",
	]);
});

test("step rows are independent of explicit or implicit execution-stage grouping", () => {
	const explicit = parsePlanDocument(VALID_PLAN);
	const implicit = parsePlanDocument(SMALL_PLAN);
	assert.equal(explicit.ok, true);
	assert.equal(implicit.ok, true);
	assert.deepEqual(buildDocumentStepProgressRows(explicit.document), [
		"☐ Define the cache behavior",
		"▶ Add reliable invalidation",
		"⛔ Cover boundary conditions",
	]);
	assert.deepEqual(buildDocumentStepProgressRows(implicit.document), [
		"☐ Clarify the cache lifecycle",
	]);
	assert.deepEqual(getDocumentProgressTasks(explicit.document).map((task) => task.id), ["1", "2", "3"]);
});

test("each row changes independently when its ledger entry transitions or reopens", () => {
	const state = { plan: { tasks }, ledger: structuredClone(ledger) };
	state.ledger[1].status = "in_progress";
	state.ledger[3].status = "in_progress";
	assert.deepEqual(buildStepProgressRows(state), [
		"▶ Not started",
		"▶ Work underway",
		"▶ Verified",
		"⛔ Waiting on access",
	]);
});
