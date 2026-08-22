import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MINIMUM_TUICR_VERSION = [0, 19, 1] as const;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const PLAN_REVIEW_THEME_NAME = "pi-plan-review-mocha";
const PLAN_REVIEW_THEME_SOURCE = new URL("./tuicr-plan-review-theme.toml", import.meta.url);
const PLAN_REVIEW_SYNTAX_THEME_NAME = "pi-plan-review-mocha-markdown.tmTheme";
const PLAN_REVIEW_SYNTAX_THEME_SOURCE = new URL(`./${PLAN_REVIEW_SYNTAX_THEME_NAME}`, import.meta.url);

export type TuicrCommentLocation =
	| { kind: "review"; path: null; startLine: null; endLine: null; side: null }
	| { kind: "file"; path: string; startLine: null; endLine: null; side: null }
	| { kind: "line" | "range"; path: string; startLine: number; endLine: number; side: "old" | "new" };

export interface TuicrPlanComment {
	id: string;
	location: TuicrCommentLocation;
	commentType: string | null;
	lifecycleState: "local_draft" | "pushed_draft" | "submitted";
	content: string;
}

export type TuicrPlanReviewResult =
	| { ok: true; comments: TuicrPlanComment[] }
	| { ok: false; error: string; level: "info" | "warning" };

type Spawn = (
	command: string,
	args: readonly string[],
	options: Parameters<typeof spawnSync>[2],
) => SpawnSyncReturns<string>;

interface ReviewDependencies {
	spawn?: Spawn;
	removeReviewRoot?: (reviewRoot: string) => Promise<void>;
}

interface ProcessOutcome {
	ok: boolean;
	error?: string;
}

