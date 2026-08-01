import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EXCLUDED_CHILD_TOOLS = new Set([
	"subagent",
	"submit_plan",
	"plan_progress",
	"complete_plan",
	"complete_stage",
]);

const EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"bash_execution_update",
	// Synthetic events used by the presentation layer and test seams.
	"run_complete",
	"run_failed",
	"run_cancelled",
]);

const NON_EVENT_TYPES = new Set(["session"]);
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 2000;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const DEFAULT_MAX_ACTIVITY = 50;
const DEFAULT_KILL_GRACE_MS = 3000;

export const ACTIVITY = Object.freeze({
	starting: { emoji: "🚀", label: "starting" },
	thinking: { emoji: "🧠", label: "thinking" },
	responding: { emoji: "💬", label: "responding" },
	reading: { emoji: "📖", label: "reading" },
	searching: { emoji: "🔎", label: "searching" },
	listing: { emoji: "📂", label: "listing" },
	shell: { emoji: "💻", label: "shell" },
	editing: { emoji: "✏️", label: "editing" },
	writing: { emoji: "📝", label: "writing" },
	web: { emoji: "🌐", label: "web" },
	retrying: { emoji: "🔄", label: "retrying" },
	completed: { emoji: "✅", label: "completed" },
	failed: { emoji: "❌", label: "failed" },
	cancelled: { emoji: "⛔", label: "cancelled" },
});

function makeActivity(kind, action) {
	const presentation = ACTIVITY[kind];
	if (!presentation) return undefined;
	return {
		kind,
		emoji: presentation.emoji,
		label: presentation.label,
		...(action ? { action } : {}),
	};
}

function compactAction(value, limit = 240) {
	if (typeof value !== "string") return undefined;
	const compact = value.replace(/\s+/g, " ").trim();
	if (!compact) return undefined;
	return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

function firstString(args, names) {
	if (!args || typeof args !== "object") return undefined;
	for (const name of names) {
		if (typeof args[name] === "string") return args[name];
	}
	return undefined;
}

export function classifyActivity(event) {
	if (!event || typeof event !== "object") return undefined;
	switch (event.type) {
		case "agent_start":
			return makeActivity("starting");
		case "message_update": {
			const updateType = event.assistantMessageEvent?.type;
			if (updateType === "thinking_delta" || updateType === "thinking_start" || updateType === "thinking_end") {
				return makeActivity("thinking");
			}
			if (updateType === "text_delta" || updateType === "text_start" || updateType === "text_end") {
				return makeActivity("responding");
			}
			return undefined;
		}
		case "tool_execution_start": {
			const name = typeof event.toolName === "string" ? event.toolName.toLowerCase() : "";
			const args = event.args;
			if (name === "read") return makeActivity("reading", compactAction(firstString(args, ["path", "file_path"])));
			if (name.startsWith("ketch_") || name.includes("web")) {
				return makeActivity("web", compactAction(firstString(args, ["query", "url"])));
			}
			if (name === "grep" || name === "find" || name.includes("search")) {
				return makeActivity("searching", compactAction(firstString(args, ["pattern", "query", "path"])));
			}
			if (name === "ls") return makeActivity("listing", compactAction(firstString(args, ["path"])));
			if (name === "bash") return makeActivity("shell", compactAction(firstString(args, ["command"])));
			if (name === "edit") return makeActivity("editing", compactAction(firstString(args, ["path", "file_path"])));
			if (name === "write") return makeActivity("writing", compactAction(firstString(args, ["path", "file_path"])));
			return makeActivity("responding", compactAction(name));
		}
		case "auto_retry_start":
		case "compaction_start":
		case "summarization_retry_scheduled":
		case "summarization_retry_attempt_start":
			return makeActivity("retrying");
		case "run_complete":
			return makeActivity("completed");
		case "run_failed":
			return makeActivity("failed");
		case "run_cancelled":
			return makeActivity("cancelled");
		default:
			return undefined;
	}
}

export function filterChildTools(activeTools = []) {
	return activeTools.filter((name) => typeof name === "string" && !EXCLUDED_CHILD_TOOLS.has(name));
}

export function isInheritedPlanningMode(activeTools = [], systemPrompt = "") {
	return activeTools.includes("submit_plan") && /\[PI PLANNING MODE ACTIVE\]/.test(systemPrompt);
}

export function createJsonlParser({ onEvent, onMalformed } = {}) {
	let buffer = "";

	const processLine = (rawLine) => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.trim()) return;
		let value;
		try {
			value = JSON.parse(line);
		} catch {
			onMalformed?.(line);
			return;
		}
		if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
			onMalformed?.(line);
			return;
		}
		if (EVENT_TYPES.has(value.type)) {
			onEvent?.(value);
			return;
		}
		if (!NON_EVENT_TYPES.has(value.type)) onMalformed?.(line);
	};

	return {
		push(chunk) {
			buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				processLine(line);
			}
		},
		end() {
			if (buffer.length > 0) processLine(buffer);
			buffer = "";
		},
	};
}

