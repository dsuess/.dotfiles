import assert from "node:assert/strict";
import test from "node:test";
import { buildStageProgressRows } from "../progress-widget.js";

const base = {
	plan: {
		stageIds: ["1", "2", "3", "4"],
		taskIds: ["1", "2", "3", "4", "5"],
		stages: [
			{ id: "1", description: "Not started.", taskIds: ["1"] },
			{ id: "2", description: "Work underway.", taskIds: ["2", "3"] },
			{ id: "3", description: "Verified.", taskIds: ["4"] },
			{ id: "4", description: "Waiting on access.", taskIds: ["5"] },
		],
	},
	ledger: {
		1: { status: "pending" },
		2: { status: "completed" },
		3: { status: "in_progress" },
		4: { status: "completed" },
		5: { status: "blocked" },
	},
};

test("shows one described stage row with a status icon", () => {
	assert.deepEqual(buildStageProgressRows(base), [
		"☐ Stage 1 — Not started.",
		"▶ Stage 2 — Work underway.",
		"☑ Stage 3 — Verified.",
		"⛔ Stage 4 — Waiting on access.",
	]);
});

test("falls back safely for restored legacy state", () => {
	assert.deepEqual(buildStageProgressRows({
		plan: { stageIds: ["1"], taskIds: ["1.1"] },
		ledger: { "1.1": { status: "pending" } },
	}), ["☐ Stage 1 — Stage 1"]);
});
