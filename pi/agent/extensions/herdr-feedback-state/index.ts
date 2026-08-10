import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PLAN_MODE_WORKFLOW_STATE_EVENT,
	type PlanModeWorkflowStateEvent,
} from "../plan-mode/events.ts";

/** Public event emitted by @juicesharp/rpiv-ask-user-question while its UI is open. */
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
/** Event consumed by Herdr's official Pi integration. */
const HERDR_BLOCKED_EVENT = "herdr:blocked";
const WAITING_LABEL = "waiting for feedback";

type ContentLike = { type?: unknown; text?: unknown };
type MessageLike = {
	role?: unknown;
	stopReason?: unknown;
	content?: unknown;
};

function assistantText(message: unknown): string {
	const candidate = message as MessageLike | undefined;
	if (candidate?.role !== "assistant") return "";
	if (candidate.stopReason !== undefined && candidate.stopReason !== "stop") return "";
	if (typeof candidate.content === "string") return candidate.content.trim();
	if (!Array.isArray(candidate.content)) return "";
	const content = candidate.content as ContentLike[];

	// A tool-calling message is not a free-form request even when its preamble
	// contains a question; the tool owns any blocked state it creates.
	if (content.some((part) => part.type === "toolCall")) return "";

	return content
		.filter((part): part is ContentLike & { text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function endsWithQuestion(line: string): boolean {
	return /\?(?:\s|[*_`~"'’”)}\]])*$/u.test(line);
}

function isChoiceLine(line: string): boolean {
	return /^(?:[-*+•]\s+|\d{1,2}[.)]\s+|[A-Za-z][.)]\s+|\[[ xX]\]\s+)/u.test(line)
		|| /^(?:options?|choices?):$/iu.test(line);
}

/** Conservatively identifies a settled plain-chat response that awaits an answer. */
export function asksForFeedback(text: string): boolean {
	const lines = text.trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return false;
	if (endsWithQuestion(lines.at(-1)!)) return true;

	// Also support a question followed only by a short markdown choice list.
	for (let index = lines.length - 2; index >= 0; index -= 1) {
		if (endsWithQuestion(lines[index]!) && lines.slice(index + 1).every(isChoiceLine)) return true;
	}
	return false;
}

export function latestSettledAssistantText(entries: readonly unknown[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; message?: MessageLike } | undefined;
		if (entry?.type !== "message") continue;
		return assistantText(entry.message);
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	let latestText = "";
	let structuredBlocked = false;
	let freeformBlocked = false;
	let approvalBlocked = false;
	let reportedBlocked = false;
	let rootSession = false;

	function syncBlockedState(): void {
		if (!rootSession) return;
		const active = structuredBlocked || freeformBlocked || approvalBlocked;
		if (active === reportedBlocked) return;
		reportedBlocked = active;
		pi.events.emit(HERDR_BLOCKED_EVENT, active ? { active, label: WAITING_LABEL } : { active });
	}

	pi.events.on(ASK_USER_BLOCKED_EVENT, (data) => {
		const payload = data as { active?: unknown } | undefined;
		structuredBlocked = payload?.active === true;
		syncBlockedState();
	});

	pi.events.on(PLAN_MODE_WORKFLOW_STATE_EVENT, (data) => {
		const payload = data as PlanModeWorkflowStateEvent | undefined;
		approvalBlocked = payload?.mode === "approval";
		syncBlockedState();
	});

	pi.on("session_start", (_event, ctx) => {
		rootSession = ctx.hasUI === true;
		structuredBlocked = false;
		approvalBlocked = false;
		reportedBlocked = false;
		latestText = rootSession ? latestSettledAssistantText(ctx.sessionManager.getBranch()) : "";
		freeformBlocked = rootSession && asksForFeedback(latestText);
		syncBlockedState();
	});

	pi.on("message_end", (event) => {
		if (rootSession && event.message.role === "assistant") latestText = assistantText(event.message);
	});

	pi.on("agent_start", () => {
		if (!rootSession) return;
		latestText = "";
		freeformBlocked = false;
		syncBlockedState();
	});

	pi.on("agent_settled", () => {
		if (!rootSession) return;
		freeformBlocked = asksForFeedback(latestText);
		syncBlockedState();
	});

	pi.on("session_shutdown", () => {
		rootSession = false;
	});
}
