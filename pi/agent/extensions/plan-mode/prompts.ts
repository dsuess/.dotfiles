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
2. Load and apply the grill-with-docs skill from normal Pi skill discovery. Use its domain, terminology, scenario, documentation, and code-conflict analysis, but override its one-question-at-a-time cadence unless the user explicitly requested that format.
3. Treat each potential user-owned decision as a pending blocker. Collect it and continue investigating every independent branch; do not ask while any useful, safe read-only progress remains.
4. Only when all remaining useful progress requires user input, ask all currently known blockers together in one ask_user_question call (up to four questions), with a recommended answer for each. If more than four are known, prioritize the highest-dependency decisions. After answers arrive, investigate again before asking another batch. Never ask questions one at a time unless the user explicitly requested it.
5. Sharpen vague terms and explicitly flag documentation/code conflicts.
6. The skill normally writes CONTEXT.md and ADRs inline. Do not do that in planning mode; record each warranted documentation change as a plan task instead.
7. Do not implement, edit documentation, change configuration, or perform any non-plan mutation.
8. Finish only by calling submit_plan with the intent, exact H1 title, and the complete canonical Markdown. Do not merely print the plan as prose.

Canonical Markdown contract (exact ordered structure):
- One non-empty H1 title at the first line.
- H2 "Why" explaining the problem, evidence, motivation, and intended outcome.
- H2 "What" summarizing the proposed solution, scope, important behavior, and constraints before listing executable steps.
- Every executable step lives under What and is globally ordered and stable: "### Step N [pending] Title", numbered from 1 without gaps. Allowed statuses are pending, in_progress, completed, blocked. New plans normally use pending.
- Every step body contains non-empty "- **Targets:** ..." and "- **Tools / APIs:** ..." lines, plus concrete changes, dependencies, acceptance/verification details, relevant edge cases, and any stopping guardrail. Put cross-cutting testing and parallel-worker guidance in the steps where it applies instead of adding top-level sections.
- H2 "Stages" is the final and only stage-oriented section. It contains one table whose exact columns are Stage, Description, Steps.
- Stage IDs are numbered from 1 without gaps. Each description is a short user-facing summary suitable for a progress monitor. Steps lists comma-separated step IDs; every step belongs to exactly one stage.
- Do not add other H2 sections or group step details under stage headings.
- At least one stage and one executable step. Keep the complete document at or below 256 KiB.

${retryGuidance}`;
}
