import assert from "node:assert/strict";
import test from "node:test";
import { createPiJiti, piPackageRoot } from "../../../../test-helpers.mjs";

const core = await import(`${piPackageRoot}/dist/index.js`);
const tuiPackage = await import(`${piPackageRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`);
await core.initTheme("dark", false);

const jiti = await createPiJiti(import.meta.url);
const rendererModule = await jiti.import(new URL("../plan-renderer.ts", import.meta.url).pathname);
const { registerPlanRenderer, PLAN_DISPLAY_ENTRY } = rendererModule;

const theme = {
	fg: (color, text) => {
		if (color === "success") return `\x1b[32m${text}\x1b[39m`;
		if (color === "warning") return `\x1b[33m${text}\x1b[39m`;
		if (color === "accent") return `\x1b[35m${text}\x1b[39m`;
		if (color === "dim") return `\x1b[90m${text}\x1b[39m`;
		return text;
	},
	bg: (_color, text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
};

function getPlanRenderer() {
	let renderer;
	registerPlanRenderer({
		registerEntryRenderer(name, fn) {
			if (name === PLAN_DISPLAY_ENTRY) renderer = fn;
		},
	});
	return renderer;
}

const BASE_PLAN = `# Core Plan

## Context
Initial context line 1.
Initial context line 2 that is fairly long and will wrap across several terminal lines.

## Approach
Preamble.

### Part A — First
Details of Part A.

## Verification
Testing steps.
`;

const REVISED_PLAN = `# Core Plan

## Context
Initial context line 1.
Edited context line 2 that is fairly long and will wrap across several terminal lines.

## Approach
Preamble.

### Part A — First
Details of Part A.
Extra line for Part A.

### Part B — Second
New Part B details.

## Verification
Testing steps.
`;

test("first candidate renders Plan candidate — revision 1 without change statistics", () => {
	const renderer = getPlanRenderer();
	const container = renderer({
		data: {
			markdown: BASE_PLAN,
			path: "/project/.pi/plans/test.md",
			revision: 1,
			hash: "hash-1",
		},
	}, { expanded: false }, theme);

	const lines = container.render(80);
	assert.ok(lines.some((line) => line.includes("Plan candidate — revision 1")));
	assert.ok(!lines.some((line) => line.includes("Approved plan candidate")));
	assert.ok(!lines.some((line) => line.includes("Change map")));
});

test("historical entry without baseline metadata keeps plain full-plan rendering", () => {
	const renderer = getPlanRenderer();
	const container = renderer({
		data: {
			markdown: BASE_PLAN,
			path: "/project/.pi/plans/test.md",
			revision: 2,
			hash: "hash-2",
		},
	}, { expanded: false }, theme);

	const lines = container.render(80);
	assert.ok(lines.some((line) => line.includes("Plan candidate — revision 2")));
	assert.ok(!lines.some((line) => line.includes("Change map")));
});

test("unavailable comparison renders explicit comparison unavailable label", () => {
	const renderer = getPlanRenderer();
	const container = renderer({
		data: {
			markdown: BASE_PLAN,
			path: "/project/.pi/plans/test.md",
			revision: 2,
			hash: "hash-2",
			baseline: null,
		},
	}, { expanded: false }, theme);

	const lines = container.render(80);
	assert.ok(lines.some((line) => line.includes("Plan candidate — revision 2 (comparison unavailable)")));
	assert.ok(!lines.some((line) => line.includes("Change map")));
});

test("identical revision renders explicit no authored changes label", () => {
	const renderer = getPlanRenderer();
	const container = renderer({
		data: {
			markdown: BASE_PLAN,
			path: "/project/.pi/plans/test.md",
			revision: 2,
			hash: "hash-1",
			baseline: {
				revision: 1,
				path: "/project/.pi/plans/test.md",
				hash: "hash-1",
				authoredHash: "hash-1",
				markdown: BASE_PLAN,
			},
		},
	}, { expanded: false }, theme);

	const lines = container.render(80);
	assert.ok(lines.some((line) => line.includes("Plan candidate — revision 2 (no authored changes since revision 1)")));
	assert.ok(!lines.some((line) => line.includes("Change map")));
});

test("revised candidate renders change map and marked current plan", () => {
	const renderer = getPlanRenderer();
	const container = renderer({
		data: {
			markdown: REVISED_PLAN,
			path: "/project/.pi/plans/test.md",
			revision: 2,
			hash: "hash-2",
			baseline: {
				revision: 1,
				path: "/project/.pi/plans/test.md",
				hash: "hash-1",
				authoredHash: "hash-1",
				markdown: BASE_PLAN,
			},
		},
	}, { expanded: false }, theme);

	const lines = container.render(80);
	assert.ok(lines.some((line) => line.includes("Plan candidate — revision 2 (compared with revision 1)")));
	assert.ok(lines.some((line) => line.includes("Change map (vs rev 1):")));
	assert.ok(lines.some((line) => line.includes("Context:")));
	assert.ok(lines.some((line) => line.includes("Part A:")));
	assert.ok(lines.some((line) => line.includes("Part B:")));

	// Addition and modification markers present
	assert.ok(lines.some((line) => line.includes("+")));
	assert.ok(lines.some((line) => line.includes("~")));
});

test("renderer fits all widths without overflow", () => {
	const renderer = getPlanRenderer();
	const container = renderer({
		data: {
			markdown: REVISED_PLAN,
			path: "/project/.pi/plans/test.md",
			revision: 2,
			hash: "hash-2",
			baseline: {
				revision: 1,
				path: "/project/.pi/plans/test.md",
				hash: "hash-1",
				authoredHash: "hash-1",
				markdown: BASE_PLAN,
			},
		},
	}, { expanded: false }, theme);

	for (const width of [24, 35, 60, 100]) {
		const lines = container.render(width);
		assert.ok(lines.every((line) => tuiPackage.visibleWidth(line) <= width), `overflow at width ${width}`);
	}

	container.invalidate();
	const linesAfterInvalidate = container.render(40);
	assert.ok(linesAfterInvalidate.every((line) => tuiPackage.visibleWidth(line) <= 40));
});
