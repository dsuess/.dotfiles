import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildCalendar,
	buildUsageSummary,
	formatTokens,
	renderUsage,
	scanUsage,
	type UsageEvent,
} from "../usage.ts";

function localDate(base: Date, offsetDays = 0, hour = 12): Date {
	return new Date(
		base.getFullYear(),
		base.getMonth(),
		base.getDate() + offsetDays,
		hour,
	);
}

function event(base: Date, offsetDays: number, tokens: number): UsageEvent {
	return { timestamp: localDate(base, offsetDays).getTime(), tokens };
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function line(entry: unknown): string {
	return JSON.stringify(entry);
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-usage-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("scanner includes every billed usage location and deduplicates copied fork entries", async () => {
	await withTempDir(async (root) => {
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		await mkdir(projectA);
		await mkdir(projectB);
		const when = new Date(2026, 7, 1, 10).toISOString();
		const copiedAssistant = {
			type: "message",
			id: "assistant-1",
			timestamp: when,
			message: {
				role: "assistant",
				timestamp: new Date(when).getTime(),
				usage: usage(1, 2, 3, 4),
			},
		};
		await writeFile(
			join(projectA, "one.jsonl"),
			[
				line({ type: "session", id: "session-a", timestamp: when, cwd: "/a" }),
				line(copiedAssistant),
				line({
					type: "message",
					id: "tool-1",
					timestamp: when,
					message: { role: "toolResult", usage: usage(2, 3) },
				}),
				line({ type: "compaction", id: "compact-1", timestamp: when, usage: usage(4, 1) }),
				line({ type: "branch_summary", id: "branch-1", timestamp: when, usage: usage(3, 2) }),
				line({ type: "message", id: "user-1", timestamp: when, message: { role: "user" } }),
				line({ type: "message", timestamp: when, message: { role: "assistant", usage: usage(1, 0) } }),
			].join("\n") + "\n",
		);
		await writeFile(
			join(projectB, "fork.jsonl"),
			[
				line({ type: "session", id: "session-b", timestamp: when, cwd: "/b" }),
				line(copiedAssistant),
				line({ type: "message", timestamp: when, message: { role: "assistant", usage: usage(1, 0) } }),
			].join("\n") + "\n",
		);

		const result = await scanUsage(root);
		assert.equal(result.events.length, 6);
		assert.equal(result.events.reduce((sum, item) => sum + item.tokens, 0), 27);
		assert.deepEqual(result.diagnostics, {
			invalidRecords: 0,
			malformedLines: 0,
			unreadableFiles: 0,
		});
	});
});

test("scanner tolerates missing roots, irrelevant files, malformed JSON, and invalid records", async () => {
	await withTempDir(async (root) => {
		const resultForMissingRoot = await scanUsage(join(root, "missing"));
		assert.deepEqual(resultForMissingRoot.events, []);
		assert.deepEqual(resultForMissingRoot.diagnostics, {
			invalidRecords: 0,
			malformedLines: 0,
			unreadableFiles: 0,
		});

		const project = join(root, "project");
		await mkdir(project);
		await writeFile(join(project, "ignored.txt"), "not a session");
		const when = new Date(2026, 7, 1, 10).toISOString();
		await writeFile(
			join(project, "broken.jsonl"),
			[
				"{not-json",
				line({
					type: "message",
					id: "negative",
					timestamp: when,
					message: { role: "assistant", usage: usage(-1, 2) },
				}),
				line({
					type: "message",
					id: "missing-input",
					timestamp: when,
					message: { role: "assistant", usage: { output: 2 } },
				}),
				line({
					type: "message",
					id: "bad-time",
					timestamp: "not-a-date",
					message: { role: "assistant", usage: usage(1, 2) },
				}),
				line({
					type: "message",
					id: "missing-cache-fields",
					timestamp: when,
					message: { role: "assistant", usage: { input: 3, output: 4 } },
				}),
			].join("\n") + "\n",
		);

		const result = await scanUsage(root);
		assert.equal(result.events.length, 1);
		assert.equal(result.events[0]?.tokens, 7);
		assert.deepEqual(result.diagnostics, {
			invalidRecords: 3,
			malformedLines: 1,
			unreadableFiles: 0,
		});
	});
});

test("scanner reports unreadable session directories without aborting", async () => {
	await withTempDir(async (root) => {
		const unreadable = join(root, "unreadable");
		await mkdir(unreadable);
		await writeFile(join(unreadable, "session.jsonl"), "{}\n");
		await chmod(unreadable, 0o000);
		let result;
		try {
			result = await scanUsage(root);
		} finally {
			await chmod(unreadable, 0o700);
		}
		assert.deepEqual(result.events, []);
		assert.equal(result.diagnostics.unreadableFiles, 1);
	});
});

test("30-day window includes local boundary dates and excludes older and future activity", () => {
	const now = new Date(2026, 7, 1, 18);
	const summary = buildUsageSummary(
		[
			event(now, 0, 5),
			event(now, -29, 10),
			event(now, -30, 100),
			event(now, 1, 200),
		],
		now,
	);
	assert.equal(summary.days.length, 30);
	assert.equal(summary.totalTokens, 15);
	assert.equal(summary.peakTokens, 10);
	assert.equal(summary.activeDays, 2);
	assert.equal(summary.days[0]?.tokens, 10);
	assert.equal(summary.days[29]?.tokens, 5);
});

test("streak allows today grace but stops at the first inactive day", () => {
	const now = new Date(2026, 7, 1, 18);
	assert.equal(buildUsageSummary([event(now, 0, 1), event(now, -1, 1), event(now, -2, 1)], now).streak, 3);
	assert.equal(buildUsageSummary([event(now, -1, 1), event(now, -2, 1)], now).streak, 2);
	assert.equal(buildUsageSummary([event(now, 0, 1), event(now, -2, 1)], now).streak, 1);
	assert.equal(buildUsageSummary([event(now, -2, 1)], now).streak, 0);
	assert.equal(buildUsageSummary([], now).streak, 0);
});

test("calendar uses Sunday-first complete weeks and represents exactly 30 dates", () => {
	const now = new Date(2026, 7, 1, 18);
	const summary = buildUsageSummary([event(now, 0, 40), event(now, -1, 1)], now);
	const calendar = buildCalendar(summary);

	assert.equal(calendar.weeks.length, 5);
	assert.equal(calendar.weeks[0]?.cells[0]?.inRange, false);
	assert.equal(calendar.weeks[0]?.cells[5]?.dateKey, "2026-07-03");
	assert.equal(calendar.weeks[4]?.cells[6]?.dateKey, "2026-08-01");
	assert.equal(calendar.weeks.flatMap((week) => week.cells).filter((cell) => cell.inRange).length, 30);
	assert.deepEqual(calendar.monthLabels, [
		{ weekIndex: 0, label: "Jul" },
		{ weekIndex: 4, label: "Aug" },
	]);
	assert.equal(calendar.weeks[4]?.cells[6]?.level, 4);
	assert.equal(calendar.weeks[4]?.cells[5]?.level, 1);

	const sixWeekCalendar = buildCalendar(buildUsageSummary([], new Date(2026, 7, 2, 18)));
	assert.equal(sixWeekCalendar.weeks.length, 6);
});

test("calendar day stepping remains contiguous around a DST-adjacent month", () => {
	const now = new Date(2026, 9, 10, 18);
	const summary = buildUsageSummary([], now);
	assert.equal(summary.days.length, 30);
	assert.equal(new Set(summary.days.map((day) => day.dateKey)).size, 30);
	for (let index = 1; index < summary.days.length; index++) {
		const previous = summary.days[index - 1]!.date;
		const current = summary.days[index]!.date;
		const expected = new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1);
		assert.equal(current.getTime(), expected.getTime());
	}
});

test("token formatter is compact and trims insignificant zeroes", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_000), "1k");
	assert.equal(formatTokens(1_500), "1.5k");
	assert.equal(formatTokens(1_000_000), "1M");
	assert.equal(formatTokens(1_250_000_000), "1.3B");
});

