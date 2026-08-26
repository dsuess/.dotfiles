import assert from "node:assert/strict";
import test from "node:test";
import { buildDocumentProgressRows, buildProgressRows, getDocumentProgressTasks } from "../progress-widget.js";
import { parsePlanDocument } from "../plan-document.js";
import { PART_PLAN, PART_PLAN_WITH_QUESTIONS } from "./fixtures.mjs";

const tasks = [
	{ id: "A", title: "Not started" },
	{ id: "B", title: "Work underway" },
	{ id: "C", title: "Verified" },
	{ id: "D", title: "Waiting on access" },
];
const ledger = {
	A: { status: "pending" }, B: { status: "in_progress" }, C: { status: "completed" }, D: { status: "blocked" },
};

test("shows every Part in plan order with title-only labels and status icons", () => {
	assert.deepEqual(buildProgressRows({ plan: { tasks }, ledger }), ["☐ Not started", "▶ Work underway", "☑ Verified", "⛔ Waiting on access"]);
});

test("projects canonical Parts independently of optional question sections", () => {
	const full = parsePlanDocument(PART_PLAN);
	const answered = parsePlanDocument(PART_PLAN_WITH_QUESTIONS);
	assert.equal(full.ok, true); assert.equal(answered.ok, true);
	assert.deepEqual(buildDocumentProgressRows(full.document), ["☐ Define cache consistency", "☐ Implement reliable invalidation", "☐ Cover boundary behavior"]);
	assert.deepEqual(getDocumentProgressTasks(answered.document).map((part) => part.id), ["A", "B"]);
});
