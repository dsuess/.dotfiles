# Make Pi Wait Reporting Authoritative in Herdr

## Context

Herdr’s canonical lifecycle state for an unresolved human decision is `blocked`; the user-facing message can say `waiting for feedback`. `working` means the agent can still advance, while `idle` means Pi has settled at its ordinary prompt. In this plan, a **human-feedback wait** means an unresolved selector, confirmation, input, editor, custom dialog, structured questionnaire, approval, or staged checkpoint that prevents the current workflow from advancing. It does not infer intent from assistant prose; a settled plain-text response remains `idle` unless a real input lifecycle is open.

The current failure has a direct producer/consumer mismatch. `pi/agent/packages/ask-user-question/ask-user-question.ts` emits the stable `rpiv:ask-user:blocked` lifecycle before awaiting either the TUI questionnaire or RPC dialog walker, then clears it in `finally`. The stock Herdr v8 integration in `pi/agent/extensions/herdr-agent-state.ts` listens only for `herdr:blocked`. Nothing currently bridges those channels, because commit `a6a1728c` removed `herdr-feedback-state` while restoring the stock integration. Consequently, the questionnaire remains `working` even though its own package reports the wait correctly.

This is a regression of an already-proven integration, not an isolated questionnaire bug. The deleted bridge also aggregated durable plan approval/checkpoint state and ordinary `ctx.ui.select`, `confirm`, `input`, `editor`, and `custom` waits. Restoring only an ask-tool special case would repeat the piecemeal failure the user rejected.

