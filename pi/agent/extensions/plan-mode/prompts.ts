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

Canonical Markdown contract:
- Start with one non-empty H1 title.
- Keep the plan high-level and outcome-oriented. Explain behavior, responsibilities, dependencies, constraints, and verification without prescribing the implementation inventory. Do not list target files, internal symbol names, tools, or API call details.
- Use these H2 sections in this order when they apply: "Background", "Changes", "Breaking Changes", "Testing Plan", "Assumptions / Decisions", "Stages". Do not add other H2 sections.
- "Background" is required. Explain the user's request, why the work is needed, and how it fits the repository's larger architecture or workflow.
- "Changes" is required. Summarize the proposed solution, then represent the work as globally ordered stable headings: "### Step N [pending] Title", numbered from 1 without gaps. Allowed statuses are pending, in_progress, completed, blocked; new plans normally use pending.
- Step bodies describe detailed but high-level changes. Include relevant behavior, scope boundaries, dependencies, acceptance outcomes, edge cases, and guardrails naturally; do not force fixed metadata fields or split work merely by file or API.
- Add "Breaking Changes" only when the proposal introduces an actual compatibility break within the codebase. Describe affected behavior and migration impact; omit the section rather than writing "None".
- Add "Testing Plan" when verification is applicable. Describe the test strategy, important scenarios, and success signals at a behavioral level rather than listing exact commands unless a command itself is a material requirement.
- Add "Assumptions / Decisions" only for material assumptions or decisions the user made during questioning. Distinguish assumptions from confirmed decisions, and never place unresolved blockers there.
- Add "Stages" only for a larger change that benefits from staged delivery. It contains one table with exact columns Stage, Description, Steps. Stage IDs start at 1 without gaps; Steps lists comma-separated step IDs and maps every step exactly once. Descriptions explain which work is grouped, ordering dependencies, and what can proceed in parallel.
- Omit every optional section that is inapplicable or empty. Small changes should normally omit "Stages".
- Include at least one high-level step and keep the complete document at or below 256 KiB.

${retryGuidance}`;
}
