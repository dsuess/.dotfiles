# Require Answers Before Plan Revisions

## Context

`agents/skills/plan-review/SKILL.md` already prevents Claude-marker `?` annotations from being silently assumed, but its Pi branch treats structured review comments as ordinary feedback and asks only about genuinely unresolved decisions. The Pi review handoff in `pi/agent/extensions/plan-mode/index.ts` and its README repeat that weaker rule. Consequently, an anchored user question that repository evidence happens to answer can be folded silently into a submitted revision rather than receiving an explicit answer.

Treat “planning skill” as the named `plan-review` skill. The requested behavior applies to every question expressed in user review feedback—not just literal `?` marker lines—while preserving the existing distinction that review comment types are advisory rather than a directive protocol. The agent may answer evidence-settled questions itself, but must visibly address each one; questions that require a user-owned decision remain open and block `submit_plan` until resolved. Existing unrelated changes in `codex/config.toml` and the untracked `.pi/` state are outside scope.

## Approach

Make review feedback a question-accountability conversation: identify every user question, provide a traceable answer or ask for the required decision, and submit one revised canonical plan only after the question set is closed.

### Part A — Define the explicit-answer review protocol
- **Ledger:** {"status":"completed","note":"Defined Pi structured-review question accountability while preserving the Claude marker workflow.","evidence":"Updated agents/skills/plan-review/SKILL.md: every natural-language question is inventoried and answered by anchor/ID with evidence, assumption, or user decision plus plan impact; open user-owned choices block submit_plan; Pi-specific edge cases and example added. git diff --check passed."}

Revise `agents/skills/plan-review/SKILL.md` so its Pi structured-comment branch inventories every question in review feedback, including natural-language interrogatives rather than only marker-prefixed lines. Require an explicit, individually attributable response grounded in repository evidence, stated assumptions, or a user decision; state whether the answer changes the plan. Keep directives and non-question feedback reconcilable as today, reconcile conflicts openly, and preserve the existing marker workflow for Claude-hosted plans.

Do not silently convert an answerable question into plan text. When a question exposes a user-owned choice or remains ambiguous after investigation, keep the discussion open, batch all such choices using the normal Pi clarification flow, and do not submit a revision. Only after every question has an explicit answer or agreed resolution may the revised plan be produced; record user-supplied decisions in the plan’s canonical Questions & Answers section where applicable. Update the skill’s Pi guidance, workflow steps, edge cases, and example so this rule is unambiguous without imposing marker semantics on tuicr comment types.

### Part B — Align the Pi review handoff and operator contract
- **Ledger:** {"status":"completed","note":"Aligned the tuicr review prompt and README lifecycle with explicit answers and deferred submission.","evidence":"Updated requestPlanReview and README review lifecycle to inventory/answer every question by anchor or ID, keep planning active for open user decisions, and allow exactly one submit_plan only after discussion closes. git diff --check passed."}

Update `requestPlanReview` in `pi/agent/extensions/plan-mode/index.ts` so the injected `[PLAN REVIEW COMMENTS]` instruction reinforces the skill contract: acknowledge and answer every review question, hold submission for unresolved user decisions, and submit only after the complete discussion closes. Remove the contradictory instruction that only genuinely unresolved decisions need attention and avoid requiring a same-turn submission when clarification is pending.

Synchronize `pi/agent/extensions/plan-mode/README.md` with the new review lifecycle. It must describe explicit answers for all user questions, the continued planning state while any answer/decision is open, and the eventual single canonical resubmission; keep advisory comment types and the immutable canonical-plan boundary unchanged.

### Part C — Lock the handoff rule with regression coverage
- **Ledger:** {"status":"completed","note":"Regression coverage now locks explicit answers, deferral for open user decisions, and eventual canonical submission.","evidence":"Updated workflow-dialogs.test.mjs to assert explicit answers to every question, no submission while a question/required decision is open, and submission only after resolution; it rejects the old wording. Passed: focused node --test test/workflow-dialogs.test.mjs (22/22); npm run check (139/139 tests plus smoke, integration, palette integration, and TUI smoke); git diff --check."}

Extend the plan-mode workflow-dialog test that exercises a successful tuicr review to assert the new planner-handoff language requiring explicit answers to every user question and deferral of submission while questions need user resolution. Remove assertions tied to the superseded “genuinely unresolved decisions only” wording, while retaining checks that structured comments, advisory types, and one eventual canonical submission are communicated.

## Critical Files

- `agents/skills/plan-review/SKILL.md` — authoritative cross-host review-question and revision protocol.
- `pi/agent/extensions/plan-mode/index.ts` — runtime prompt delivered after tuicr returns structured comments.
- `pi/agent/extensions/plan-mode/README.md` — documented Pi planning and review behavior.
- `pi/agent/extensions/plan-mode/test/workflow-dialogs.test.mjs` — regression coverage for the review handoff prompt contract.

## Verification

Run the focused plan-mode workflow-dialog test to confirm the review handoff carries the new question-accountability rule and no longer advertises the old shortcut. Then run `npm run check` from `pi/agent/extensions/plan-mode` to cover the extension’s complete test, smoke, integration, palette, and TUI checks. Review the final diff to confirm that all documented/runtime guidance agrees, every user question is explicitly addressed before revision, unresolved choices keep planning open, and unrelated working-tree changes remain untouched.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Define the explicit-answer review protocol
- ☑ Align the Pi review handoff and operator contract
- ☑ Lock the handoff rule with regression coverage
<!-- pi-plan-mode:progress:end -->
