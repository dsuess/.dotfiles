/**
 * Read-only aggregation and rendering for the global /usage command.
 *
 * "Usage" matches Pi's session-total accounting: assistant, nested-tool,
 * compaction, and branch-summary input/output/cache tokens. The window is 365
 * local calendar days (today plus 364), and copied fork entries are counted once.
 */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const WINDOW_DAYS = 365;

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const ACTIVITY_COLORS = ["#4a4a4a", "#6f4e37", "#965f36", "#c47735", "#f28c28"] as const;
const OVERVIEW_COLOR = ACTIVITY_COLORS[4];

type ThemeRole = "accent" | "dim" | "muted" | "warning";
type ColorMode = "truecolor" | "256color";

type JsonRecord = Record<string, unknown>;

export interface UsageTheme {
	fg(role: ThemeRole, text: string): string;
	bold(text: string): string;
	color(hex: string, text: string): string;
}

interface UsageThemeSource {
	fg(role: ThemeRole, text: string): string;
	bold(text: string): string;
	getColorMode(): ColorMode;
}

function parseHexColor(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

function rgbToAnsi256(red: number, green: number, blue: number): number {
	if (red === green && green === blue) {
		return Math.max(232, Math.min(255, 232 + Math.round((red - 8) / 10)));
	}
	const cube = [0, 95, 135, 175, 215, 255];
	const channel = (value: number) => cube.reduce(
		(closest, candidate, index) =>
			Math.abs(candidate - value) < Math.abs(cube[closest]! - value) ? index : closest,
		0,
	);
	return 16 + 36 * channel(red) + 6 * channel(green) + channel(blue);
}

export function createUsageTheme(theme: UsageThemeSource): UsageTheme {
	return {
		fg: (role, text) => theme.fg(role, text),
		bold: (text) => theme.bold(text),
		color: (hex, text) => {
			const [red, green, blue] = parseHexColor(hex);
			const ansi = theme.getColorMode() === "truecolor"
				? `\x1b[38;2;${red};${green};${blue}m`
				: `\x1b[38;5;${rgbToAnsi256(red, green, blue)}m`;
			return `${ansi}${text}\x1b[39m`;
		},
	};
}

export interface UsageEvent {
	timestamp: number;
	tokens: number;
}

export interface ScanDiagnostics {
	invalidRecords: number;
	malformedLines: number;
	unreadableFiles: number;
}

export interface UsageScanResult {
	events: UsageEvent[];
	diagnostics: ScanDiagnostics;
}

export interface UsageDay {
	date: Date;
	dateKey: string;
	tokens: number;
}

export interface UsageSummary {
	startDate: Date;
	endDate: Date;
	days: UsageDay[];
	totalTokens: number;
	peakTokens: number;
	activeDays: number;
	streak: number;
}

export interface CalendarCell {
	dateKey?: string;
	inRange: boolean;
	level: 0 | 1 | 2 | 3 | 4;
	tokens: number;
}

export interface CalendarWeek {
	cells: CalendarCell[];
}

export interface MonthLabel {
	weekIndex: number;
	label: string;
}

export interface UsageCalendar {
	weeks: CalendarWeek[];
	monthLabels: MonthLabel[];
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyDiagnostics(): ScanDiagnostics {
	return { invalidRecords: 0, malformedLines: 0, unreadableFiles: 0 };
}

function isMissingPath(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function discoverSessionFiles(root: string, diagnostics: ScanDiagnostics): Promise<string[]> {
	const files: string[] = [];
	const directories = [root];

	while (directories.length > 0) {
		const directory = directories.pop()!;
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (directory !== root || !isMissingPath(error)) diagnostics.unreadableFiles++;
			continue;
		}

		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) directories.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}

	return files.sort();
}

function parseTimestamp(entry: JsonRecord, message?: JsonRecord): number | null {
	const messageTimestamp = message?.timestamp;
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
		return messageTimestamp;
	}

	const entryTimestamp = entry.timestamp;
	if (typeof entryTimestamp === "number" && Number.isFinite(entryTimestamp)) {
		return entryTimestamp;
	}
	if (typeof entryTimestamp !== "string") return null;

	const timestamp = Date.parse(entryTimestamp);
	return Number.isFinite(timestamp) ? timestamp : null;
}

function sumUsageTokens(value: unknown): number | null {
	if (!isRecord(value)) return null;
	let total = 0;

	for (const field of TOKEN_FIELDS) {
		const component = value[field];
		if (component === undefined && (field === "cacheRead" || field === "cacheWrite")) continue;
		if (typeof component !== "number" || !Number.isFinite(component) || component < 0) return null;
		total += component;
	}

	return Number.isFinite(total) ? total : null;
}