function buildChildSystemPrompt(systemPrompt) {
	const guardrails = [
		"[PI SUBAGENT ONE-SHOT]",
		"Complete only the delegated user task, then report back with a concise final result.",
		"Do not delegate further: you cannot invoke nested subagents.",
		"Parent-session workflow tools are intentionally unavailable; do not attempt to update or complete the parent workflow.",
	].join("\n");
	const inherited = typeof systemPrompt === "string" ? systemPrompt.trimEnd() : "";
	return inherited ? `${inherited}\n\n${guardrails}\n` : `${guardrails}\n`;
}

function createChildEnvironment(baseEnv, planningMode) {
	const env = { ...baseEnv };
	for (const name of [
		"PI_SESSION_ID",
		"PI_SESSION_FILE",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
		"PI_SUBAGENT_PLANNING",
	]) {
		delete env[name];
	}
	env.PI_SUBAGENT_CHILD = "1";
	if (planningMode) env.PI_SUBAGENT_PLANNING = "1";
	return env;
}

function addNumericFields(target, source) {
	if (!source || typeof source !== "object") return;
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === "number" && Number.isFinite(value)) {
			target[key] = (target[key] ?? 0) + value;
		}
	}
}

function addUsage(total, usage) {
	if (!usage || typeof usage !== "object") return;
	addNumericFields(total, usage);
	if (usage.cost && typeof usage.cost === "object") {
		total.cost ??= {};
		addNumericFields(total.cost, usage.cost);
	}
}

