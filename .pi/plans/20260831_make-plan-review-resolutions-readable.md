# Quote Plan Review Comments in Resolutions

## Context

Pi plan mode sends tuicr comments to the planner as structured JSON. The current instruction requires attribution by anchor or stable ID. This permits compact, opaque output such as `e1d00443…: Agreed`, which makes the user match hashes back to comments.

The readable unit is a **plan review comment** followed by its **resolution**. The planner must preserve each comment's exact content and original order. It must show the content as a Markdown blockquote, then put a clearly labeled resolution underneath. Stable IDs remain useful for internal coverage checks, but they must not replace the quoted user text in the visible response.

The runtime prompt in `pi/agent/extensions/plan-mode/index.ts`, the Pi-specific guidance in the shared `plan-review` skill, and the plan-mode README currently agree on ID-based attribution. They need the same display contract. This is a reversible presentation rule, so it does not warrant a glossary entry or ADR. The worktree contains unrelated user changes; implementation must preserve them and limit edits to this behavior, its documentation, its tests, and this generated plan document.

Prompt adherence is not fully deterministic. Precise formatting instructions and an example reduce that risk. A focused prompt regression test verifies the contract that Pi sends to the planner, while a review smoke scenario verifies the visible result.

## Approach

Add one consistent response contract at every Pi plan-review instruction boundary. Keep the structured comment schema, reconciliation rules, clarification workflow, canonical-plan validation, and approval lifecycle unchanged.

### Part A — Present quoted comments with labeled resolutions
- **Ledger:** {"status":"completed","note":"Added the quoted-comment resolution contract consistently to the planner prompt, Pi guidance, and README; extended the workflow regression with opaque IDs, a question, and a multiline comment.","evidence":"`npm --prefix pi/agent/extensions/plan-mode run check` passed (116 tests plus smoke/integration/palette/TUI smoke). `npm --prefix pi run check` passed. `git diff --check` passed; final scoped review found only the planned runtime, skill, README, test, and generated-plan changes."}

Update the plan-review prompt so that every user-visible resolution block follows the comments' original order and uses this shape:

```markdown
> Exact user question or comment

**Resolution:** Grounded answer, reconciliation, and plan impact.
```

Require every line of multi-line comments to remain quoted. Require a final complete resolution block before `submit_plan`. Stable IDs can support internal inventory checks, but the planner must not use an ID-only bullet or an opaque hash as the visible label. Open user-owned decisions still use the existing batched clarification flow, and submission remains blocked until all comments have resolutions.

Apply the same Pi-specific rule to `agents/skills/plan-review/SKILL.md`, including its structured-feedback example. Update the plan-mode README to describe the quoted format without changing Claude's separate `!` and `?` annotation protocol. Extend the existing workflow-dialog regression test to prove that the generated planner message contains the quote-and-resolution template, preserves exact comment text, and rejects ID-only presentation guidance.

This Part is accepted when a plan-review round tells the planner to quote each original comment, put `**Resolution:**` directly below it, retain the existing evidence and plan-impact requirements, and avoid hash-led bullets. No comment schema, tuicr integration, plan persistence, or approval behavior changes.

## Critical Files

- `pi/agent/extensions/plan-mode/index.ts` — emits the authoritative planner message after a successful tuicr review.
- `agents/skills/plan-review/SKILL.md` — supplies Pi-specific review behavior that the planner can load for structured comments.
- `pi/agent/extensions/plan-mode/test/workflow-dialogs.test.mjs` — verifies the generated review instruction and existing review lifecycle.
- `pi/agent/extensions/plan-mode/README.md` — documents the user-visible plan-review contract.

## Verification

Regression checks must preserve comment normalization, review retries, batched clarification, one canonical resubmission, and the approval lifecycle. Run the focused plan-mode checks first. Then run `npm --prefix pi/agent/extensions/plan-mode run check`.

For the new scenario, use multiple review comments with opaque stable IDs, including a question and a multi-line comment. The generated planner instruction must contain the exact comment text, the Markdown blockquote rule, the `**Resolution:**` label, original-order guidance, and the prohibition on ID-only labels.

Perform a TUI review smoke check when the environment supports it. The visible success signal is one quoted user comment followed immediately by its resolution for every entry. A hash-only bullet, a paraphrased comment without the original quote, a missing resolution, reordered comments, or premature `submit_plan` is a failure signal.

Finally, run `npm --prefix pi run check` from an ordinary host terminal as required by the Pi package gate. Review the final diff to make sure that unrelated worktree changes remain untouched and that the generated `.pi/plans/...` document remains in the change set.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Present quoted comments with labeled resolutions
<!-- pi-plan-mode:progress:end -->
