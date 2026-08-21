import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_BLOCKED_EVENT,
	type AskUserBlockedEventPayload,
} from "../../packages/ask-user-question/events.ts";
import {
	PLAN_MODE_WORKFLOW_STATE_EVENT,
	type PlanModeWorkflowStateEvent,
} from "../plan-mode/events.ts";

/** Event consumed by Herdr's official Pi integration. */
const HERDR_BLOCKED_EVENT = "herdr:blocked";
const WAITING_LABEL = "waiting for feedback";
const BLOCKING_UI_METHODS = ["select", "confirm", "input", "editor", "custom"] as const;

type BlockingUIMethod = (typeof BLOCKING_UI_METHODS)[number];
type ContentLike = { type?: unknown; text?: unknown };
type MessageLike = {
	role?: unknown;
	stopReason?: unknown;
	content?: unknown;
};
type UIContextLike = Record<BlockingUIMethod, (...args: unknown[]) => unknown>;

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
	let blockingUICount = 0;
	let blockingUIActive = false;
	let freeformBlocked = false;
	let questionnaireBlocked = false;
	let workflowBlocked = false;
	let reportedBlocked = false;
	let rootSession = false;
	let clearBlockingUITimer: ReturnType<typeof setTimeout> | undefined;
	let restoreUI: (() => void) | undefined;
	let unsubscribeQuestionnaire: (() => void) | undefined;
	let unsubscribeWorkflow: (() => void) | undefined;
	let installation = 0;

	function syncBlockedState(): void {
		if (!rootSession) return;
		const active = blockingUIActive || freeformBlocked || questionnaireBlocked || workflowBlocked;
		if (active === reportedBlocked) return;
		reportedBlocked = active;
		pi.events.emit(HERDR_BLOCKED_EVENT, active ? { active, label: WAITING_LABEL } : { active });
	}

	function clearPendingBlockingUI(): void {
		if (clearBlockingUITimer) clearTimeout(clearBlockingUITimer);
		clearBlockingUITimer = undefined;
	}

	function beginBlockingUI(): void {
		clearPendingBlockingUI();
		blockingUICount += 1;
		blockingUIActive = true;
		syncBlockedState();
	}

	function endBlockingUI(generation: number): void {
		if (generation !== installation) return;
		blockingUICount = Math.max(0, blockingUICount - 1);
		if (blockingUICount > 0 || clearBlockingUITimer) return;
		clearBlockingUITimer = setTimeout(() => {
			clearBlockingUITimer = undefined;
			if (generation !== installation || blockingUICount > 0) return;
			blockingUIActive = false;
			syncBlockedState();
		}, 0);
	}

	function installBlockingUI(ui: UIContextLike): void {
		const generation = installation;
		const originals = new Map<BlockingUIMethod, (...args: unknown[]) => unknown>();
		const wrappers = new Map<BlockingUIMethod, (...args: unknown[]) => unknown>();

		for (const method of BLOCKING_UI_METHODS) {
			const original = ui[method];
			if (typeof original !== "function") continue;
			originals.set(method, original);
			function wrapped(this: unknown, ...args: unknown[]) {
				beginBlockingUI();
				try {
					return Promise.resolve(original.apply(this, args)).then(
						(value) => {
							endBlockingUI(generation);
							return value;
						},
						(error) => {
							endBlockingUI(generation);
							throw error;
						},
					);
				} catch (error) {
					endBlockingUI(generation);
					throw error;
				}
			}
			wrappers.set(method, wrapped);
			ui[method] = wrapped;
		}

		restoreUI = () => {
			for (const method of BLOCKING_UI_METHODS) {
				const original = originals.get(method);
				const wrapper = wrappers.get(method);
				if (original && wrapper && ui[method] === wrapper) ui[method] = original;
			}
		};
	}

	function updateQuestionnaireBlocked(data: unknown): void {
		const payload = data as AskUserBlockedEventPayload | undefined;
		questionnaireBlocked = payload?.active === true;
		syncBlockedState();
	}

	function updateWorkflowBlocked(data: unknown): void {
		const payload = data as PlanModeWorkflowStateEvent | undefined;
		workflowBlocked = payload?.feedbackPending === true;
		syncBlockedState();
	}

	function subscribeFeedbackSources(): void {
		if (!unsubscribeQuestionnaire) {
			unsubscribeQuestionnaire = pi.events.on(ASK_USER_BLOCKED_EVENT, updateQuestionnaireBlocked);
		}
		if (!unsubscribeWorkflow) unsubscribeWorkflow = pi.events.on(PLAN_MODE_WORKFLOW_STATE_EVENT, updateWorkflowBlocked);
	}

	function resetSessionState(disposeSubscriptions = false): void {
		installation += 1;
		clearPendingBlockingUI();
		restoreUI?.();
		restoreUI = undefined;
		blockingUICount = 0;
		blockingUIActive = false;
		questionnaireBlocked = false;
		if (disposeSubscriptions) {
			unsubscribeQuestionnaire?.();
			unsubscribeQuestionnaire = undefined;
			unsubscribeWorkflow?.();
			unsubscribeWorkflow = undefined;
			workflowBlocked = false;
		}
	}

	// Subscribe before any session_start handler can publish restored feedback state.
	subscribeFeedbackSources();

	pi.on("session_start", (_event, ctx) => {
		subscribeFeedbackSources();
		resetSessionState();
		rootSession = ctx.mode === "tui";
		reportedBlocked = false;
		latestText = rootSession ? latestSettledAssistantText(ctx.sessionManager.getBranch()) : "";
		freeformBlocked = rootSession && asksForFeedback(latestText);
		if (!rootSession) return;

		installBlockingUI(ctx.ui as UIContextLike);
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
		resetSessionState(true);
		freeformBlocked = false;
		reportedBlocked = false;
	});
}
