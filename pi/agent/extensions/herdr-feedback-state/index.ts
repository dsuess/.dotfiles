import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_BLOCKED_EVENT,
	type AskUserBlockedEventPayload,
} from "../../packages/ask-user-question/events.ts";
import {
	PLAN_MODE_WORKFLOW_STATE_EVENT,
	type PlanModeWorkflowStateEvent,
} from "../plan-mode/events.ts";
import {
	HERDR_BLOCKED_EVENT,
	HERDR_FEEDBACK_SNAPSHOT_EVENT,
	type HerdrFeedbackSource,
} from "./events.ts";

const WAITING_LABEL = "waiting for feedback";
const BLOCKING_UI_METHODS = ["select", "confirm", "input", "editor", "custom"] as const;

type BlockingUIMethod = (typeof BLOCKING_UI_METHODS)[number];
type UIContextLike = Record<BlockingUIMethod, (...args: unknown[]) => unknown>;

function sameSource(left: HerdrFeedbackSource | undefined, right: HerdrFeedbackSource | undefined): boolean {
	return left?.id === right?.id && left?.label === right?.label;
}

export default function feedbackStateExtension(pi: ExtensionAPI): void {
	const sources = new Map<string, HerdrFeedbackSource>();
	let rootSession = false;
	let workflowActive = false;
	let workflowLabel = WAITING_LABEL;
	let installation = 0;
	let nextUIOperation = 0;
	let pendingUIClears = new Set<string>();
	let clearBlockingUITimer: ReturnType<typeof setTimeout> | undefined;
	let restoreUI: (() => void) | undefined;
	let unsubscribeQuestionnaire: (() => void) | undefined;
	let unsubscribeWorkflow: (() => void) | undefined;
	let lastSnapshotKey = "";
	let legacyBlocked = false;

	function snapshot(): HerdrFeedbackSource[] {
		return [...sources.values()]
			.map((source) => ({ ...source }))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	function publishSnapshot(force = false): void {
		if (!rootSession) return;
		const current = snapshot();
		const key = JSON.stringify(current);
		if (!force && key === lastSnapshotKey) return;
		lastSnapshotKey = key;
		pi.events.emit(HERDR_FEEDBACK_SNAPSHOT_EVENT, { sources: current });

		// The generated direct-socket integration used by --yolo only understands
		// a boolean edge. Keep it derived from this reducer, never from prose or
		// individual producer edges.
		const active = current.length > 0;
		if (active === legacyBlocked) return;
		legacyBlocked = active;
		pi.events.emit(HERDR_BLOCKED_EVENT, active
			? { active: true, label: current[0]?.label ?? WAITING_LABEL }
			: { active: false });
	}

	function setSource(id: string, label: string): void {
		const next = { id, label };
		if (sameSource(sources.get(id), next)) return;
		sources.set(id, next);
		publishSnapshot();
	}

	function clearSource(id: string): void {
		if (!sources.delete(id)) return;
		publishSnapshot();
	}

	function clearPendingBlockingUI(): void {
		if (clearBlockingUITimer) clearTimeout(clearBlockingUITimer);
		clearBlockingUITimer = undefined;
	}

	function beginBlockingUI(): string {
		clearPendingBlockingUI();
		const id = `ui:${++nextUIOperation}`;
		setSource(id, WAITING_LABEL);
		return id;
	}

	function endBlockingUI(id: string, generation: number): void {
		if (generation !== installation) return;
		pendingUIClears.add(id);
		if (clearBlockingUITimer) return;
		clearBlockingUITimer = setTimeout(() => {
			clearBlockingUITimer = undefined;
			if (generation !== installation) return;
			for (const sourceId of pendingUIClears) clearSource(sourceId);
			pendingUIClears.clear();
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
				const sourceId = beginBlockingUI();
				try {
					return Promise.resolve(original.apply(this, args)).then(
						(value) => {
							endBlockingUI(sourceId, generation);
							return value;
						},
						(error) => {
							endBlockingUI(sourceId, generation);
							throw error;
						},
					);
				} catch (error) {
					endBlockingUI(sourceId, generation);
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

	function updateQuestionnaire(data: unknown): void {
		const payload = data as AskUserBlockedEventPayload | undefined;
		if (payload?.active === true) setSource("questionnaire", WAITING_LABEL);
		else clearSource("questionnaire");
	}

	function updateWorkflow(data: unknown): void {
		const payload = data as PlanModeWorkflowStateEvent | undefined;
		workflowActive = payload?.feedbackPending === true;
		workflowLabel = WAITING_LABEL;
		if (workflowActive) setSource("plan-workflow", workflowLabel);
		else clearSource("plan-workflow");
	}

	function subscribeFeedbackSources(): void {
		if (!unsubscribeQuestionnaire) unsubscribeQuestionnaire = pi.events.on(ASK_USER_BLOCKED_EVENT, updateQuestionnaire);
		if (!unsubscribeWorkflow) unsubscribeWorkflow = pi.events.on(PLAN_MODE_WORKFLOW_STATE_EVENT, updateWorkflow);
	}

	function resetSessionState(disposeSubscriptions = false): void {
		installation += 1;
		clearPendingBlockingUI();
		pendingUIClears.clear();
		restoreUI?.();
		restoreUI = undefined;
		for (const id of [...sources.keys()]) {
			if (id !== "plan-workflow") sources.delete(id);
		}
		if (workflowActive) sources.set("plan-workflow", { id: "plan-workflow", label: workflowLabel });
		else sources.delete("plan-workflow");
		lastSnapshotKey = "";
		legacyBlocked = false;
		if (disposeSubscriptions) {
			unsubscribeQuestionnaire?.();
			unsubscribeQuestionnaire = undefined;
			unsubscribeWorkflow?.();
			unsubscribeWorkflow = undefined;
			workflowActive = false;
			sources.clear();
		}
	}

	// Subscribe before any session_start handler can publish restored workflow
	// state. The durable plan producer re-emits its snapshot on restoration.
	subscribeFeedbackSources();

	pi.on("session_start", (_event, ctx) => {
		subscribeFeedbackSources();
		resetSessionState();
		rootSession = ctx.mode === "tui";
		if (!rootSession) return;
		installBlockingUI(ctx.ui as UIContextLike);
		publishSnapshot(true);
	});

	pi.on("session_shutdown", () => {
		rootSession = false;
		resetSessionState(true);
	});
}
