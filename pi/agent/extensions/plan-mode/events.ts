import type { WorkflowMode } from "./state.ts";

export const PLAN_MODE_DIRECT_TOGGLE_EVENT = "plan-mode:direct-toggle";
export const PLAN_MODE_WORKFLOW_STATE_EVENT = "plan-mode:workflow-state";

export interface PlanModeWorkflowStateEvent {
	/** Persisted workflow mode, emitted after every state refresh and restoration. */
	mode: WorkflowMode;
	/** A plan approval or staged checkpoint still needs a workflow decision. */
	feedbackPending: boolean;
}