interface ExtractedUsage {
	event?: UsageEvent;
	fingerprint?: string;
	invalid: boolean;
}

function extractUsage(entry: unknown): ExtractedUsage {
	if (!isRecord(entry)) return { invalid: false };

	let kind: string | undefined;
	let message: JsonRecord | undefined;
	let usage: unknown;

	if (entry.type === "message" && isRecord(entry.message)) {
		message = entry.message;
		if (message.role === "assistant") {
			kind = "message:assistant";
			usage = message.usage;
		} else if (message.role === "toolResult" && message.usage !== undefined) {
			kind = "message:toolResult";
			usage = message.usage;
		}
	} else if (entry.type === "compaction" && entry.usage !== undefined) {
		kind = "compaction";
		usage = entry.usage;
	} else if (entry.type === "branch_summary" && entry.usage !== undefined) {
		kind = "branch_summary";
		usage = entry.usage;
	}

	if (!kind || usage === undefined) return { invalid: false };

	const tokens = sumUsageTokens(usage);
	const timestamp = parseTimestamp(entry, message);
	if (tokens === null || timestamp === null) return { invalid: true };

	const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : undefined;
	return {
		event: { timestamp, tokens },
		fingerprint: id ? `${kind}|${id}|${timestamp}` : undefined,
		invalid: false,
	};
}

async function scanSessionFile(
	path: string,
	events: UsageEvent[],
	seen: Set<string>,
	diagnostics: ScanDiagnostics,
): Promise<void> {
	try {
		const lines = createInterface({
			input: createReadStream(path, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of lines) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				diagnostics.malformedLines++;
				continue;
			}

			const extracted = extractUsage(entry);
			if (extracted.invalid) {
				diagnostics.invalidRecords++;
				continue;
			}
			if (!extracted.event) continue;
			if (extracted.fingerprint) {
				if (seen.has(extracted.fingerprint)) continue;
				seen.add(extracted.fingerprint);
			}
			events.push(extracted.event);
		}
	} catch {
		diagnostics.unreadableFiles++;
	}
}

export async function scanUsage(root: string): Promise<UsageScanResult> {
	const diagnostics = emptyDiagnostics();
	const files = await discoverSessionFiles(root, diagnostics);
	const events: UsageEvent[] = [];
	const seen = new Set<string>();

	for (const file of files) {
		await scanSessionFile(file, events, seen, diagnostics);
	}

	return { events, diagnostics };
}

function startOfLocalDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function localDateKey(date: Date): string {
	const year = date.getFullYear().toString().padStart(4, "0");
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function buildUsageSummary(events: UsageEvent[], now = new Date()): UsageSummary {
	const endDate = startOfLocalDay(now);
	const startDate = addLocalDays(endDate, -(WINDOW_DAYS - 1));
	const days: UsageDay[] = [];
	const byDate = new Map<string, UsageDay>();

	for (let offset = 0; offset < WINDOW_DAYS; offset++) {
		const date = addLocalDays(startDate, offset);
		const day = { date, dateKey: localDateKey(date), tokens: 0 };
		days.push(day);
		byDate.set(day.dateKey, day);
	}

	for (const event of events) {
		if (!Number.isFinite(event.timestamp) || !Number.isFinite(event.tokens) || event.tokens < 0) continue;
		const eventDate = startOfLocalDay(new Date(event.timestamp));
		const day = byDate.get(localDateKey(eventDate));
		if (day) day.tokens += event.tokens;
	}

	const totalTokens = days.reduce((sum, day) => sum + day.tokens, 0);
	const peakTokens = days.reduce((peak, day) => Math.max(peak, day.tokens), 0);
	const activeDays = days.filter((day) => day.tokens > 0).length;

	let streakIndex = days.length - 1;
	if (days[streakIndex]?.tokens === 0) streakIndex--;
	let streak = 0;
	while (streakIndex >= 0 && days[streakIndex]!.tokens > 0) {
		streak++;
		streakIndex--;
	}

	return { startDate, endDate, days, totalTokens, peakTokens, activeDays, streak };
}

function intensityLevel(tokens: number, peakTokens: number): 0 | 1 | 2 | 3 | 4 {
	if (tokens <= 0 || peakTokens <= 0) return 0;
	return Math.min(4, Math.max(1, Math.ceil((tokens / peakTokens) * 4))) as 1 | 2 | 3 | 4;
}

function mondayWeekday(date: Date): number {
	return (date.getDay() + 6) % 7;
}

export function buildCalendar(summary: UsageSummary): UsageCalendar {
	const byDate = new Map(summary.days.map((day) => [day.dateKey, day]));
	const gridStart = addLocalDays(summary.startDate, -mondayWeekday(summary.startDate));
	const gridEnd = addLocalDays(summary.endDate, 6 - mondayWeekday(summary.endDate));
	const weeks: CalendarWeek[] = [];
	const weekByDate = new Map<string, number>();

	for (let cursor = gridStart, weekIndex = 0; cursor.getTime() <= gridEnd.getTime(); weekIndex++) {
		const cells: CalendarCell[] = [];
		for (let weekday = 0; weekday < 7; weekday++) {
			const date = addLocalDays(cursor, weekday);
			const dateKey = localDateKey(date);
			const day = byDate.get(dateKey);
			weekByDate.set(dateKey, weekIndex);
			cells.push(
				day
					? {
						dateKey,
						inRange: true,
						level: intensityLevel(day.tokens, summary.peakTokens),
						tokens: day.tokens,
					}
					: { inRange: false, level: 0, tokens: 0 },
			);
		}
		weeks.push({ cells });
		cursor = addLocalDays(cursor, 7);
	}

	const monthLabels: MonthLabel[] = [];
	const seenMonths = new Set<string>();
	const occupiedWeeks = new Set<number>();
	for (const day of summary.days) {
		const monthKey = `${day.date.getFullYear()}-${day.date.getMonth()}`;
		if (seenMonths.has(monthKey)) continue;
		seenMonths.add(monthKey);
		let weekIndex = weekByDate.get(day.dateKey) ?? 0;
		while (occupiedWeeks.has(weekIndex) && weekIndex < weeks.length - 1) weekIndex++;
		if (occupiedWeeks.has(weekIndex)) continue;
		occupiedWeeks.add(weekIndex);
		monthLabels.push({
			weekIndex,
			label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(day.date),
		});
	}

	return { weeks, monthLabels };
}

function compactNumber(value: number, divisor: number, suffix: string): string {
	const scaled = value / divisor;
	const digits = scaled >= 100 ? 0 : 1;
	return `${scaled.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000_000) return compactNumber(tokens, 1_000_000_000, "B");
	if (tokens >= 1_000_000) return compactNumber(tokens, 1_000_000, "M");
	if (tokens >= 1_000) return compactNumber(tokens, 1_000, "k");
	return Math.round(tokens).toLocaleString("en-US");
}

function metric(theme: UsageTheme, label: string, value: string): string {
	return `${theme.fg("muted", label)} ${theme.color(OVERVIEW_COLOR, theme.bold(value))}`;
}

function renderCell(theme: UsageTheme, cell: CalendarCell): string {
	if (!cell.inRange) return " ";
	return theme.color(ACTIVITY_COLORS[cell.level], "■");
}

function renderMonthLabels(calendar: UsageCalendar, theme: UsageTheme): string {
	let line = " ".repeat(3);
	let calendarColumn = 0;
	for (const month of calendar.monthLabels) {
		const targetColumn = month.weekIndex * 2;
		line += " ".repeat(Math.max(0, targetColumn - calendarColumn));
		line += theme.fg("muted", month.label);
		calendarColumn = targetColumn + month.label.length;
	}
	return line.trimEnd();
}

export function renderUsage(summary: UsageSummary, theme: UsageTheme): string[] {
	const calendar = buildCalendar(summary);
	const lines = [
		theme.fg("accent", "/usage"),
		"",
		`${theme.bold("Token activity")}  ${theme.fg("muted", "last 365 days")}`,
		[
			metric(theme, "1y", formatTokens(summary.totalTokens)),
			metric(theme, "Peak", formatTokens(summary.peakTokens)),
			metric(theme, "Streak", `${summary.streak}d`),
			metric(theme, "Active", `${summary.activeDays}d`),
		].join(theme.fg("dim", " · ")),
		"",
		renderMonthLabels(calendar, theme),
	];

	for (let weekday = 0; weekday < WEEKDAYS.length; weekday++) {
		let row = `${theme.fg("muted", WEEKDAYS[weekday])} `;
		for (const week of calendar.weeks) row += `${renderCell(theme, week.cells[weekday]!)} `;
		lines.push(row.trimEnd());
	}

	lines.push("");
	lines.push(
		`${theme.fg("muted", "Less")} ${ACTIVITY_COLORS.map((color) => theme.color(color, "■")).join(" ")} ${theme.fg("muted", "More")}`,
	);
	return lines;
}

export function skippedRecordCount(diagnostics: ScanDiagnostics): number {
	return diagnostics.invalidRecords + diagnostics.malformedLines + diagnostics.unreadableFiles;
}