test("zero-activity render remains valid and avoids intensity division errors", () => {
	const summary = buildUsageSummary([], new Date(2026, 7, 1, 18));
	const theme = {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
	const lines = renderUsage(summary, theme);
	assert.equal(summary.peakTokens, 0);
	assert.ok(lines.some((entry) => entry.includes("30d 0") && entry.includes("Peak 0")));
	const gridLines = lines.filter((entry) => /^(Su|Mo|Tu|We|Th|Fr|Sa) /.test(entry));
	assert.equal(gridLines.join("").split("■").length - 1, 30);
});

test("renderer preserves reference hierarchy, calendar alignment, and semantic intensity order", () => {
	const now = new Date(2026, 7, 1, 18);
	const summary = buildUsageSummary([event(now, 0, 40), event(now, -1, 30), event(now, -2, 20), event(now, -3, 10)], now);
	const identityTheme = {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
	const lines = renderUsage(summary, identityTheme);

	assert.equal(lines[0], "/usage");
	assert.ok(lines.includes("Token activity  last 30 days"));
	assert.ok(lines.some((entry) => entry.includes("30d 100") && entry.includes("Peak 40") && entry.includes("Streak 4d") && entry.includes("Active 4d")));
	assert.ok(lines.some((entry) => entry.includes("Jul") && entry.includes("Aug")));
	for (const weekday of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) {
		assert.equal(lines.filter((entry) => entry.startsWith(`${weekday} `)).length, 1);
	}
	const gridLines = lines.filter((entry) => /^(Su|Mo|Tu|We|Th|Fr|Sa) /.test(entry));
	assert.equal(gridLines.join("").split("■").length - 1, 30);
	assert.equal(lines.at(-1), "Less ■ ■ ■ ■ ■ More");

	const taggedTheme = {
		fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
		bold: (text: string) => `<bold>${text}</bold>`,
	};
	const taggedLegend = renderUsage(summary, taggedTheme).at(-1) ?? "";
	assert.match(taggedLegend, /<dim>■<\/dim>.*<muted>■<\/muted>.*<text>■<\/text>.*<accent>■<\/accent>.*<warning>■<\/warning>/);
});
