# Simplify Pi Planning into Two Flexible Modes

## Context

The current extension models planning as a fixed chain of `off → planning → approval → executing_* → completed | blocked`. `submit_plan` both validates and renders a candidate, changes the workflow to `approval`, and is required by the planner prompt at the end of a planning turn. Although `planning` and `approval` use the same limited tools, the separate phase prevents ordinary planning conversation after a candidate is shown and causes **Change** feedback to push the model toward an immediate resubmission.

Pi also checks automatic compaction after the agent run but before `agent_settled`, which is when the extension opens plan actions. The supported interception point is `session_before_compact`; a subsequent interactive/RPC input is observed before Pi's pre-prompt compaction check. These event boundaries allow the extension to defer automatic compaction while a shown candidate awaits a decision, then permit it after approval or a new user interaction.

Use **mode** only for the tool-access boundary: `planning` has inspection/research/question tools plus the plan-display tool, and `normal` has the restored implementation tools. Approval, execution strategy, pause/checkpoint state, completion, and blocking remain orthogonal workflow data rather than additional modes. Preserve the existing Implement, fast, staged, review, ledger, and execution-boundary features. A validated but unaccepted document is a **candidate plan**; reserve **approved plan** for a candidate after the user selects an implementation action.

Replace `submit_plan` with `show_plan` rather than retaining a second alias. This rename crosses the SRT audited-host-adapter manifest and the child Pi capability filters: both subagents and questionnaire discussions currently identify inherited planning by the active `submit_plan` tool. Existing persisted plan-mode state must migrate without losing a pending candidate, active execution, ledger, or checkpoint. No ADR is warranted because this is a reversible workflow redesign, and no standalone domain glossary is needed; the extension README will define the terms. Unrelated worktree changes must remain untouched.

## Approach

Implement a two-mode state model, then make plan presentation an explicit readiness action inside planning rather than a phase transition.

### Part A — Replace workflow phases with orthogonal state

Introduce a versioned state shape whose only mode values are `planning` and `normal`. Keep pending approval tokens inside planning, and represent active all/staged execution, paused checkpoints, and completed/blocked outcomes separately. Replace mode-string checks throughout planning, execution, restoration, model routing, tool selection, and progress handling with focused predicates over those fields.

A successful candidate presentation must leave the mode as `planning`. Approving a standard or staged run switches to `normal` and restores implementation tools; fast optimization may remain gated while it derives the approved parallel revision, then switches to normal execution. `/plan off` must always return to normal rather than stopping at an intermediate workflow condition.

Add migration from the current state version: old `off`, execution, completed, and blocked records become normal state with equivalent execution/outcome data, while old `planning` and pending `approval` records become planning state. Restoration must continue to fail closed for stale optimization or missing execution contracts and must preserve current plan metadata, approval nonces, ledgers, and checkpoints. Acceptance requires every reachable and restored state to expose exactly one of the two mode values without weakening execution ordering or ledger validation.

### Part B — Make candidate presentation and discussion model-directed

Register `show_plan` as the sole trusted plan writer/display tool. It retains the canonical Markdown validation, safe path allocation, atomic persistence, durable transcript rendering, revision/hash checks, and retry diagnostics, but it creates a pending candidate decision without leaving planning mode. Rename UI and internal wording that currently calls an unaccepted document approved.

Revise the planning prompt so the model can investigate, answer, and discuss for as many turns as needed. It should call `show_plan` only when all blockers are resolved and it is satisfied that the complete candidate is ready for approval; it must not print a full plan as a substitute or call the tool merely because a turn is ending. Apply the same tool name and readiness rule to fast optimization and tuicr review reconciliation.

Rename **Change** to **Discuss** in TUI and RPC actions. The editor still captures the user's initial free-form feedback, but the injected turn must frame it as an open planning conversation: the model may answer, investigate, ask batched questions, or change direction, and it must show a revised candidate only when ready. Clear the prior approval token when Discuss starts. Treat any ordinary interactive/RPC prompt entered while a candidate is pending as discussion too, so dismissing the action dialog never traps the session in a non-conversational approval state. Keep the candidate reference available for re-reading and revision.

Intercept `session_before_compact` and cancel non-manual compaction while a candidate approval is pending. This covers the post-run threshold/overflow check before the action dialog. Manual `/compact` remains user-controlled. Approval, successful Review/Discuss handoff, or another ordinary user prompt clears the pending wait before the next pre-prompt compaction check, so compaction can then proceed normally. Acceptance requires a discussion turn that does not call `show_plan` to settle without rendering or reopening actions, while a later ready revision can invoke the tool and receive one fresh decision.