function assistantText(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function utf8Prefix(text, maxBytes) {
	if (!Number.isFinite(maxBytes) || maxBytes < 0) return text;
	let bytes = 0;
	let result = "";
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

function truncateOutput(text, maxBytes, maxLines) {
	const lines = text.split("\n");
	const lineLimited = lines.length > maxLines ? lines.slice(0, Math.max(0, maxLines)).join("\n") : text;
	const content = utf8Prefix(lineLimited, maxBytes);
	return {
		content,
		truncated: content !== text,
		omittedBytes: Buffer.byteLength(text, "utf8") - Buffer.byteLength(content, "utf8"),
	};
}

function boundedDiagnostic(value, maxBytes) {
	const compact = String(value ?? "").trim();
	if (!compact) return "";
	const prefix = utf8Prefix(compact, maxBytes);
	return prefix === compact ? prefix : `${prefix}\n[diagnostic truncated]`;
}

function cancelledError() {
	const error = new Error("Subagent run cancelled or aborted");
	error.name = "AbortError";
	return error;
}

async function retainFullOutput(text, tmpRoot) {
	await mkdir(tmpRoot, { recursive: true });
	const directory = await mkdtemp(path.join(tmpRoot, "pi-subagent-output-"));
	const outputPath = path.join(directory, "output.txt");
	await writeFile(outputPath, text, { encoding: "utf8", mode: 0o600 });
	await chmod(outputPath, 0o600);
	return outputPath;
}

export async function runSubagent(options, dependencies = {}) {
	const {
		prompt,
		model,
		thinkingLevel,
		systemPrompt = "",
		activeTools = [],
		cwd,
		planningMode = false,
		signal,
		onActivity,
	} = options ?? {};

	if (signal?.aborted) throw cancelledError();
	if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Subagent requires a nonblank prompt");
	if (typeof model !== "string" || !model.trim()) throw new Error("Subagent requires a model");

	const spawnImpl = dependencies.spawnImpl ?? spawn;
	const piCommand = dependencies.piCommand ?? "pi";
	const tmpRoot = dependencies.tmpRoot ?? os.tmpdir();
	const baseEnv = dependencies.baseEnv ?? process.env;
	const maxOutputBytes = dependencies.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	const maxOutputLines = dependencies.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES;
	const maxDiagnosticBytes = dependencies.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
	const maxActivity = dependencies.maxActivity ?? DEFAULT_MAX_ACTIVITY;
	const killGraceMs = dependencies.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

	await mkdir(tmpRoot, { recursive: true });
	const promptDirectory = await mkdtemp(path.join(tmpRoot, "pi-subagent-prompt-"));
	const promptPath = path.join(promptDirectory, "system.md");

	try {
		await writeFile(promptPath, buildChildSystemPrompt(systemPrompt), { encoding: "utf8", mode: 0o600 });
		await chmod(promptPath, 0o600);

		const childTools = filterChildTools(activeTools);
		const args = [
			"--mode", "json",
			"--print",
			"--no-session",
			"--model", model,
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--system-prompt", promptPath,
		];
		if (thinkingLevel) args.push("--thinking", thinkingLevel);
		if (childTools.length > 0) args.push("--tools", childTools.join(","));
		else args.push("--no-tools");

		const activity = [];
		let malformedLines = 0;
		let turns = 0;
		let lastAssistant;
		let stderr = "";
		let stderrOmitted = 0;
		const usage = {};
		let hasUsage = false;
		let wasAborted = false;

		const recordActivity = (item) => {
			if (!item) return;
			activity.push(item);
			if (activity.length > maxActivity) activity.splice(0, activity.length - maxActivity);
			onActivity?.(item);
		};

		const parser = createJsonlParser({
			onMalformed: () => { malformedLines++; },
			onEvent: (event) => {
				recordActivity(classifyActivity(event));
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				lastAssistant = event.message;
				turns++;
				if (event.message.usage && typeof event.message.usage === "object") {
					hasUsage = true;
					addUsage(usage, event.message.usage);
				}
			},
		});

		const processResult = await new Promise((resolve, reject) => {
			let child;
			let settled = false;
			let killTimer;

			const clearOwnedState = () => {
				if (killTimer !== undefined) clearTimeout(killTimer);
				if (signal) signal.removeEventListener("abort", abortChild);
			};
			const settleResolve = (value) => {
				if (settled) return;
				settled = true;
				clearOwnedState();
				resolve(value);
			};
			const settleReject = (error) => {
				if (settled) return;
				settled = true;
				clearOwnedState();
				reject(error);
			};
			const terminate = () => {
				if (!child || settled) return;
				try { child.kill("SIGTERM"); } catch { /* process already gone */ }
				killTimer = setTimeout(() => {
					if (settled) return;
					try { child.kill("SIGKILL"); } catch { /* process already gone */ }
				}, Math.max(0, killGraceMs));
			};
			function abortChild() {
				wasAborted = true;
				recordActivity(classifyActivity({ type: "run_cancelled" }));
				terminate();
			}

			try {
				child = spawnImpl(piCommand, args, {
					cwd,
					env: createChildEnvironment(baseEnv, planningMode),
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
				});
			} catch (error) {
				settleReject(new Error(`Failed to start subagent: ${boundedDiagnostic(error?.message ?? error, maxDiagnosticBytes)}`));
				return;
			}

			if (signal) signal.addEventListener("abort", abortChild, { once: true });
			if (signal?.aborted) abortChild();

			child.stdout.on("data", (chunk) => parser.push(chunk));
			child.stderr.on("data", (chunk) => {
				const incoming = chunk.toString("utf8");
				const remaining = Math.max(0, maxDiagnosticBytes - Buffer.byteLength(stderr, "utf8"));
				const kept = utf8Prefix(incoming, remaining);
				stderr += kept;
				stderrOmitted += Buffer.byteLength(incoming, "utf8") - Buffer.byteLength(kept, "utf8");
			});
			const streamFailure = (streamName) => (error) => {
				terminate();
				settleReject(new Error(`Subagent ${streamName} stream failed: ${boundedDiagnostic(error?.message ?? error, maxDiagnosticBytes)}`));
			};
			child.stdout.once("error", streamFailure("stdout"));
			child.stderr.once("error", streamFailure("stderr"));
			child.stdin.once("error", streamFailure("stdin"));
			child.once("error", (error) => {
				settleReject(new Error(`Failed to start subagent: ${boundedDiagnostic(error?.message ?? error, maxDiagnosticBytes)}`));
			});
			child.once("close", (code, closeSignal) => {
				parser.end();
				settleResolve({ code, signal: closeSignal });
			});

			if (!wasAborted) child.stdin.end(`${prompt}\n`);
		});

		if (wasAborted) throw cancelledError();
		if (processResult.code !== 0) {
			recordActivity(classifyActivity({ type: "run_failed" }));
			const signalText = processResult.signal ? ` (signal ${processResult.signal})` : "";
			const diagnostic = boundedDiagnostic(stderr, maxDiagnosticBytes);
			const omitted = stderrOmitted > 0 ? `\n[${stderrOmitted} diagnostic bytes omitted]` : "";
			throw new Error(`Subagent exited with code ${processResult.code ?? "unknown"}${signalText}${diagnostic ? `: ${diagnostic}` : ""}${omitted}`);
		}

		if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
			recordActivity(classifyActivity({ type: lastAssistant.stopReason === "aborted" ? "run_cancelled" : "run_failed" }));
			const diagnostic = boundedDiagnostic(lastAssistant.errorMessage || stderr || `provider stop reason: ${lastAssistant.stopReason}`, maxDiagnosticBytes);
			throw new Error(`Subagent ${lastAssistant.stopReason}: ${diagnostic}`);
		}

		recordActivity(classifyActivity({ type: "run_complete" }));
		const completeText = lastAssistant ? assistantText(lastAssistant) : "";
		const finalText = completeText || "(no output)";
		const truncated = truncateOutput(finalText, maxOutputBytes, maxOutputLines);
		let output = truncated.content;
		let fullOutputPath;
		if (truncated.truncated) {
			fullOutputPath = await retainFullOutput(finalText, tmpRoot);
			output = `${truncated.content}${truncated.content ? "\n\n" : ""}[Output truncated: ${truncated.omittedBytes} bytes omitted. Full output saved to: ${fullOutputPath}]`;
		}

		const resolvedModel = lastAssistant?.provider && lastAssistant?.model
			? `${lastAssistant.provider}/${lastAssistant.model}`
			: model;
		const details = {
			status: "completed",
			model: resolvedModel,
			requestedModel: model,
			thinkingLevel,
			activity,
			finalText: output,
			turns,
			malformedLines,
			...(stderr ? { stderr: boundedDiagnostic(stderr, maxDiagnosticBytes) } : {}),
			...(stderrOmitted > 0 ? { stderrOmittedBytes: stderrOmitted } : {}),
			...(fullOutputPath ? { fullOutputPath, outputTruncated: true, omittedBytes: truncated.omittedBytes } : {}),
			...(hasUsage ? { usage } : {}),
		};
		return { output, details, usage: hasUsage ? usage : undefined };
	} finally {
		await rm(promptDirectory, { recursive: true, force: true });
	}
}
