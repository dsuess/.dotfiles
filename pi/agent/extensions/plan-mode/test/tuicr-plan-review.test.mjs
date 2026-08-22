import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
} });
const { normalizeTuicrComments, runTuicrPlanReview } = await jiti.import(new URL("../tuicr-plan-review.ts", import.meta.url).pathname);

const PLAN = "# Review plan\n\n## Context\n\nExact validated revision.\n";

function processResult({ status = 0, signal = null, stdout = "", stderr = "", error } = {}) {
	return { pid: 123, output: [], status, signal, stdout, stderr, error };
}

function rawComment(overrides = {}) {
	return {
		id: "comment-1",
		location: "plan.md:4",
		path: "plan.md",
		start_line: 4,
		end_line: 4,
		side: "new",
		comment_type: "issue",
		lifecycle_state: "local_draft",
		created_at: "2026-08-10T10:00:00Z",
		content: "Tighten this outcome.",
		...overrides,
	};
}

function sessionFor(options) {
	return {
		slug: "snapshot@file",
		kind: "local",
		path: path.join(options.env.XDG_DATA_HOME, "tuicr", "reviews", "sessions", "session.json"),
		updated_at: "2026-08-10T10:00:00Z",
		comment_count: 1,
		reviewed_count: 0,
		file_count: 1,
		anchor: "file",
		active: false,
	};
}

function compatibleSpawn(scenario = {}) {
	const calls = [];
	const spawn = (_command, args, options) => {
		calls.push({ args: [...args], options });
		if (args[0] === "--version") return scenario.version ?? processResult({ stdout: "tuicr 0.19.1\n" });
		if (args.length === 1 && args[0] === "--help") {
			return scenario.rootHelp ?? processResult({ stdout: "--file --theme --no-update-check review" });
		}
		if (args.join(" ") === "review list --help") return processResult({ stdout: "--all" });
		if (args.join(" ") === "review comments --help") return processResult({ stdout: "--session" });
		if (args[0] === "--file") {
			scenario.onLaunch?.(args, options);
			return scenario.launch ?? processResult();
		}
		if (args.join(" ") === "review list --all") {
			if (scenario.list) return scenario.list(args, options);
			return processResult({ stdout: JSON.stringify([sessionFor(options)]) });
		}
		if (args[0] === "review" && args[1] === "comments") {
			if (scenario.comments) return scenario.comments(args, options);
			return processResult({ stdout: JSON.stringify([rawComment()]) });
		}
		throw new Error(`Unexpected tuicr call: ${args.join(" ")}`);
	};
	return { calls, spawn };
}

async function createHarness({ mode = "tui", custom } = {}) {
	const project = await mkdtemp(path.join(os.tmpdir(), "pi-tuicr-review-test-"));
	const planPath = path.join(project, "plan.md");
	await writeFile(planPath, PLAN);
	const terminal = { stops: 0, starts: 0, renders: 0 };
	let customCalls = 0;
	const ctx = {
		mode,
		cwd: project,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			async custom(factory) {
				customCalls += 1;
				if (custom) return custom(factory, terminal);
				return new Promise((resolve) => factory({
					stop() { terminal.stops += 1; },
					start() { terminal.starts += 1; },
					requestRender(force) { if (force) terminal.renders += 1; },
				}, {}, {}, resolve));
			},
		},
	};
	return {
		ctx, planPath, terminal,
		get customCalls() { return customCalls; },
		async cleanup() { await rm(project, { recursive: true, force: true }); },
	};
}

async function assertPlanUnchanged(harness) {
	assert.equal(await readFile(harness.planPath, "utf8"), PLAN);
}