### Part C — Propagate the two-mode and `show_plan` contracts

Update the planning gate, workflow-state event, statusbar, and Herdr feedback coordinator so planning appearance depends only on `mode === "planning"`, while `feedbackPending` still reports a candidate decision or staged checkpoint. Preserve pending-decision behavior across Escape, reload, resume, and tree navigation.

Rename the audited host adapter and child capability from `submit_plan` to `show_plan` without changing its validated schema or trusted persistence effects. Update SRT schema checks, subagent and questionnaire-discussion workflow-tool exclusions, inherited-planning detection, and their documentation/tests so child processes remain fail-closed and cannot receive parent plan workflow tools.

Update `pi/agent/extensions/plan-mode/README.md` to describe the two modes, candidate/approval lifecycle, explicit `show_plan`, Discuss behavior, and deferred automatic compaction. Surgically align `pi/agent/AGENTS.md` with the new integrated tool name so the base runtime instructions do not conflict with the per-turn planning prompt. Record the reusable correction in the repository `AGENTS.md`: planning UX must be modeled as a persistent tool-gated mode with explicit model-directed presentation, not a forced one-response approval phase.

### Part D — Lock down conversational and restoration behavior

Refactor the existing state, workflow-dialog, RPC, palette, TUI, execution, SRT, subagent, questionnaire-discussion, and feedback tests around the new contract. Add focused scenarios for old-state migration, a shown candidate remaining in planning, direct input invalidating a pending candidate decision, multi-turn Discuss without automatic re-display, a later `show_plan` revision reopening actions once, and automatic versus manual compaction interception.

Retain regression coverage for safe plan persistence, stale nonce/hash rejection, fast optimizer recovery, print/JSON save-without-prompt behavior, staged checkpoints, model-profile routing, execution context isolation, SRT schema auditing, and exact child capability filtering. Test fixtures may contain legacy mode/tool names only when they explicitly exercise migration; active runtime assertions and documentation must use the new terms.

## Critical Files

- `pi/agent/extensions/plan-mode/state.{js,ts}` — versioned two-mode state, migration, approval, execution, and outcome invariants.
- `pi/agent/extensions/plan-mode/index.ts`, `prompts.ts`, and `action-dialog.ts` — `show_plan`, open-ended Discuss flow, compaction deferral, tool gating, and UI orchestration.
- `pi/agent/extensions/srt-tool-routing/host-adapters.ts` and `child-capabilities.js` — audited host adapter identity and child fail-closed capability boundary.
- `pi/agent/extensions/subagent/runtime.js` and `pi/agent/packages/ask-user-question/discussion/runtime.ts` — inherited planning detection and parent-workflow exclusion for child Pi processes.
- `pi/agent/extensions/plan-mode/README.md`, `pi/agent/AGENTS.md`, and repository `AGENTS.md` — user-facing workflow contract, runtime planning instruction, and correction lesson.

## Verification

Regression checks:

- Run `npm --prefix pi/agent/extensions/plan-mode run check`; all state, persistence, workflow dialog, RPC, palette, TUI, execution, and restoration checks must pass.
- Run the affected subagent, SRT routing, Herdr feedback, statusbar, and ask-user-question tests, including the ask-user-question typecheck. Schema audit success and exact child capability lists are required signals; an unaudited `show_plan`, leaked parent workflow tool, or stale active `submit_plan` reference is a failure.
- Run the repository-required `npm --prefix pi run check` from the host. The complete deterministic and native SRT/Docker gates must pass, or any environment-only blocker must be reported precisely.

New behavior scenarios:

- Enter `/plan`, hold a normal planning conversation, and verify that no candidate appears until the model calls `show_plan`.
- After `show_plan`, verify the candidate renders once, actions open once, the status remains `[PLANNING]`, limited tools remain active, and automatic compaction is cancelled while the decision is pending; manual compaction remains available.
- Choose Discuss, have the model answer without revising, and verify no plan is shown automatically. Continue with another user turn, then show a ready revision and verify one fresh candidate decision.
- Approve standard, fast, and staged paths and verify each enters normal mode with the existing execution contract, ledger ordering, model handoff, and checkpoint behavior intact.
- Restore representative legacy planning, approval, execution, completed, and blocked records and verify their candidate, approval, execution, and ledger data survive under exactly the `planning` or `normal` mode.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☐ Replace workflow phases with orthogonal state
- ☐ Make candidate presentation and discussion model-directed
- ☐ Propagate the two-mode and `show_plan` contracts
- ☐ Lock down conversational and restoration behavior
<!-- pi-plan-mode:progress:end -->