function hashBytes(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function commandFailure(label: string, result: SpawnSyncReturns<string>): string | undefined {
	if (result.error) return `${label} could not start: ${result.error.message}`;
	if (result.signal) return `${label} was terminated by signal ${result.signal}`;
	if (result.status !== 0) {
		const detail = result.stderr?.trim();
		return `${label} exited with status ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`;
	}
	return undefined;
}

function parseVersion(output: string): [number, number, number] | null {
	const match = output.trim().match(/^tuicr\s+(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/i);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!;
	}
	return true;
}

function capturedCommand(spawn: Spawn, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> {
	return spawn("tuicr", args, {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
		maxBuffer: MAX_CAPTURE_BYTES,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function checkCompatibility(spawn: Spawn): ProcessOutcome {
	const version = capturedCommand(spawn, ["--version"]);
	const versionFailure = commandFailure("tuicr --version", version);
	if (versionFailure) return { ok: false, error: versionFailure };
	const parsedVersion = parseVersion(version.stdout ?? "");
	if (!parsedVersion || !versionAtLeast(parsedVersion, MINIMUM_TUICR_VERSION)) {
		return { ok: false, error: `tuicr 0.19.1 or newer is required (found ${version.stdout?.trim() || "an unknown version"})` };
	}

	const checks: Array<{ args: string[]; label: string; required: string[] }> = [
		{ args: ["--help"], label: "tuicr --help", required: ["--file", "--theme", "--no-update-check", "review"] },
		{ args: ["review", "list", "--help"], label: "tuicr review list --help", required: ["--all"] },
		{ args: ["review", "comments", "--help"], label: "tuicr review comments --help", required: ["--session"] },
	];
	for (const check of checks) {
		const result = capturedCommand(spawn, check.args);
		const failure = commandFailure(check.label, result);
		if (failure) return { ok: false, error: failure };
		const help = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		const missing = check.required.filter((token) => !help.includes(token));
		if (missing.length > 0) return { ok: false, error: `${check.label} is missing required interface ${missing.join(", ")}` };
	}
	return { ok: true };
}

function parseJsonArray(output: string, label: string): unknown[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch (error) {
		throw new Error(`${label} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`${label} must return a JSON array`);
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSession(value: unknown, reviewRoot: string): { path: string } {
	if (!isRecord(value)) throw new Error("tuicr review list returned an invalid session object");
	for (const field of ["slug", "kind", "path", "updated_at", "anchor"] as const) {
		if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`tuicr session field ${field} must be a non-empty string`);
	}
	for (const field of ["comment_count", "reviewed_count", "file_count"] as const) {
		if (!Number.isInteger(value[field]) || (value[field] as number) < 0) throw new Error(`tuicr session field ${field} must be a non-negative integer`);
	}
	if (typeof value.active !== "boolean") throw new Error("tuicr session field active must be boolean");
	const sessionPath = path.resolve(value.path as string);
	const relative = path.relative(path.resolve(reviewRoot), sessionPath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("tuicr returned a session outside the isolated review root");
	return { path: sessionPath };
}

function nullableString(value: unknown, field: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || value.length === 0) throw new Error(`tuicr comment field ${field} must be a non-empty string or null`);
	return value;
}

function nullableLine(value: unknown, field: string): number | null {
	if (value === null || value === undefined) return null;
	if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`tuicr comment field ${field} must be a positive integer or null`);
	return value as number;
}

export function normalizeTuicrComments(values: unknown[], canonicalPlanPath: string): TuicrPlanComment[] {
	const comments: TuicrPlanComment[] = [];
	const ids = new Set<string>();
	let reviewedPath: string | null = null;
	for (const value of values) {
		if (!isRecord(value)) throw new Error("tuicr review comments returned an invalid comment object");
		if (typeof value.id !== "string" || value.id.trim().length === 0 || value.id !== value.id.trim()) throw new Error("tuicr comment id must be a trimmed non-empty string");
		if (ids.has(value.id)) throw new Error(`tuicr returned duplicate comment id ${value.id}`);
		ids.add(value.id);
		if (typeof value.location !== "string" || value.location.length === 0) throw new Error(`tuicr comment ${value.id} has an invalid location`);
		if (typeof value.content !== "string" || value.content.trim().length === 0) throw new Error(`tuicr comment ${value.id} has empty content`);
		if (typeof value.created_at !== "string" || value.created_at.length === 0) throw new Error(`tuicr comment ${value.id} has an invalid creation timestamp`);
		const commentType = nullableString(value.comment_type, "comment_type");
		const lifecycleState = value.lifecycle_state;
		if (lifecycleState !== "local_draft" && lifecycleState !== "pushed_draft" && lifecycleState !== "submitted") {
			throw new Error(`tuicr comment ${value.id} has an invalid lifecycle state`);
		}
		const commentPath = nullableString(value.path, "path");
		const startLine = nullableLine(value.start_line, "start_line");
		const endLine = nullableLine(value.end_line, "end_line");
		const side = nullableString(value.side, "side");
		let location: TuicrCommentLocation;
		if (commentPath === null) {
			if (value.location !== "review" || startLine !== null || endLine !== null || side !== null) {
				throw new Error(`tuicr comment ${value.id} has an invalid review-level location`);
			}
			location = { kind: "review", path: null, startLine: null, endLine: null, side: null };
		} else if (startLine === null && endLine === null) {
			if (side !== null || value.location !== commentPath) throw new Error(`tuicr comment ${value.id} has an invalid file-level location`);
			if (reviewedPath !== null && reviewedPath !== commentPath) throw new Error("tuicr returned comments for multiple files in a single-file review");
			reviewedPath = commentPath;
			location = { kind: "file", path: canonicalPlanPath, startLine: null, endLine: null, side: null };
		} else {
			if (startLine === null || endLine === null || startLine > endLine) throw new Error(`tuicr comment ${value.id} has an invalid line range`);
			if (side !== "old" && side !== "new") throw new Error(`tuicr comment ${value.id} has an invalid line side`);
			const lines = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
			const expectedLocation = `${commentPath}:${lines}${side === "old" ? " [old]" : ""}`;
			if (value.location !== expectedLocation) throw new Error(`tuicr comment ${value.id} has inconsistent location fields`);
			if (reviewedPath !== null && reviewedPath !== commentPath) throw new Error("tuicr returned comments for multiple files in a single-file review");
			reviewedPath = commentPath;
			location = {
				kind: startLine === endLine ? "line" : "range",
				path: canonicalPlanPath,
				startLine,
				endLine,
				side,
			};
		}
		comments.push({
			id: value.id,
			location,
			commentType: commentType === "none" ? null : commentType,
			lifecycleState,
			content: value.content.trim(),
		});
	}
	return comments;
}

async function prepareIsolatedConfiguration(configHome: string): Promise<void> {
	const originalConfigHome = process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, ".config") : undefined);
	const target = path.join(configHome, "tuicr");
	await mkdir(configHome, { recursive: true, mode: 0o700 });
	if (originalConfigHome) {
		try {
			await cp(path.join(originalConfigHome, "tuicr"), target, { recursive: true, force: false, errorOnExist: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const themes = path.join(target, "themes");
	await mkdir(themes, { recursive: true, mode: 0o700 });
	await Promise.all([
		writeFile(path.join(themes, `${PLAN_REVIEW_THEME_NAME}.toml`), await readFile(PLAN_REVIEW_THEME_SOURCE, "utf8"), {
			encoding: "utf8",
			mode: 0o600,
		}),
		writeFile(path.join(themes, PLAN_REVIEW_SYNTAX_THEME_NAME), await readFile(PLAN_REVIEW_SYNTAX_THEME_SOURCE, "utf8"), {
			encoding: "utf8",
			mode: 0o600,
		}),
	]);
}

function isolatedEnvironment(reviewRoot: string, configHome: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: path.join(reviewRoot, "home"),
		XDG_CONFIG_HOME: configHome,
		XDG_DATA_HOME: path.join(reviewRoot, "data"),
		XDG_CACHE_HOME: path.join(reviewRoot, "cache"),
		XDG_STATE_HOME: path.join(reviewRoot, "state"),
	};
}

async function verifyUnchanged(filePath: string, expectedHash: string, label: string): Promise<void> {
	const current = await readFile(filePath, "utf8");
	if (hashBytes(current) !== expectedHash) throw new Error(`${label} changed during tuicr review`);
}

export async function runTuicrPlanReview(
	ctx: ExtensionContext,
	canonicalPlanPath: string,
	validatedPlan: string,
	dependencies: ReviewDependencies = {},
): Promise<TuicrPlanReviewResult> {
	if (ctx.mode !== "tui") {
		return { ok: false, error: "Plan Review requires interactive TUI mode; use Change to send revision feedback in this host", level: "warning" };
	}
	const spawn: Spawn = dependencies.spawn ?? ((command, args, options) => spawnSync(command, [...args], options) as SpawnSyncReturns<string>);
	const compatibility = checkCompatibility(spawn);
	if (!compatibility.ok) {
		return { ok: false, error: `${compatibility.error}. Install or upgrade tuicr, or use Change instead`, level: "warning" };
	}

	const expectedHash = hashBytes(validatedPlan);
	let reviewRoot: string | undefined;
	let outcome: TuicrPlanReviewResult;
	try {
		await verifyUnchanged(canonicalPlanPath, expectedHash, "The canonical plan");
		reviewRoot = await mkdtemp(path.join(os.tmpdir(), "pi-plan-tuicr-"));
		const home = path.join(reviewRoot, "home");
		const configHome = path.join(reviewRoot, "config");
		const snapshotDir = path.join(reviewRoot, "snapshot");
		await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(snapshotDir, { recursive: true, mode: 0o700 })]);
		await prepareIsolatedConfiguration(configHome);
		const snapshotPath = path.join(snapshotDir, path.basename(canonicalPlanPath));
		await writeFile(snapshotPath, validatedPlan, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await verifyUnchanged(snapshotPath, expectedHash, "The review snapshot");
		const env = isolatedEnvironment(reviewRoot, configHome);

		let launch: ProcessOutcome | undefined;
		try {
			launch = await ctx.ui.custom<ProcessOutcome | undefined>((tui, _theme, _keybindings, done) => {
				let processOutcome: ProcessOutcome;
				tui.stop();
				try {
					const result = spawn("tuicr", ["--file", snapshotPath, "--theme", PLAN_REVIEW_THEME_NAME, "--no-update-check"], {
						cwd: snapshotDir,
						env,
						encoding: "utf8",
						stdio: "inherit",
					});
					const failure = commandFailure("tuicr review", result);
					processOutcome = failure ? { ok: false, error: failure } : { ok: true };
				} catch (error) {
					processOutcome = { ok: false, error: `tuicr review failed: ${error instanceof Error ? error.message : String(error)}` };
				} finally {
					tui.start();
					tui.requestRender(true);
				}
				done(processOutcome);
				return { render: () => [], invalidate: () => {} };
			});
		} catch (error) {
			launch = { ok: false, error: `tuicr review UI failed: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!launch) throw new Error("tuicr review was cancelled before launch");
		if (!launch.ok) throw new Error(launch.error ?? "tuicr review failed");
		await verifyUnchanged(canonicalPlanPath, expectedHash, "The canonical plan");
		await verifyUnchanged(snapshotPath, expectedHash, "The review snapshot");

		const listed = capturedCommand(spawn, ["review", "list", "--all"], env);
		const listFailure = commandFailure("tuicr review list", listed);
		if (listFailure) throw new Error(listFailure);
		const sessions = parseJsonArray(listed.stdout ?? "", "tuicr review list");
		if (sessions.length === 0) {
			outcome = { ok: false, error: "No saved tuicr comments were found; approval remains pending", level: "info" };
		} else {
			if (sessions.length !== 1) throw new Error(`Expected one isolated tuicr session, found ${sessions.length}`);
			const session = validateSession(sessions[0], reviewRoot);
			const retrieved = capturedCommand(spawn, ["review", "comments", "--session", session.path], env);
			const commentsFailure = commandFailure("tuicr review comments", retrieved);
			if (commentsFailure) throw new Error(commentsFailure);
			const comments = normalizeTuicrComments(parseJsonArray(retrieved.stdout ?? "", "tuicr review comments"), canonicalPlanPath);
			if (comments.length === 0) outcome = { ok: false, error: "No saved tuicr comments were found; approval remains pending", level: "info" };
			else outcome = { ok: true, comments };
		}
		await verifyUnchanged(canonicalPlanPath, expectedHash, "The canonical plan");
		await verifyUnchanged(snapshotPath, expectedHash, "The review snapshot");
	} catch (error) {
		outcome = { ok: false, error: error instanceof Error ? error.message : String(error), level: "warning" };
	}

	if (reviewRoot) {
		try {
			await (dependencies.removeReviewRoot ?? ((root) => rm(root, { recursive: true, force: true })))(reviewRoot);
		} catch (error) {
			return { ok: false, error: `Could not clean up isolated tuicr review data: ${error instanceof Error ? error.message : String(error)}`, level: "warning" };
		}
	}
	return outcome!;
}