test("runs a compatible tuicr review in isolated storage and restores Pi's terminal", async () => {
	const harness = await createHarness();
	let reviewedSnapshot;
	const fake = compatibleSpawn({
		onLaunch(args, options) {
			reviewedSnapshot = args[1];
			assert.deepEqual(args.slice(2), ["--theme", "pi-plan-review-mocha", "--no-update-check"]);
			assert.equal(options.cwd, path.dirname(args[1]));
			assert.match(options.env.XDG_CONFIG_HOME, /pi-plan-tuicr-/);
			assert.notEqual(options.env.XDG_CONFIG_HOME, process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, ".config"));
			assert.notEqual(options.env.HOME, process.env.HOME);
			assert.match(options.env.XDG_DATA_HOME, /pi-plan-tuicr-/);
			const themes = path.join(options.env.XDG_CONFIG_HOME, "tuicr", "themes");
			const theme = readFileSync(path.join(themes, "pi-plan-review-mocha.toml"), "utf8");
			const syntaxTheme = readFileSync(path.join(themes, "pi-plan-review-mocha-markdown.tmTheme"), "utf8");
			const panelBackground = theme.match(/^panel_bg = "(#[0-9a-f]{6})"$/m)?.[1];
			const dimForeground = theme.match(/^fg_dim = "(#[0-9a-f]{6})"$/m)?.[1];
			assert.equal(panelBackground, "#1e1e2e");
			assert.equal(dimForeground, panelBackground);
			assert.match(theme, /^syntax_theme = "pi-plan-review-mocha-markdown\.tmTheme"$/m);
			assert.match(theme, /^diff_add = "#cdd6f4"$/m);
			assert.match(theme, /^diff_add_bg = "#1e1e2e"$/m);
			assert.match(theme, /^syntax_add_bg = "#1e1e2e"$/m);
			assert.match(syntaxTheme, /Pi Plan Review Mocha Markdown/);
			assert.match(syntaxTheme, /markup\.heading\.markdown/);
		},
	});
	try {
		const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, { spawn: fake.spawn });
		assert.equal(result.ok, true);
		assert.equal(result.comments.length, 1);
		assert.deepEqual(result.comments[0].location, {
			kind: "line", path: harness.planPath, startLine: 4, endLine: 4, side: "new",
		});
		assert.equal(await readFile(reviewedSnapshot, "utf8").catch(() => "removed"), "removed");
		assert.deepEqual(harness.terminal, { stops: 1, starts: 1, renders: 1 });
		await assertPlanUnchanged(harness);
	} finally { await harness.cleanup(); }
});

test("rejects unsupported hosts before starting tuicr", async () => {
	for (const mode of ["rpc", "print", "json"]) {
		const harness = await createHarness({ mode });
		const fake = compatibleSpawn();
		try {
			const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, { spawn: fake.spawn });
			assert.equal(result.ok, false);
			assert.match(result.error, /interactive TUI mode/);
			assert.equal(fake.calls.length, 0);
			assert.equal(harness.customCalls, 0);
			await assertPlanUnchanged(harness);
		} finally { await harness.cleanup(); }
	}
});

test("reports missing and incompatible tuicr executables without opening the TUI", async () => {
	for (const fake of [
		compatibleSpawn({ version: processResult({ status: null, error: Object.assign(new Error("spawn tuicr ENOENT"), { code: "ENOENT" }) }) }),
		compatibleSpawn({ version: processResult({ stdout: "tuicr 0.18.0\n" }) }),
		compatibleSpawn({ rootHelp: processResult({ stdout: "review only" }) }),
	]) {
		const harness = await createHarness();
		try {
			const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, { spawn: fake.spawn });
			assert.equal(result.ok, false);
			assert.equal(result.level, "warning");
			assert.equal(harness.customCalls, 0);
			await assertPlanUnchanged(harness);
		} finally { await harness.cleanup(); }
	}
});

test("restores the terminal after non-zero, signal, and thrown launch failures", async () => {
	for (const launch of [
		processResult({ status: 2, stderr: "bad target" }),
		processResult({ status: null, signal: "SIGTERM" }),
		"throw",
	]) {
		const harness = await createHarness();
		const fake = compatibleSpawn(launch === "throw" ? {
			onLaunch() { throw new Error("spawn exploded"); },
		} : { launch });
		try {
			const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, { spawn: fake.spawn });
			assert.equal(result.ok, false);
			assert.deepEqual(harness.terminal, { stops: 1, starts: 1, renders: 1 });
			await assertPlanUnchanged(harness);
		} finally { await harness.cleanup(); }
	}
});

test("leaves approval reusable when the custom UI is cancelled before launch", async () => {
	const harness = await createHarness({ custom: async () => undefined });
	const fake = compatibleSpawn();
	try {
		const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, { spawn: fake.spawn });
		assert.equal(result.ok, false);
		assert.match(result.error, /cancelled before launch/);
		assert.deepEqual(harness.terminal, { stops: 0, starts: 0, renders: 0 });
		await assertPlanUnchanged(harness);
	} finally { await harness.cleanup(); }
});

