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
- Start with one non-empty H1 title that is concise and action-oriented.
- Use these H2 sections in this exact order: required "Context", optional "Questions & Answers", required "Approach", optional "Parallel Execution", optional "Critical Files", then optional "Verification". Do not add other H2 sections.
- Omit "Parallel Execution" during ordinary planning. It is reserved for the fast optimizer, where it contains one strict Wave, Worker, Part, Source Part, Depends On, Ownership table.
- "Context" explains the current behavior and motivation, how the work fits the repository architecture or workflow, and relevant research. Record terminology conflicts, material assumptions, confirmed decisions, and accepted risks when they affect the approach. All blockers must be resolved before submission.
- Add "Questions & Answers" only when you asked a user clarification and received an answer. Use only this table shape: | Question | Answer |, |---|---|, then one or more rows with both cells non-empty. Record every answered clarification verbatim enough to retain the question, decision, and answer. Do not add unresolved blockers, invented entries, or a no-questions placeholder.
- "Approach" first explains the proposed solution and architectural shape, then contains one or more ordered headings using "### Part A — Action-oriented title", continuing alphabetically without gaps (A, B, ... Z, AA, AB, ...). Do not add an author-written status marker.
- Each Part is one coherent executable and staged-delivery boundary. Its body should cover the intended behavior, dependencies, scope boundaries, relevant edge cases, guardrails, rationale, and observable acceptance outcomes. Do not add a second Step or task hierarchy, and do not split Parts merely by file or API.
- Preserve selective implementation anchors such as important paths, symbols, flags, external interfaces, or data shapes when research established a constraint or the anchor materially reduces ambiguity. Explain why the anchor matters. Do not produce exhaustive implementation inventories, mandatory file or tool lists, internal call-by-call recipes, or tool-call instructions.
- Add "Critical Files" only when a short map of important boundaries adds useful cross-file or integration context. Identify only the most important modification boundaries and read-only references, and state each entry's responsibility. It is not an exhaustive target-file inventory; omit it when it would be ceremonial.
- Add "Verification" whenever the planned result can be meaningfully checked. Distinguish regression checks from new-feature scenarios, and define observable success signals, smoke or canary cases, and failure signals for uncertain assumptions. Exact commands are appropriate only when the command itself is a material project requirement. Purely explanatory or investigative plans may omit this section when no meaningful verification applies.
- Omit optional sections cleanly when inapplicable or empty. Include at least one Part and keep the complete document at or below 256 KiB.

${retryGuidance}`;
}

export function buildFastOptimizationPrompt(state: PlanModeState, sourceMarkdown: string): string {
	const optimization = state.optimization;
	return `[PI FAST PLAN OPTIMIZATION ACTIVE]
You are optimizing an already approved version-4 Part plan for safe parallel execution. Do not ask questions, implement, edit files, change configuration, or request user approval. Repository inspection is allowed only to identify dependencies and exclusive mutation boundaries.

You may only split existing source Parts into ordered optimized Parts and add the required Parallel Execution schedule. Do not combine source Parts. Do not add, remove, reorder, or rewrite approved requirements. Keep the title, Context, answered Questions & Answers, Approach preamble, Critical Files, and Verification unchanged. For each source Part, concatenate the bodies of its mapped optimized Parts in source order so that the normalized text is exactly the source body. If a coherent split is unsafe, keep that source Part intact.

The optimized document must include ## Parallel Execution after Approach and before Critical Files. Its only content is this table with one row for every optimized Part:
| Wave | Worker | Part | Source Part | Depends On | Ownership |
|---|---|---|---|---|---|
Waves start at 1, are contiguous and ordered. Workers and Parts are unique. Dependencies name only Parts in earlier waves. Ownership names an exclusive mutation boundary; sibling ownership must not overlap. Use — when a Part has no dependencies. Assign one worker per optimized Part and put all safe, independent workers in the same wave.

Finish only by calling submit_plan with the complete optimized Markdown. Its successful submission starts execution directly; there is no second approval dialog.

Source approval: hash ${optimization?.sourceHash ?? "unknown"}, revision ${optimization?.sourceRevision ?? "unknown"}, source Parts ${optimization?.sourcePartIds.join(", ") ?? "unknown"}.

Approved source Markdown:

${sourceMarkdown}`;
}
