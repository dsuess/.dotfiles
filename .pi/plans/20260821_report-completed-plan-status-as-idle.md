# Report completed plans as idle

## Context

Herdr renders Pi’s green state as its `idle` agent status. The generated Pi reporter in `pi/agent/extensions/herdr-agent-state.ts` currently derives that status only from Pi’s `agent_settled` lifecycle edge. Plan mode already persists an explicit `completed` workflow state after `complete_plan` validates every ledger item, and emits `plan-mode:workflow-state` whenever it refreshes its state. A completed plan can therefore remain yellow (`working`) if the terminal lifecycle edge is delayed, missed, or superseded, despite the durable plan contract being complete.

Pi itself sets `ctx.isIdle()` before it emits `agent_settled`, so the issue is not sandbox transport or Herdr’s color mapping. The broker acknowledgement/retry pipeline should remain authoritative for transport ordering. The fix should add the completed-plan signal as a narrow semantic override: it reports `idle` after plan mode declares completion, but an active feedback wait still wins as `blocked`, and the next agent run immediately returns to `working`. Other workflow outcomes, including blocked or paused execution, are out of scope.

The repository has no `CONTEXT.md` or ADRs for this integration. Existing local guidance requires explicit producer lifecycle events and a production-shaped composed test; this approach uses the existing workflow event rather than another UI wrapper or screen heuristic.

## Approach

Use plan mode’s persisted completion transition as a semantic terminal-state input while retaining normal Pi lifecycle state for all other work.

### Part A — Reconcile explicit plan completion with Herdr lifecycle state
- **Ledger:** {"status":"completed","note":"Reporter now treats only persisted `mode: \"completed\"` workflow events as an idle override, with blocked feedback precedence and reset at root-session/new-run boundaries.","evidence":"`npm --prefix pi/sandbox run test:broker` passed all reporter/broker tests; the sandbox-wrapper composed case is environment-blocked under the current sandbox (wrapper exited 1 without diagnostics)."}

Extend the `plan-mode:workflow-state` contract and the Herdr reporter so the reporter tracks whether the current root session’s workflow is explicitly `completed`. When completion is received, make the effective state `idle` even if the current agent lifecycle has not yet emitted `agent_settled`; preserve `blocked` as the higher-priority state for unresolved feedback. Clear the completion override on any non-completed workflow update and before publishing a new `agent_start`, so follow-up prompts and a new planning run cannot inherit green status. Keep the existing generation ownership, session/metadata acknowledgement ordering, broker retries, sequence ordering, and TUI-only boundary unchanged.

The existing `PLAN_MODE_WORKFLOW_STATE_EVENT` is the integration anchor: plan mode must continue publishing the mode alongside `feedbackPending` on every state refresh, including restored completed sessions and the `complete_plan` transition. Do not infer completion from tool text, screen output, or the plan file; only the persisted workflow mode is authoritative. Acceptance is an acknowledged `pane.report_agent` request with `state: "idle"` after `mode: "completed"`, without needing a later lifecycle event.

### Part B — Prove terminal override and lifecycle recovery
- **Ledger:** {"status":"completed","note":"Added broker-backed composed coverage for an acknowledged completed event reaching idle before settlement, new-run recovery to working, and feedback-block precedence/clearance; added completion producer coverage.","evidence":"`node --test pi/sandbox/test-herdr-agent-state.mjs` passed 14/14; `PI_PACKAGE_ROOT=/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent node --test pi/agent/extensions/plan-mode/test/workflow-dialogs.test.mjs` passed 22/22; `npm --prefix pi/sandbox run test:broker` passed 16/16."}

Add focused reporter coverage using the existing fake broker/composed harness. Exercise an active implementation state that becomes `working`, publish the real workflow-event shape for `completed` without emitting `agent_settled`, and assert the broker receives `idle` for the same current session reference. Then begin a new agent run and assert it supersedes that override with `working`; cover a competing feedback block so `blocked` remains dominant until cleared.

Extend plan-mode workflow tests to assert that completing a validated plan emits `mode: "completed"` with no durable feedback pending, rather than relying on an incidental UI refresh. Preserve existing coverage for terminal idle retries, durable blocked retries, session replacement, and structured-question behavior. The new tests must fail under the lifecycle-only implementation and use acknowledged broker responses rather than inspecting private reporter variables.

### Part C — Document the status authority boundary
- **Ledger:** {"status":"completed","note":"Documented the dual green-status inputs and their completed-only, feedback, and new-run precedence in both operational and plan-mode lifecycle guides.","evidence":"Reviewed `pi/sandbox/README.md` and `pi/agent/extensions/plan-mode/README.md`; broker suite `npm --prefix pi/sandbox run test:broker` passed 16/16."}

Update the Herdr sandbox operational documentation and the plan-mode lifecycle documentation to distinguish two inputs to green status: ordinary settled Pi lifecycle and the durable `completed` plan workflow event. State that this is a completed-plan-only semantic override, that a new agent run reasserts working, and that feedback waits still report blocked. Retain the guidance to diagnose stale reports through broker acknowledgement and `herdr agent get`/`herdr agent explain`, rather than adding screen-detection patterns or bypassing the status broker.

## Critical Files

- `pi/agent/extensions/herdr-agent-state.ts` — generated reporter with the local broker transport; owns state precedence, acknowledgement, and retries.
- `pi/agent/extensions/plan-mode/events.ts` and `pi/agent/extensions/plan-mode/index.ts` — explicit producer event contract and its durable workflow-state publication.
- `pi/sandbox/test-herdr-agent-state.mjs` — broker-backed, cross-extension lifecycle regression boundary.
- `pi/agent/extensions/plan-mode/test/workflow-dialogs.test.mjs` — validates plan completion publishes the producer contract.
- `pi/sandbox/README.md` and `pi/agent/extensions/plan-mode/README.md` — operational and workflow semantics.

## Verification

Regression checks run the focused plan-mode suite and `npm --prefix pi/sandbox run test:broker`. Existing lifecycle-only behavior must remain: ordinary turns reach idle at `agent_settled`; feedback waits remain blocked; terminal idle and durable blocked both reconcile after exhausted immediate delivery attempts; a session replacement cannot publish from its retired reporter.

New-feature scenarios use a fake acknowledged broker to demonstrate `working → idle` immediately after the completed workflow event, with no `agent_settled`, then `idle → working` on the next agent start. A completed event concurrent with an active feedback wait must remain `blocked` until that wait clears. As a live smoke check after a normal completed plan, `herdr agent get <pane>` must show `agent_status: "idle"` and `herdr agent explain <pane>` must retain `full_lifecycle_hook_authority`; a green state before `complete_plan`, a lingering working state after an acknowledged completed event, or a stale green state after the next prompt are failure signals.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Reconcile explicit plan completion with Herdr lifecycle state
- ☑ Prove terminal override and lifecycle recovery
- ☑ Document the status authority boundary
<!-- pi-plan-mode:progress:end -->
