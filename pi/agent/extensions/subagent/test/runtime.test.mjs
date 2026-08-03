import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
	ACTIVITY,
	classifyActivity,
	createJsonlParser,
	filterChildTools,
	isInheritedPlanningMode,
	runSubagent,
} from "../runtime.js";

class FakeProcess extends EventEmitter {
	constructor() {
		super();
		this.stdin = new PassThrough();
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		this.stdinText = "";
		this.signals = [];
		this.stdin.setEncoding("utf8");
		this.stdin.on("data", (chunk) => { this.stdinText += chunk; });
	}

	kill(signal = "SIGTERM") {
		this.signals.push(signal);
		return true;
	}
}

class TrackingSignal extends EventTarget {
	aborted = false;
	added = 0;
	removed = 0;

	addEventListener(type, listener, options) {
		if (type === "abort") this.added++;
		return super.addEventListener(type, listener, options);
	}

	removeEventListener(type, listener, options) {
		if (type === "abort") this.removed++;
		return super.removeEventListener(type, listener, options);
	}

	abort() {
		this.aborted = true;
		this.dispatchEvent(new Event("abort"));
	}
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistant({ text = "", model = "resolved-model", provider = "test-provider", stopReason = "stop", usage, errorMessage } = {}) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: text === undefined ? [] : [{ type: "text", text }],
			provider,
			model,
			stopReason,
			errorMessage,
			usage: usage ?? {
				input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: ZERO_COST,
			},
			timestamp: Date.now(),
		},
	};
}

function emitAndClose(proc, events, code = 0, stderr = "") {
	for (const event of events) proc.stdout.write(`${JSON.stringify(event)}\n`);
	if (stderr) proc.stderr.write(stderr);
	proc.stdout.end();
	proc.stderr.end();
	proc.emit("close", code, null);
}

