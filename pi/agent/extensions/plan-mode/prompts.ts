import type { PlanModeState } from "./state.ts";

export const PLAN_MODE_CONTEXT_TYPE = "plan-mode-planning-context";

export function buildPlanningPrompt(state: PlanModeState): string {
	const retryGuidance =
		state.counters.invalidSubmissions >= 3
			? "Three submissions have failed. Do not call submit_plan again until the user provides new input."
			: `Invalid submission attempts in this planning round: ${state.counters.invalidSubmissions}/3.`;

	return `[PI PLANNING MODE ACTIVE]
You are planning, not implementing. Workspace mutation tools are gated. Bash uses a permissive known-mutator detector: unclassified commands may run, so still choose read-only commands and never intentionally mutate the workspace.

Planning workflow:
1. Inspect code and existing documentation before asking anything answerable locally.
2. Load and apply the grill-with-docs skill from normal Pi skill discovery. Challenge the plan against project terminology, CONTEXT.md, CONTEXT-MAP.md, ADRs, and code behavior.
3. Ask unresolved design questions one at a time and include your recommended answer. Sharpen vague terms and explicitly flag documentation/code conflicts.
4. The skill normally writes CONTEXT.md and ADRs inline. Do not do that in planning mode; record each warranted documentation change as a plan task instead.
5. Do not implement, edit documentation, change configuration, or perform any non-plan mutation.
6. Finish only by calling submit_plan with the intent, exact H1 title, and the complete canonical Markdown. Do not merely print the plan as prose.

Canonical Markdown contract (exact ordered structure):
- One non-empty H1 title at the first line.
- H2 "Objective / Goal Statement" with a concrete objective.
- H2 "Stages Overview" containing a table whose exact columns are Stage, Name, Purpose.
- Ordered sections "### Stage N — Name", matching the overview, numbered from 1 without gaps.
- Every executable task is ordered and stable: "#### N.M [pending] Title". Allowed statuses are pending, in_progress, completed, blocked. New plans normally use pending.
- Every task body contains non-empty "- **Targets:** ..." and "- **Tools / APIs:** ..." lines plus concrete behavior, dependencies, conditional logic, or acceptance details.
- H2 "Conditional Logic and Edge Cases".
- H2 "Parallel Subagent Recommendations", including dependencies and shared-file exclusions; say sequential when parallelism is unsafe.
- H2 "Testing Requirements and Edge Cases".
- H2 "Stopping Criteria / Guardrails".
- At least one stage and one executable task. Keep the complete document at or below 256 KiB.

${retryGuidance}`;
}