Pi 0.84.2 exposes lifecycle events and promise-based UI primitives, but no public generic “UI wait started/ended” extension event. Therefore the robust local boundary is an adjacent wait-coordinator extension: consume explicit producer lifecycles where available, instrument standard extension UI as fallback, and reduce all active sources to one idempotent `herdr:blocked` edge. The generated Herdr file already documents that custom hooks belong beside it and must remain Herdr-managed ([Pi 0.84.2 extension API](https://raw.githubusercontent.com/earendil-works/pi-mono/v0.84.2/packages/coding-agent/docs/extensions.md), [Pi TUI API](https://raw.githubusercontent.com/earendil-works/pi-mono/v0.84.2/packages/coding-agent/docs/tui.md), [Herdr integration model](https://herdr.dev/docs/integrations/), [Herdr v0.8.2 Pi asset](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/integration/assets/pi/herdr-agent-state.ts)).

There is a second authority hazard in the same questionnaire flow. **Discuss this** launches a nested interactive Pi in the same terminal and currently inherits `HERDR_*`. Herdr issue [#2668](https://github.com/herdrdev/herdr/issues/2668) reproduces stale lifecycle authority when a nested TUI reports for its parent pane. The parent questionnaire must remain the sole Herdr authority and stay blocked while the child owns the terminal; the child must not inherit pane-reporting capability.

The accepted architecture keeps the stock generated integration byte-for-byte unchanged, restores one adjacent semantic bridge, and suppresses Herdr authority in nested questionnaire children. Source-keyed state and composed production tests prevent duplicate, overlapping, reload, and cleanup paths from ratcheting Herdr’s edge-counted listener. The unrelated worktree changes, especially `pi/agent/settings.json`, `AGENTS.md`, and Alfred workflow work, remain untouched. No glossary or ADR is warranted: this restores the established meanings of Herdr lifecycle states and follows the generated integration’s intended extension boundary.

## Approach

Implement one root-TUI human-feedback coordinator that owns wait aggregation but not transport. Explicit producer events are authoritative; standard Pi UI instrumentation is fallback coverage for extensions without semantic events. The coordinator emits exactly one active edge when the aggregate changes from empty to non-empty and one clear edge when the final source ends. Herdr’s generated reporter remains the sole socket transport and lifecycle authority.

### Part A — Reproduce the complete broken wait path
- **Ledger:** {"status":"completed","note":"Added coordinator, composed stock-reporter, and discussion-child regressions before repair.","evidence":"`node --test pi/agent/extensions/herdr-feedback-state/test.mjs` and the composed Vitest suite fail because the coordinator module is absent; `discussion/runtime.test.ts` fails because HERDR_ENV is inherited by the child. These failures isolate the missing bridge and nested authority leak."}

Add a focused coordinator regression suite and a production-shaped composed test before restoring behavior. Use the real questionnaire producer, the real plan workflow event contract, the proposed coordinator boundary, and the stock generated Herdr reporter against a controlled fake Unix socket.

Hold the questionnaire promise unresolved and prove the current repository fails to produce `working → blocked`. Cover normal answer, cancellation, UI rejection, and **Discuss this** suspension. Assert that the blocked edge starts before user input is awaited and always clears after the terminal path settles.

Add adversarial scenarios for duplicate producer events, malformed payloads, simultaneous questionnaire/plan/custom-UI waits, both overlap-clear orders, reload/session replacement, and late completion from a retired UI wrapper. The observable reporter sequence must be `working → blocked → working → idle`, with no duplicate active edge and no intermediate clear while another source remains.

Add a child-process environment regression showing that a nested interactive discussion currently receives the parent pane’s `HERDR_*` capability. The repaired expectation is that the parent remains blocked while the child runs and the child cannot report a competing session or lifecycle state.

Acceptance outcome: pre-repair failures identify the missing event bridge and inherited nested authority, rather than passing through mocked direct `herdr:blocked` calls.

### Part B — Restore one idempotent human-feedback coordinator
- **Ledger:** {"status":"completed","note":"Restored a source-keyed root-TUI coordinator beside the generated reporter. It consumes questionnaire and plan lifecycle events, instruments shared UI primitives, delays handoff clears, and retires wrappers/listeners safely.","evidence":"`node --test pi/agent/extensions/herdr-feedback-state/test.mjs`: 8/8 pass. `npm --prefix pi/agent/packages/ask-user-question test -- --run herdr-feedback-composed.test.mjs`: 5/5 pass with stock Unix-socket reporter sequence working→blocked→working→idle."}

Reintroduce `pi/agent/extensions/herdr-feedback-state/` as a locally owned extension beside `herdr-agent-state.ts`; do not modify or duplicate the generated reporter. Track active waits in a source-keyed map rather than forwarding producer edges directly.

Consume these authoritative sources:

- `rpiv:ask-user:blocked` for the complete structured-question lifecycle, including the suspended **Discuss this** interval;
- `plan-mode:workflow-state` while `feedbackPending` is true, so approval and staged checkpoints survive dialog cancellation, restoration, and reload;
- individually identified `ctx.ui.select`, `confirm`, `input`, `editor`, and `custom` operations as fallback for permission hooks and other extensions that lack a producer event.

Instrument the root TUI’s shared extension UI context during `session_start`, preserving receiver binding, arguments, return values, synchronous throws, promise rejection, cancellation, and overlapping calls. Explicit semantic events and fallback UI wrappers may overlap; the map must deduplicate their aggregate effect and clear only after every source ends. User-initiated extension contexts that Pi creates outside the shared runner context must use the same semantic event contract where they can block continuation; inventory the current local shortcut/command paths and add only the needed adapters rather than inferring from terminal text.

Publish only effective boolean transitions to `herdr:blocked`, with `waiting for feedback` as the safe message. Treat `active === true` strictly; malformed or false payloads clear only their own source. On `session_shutdown`, remove subscriptions, restore wrapped UI methods, invalidate delayed completions, and release any aggregate active edge so reload/new/resume/fork cannot leave the next reporter generation counted as blocked. On the replacement `session_start`, rebuild state from durable producer snapshots before publishing.

Acceptance outcome: every observable agent-blocking Pi input lifecycle reports `blocked`, duplicate/replayed events are idempotent, and ordinary settlement still reports `idle` through the stock reporter.

### Part C — Keep nested Pi children subordinate to the parent pane
- **Ledger:** {"status":"completed","note":"Discussion children now drop all HERDR_* and legacy PI_HERDR_* variables while retaining unrelated child capabilities and existing Pi/Gondolin behavior.","evidence":"Discussion runtime suite 5/5 pass, including explicit present-in-parent/absent-in-child capability assertions; composed questionnaire suite 5/5 confirms the parent remains blocked while the questionnaire is suspended; package typecheck passes."}

Update the questionnaire discussion child environment to remove inherited `HERDR_*` and any legacy local Pi/Herdr status variables before spawning the interactive child. Keep Pi session/model identity cleanup, Gondolin capabilities, planning inheritance, and terminal suspension behavior unchanged.

The parent `ask_user_question` execution remains unresolved throughout the child session, so its explicit questionnaire source keeps the parent pane blocked. Returning through `/resolve`, ordinary child exit, spawn failure, or abort must restore the parent TUI without allowing the child to replace the pane’s Herdr session reference or lifecycle state.

Extend discussion runtime tests to assert capability removal and parent-state continuity. This is deliberate authority isolation, not general environment sanitization: non-Herdr child capabilities remain inherited according to the existing child contract.

Acceptance outcome: exactly one Pi lifecycle reporter—the root parent—can author the Herdr pane while a discussion child owns the terminal.

### Part D — Lock the contract into documentation and deployment checks
- **Ledger:** {"status":"completed","note":"Documented the three-state/source contract and repository invariant, deployed through Stow, verified the generated reporter, and ran production and live canaries.","evidence":"`./install.sh config` passed; pinned Herdr v0.8.2 asset diff is empty; `git diff --check` passes. Fresh Herdr pane reported blocked with full_lifecycle_hook_authority and the parent session, stayed blocked with the same session through a discussion-child spawn failure, then changed to working after answer and done after settlement. Composed socket test proves the raw reporter sequence ends in idle."}

Document the three-state terminology and source contract near the coordinator: producer-owned lifecycle first, standard UI instrumentation as fallback, no prose/screen inference, and one aggregate edge into the generated reporter. Restore the scoped repository invariant that cross-extension status integrations require explicit producer events plus a production-shaped composed test. Keep `pi/agent/extensions/herdr-agent-state.ts` marked and verified as generated content that must not be patched locally.

Deploy only through `./install.sh config`. Do not add a broker, second socket reporter, status-forcing command, screen pattern, or settings entry; global extension auto-discovery loads the coordinator beside the generated integration.

Acceptance outcome: a future producer or Herdr update has a documented integration rule and fails locally if it bypasses, duplicates, or strands the aggregate wait lifecycle.

## Critical Files

- `pi/agent/extensions/herdr-agent-state.ts` — stock Herdr lifecycle/socket reporter and consumer of the final `herdr:blocked` edge; read-only generated boundary.
- `pi/agent/extensions/herdr-feedback-state/index.ts` — restored root-TUI coordinator for explicit and fallback human-feedback sources.
- `pi/agent/packages/ask-user-question/events.ts` and `ask-user-question.ts` — authoritative structured-question wait contract and `finally` cleanup ordering.
- `pi/agent/extensions/plan-mode/events.ts` — durable approval/checkpoint wait contract across dialog and session restoration.
- `pi/agent/packages/ask-user-question/discussion/runtime.ts` — nested interactive child environment and terminal handoff boundary.
- `pi/agent/extensions/herdr-feedback-state/test.mjs` and the questionnaire composed test — source aggregation and real producer-to-reporter regression boundaries.
- `pi/AGENTS.md` — generated-file ownership and cross-extension lifecycle verification rules.

## Verification

Regression checks:

- Run the coordinator suite for explicit questionnaire state, plan workflow state, every standard blocking UI primitive, overlap, duplicate/malformed events, rejection, reload, shutdown, and retired completions.
- Run the questionnaire package tests and typecheck. Verify active emission precedes TUI/RPC waiting and false emission is guaranteed after answer, cancel, handoff, abort, and error.
- Run plan-mode workflow/dialog checks to confirm durable `feedbackPending` restoration and checkpoint behavior are unchanged.
- Run the stock-reporter composed socket test. Assert session identity precedes state and the effective sequence is `working → blocked → working → idle` without duplicate oscillation.
- Compare `pi/agent/extensions/herdr-agent-state.ts` with the pinned Herdr v8 asset; any local modification is a failure.
- Review `git diff`, run whitespace checks, and confirm all unrelated existing worktree changes are byte-for-byte untouched.

New failure-mode scenarios:

1. Leave a real `ask_user_question` overlay unanswered: the latest Herdr report is `blocked` with `waiting for feedback`.
2. Answer, cancel, or fail the overlay: it returns to `working` while the turn continues, then `idle` only after `agent_settled`.
3. Overlap questionnaire, plan approval, and generic UI waits: clearing any subset does not clear `blocked`.
4. Reload or replace the session during a wait: retired listeners/wrappers emit no late state and the new session establishes one correct aggregate.
5. Enter **Discuss this**: the parent remains blocked, the child receives no Herdr pane capability, and `/resolve` or exit returns without changing lifecycle authority.

Live canary after Stow deployment:

- Start a fresh Pi pane under Herdr, invoke `ask_user_question`, and leave it open. `herdr agent get <pane>` must show `agent_status: blocked` and the active parent Pi session.
- `herdr agent explain <pane> --json` must show `full_lifecycle_hook_authority`; screen fallback or a missing session reference is a failure.
- Enter and exit **Discuss this** while observing the pane. The session reference must remain the parent’s and status must remain blocked throughout.
- Answer the questionnaire. Herdr must move immediately to `working`, then to `idle` when Pi settles. A visible question reported as working, duplicate blocked transitions, stale child authority, or a state that remains blocked after every source clears is a release blocker.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Reproduce the complete broken wait path
- ☑ Restore one idempotent human-feedback coordinator
- ☑ Keep nested Pi children subordinate to the parent pane
- ☑ Lock the contract into documentation and deployment checks
<!-- pi-plan-mode:progress:end -->
