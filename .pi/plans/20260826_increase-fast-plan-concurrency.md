# Increase Fast Plan Concurrency

## Context

The fast optimizer currently says to put safe independent workers in the same wave, but its stronger conservative wording encourages verbatim Parts without distinguishing source preservation from sequential scheduling. Representative output therefore carries source-plan ordering into four waves even when several workers own disjoint implementation areas. Execution already batches siblings correctly; the optimizer schedule is the bottleneck.

Keep source-equivalence, exclusive ownership, and genuine dependency safety unchanged. Define a dependency as a concrete predecessor output required before another worker can begin, not source order, conceptual ordering, shared context, later integration, or general caution.

## Approach

Make critical-path minimization explicit while retaining fail-safe scheduling.

### Part A — Schedule independent work in the earliest safe wave

Update the fast-optimization prompt to minimize wave count after safety, place each Part in its earliest valid wave, split broad source Parts when an exact source-preserving partition unlocks concurrency, and audit every dependency and single-worker wave. Clarify that keeping Part text verbatim does not imply serial execution. Update local documentation, the prompt regression, and the Pi extension invariant so future changes preserve this distinction.

Acceptance requires the optimizer guidance to reject unsupported dependency edges while preserving concrete artifact dependencies, source equivalence, and non-overlapping ownership.

## Critical Files

- `pi/agent/extensions/plan-mode/prompts.ts` — fast optimizer scheduling objective and dependency rules.
- `pi/agent/extensions/plan-mode/README.md` — user-facing fast optimization behavior.
- `pi/agent/extensions/plan-mode/test/workflow-dialogs.test.mjs` — prompt contract regression.
- `pi/AGENTS.md` — reusable repository invariant from the correction.

## Verification

Run the focused plan-document tests and the plan-mode check where the installed Pi package is available. Run `git diff --check`, inspect the staged diff, and commit only the plan and intended Pi files. Success means the prompt explicitly minimizes critical-path waves, defines hard dependencies, and retains strict safety guards.