const malformedScenarios = [
	["malformed list JSON", { list: () => processResult({ stdout: "not-json" }) }, /malformed JSON/],
	["absent session", { list: () => processResult({ stdout: "[]" }) }, /No saved tuicr comments/],
	["multiple sessions", { list: (_args, options) => processResult({ stdout: JSON.stringify([sessionFor(options), sessionFor(options)]) }) }, /Expected one isolated/],
	["malformed comments JSON", { comments: () => processResult({ stdout: "{}" }) }, /JSON array/],
	["empty comments", { comments: () => processResult({ stdout: "[]" }) }, /No saved tuicr comments/],
	["duplicate IDs", { comments: () => processResult({ stdout: JSON.stringify([rawComment(), rawComment()]) }) }, /duplicate comment id/],
	["invalid range", { comments: () => processResult({ stdout: JSON.stringify([rawComment({ start_line: 9, end_line: 4 })]) }) }, /invalid line range/],
	["empty content", { comments: () => processResult({ stdout: JSON.stringify([rawComment({ content: "  " })]) }) }, /empty content/],
	["inconsistent location", { comments: () => processResult({ stdout: JSON.stringify([rawComment({ location: "wrong.md:4" })]) }) }, /inconsistent location fields/],
];

for (const [name, scenario, message] of malformedScenarios) {
	test(`rejects ${name} without changing the canonical plan`, async () => {
		const harness = await createHarness();
		const fake = compatibleSpawn(scenario);
		try {
			const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, { spawn: fake.spawn });
			assert.equal(result.ok, false);
			assert.match(result.error, message);
			assert.deepEqual(harness.terminal, { stops: 1, starts: 1, renders: 1 });
			await assertPlanUnchanged(harness);
		} finally { await harness.cleanup(); }
	});
}

test("rejects snapshot edits made through tuicr", async () => {
	const harness = await createHarness();
	const fake = compatibleSpawn({ onLaunch(args) { writeFileSync(args[1], `${PLAN}\nchanged`); } });
	try {
		const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, { spawn: fake.spawn });
		assert.equal(result.ok, false);
		assert.match(result.error, /review snapshot changed/);
		assert.deepEqual(harness.terminal, { stops: 1, starts: 1, renders: 1 });
		await assertPlanUnchanged(harness);
	} finally { await harness.cleanup(); }
});

test("rejects a successful review when isolated cleanup fails", async () => {
	const harness = await createHarness();
	const fake = compatibleSpawn();
	try {
		const result = await runTuicrPlanReview(harness.ctx, harness.planPath, PLAN, {
			spawn: fake.spawn,
			async removeReviewRoot(reviewRoot) {
				await rm(reviewRoot, { recursive: true, force: true });
				throw new Error("simulated cleanup failure");
			},
		});
		assert.equal(result.ok, false);
		assert.match(result.error, /clean up isolated tuicr review data/);
		assert.deepEqual(harness.terminal, { stops: 1, starts: 1, renders: 1 });
		await assertPlanUnchanged(harness);
	} finally { await harness.cleanup(); }
});

test("normalizes review, file, line, and range comments with advisory types", () => {
	const canonical = "/project/.pi/plans/review.md";
	const comments = normalizeTuicrComments([
		rawComment({ id: "review", location: "review", path: null, start_line: null, end_line: null, side: null, comment_type: "none", content: "  Overall feedback.  " }),
		rawComment({ id: "file", location: "plan.md", start_line: null, end_line: null, side: null, comment_type: null }),
		rawComment({ id: "line", location: "plan.md:7 [old]", start_line: 7, end_line: 7, side: "old", comment_type: "note" }),
		rawComment({ id: "range", location: "plan.md:10-14", start_line: 10, end_line: 14, side: "new", comment_type: "suggestion" }),
	], canonical);
	assert.deepEqual(comments.map((comment) => comment.location.kind), ["review", "file", "line", "range"]);
	assert.deepEqual(comments.map((comment) => comment.commentType), [null, null, "note", "suggestion"]);
	assert.equal(comments[0].content, "Overall feedback.");
	assert.equal(comments[2].location.side, "old");
	assert.equal(comments[3].location.path, canonical);
});
