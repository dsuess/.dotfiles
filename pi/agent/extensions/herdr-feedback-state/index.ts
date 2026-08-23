import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_BLOCKED_EVENT,
	type AskUserBlockedEventPayload,
} from "../../packages/ask-user-question/events.ts";
import {
	PLAN_MODE_WORKFLOW_STATE_EVENT,
	type PlanModeWorkflowStateEvent,
} from "../plan-mode/events.ts";

/**
 * Human-feedback state has one semantic boundary:
 *
 * - `working`: the agent can still advance without a human decision.
 * - `blocked`: an explicit input lifecycle prevents the workflow from advancing.
 * - `idle`: Pi has settled at its ordinary prompt.
 *
 * Producer-owned lifecycle events are authoritative. Standard extension UI
 * methods are instrumented only as fallback coverage for producers without a
 * semantic event. Never infer a wait from assistant prose or terminal output.
 * This coordinator reduces all active sources to one boolean `herdr:blocked`
 * edge; the generated Herdr extension remains the only socket reporter.
 */

const WAITING_LABEL = "waiting for feedback";
const BLOCKING_UI_METHODS = ["select", "confirm", "input", "editor", "custom"] as const;

type BlockingUIMethod = (typeof BLOCKING_UI_METHODS)[number];
type BlockingUI = Record<BlockingUIMethod, (...args: unknown[]) => unknown>;

export default function feedbackStateExtension(pi: ExtensionAPI): void {
	const sources = new Map<string, string>();
	let rootSession = false;
	let workflowActive = false;
	let installation = 0;
	let nextUIOperation = 0;
	let edgeActive = false;
	let pendingUIClears = new Set<string>();
	let clearBlockingUITimer: ReturnType<typeof setTimeout> | undefined;
	let restoreUI: (() => void) | undefined;
	let unsubscribeQuestionnaire: (() => void) | undefined;
	let unsubscribeWorkflow: (() => void) | undefined;

	function publishEdge(): void {
		if (!rootSession) return;
		const active = sources.size > 0;
		if (active === edgeActive) return;
		edgeActive = active;
		pi.events.emit("herdr:blocked", active
			? { active: true, label: WAITING_LABEL }
			: { active: false });
	}

	function setSource(id: string, active: boolean): void {
		if (active) {
			if (sources.has(id)) return;
			sources.set(id, WAITING_LABEL);
		} else if (!sources.delete(id)) {
			return;
		}
		publishEdge();
	}

	function cancelPendingUIClears(): void {
		if (clearBlockingUITimer) clearTimeout(clearBlockingUITimer);
		clearBlockingUITimer = undefined;
		pendingUIClears.clear();
	}

	function beginBlockingUI(): string {
		const id = `ui:${++nextUIOperation}`;
		setSource(id, true);
		return id;
	}

	function endBlockingUI(id: string, generation: number): void {
		if (generation !== installation) return;
		pendingUIClears.add(id);
		if (clearBlockingUITimer) return;
		// Delay the clear by one turn so select -> editor and similar immediate
		// handoffs overlap instead of oscillating through a false blocked edge.
		clearBlockingUITimer = setTimeout(() => {
			clearBlockingUITimer = undefined;
			if (generation !== installation) return;
			const completed = pendingUIClears;
			pendingUIClears = new Set();
			for (const sourceId of completed) setSource(sourceId, false);
		}, 0);
	}

	function installBlockingUI(ui: BlockingUI): void {
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
		setSource("questionnaire", payload?.active === true);
	}

	function updateWorkflow(data: unknown): void {
		const payload = data as PlanModeWorkflowStateEvent | undefined;
		workflowActive = payload?.feedbackPending === true;
		setSource("plan-workflow", workflowActive);
	}

	function subscribe(): void {
		unsubscribeQuestionnaire ??= pi.events.on(ASK_USER_BLOCKED_EVENT, updateQuestionnaire);
		unsubscribeWorkflow ??= pi.events.on(PLAN_MODE_WORKFLOW_STATE_EVENT, updateWorkflow);
	}

	function releasePublishedEdge(): void {
		if (!rootSession || !edgeActive) return;
		edgeActive = false;
		pi.events.emit("herdr:blocked", { active: false });
	}

	function retireSession({ disposeSubscriptions = false } = {}): void {
		installation += 1;
		cancelPendingUIClears();
		restoreUI?.();
		restoreUI = undefined;
		releasePublishedEdge();
		rootSession = false;
		edgeActive = false;
		sources.clear();
		if (workflowActive && !disposeSubscriptions) sources.set("plan-workflow", WAITING_LABEL);
		if (disposeSubscriptions) {
			unsubscribeQuestionnaire?.();
			unsubscribeQuestionnaire = undefined;
			unsubscribeWorkflow?.();
			unsubscribeWorkflow = undefined;
			workflowActive = false;
		}
	}

	// Subscribe at factory time so the durable plan producer can publish its
	// restored snapshot from its own session_start handler in any load order.
	subscribe();

	pi.on("session_start", (_event, ctx) => {
		retireSession();
		subscribe();
		rootSession = ctx.mode === "tui";
		if (!rootSession) return;
		installBlockingUI(ctx.ui as BlockingUI);
		publishEdge();
	});

	pi.on("session_shutdown", () => {
		retireSession({ disposeSubscriptions: true });
	});
}
