# Make Fast Plan Parallelization Self-Correcting

## Context

The user-visible “parallel planning mode” is the plan-mode extension’s **Implement (fast)** workflow: after a version-4 plan is approved, a planning-model turn creates a source-equivalent revision with a `Parallel Execution` schedule. The strict checks in `validateFastPlanRevision()` correctly protect approved scope, Part order, schedule dependencies, and exclusive ownership before execution starts.

The repeated failure is primarily a feedback defect, not evidence that those guards are too strict. `validateFastPlanRevision()` returns specific errors such as malformed schedule rows, overlapping ownership, changed fixed sections, or changed mapped Part bodies, and `submit_plan` attaches them to a `PlanStoreError` with code `fast_revision_invalid`. However, `formatStoreError()` renders detail rows only for `validation_failed`. For `fast_revision_invalid`, it discards the attached diagnostics and returns only the generic message shown in the report. The optimizer therefore cannot tell what to correct during its two remaining attempts and may repeat the same mistake until the original approval is restored.

Preserve the source-equivalence and scheduling safety boundary. Make each rejected fast revision actionable, and bias the optimizer toward the simplest valid fallback: retain source Parts verbatim and add only a schedule when a safe coherent split is not clear. Do not silently repair, accept, or execute a scope-changing revision. The existing three-attempt cap and restoration of the unconsumed source approval remain fail-safe behavior.

No glossary or ADR change is warranted. The repository already uses “Implement (fast),” “fast optimization,” and “parallel execution” consistently; the change is a reversible diagnostic and prompt refinement rather than a hard-to-reverse architectural decision. Pi’s installed extension documentation was unavailable inside the routed planning filesystem, so the investigation used the complete local plan-mode README, implementation, tests, and introducing commit as the authoritative project sources.

## Approach

Keep the current full-document optimizer and strict validator, but close the retry feedback loop. Surface bounded, structured validator diagnostics in both model-visible text and tool details, then give the optimizer an explicit conservative recovery strategy. This is smaller and safer than weakening equivalence checks or introducing automatic reconstruction of approved Markdown.

### Part A — Return actionable fast-revision diagnostics
- **Ledger:** {"status":"completed","note":"Rendered structured PlanStoreError details for all validation rows and returned the same bounded rows as validationErrors on rejections.","evidence":"Added duplicate-worker fast-rejection regression in test/workflow-dialogs.test.mjs; static fast-validator regression passed: node --test --test-name-pattern='Parallel Execution|fast scope' pi/agent/extensions/plan-mode/test/plan-document.test.mjs. Workflow harness could not load because its required Pi package jiti path is absent in this sandbox; final full check remains required."}

Refactor the plan-store error formatting boundary in `pi/agent/extensions/plan-mode/index.ts` so any `PlanStoreError` carrying validation-detail rows can render them, not only errors whose top-level code is `validation_failed`. Include each bounded row’s stable error code, optional line number, and message so the optimizer can distinguish document-shape, schedule, ownership, dependency, source-mapping, and scope-equivalence failures. Preserve truncation for large error sets and the current concise formatting for errors without structured details.

Expose the same bounded rows in the rejected `submit_plan` result’s `details` payload for machine-readable inspection while retaining the existing attempt count, `fast` marker, and retry-limit fields. Do not persist the candidate, consume the source approval, or start execution after any failed equivalence check. A corrected candidate within the limit must still pass the existing validator and follow the normal direct fast-execution handoff; the third invalid candidate must still restore the original approval without execution.

Acceptance requires the exact cause of the reported generic failure to be visible after the first rejection, with the optimization state and approved source unchanged and enough information for the next model turn to correct the candidate.

### Part B — Make conservative recovery explicit and cover the retry lifecycle
- **Ledger:** {"status":"completed","note":"Added conservative no-split recovery guidance, README coverage, and parser/workflow regressions for schedule, scope, retry, correction, and exhaustion paths.","evidence":"node --test pi/agent/extensions/plan-mode/test/plan-document.test.mjs passed (29/29); git diff --check passed. Full plan-mode and sandbox suites were attempted but fail before affected tests because the routed sandbox lacks the hard-coded Pi package jiti module."}

Tighten `buildFastOptimizationPrompt()` in `pi/agent/extensions/plan-mode/prompts.ts` without changing approved scope semantics. Tell the optimizer to prefer unsplit, verbatim source Parts unless repository evidence establishes a coherent safe split; identify copying the source unchanged and adding only the schedule as the valid fallback; and instruct it to use returned validator codes rather than rewriting content when a submission is rejected. Continue to require unique workers, contiguous ordered waves, earlier-wave dependencies, and non-overlapping sibling ownership.

Add focused parser/workflow regressions for the realistic failure modes hidden by the current message. Cover malformed or overlapping schedules, fixed-section scope drift, mapped-Part body drift, a first invalid fast submission followed by a corrected successful submission, and exhaustion of all three attempts. Assert that responses contain stable codes and line/message context where available, structured details agree with visible diagnostics, failed candidates never replace the approved source or queue execution, successful correction starts parallel execution once, and exhaustion restores the pending original approval.

Update `pi/agent/extensions/plan-mode/README.md` to describe actionable fast-optimizer retries and the conservative no-split fallback. Retain the generated plan document with the implementation commit as required by repository workflow. Acceptance requires documentation, prompt guidance, formatter behavior, and lifecycle tests to describe one consistent fail-safe workflow.

## Critical Files

- `pi/agent/extensions/plan-mode/index.ts` — formats `PlanStoreError` results and owns `submit_plan` rejection/retry behavior.
- `pi/agent/extensions/plan-mode/prompts.ts` — defines the fast optimizer’s constraints and recovery guidance.
- `pi/agent/extensions/plan-mode/plan-document.js` — read-only safety reference that emits detailed schedule and source-equivalence errors; its strict acceptance rules should remain intact unless a test exposes an actual diagnostic gap.
- `pi/agent/extensions/plan-mode/test/plan-document.test.mjs` and `test/workflow-dialogs.test.mjs` — focused validator and end-to-end fast retry coverage.
- `pi/agent/extensions/plan-mode/README.md` — authoritative local workflow documentation.

## Verification

**New reliability scenarios**

- Submit a fast revision with a duplicate worker or overlapping ownership and require the rejection to name the exact validator code and relevant line/message while remaining in fast optimization.
- Submit a revision that changes a fixed section or mapped source-Part body and require the response to identify the changed boundary without persisting or executing it.
- After one invalid candidate, submit a source-equivalent corrected schedule and require exactly one parallel execution handoff with the retry counter reset.
- Submit three invalid candidates and require restoration of the original unconsumed approval, no parallel execution contract, and no candidate plan replacement.

**Regression checks**

- Preserve ordinary canonical-plan validation messages, non-validation `PlanStoreError` formatting, the three-attempt limit, source hash/revision checks, and approval recovery when the optimizer stops without submitting.
- Run `npm --prefix pi/agent/extensions/plan-mode run check` for the complete plan-mode unit, integration, palette, and TUI suite.
- Run `npm --prefix pi/sandbox test` as the final composed sandboxing regression required for Pi extension changes.
- Review the final diff and `git diff --check`. Success means strict scope protection remains unchanged, every fast rejection is actionable, a correction can succeed on the next attempt, and no unrelated Pi runtime settings or existing uncommitted files are modified.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Return actionable fast-revision diagnostics
- ☑ Make conservative recovery explicit and cover the retry lifecycle
<!-- pi-plan-mode:progress:end -->