async function waitFor(predicate, message = "condition") {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

function baseOptions(overrides = {}) {
	return {
		prompt: "Inspect the repository and report back.",
		model: "test-provider/requested-model",
		thinkingLevel: "high",
		systemPrompt: "PARENT EFFECTIVE SYSTEM PROMPT",
		activeTools: ["read", "bash"],
		cwd: "/workspace/project",
		planningMode: false,
		...overrides,
	};
}

test("filters recursive and parent-workflow tools without changing the inherited order", () => {
	assert.deepEqual(filterChildTools([
		"read", "subagent", "bash", "submit_plan", "plan_progress", "complete_plan", "complete_stage", "read",
	]), ["read", "bash", "read"]);
});

test("planning inheritance requires both the active workflow marker and effective planning prompt", () => {
	const prompt = "prefix\n[PI PLANNING MODE ACTIVE]\nplanning rules";
	assert.equal(isInheritedPlanningMode(["read", "subagent", "submit_plan"], prompt), true);
	assert.equal(isInheritedPlanningMode(["read", "subagent"], prompt), false);
	assert.equal(isInheritedPlanningMode(["read", "submit_plan"], "ordinary prompt"), false);
});

test("incremental JSONL parsing handles split, multiple, trailing, malformed, and non-event records", () => {
	const events = [];
	const malformed = [];
	const parser = createJsonlParser({
		onEvent: (event) => events.push(event),
		onMalformed: (line) => malformed.push(line),
	});
	parser.push('{"type":"agent_');
	parser.push('start"}\nnot json\n{"type":"turn_start"}\n{"hello":true}\n{"type":"agent_end"');
	parser.push(",\"messages\":[]}");
	parser.end();
	assert.deepEqual(events.map((event) => event.type), ["agent_start", "turn_start", "agent_end"]);
	assert.deepEqual(malformed, ["not json", '{"hello":true}']);
});

test("classifies observable lifecycle and tool activity without retaining thinking deltas", () => {
	const cases = [
		[{ type: "agent_start" }, "starting", "🚀"],
		[{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } }, "thinking", "🧠"],
		[{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer token" } }, "responding", "💬"],
		[{ type: "tool_execution_start", toolName: "read", args: { path: "/tmp/a.ts" } }, "reading", "📖"],
		[{ type: "tool_execution_start", toolName: "grep", args: { pattern: "needle", path: "src" } }, "searching", "🔎"],
		[{ type: "tool_execution_start", toolName: "ls", args: { path: "src" } }, "listing", "📂"],
		[{ type: "tool_execution_start", toolName: "bash", args: { command: "git status\nrm secret" } }, "shell", "💻"],
		[{ type: "tool_execution_start", toolName: "edit", args: { path: "src/a.ts" } }, "editing", "✏️"],
		[{ type: "tool_execution_start", toolName: "write", args: { path: "src/b.ts" } }, "writing", "📝"],
		[{ type: "tool_execution_start", toolName: "ketch_search", args: { query: "Pi API" } }, "web", "🌐"],
		[{ type: "auto_retry_start", attempt: 2 }, "retrying", "🔄"],
		[{ type: "compaction_start", reason: "threshold" }, "retrying", "🔄"],
		[{ type: "run_complete" }, "completed", "✅"],
		[{ type: "run_failed" }, "failed", "❌"],
		[{ type: "run_cancelled" }, "cancelled", "⛔"],
	];
	for (const [event, kind, emoji] of cases) {
		const activity = classifyActivity(event);
		assert.equal(activity.kind, kind);
		assert.equal(activity.emoji, emoji);
		assert.equal(ACTIVITY[kind].emoji, emoji);
		assert.doesNotMatch(JSON.stringify(activity), /private reasoning|answer token/);
	}
	assert.equal(classifyActivity(cases[6][0]).action, "git status rm secret");
});

test("constructs an inherited ephemeral child, sends the task only on stdin, and cleans its secure prompt file", async () => {
	const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-runtime-test-"));
	const proc = new FakeProcess();
	let spawnCall;
	let promptSnapshot;
	const parentEnv = {
		PATH: "/bin",
		PI_SANDBOX_PROFILE: "inherited-profile",
		PI_SESSION_ID: "parent-id",
		PI_SESSION_FILE: "/parent/session.jsonl",
		PI_PROVIDER: "parent-provider",
		PI_MODEL: "parent-model",
		PI_REASONING_LEVEL: "xhigh",
	};
	try {
		const result = await runSubagent(baseOptions({
			activeTools: ["read", "subagent", "bash", "submit_plan", "plan_progress", "complete_plan", "complete_stage"],
			planningMode: true,
		}), {
			piCommand: "/fake/pi",
			tmpRoot,
			baseEnv: parentEnv,
			spawnImpl(command, args, options) {
				spawnCall = { command, args, options };
				const promptPath = args[args.indexOf("--system-prompt") + 1];
				promptSnapshot = {
					path: promptPath,
					text: readFileSync(promptPath, "utf8"),
					mode: statSync(promptPath).mode & 0o777,
				};
				queueMicrotask(() => emitAndClose(proc, [assistant({ text: "final report" })]));
				return proc;
			},
		});

		assert.equal(spawnCall.command, "/fake/pi");
		assert.equal(spawnCall.options.cwd, "/workspace/project");
		assert.equal(spawnCall.options.shell, false);
		assert.deepEqual(spawnCall.options.stdio, ["pipe", "pipe", "pipe"]);
		for (const pair of [
			["--mode", "json"], ["--model", "test-provider/requested-model"], ["--thinking", "high"],
			["--tools", "read,bash"],
		]) {
			const index = spawnCall.args.indexOf(pair[0]);
			assert.equal(spawnCall.args[index + 1], pair[1], `${pair[0]} inheritance`);
		}
		for (const flag of ["--print", "--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates"]) {
			assert.ok(spawnCall.args.includes(flag), flag);
		}
		assert.equal(spawnCall.args.includes("--no-extensions"), false, "custom extension discovery stays enabled");
		assert.equal(spawnCall.args.includes(baseOptions().prompt), false, "task is not exposed as an argv value");
		assert.equal(proc.stdinText, `${baseOptions().prompt}\n`);
		assert.equal(promptSnapshot.mode, 0o600);
		assert.match(promptSnapshot.text, /^PARENT EFFECTIVE SYSTEM PROMPT/);
		assert.doesNotMatch(promptSnapshot.text, /Inspect the repository/, "delegated task remains solely on stdin");
		assert.match(promptSnapshot.text, /report back/i);
		assert.match(promptSnapshot.text, /cannot invoke nested/i);
		assert.match(promptSnapshot.text, /parent-session workflow tools/i);
		assert.equal(spawnCall.options.env.PI_SUBAGENT_CHILD, "1");
		assert.equal(spawnCall.options.env.PI_SUBAGENT_PLANNING, "1");
		assert.equal(spawnCall.options.env.PI_SANDBOX_PROFILE, "inherited-profile");
		for (const name of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
			assert.equal(spawnCall.options.env[name], undefined, `${name} must not leak from parent`);
			assert.ok(name in parentEnv, `${name} removal must not mutate the parent environment object`);
		}
		assert.equal(result.output, "final report");
		await assert.rejects(stat(promptSnapshot.path), /ENOENT/);
		assert.deepEqual(await readdir(tmpRoot), [], "prompt directory is removed after completion");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("uses --no-tools when filtering leaves no inherited tools", async () => {
	const proc = new FakeProcess();
	let args;
	await runSubagent(baseOptions({ activeTools: ["subagent", "submit_plan", "plan_progress"] }), {
		spawnImpl(_command, childArgs) {
			args = childArgs;
			queueMicrotask(() => emitAndClose(proc, [assistant({ text: "ok" })]));
			return proc;
		},
	});
	assert.ok(args.includes("--no-tools"));
	assert.equal(args.includes("--tools"), false);
});

test("parses split events, aggregates complete nested usage, resolves the actual model, and extracts final text", async () => {
	const proc = new FakeProcess();
	const activities = [];
	const firstUsage = {
		input: 11, output: 3, cacheRead: 7, cacheWrite: 2, cacheWrite1h: 1, reasoning: 2, totalTokens: 23,
		cost: { input: 0.11, output: 0.03, cacheRead: 0.07, cacheWrite: 0.02, total: 0.23 },
	};
	const secondUsage = {
		input: 5, output: 4, cacheRead: 1, cacheWrite: 0, cacheWrite1h: 2, reasoning: 1, totalTokens: 10,
		cost: { input: 0.05, output: 0.04, cacheRead: 0.01, cacheWrite: 0, total: 0.10 },
	};
	const resultPromise = runSubagent(baseOptions({ onActivity: (activity) => activities.push(activity) }), {
		spawnImpl() { return proc; },
	});
	await waitFor(() => proc.stdinText.length > 0, "child stdin");
	const records = [
		{ type: "agent_start" },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "never persist me" } },
		{ type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "/workspace/a.ts" } },
		assistant({ text: "intermediate", model: "actual-one", provider: "actual-provider", usage: firstUsage }),
		assistant({ text: "final\nanswer", model: "actual-two", provider: "actual-provider", usage: secondUsage }),
	];
	const payload = records.map((record) => JSON.stringify(record)).join("\n") + "\nmalformed line\n";
	proc.stdout.write(payload.slice(0, 19));
	proc.stdout.write(payload.slice(19, 83));
	proc.stdout.write(payload.slice(83));
	proc.emit("close", 0, null);
	const result = await resultPromise;

	assert.equal(result.output, "final\nanswer");
	assert.equal(result.details.model, "actual-provider/actual-two");
	assert.equal(result.details.turns, 2);
	assert.equal(result.details.malformedLines, 1);
	assert.deepEqual(result.usage, {
		input: 16, output: 7, cacheRead: 8, cacheWrite: 2, cacheWrite1h: 3, reasoning: 3, totalTokens: 33,
		cost: { input: 0.16, output: 0.07, cacheRead: 0.08, cacheWrite: 0.02, total: 0.33 },
	});
	assert.ok(activities.some((item) => item.kind === "thinking"));
	assert.ok(activities.some((item) => item.kind === "reading" && item.action === "/workspace/a.ts"));
	assert.ok(activities.some((item) => item.kind === "completed"));
	assert.doesNotMatch(JSON.stringify(result.details.activity), /never persist me/);
});

test("coalesces adjacent duplicate activity while preserving meaningful transitions", async () => {
	const proc = new FakeProcess();
	const updates = [];
	const promise = runSubagent(baseOptions({ onActivity: (item) => updates.push(item) }), {
		spawnImpl() { return proc; },
	});
	await waitFor(() => proc.stdinText.length > 0);
	emitAndClose(proc, [
		{ type: "agent_start" },
		{ type: "message_update", assistantMessageEvent: { type: "text_start" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
		{ type: "tool_execution_start", toolName: "read", args: { path: "/workspace/a.ts" } },
		{ type: "tool_execution_start", toolName: "read", args: { path: "/workspace/a.ts" } },
		{ type: "tool_execution_start", toolName: "read", args: { path: "/workspace/b.ts" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_start" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "three" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
		assistant({ text: "done" }),
	]);
	const result = await promise;
	const expected = [
		["starting", undefined],
		["responding", undefined],
		["reading", "/workspace/a.ts"],
		["reading", "/workspace/b.ts"],
		["responding", undefined],
		["completed", undefined],
	];
	const chronology = (items) => items.map((item) => [item.kind, item.action]);
	assert.deepEqual(chronology(updates), expected, "callbacks receive one update per semantic transition");
	assert.deepEqual(chronology(result.details.activity), expected, "retained history matches callback chronology");
});

test("returns explicit no-output text for a successful empty assistant response", async () => {
	const proc = new FakeProcess();
	const promise = runSubagent(baseOptions(), { spawnImpl() { return proc; } });
	await waitFor(() => proc.stdinText.length > 0);
	emitAndClose(proc, [assistant({ text: undefined })]);
	assert.equal((await promise).output, "(no output)");
});

test("surfaces bounded nonzero, provider-error, and stream diagnostics as tool errors", async (t) => {
	await t.test("nonzero exit", async () => {
		const proc = new FakeProcess();
		const promise = runSubagent(baseOptions(), {
			maxDiagnosticBytes: 256,
			spawnImpl() { return proc; },
		});
		await waitFor(() => proc.stdinText.length > 0);
		emitAndClose(proc, [], 2, `model resolution failed ${"x".repeat(2000)}`);
		await assert.rejects(promise, (error) => {
			assert.match(error.message, /model resolution failed/);
			assert.ok(Buffer.byteLength(error.message) < 600);
			return true;
		});
	});

	await t.test("provider stop reason", async () => {
		const proc = new FakeProcess();
		const promise = runSubagent(baseOptions(), { spawnImpl() { return proc; } });
		await waitFor(() => proc.stdinText.length > 0);
		emitAndClose(proc, [assistant({ text: "partial", stopReason: "error", errorMessage: "authentication denied" })]);
		await assert.rejects(promise, /authentication denied/);
	});

	await t.test("stdout stream failure", async () => {
		const proc = new FakeProcess();
		const promise = runSubagent(baseOptions(), { spawnImpl() { return proc; } });
		await waitFor(() => proc.stdinText.length > 0);
		proc.stdout.emit("error", new Error("broken stdout"));
		await assert.rejects(promise, /broken stdout/);
		assert.ok(proc.signals.includes("SIGTERM"));
	});
});

test("propagates spawn failures and cleans temporary prompt state", async () => {
	const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-spawn-error-"));
	const proc = new FakeProcess();
	try {
		const promise = runSubagent(baseOptions(), { tmpRoot, spawnImpl() {
			queueMicrotask(() => proc.emit("error", new Error("ENOENT fake pi")));
			return proc;
		} });
		await assert.rejects(promise, /ENOENT fake pi/);
		assert.deepEqual(await readdir(tmpRoot), []);
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});

test("rejects a pre-aborted run before spawning and removes mid-run abort listeners", async () => {
	const preAborted = new AbortController();
	preAborted.abort();
	let spawnCount = 0;
	await assert.rejects(
		runSubagent(baseOptions({ signal: preAborted.signal }), { spawnImpl() { spawnCount++; return new FakeProcess(); } }),
		/cancelled|aborted/i,
	);
	assert.equal(spawnCount, 0);

	const signal = new TrackingSignal();
	const proc = new FakeProcess();
	const promise = runSubagent(baseOptions({ signal }), {
		killGraceMs: 5,
		spawnImpl() { return proc; },
	});
	await waitFor(() => proc.stdinText.length > 0);
	signal.abort();
	await waitFor(() => proc.signals.includes("SIGTERM"), "SIGTERM");
	await waitFor(() => proc.signals.includes("SIGKILL"), "SIGKILL escalation");
	proc.emit("close", null, "SIGKILL");
	await assert.rejects(promise, /cancelled|aborted/i);
	assert.equal(signal.added, 1);
	assert.equal(signal.removed, 1);
});

test("bounds model-visible output and securely retains the complete answer when truncated", async () => {
	const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-output-limit-"));
	const proc = new FakeProcess();
	const full = Array.from({ length: 12 }, (_, index) => `line-${index} ${"z".repeat(30)}`).join("\n");
	try {
		const promise = runSubagent(baseOptions(), {
			tmpRoot,
			maxOutputBytes: 120,
			maxOutputLines: 3,
			spawnImpl() { return proc; },
		});
		await waitFor(() => proc.stdinText.length > 0);
		emitAndClose(proc, [assistant({ text: full })]);
		const result = await promise;
		assert.match(result.output, /Output truncated/);
		assert.match(result.output, /bytes omitted/);
		assert.match(result.output, /Full output saved to:/);
		assert.ok(result.details.fullOutputPath);
		assert.equal(await readFile(result.details.fullOutputPath, "utf8"), full);
		assert.equal((await stat(result.details.fullOutputPath)).mode & 0o777, 0o600);
		assert.ok(Buffer.byteLength(result.output) < 700, "notice remains bounded");
	} finally {
		await rm(tmpRoot, { recursive: true, force: true });
	}
});
