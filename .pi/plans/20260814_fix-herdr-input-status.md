# Restore Herdr Waiting-for-Input Status

## Context

Herdr’s canonical state for an agent that needs input, approval, or a decision is `blocked`; `working` means the agent is actively running. The reported example is a Pi plan-approval dialog, so it must remain `blocked` until the user chooses an action or dismisses the dialog.

The local design has three layers: `herdr-feedback-state` aggregates blocking Pi UI and durable plan-workflow waits into `herdr:blocked`; `herdr-agent-state.ts` gives that state precedence over `working` and `idle`; and the authenticated loopback broker forwards only canonical Herdr status/session/metadata methods. The broker boundary and the repository invariant against exposing Herdr’s native socket must remain unchanged.

The isolated feedback, reporter, plan-dialog, and broker tests all pass, but the live pane from the screenshot did not have lifecycle-hook authority. `herdr agent explain` classified it as `working` from the stale terminal literal `Working...` instead of reporting `screen_detection_skip_reason: full_lifecycle_hook_authority`, and `herdr agent get` had no Pi session reference. The pane had also replaced its Pi session before entering approval. This conflicts with `pi/sandbox/README.md`, which describes the brokered reporter as authoritative, and with Herdr’s integration contract that a current Pi lifecycle reporter owns `idle`, `working`, and `blocked` without screen fallback ([Herdr agents](https://herdr.dev/docs/agents/), [Herdr integrations](https://herdr.dev/docs/integrations/)). The coverage gap is composition and session replacement: current tests exercise the components independently but do not prove that a root TUI can replace/reload its session, retain one valid authority, and then forward a durable approval wait.

Keep the existing plan action dialog and plan workflow semantics. Preserve the user’s unrelated uncommitted `pi/agent/settings.json` changes. No glossary or ADR is warranted: this is a repair to the documented lifecycle contract, not a new domain term or hard-to-reverse architectural decision.

## Approach

Repair the existing semantic-state path rather than adding screen patterns for the plan dialog. Screen detection is only a fallback and can be misled by scrollback; the Pi integration already has the precise lifecycle and UI signals.

### Part A — Reproduce authority loss across session replacement
- **Ledger:** {"status":"completed","note":"Added a composed root-session replacement regression harness using the real feedback extension, workflow-state event, durable plan state transition, and broker-facing HTTP transport.","evidence":"`node --test pi/sandbox/test-herdr-agent-state.mjs` fails before the repair only at `root session replacement retains only the current reporter through a durable approval wait`, proving a retired reporter can emit session-1 state after session-2 replaces it."}

Add a regression harness that composes the real feedback aggregator, Pi lifecycle reporter, plan workflow event bus, and broker-facing transport instead of mocking each extension in isolation. Drive a root TUI through initial startup, a `new`/reload-style session replacement, plan submission, and an unresolved approval dialog. Keep the dialog promise open long enough to inspect the forwarded state.

The harness must verify that the replacement session reference is reported before its lifecycle state, only the active root-session generation reacts to shared `herdr:blocked` events, and the effective request becomes `blocked` with `waiting for feedback`. It must then resolve or dismiss the dialog and verify the correct `working` or `idle` successor without a stale instance reclaiming or clearing authority. Include overlapping waits so a UI completion cannot clear a still-pending durable approval.

This Part is accepted when the test fails against the current session-replacement behavior for the same reason observed live and distinguishes authority/session loss from UI-question classification.

### Part B — Make one reporter own the active root TUI lifecycle
- **Ledger:** {"status":"completed","note":"Added a process-wide reporter generation/operation queue, scoped session references, shutdown invalidation, and teardown waits. Retired reporters now ignore shared events and cannot race a replacement session.","evidence":"The composed replacement regression now passes, as do all five reporter transport tests and all 14 feedback-state tests (`node --test pi/sandbox/test-herdr-agent-state.mjs`; `node --test pi/agent/extensions/herdr-feedback-state/test.mjs`)."}

Correct the reporter and feedback lifecycle around `session_start` and `session_shutdown`. Use one active root-session generation at a time: refresh the Pi session reference before publishing state, preserve strictly increasing report order across replacement/reload boundaries, prevent old queues or shared-event listeners from reporting after teardown, and ensure a successor does not race an old release or state write. Keep `blocked` above `working` and `idle` in `desiredState()`.

Retain durable plan workflow state as an independent blocking source. A pending approval or staged checkpoint must remain blocked even if `ctx.ui.custom`, `select`, or `editor` returns; overlapping blocking UI must remain deduplicated. Plain settled questions and structured blocking UI continue to use their existing semantic paths, with non-TUI sessions remaining silent.

Do not broaden the broker capability, expose `HERDR_SOCKET_PATH` to sandboxed Pi, add screen-scraping rules, or change plan approval choices. Preserve canonical broker fields and session-path confinement. If the composed regression shows that broker-side sequence canonicalization is the authority-loss point, repair that ordering within the existing allowlisted broker contract rather than bypassing it.

This Part is accepted when the composed regression shows a current Pi session reference and uninterrupted lifecycle authority through session replacement, with the plan dialog reported as `blocked` until feedback is resolved.

### Part C — Align regression coverage and operational diagnostics
- **Ledger:** {"status":"completed","note":"Added stale-retry suppression coverage and documented the lifecycle authority diagnostic without changing broker capabilities or socket exposure.","evidence":"Pass: `npm --prefix /Users/dsuess/.dotfiles/pi/sandbox run test:broker` (7 tests); `node --test /Users/dsuess/.dotfiles/pi/agent/extensions/herdr-feedback-state/test.mjs` (14 tests); `npm --prefix /Users/dsuess/.dotfiles/pi/agent/extensions/plan-mode test -- --test-name-pattern='.'` (138 tests). `git diff --check` passes; `pi/agent/settings.json` retains exactly its pre-existing 4-line user diff."}

Extend the narrow reporter/broker tests for the concrete failure mode: replacement generation, stale listener/queue suppression, retry ordering, and blocked-state precedence while a durable workflow wait overlaps a custom dialog. Keep direct-socket behavior for `--yolo` and brokered behavior for normal sandbox launches covered separately.

Update `pi/sandbox/README.md` only if the repaired lifecycle or troubleshooting signal needs clarification. The documented security boundary and unrestricted-network design must not change. Deployment continues through the existing Stow-managed paths; do not create or replace symlinks manually.

This Part is accepted when a future regression fails locally with an authority/session-specific assertion rather than only appearing as an incorrect sidebar color.

## Critical Files

- `pi/agent/extensions/herdr-feedback-state/index.ts` — aggregates blocking UI, durable workflow waits, and settled free-form feedback into one semantic blocked signal.
- `pi/agent/extensions/herdr-agent-state.ts` — owns Pi session identity, state precedence, report ordering, and root-TUI lifecycle reporting.
- `pi/sandbox/herdr-status-broker.mjs` — canonical, capability-limited transport boundary; change only if composed evidence identifies broker ordering as the fault.
- `pi/agent/extensions/plan-mode/events.ts` and `pi/agent/extensions/plan-mode/state.js` — read-only contract references for durable approval/checkpoint waits.
- `pi/agent/extensions/herdr-feedback-state/test.mjs` and `pi/sandbox/test-herdr-agent-state.mjs` — primary regression boundaries to extend with composed session-replacement behavior.

## Verification

Regression checks:

- Run the feedback-state suite, the plan workflow-dialog suite, and the reporter/broker suites; all existing free-form question, overlapping UI, retry, TUI-only, and broker-hardening scenarios must remain green.
- Run `npm run test:broker` from `pi/sandbox` to verify canonical forwarding, authentication, session-root confinement, retry behavior, and direct/broker transport separation.
- Confirm the unrelated `pi/agent/settings.json` diff is unchanged and review the final diff for security-boundary or scope drift.

New failure-mode scenarios:

- Start a root TUI, replace or reload its session, submit a plan, and leave the approval dialog open. The latest forwarded state must be `blocked` with the replacement session reference; any `working`/`idle` report from the old generation is a failure.
- Resolve the approval into execution. The next state must be `working`; dismissing it with no pending work must produce `idle` while retaining the unconsumed durable approval for reopening.
- Overlap a pending approval with custom/editor UI. Completing one source must not clear `blocked` until every source is resolved.

Live canary after deployment:

- `herdr agent get <pane>` must include the active Pi `agent_session`, and `herdr agent explain <pane> --json` must report `screen_detection_skipped: true` with `full_lifecycle_hook_authority`.
- While plan approval or another blocking Pi dialog is visible, Herdr must report `blocked`; after the user answers, it must transition to `working` or `idle` according to Pi’s lifecycle. A fallback match on stale `Working...`, a missing session reference, or a state that remains blocked after all waits resolve is a failure signal.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Reproduce authority loss across session replacement
- ☑ Make one reporter own the active root TUI lifecycle
- ☑ Align regression coverage and operational diagnostics
<!-- pi-plan-mode:progress:end -->
