import assert from "node:assert/strict";
import test from "node:test";
import { fmtTokens, selectContextDisplay } from "./statusbar-context.ts";

test("selectContextDisplay uses one current-usage snapshot", () => {
	assert.deepEqual(
		selectContextDisplay({ tokens: 12_345, percent: 12.3 }),
		{ count: "12.3k", gaugePercent: 12.3 },
	);
});

test("selectContextDisplay replaces pre-compaction usage after a post-compaction response", () => {
	const beforeCompaction = selectContextDisplay({ tokens: 180_000, percent: 90 });
	const afterCompaction = selectContextDisplay({ tokens: null, percent: null });
	const afterResponse = selectContextDisplay({ tokens: 24_000, percent: 12 });

	assert.deepEqual(beforeCompaction, { count: "180.0k", gaugePercent: 90 });
	assert.deepEqual(afterCompaction, { count: "?", gaugePercent: undefined });
	assert.deepEqual(afterResponse, { count: "24.0k", gaugePercent: 12 });
});

test("selectContextDisplay renders missing usage as unknown", () => {
	assert.deepEqual(
		selectContextDisplay(undefined),
		{ count: "?", gaugePercent: undefined },
	);
});

test("fmtTokens keeps compact context-count formatting", () => {
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1_000), "1.0k");
	assert.equal(fmtTokens(1_250_000), "1.3M");
});

test("selectContextDisplay clamps only the gauge percentage", () => {
	assert.deepEqual(
		selectContextDisplay({ tokens: 250_000, percent: 125 }),
		{ count: "250.0k", gaugePercent: 100 },
	);
});
