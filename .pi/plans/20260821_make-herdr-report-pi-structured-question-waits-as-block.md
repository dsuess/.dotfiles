# Make Herdr questionnaire waits reliably blocked

## Context

Herdr’s canonical states remain unchanged: `blocked` means Pi is waiting for human input, `working` means the agent is actively executing, and `idle` means no work or decision is pending.

The failure is reproduced live in two authoritative Pi panes. `w15:p2` and `w16:p6` visibly show unresolved `ask_user_question` questionnaires, but `herdr agent get` reports `working`. Both panes have a current Pi `agent_session`, and `herdr agent explain --json` reports `screen_detection_skip_reason: full_lifecycle_hook_authority`. This rules out the previously repaired broker, session-reference, and screen-fallback paths: Herdr is accepting Pi lifecycle reports, but Pi never publishes the semantic blocked transition for these questionnaires.

The local questionnaire package already provides the precise signal needed. It emits the stable public event `rpiv:ask-user:blocked` with `{ active: true }` immediately before awaiting its TUI/RPC dialog and emits `{ active: false }` from `finally` after answer, cancellation, or failure. However, `herdr-feedback-state` explicitly ignores that event; its test suite asserts this behavior. The extension instead monkey-patches the `ctx.ui` methods captured during `session_start`. The isolated test uses the same mutable UI object for session startup and dialog execution, so all 14 tests pass while the production questionnaire remains `working`. The current code therefore contradicts both the package’s event contract and `pi/sandbox/README.md`, which promises that unresolved Pi questions report `blocked` with `waiting for feedback`.

Use the explicit producer-owned event as the authoritative questionnaire signal. Keep generic UI instrumentation as a fallback for other extensions that do not publish semantic wait events, and retain the durable plan-workflow and settled free-form-question sources. No Herdr transport, broker capability, screen rule, questionnaire UI, or plan workflow change is required. No glossary or ADR is warranted because this restores an existing status contract rather than introducing a new domain decision.

The current feedback suite is green despite encoding the bug. The reporter tests are green. The wrapper-composed broker test exits inside the current nested planning sandbox without diagnostic output; implementation verification must distinguish that environment limitation from a product regression and run the live canary regardless.

## Approach

Add the questionnaire package’s public blocked lifecycle to the existing feedback-source aggregation, then lock the real producer-to-reporter path into regression coverage. The aggregate should emit only when its effective boolean changes, so overlapping semantic events and generic UI wrappers cannot duplicate reports or clear `blocked` early.

### Part A — Reproduce the questionnaire integration gap
- **Ledger:** {"status":"completed","note":"Added direct event-contract and malformed-payload regressions plus a real producer-to-feedback composed test using distinct session-start and questionnaire UI objects.","evidence":"Pre-fix `node --test pi/agent/extensions/herdr-feedback-state/test.mjs` fails only the 2 new event-bridge assertions (13 existing checks pass). Pre-fix targeted Vitest `herdr-feedback-composed.test.ts` fails all answer/cancellation/rejection cases because reports remain empty while the real producer wait is open."}

Replace the test that asserts `rpiv:ask-user:blocked` is ignored with a regression that demonstrates the required behavior: an active event from an unresolved questionnaire emits one `herdr:blocked` report labeled `waiting for feedback`, and the matching inactive event clears it.

Add a production-shaped composed scenario around the real questionnaire event ordering rather than testing only direct calls on the session-start UI mock. Keep the questionnaire unresolved long enough to observe the reporter state. Cover answer, cancellation, and rejection cleanup, plus malformed payload tolerance. The pre-fix failure must identify the missing event subscription rather than transport or screen detection.

Acceptance outcome: the current code fails the new regression for the same reason as `w15:p2` and `w16:p6`, while existing generic dialog, free-form question, durable workflow, and reporter authority checks remain valid.

### Part B — Make explicit questionnaire state authoritative
- **Ledger:** {"status":"completed","note":"Feedback aggregation now tracks the public questionnaire lifecycle independently, uses strict `active === true`, deduplicates overlapping semantic/UI waits, and disposes/reset listeners reload-safely.","evidence":"`node --test pi/agent/extensions/herdr-feedback-state/test.mjs`: 18/18 pass, including malformed payloads, overlap in both clear orders, replacement reset, shutdown disposal, generic UI, durable workflow, free-form, and non-TUI cases. Real producer composed Vitest: 3/3 pass. Questionnaire package typecheck passes."}

Subscribe `herdr-feedback-state` to the immutable `rpiv:ask-user:blocked` channel and track it as an independent source in the aggregate blocked predicate. Treat only `active === true` as active and every other payload as inactive. Establish and dispose the subscription with the same reload-safe session lifecycle used for the plan workflow subscription, resetting stale source state during session replacement and shutdown.

Preserve generic `select`/`confirm`/`input`/`editor`/`custom` instrumentation as fallback coverage. When a questionnaire produces both its semantic event and a wrapped `custom()` wait, deduplicate them through the aggregate state: publish one blocked transition, remain blocked until both sources have cleared, then return to `working` while the tool/agent continues or `idle` after settlement. Durable approval or staged feedback must likewise prevent an early clear.

Do not change `herdr-agent-state.ts` state precedence, session generations, retry ordering, broker canonicalization, questionnaire rendering, or the status-only security boundary unless the composed regression supplies contrary evidence. Do not add screen-scraping patterns.

Acceptance outcome: an unresolved structured questionnaire publishes canonical `blocked` through the existing authoritative Pi reporter, and every completion path clears it without duplicate or stale reports.

### Part C — Prevent another mock-only status repair
- **Ledger:** {"status":"completed","note":"Added real producer→feedback→reporter/fake-endpoint coverage, reporter reload/overlap checks, operational guidance and repository invariant; deployed through Stow and completed canary confirmation.","evidence":"Commit 10b68b56. Full questionnaire suite 612/612; feedback 18/18; reporter/broker 8/8; typecheck passed before Stow pruned dev dependencies; `./install.sh config` completed. User confirmed live canary “works!”; post-answer Herdr reports active Pi sessions as working with `full_lifecycle_hook_authority`. Nested wrapper-composed test remains the documented environment limitation: child wrapper exits 1 with no stderr inside the already-sandboxed Pi session. `git diff --check` passed; unrelated settings/config and concurrent launcher changes remain unstaged."}

Extend composed coverage through the real questionnaire producer, feedback aggregator, and Herdr reporter/fake endpoint where the existing test infrastructure permits. Assert the observable sequence around an active agent: `working` → `blocked` while the questionnaire promise is open → `working` after the answer, followed by `idle` only after `agent_settled`. Include reload/shutdown cleanup and overlap with durable plan feedback so stale listeners cannot reclaim or clear authority.

Update `pi/sandbox/README.md` to identify `rpiv:ask-user:blocked` as the authoritative structured-question source and generic UI wrapping as fallback, while preserving the documented broker security model. Record the reusable correction in the repository `AGENTS.md`: cross-extension status integrations must consume explicit producer lifecycle events and include a production-shaped composed test; mutable UI monkey-patching and isolated mocks are not sufficient acceptance evidence.

Deploy through `./install.sh config` only. Preserve the unrelated existing changes in `pi/agent/settings.json` and `codex/config.toml`, and do not modify or remove prior plan files.

Acceptance outcome: future regressions fail at the questionnaire-event bridge in local tests instead of surfacing only as a yellow Herdr sidebar entry.

## Critical Files

- `pi/agent/packages/ask-user-question/events.ts` and `ask-user-question.ts` — authoritative public lifecycle contract and producer ordering for structured waits; expected to remain behaviorally unchanged.
- `pi/agent/extensions/herdr-feedback-state/index.ts` — aggregates explicit questionnaire, generic UI, durable workflow, and free-form feedback sources into `herdr:blocked`.
- `pi/agent/extensions/herdr-feedback-state/test.mjs` — primary source-composition and lifecycle regression boundary.
- `pi/sandbox/test-herdr-agent-state.mjs` — reporter-level sequence and authority boundary for a composed questionnaire wait.
- `pi/sandbox/README.md` and `AGENTS.md` — operational contract and reusable prevention rule.

## Verification

Regression checks:

- Run the Herdr feedback-state suite; verify explicit questionnaire events, generic UI methods, overlapping waits, malformed payloads, rejection cleanup, non-TUI behavior, and reload/shutdown disposal.
- Run the questionnaire package’s targeted event-emission tests and typecheck when its development dependencies are available. Confirm `active: true` precedes the dialog and `active: false` is guaranteed by `finally` for answer, cancellation, and error.
- Run the reporter/broker suites. Existing session-before-state ordering, blocked precedence, retry, replacement-generation, direct-socket, broker hardening, and plan-workflow scenarios must remain green. If the wrapper-composed fixture still cannot nest inside Pi’s sandbox, record that exact environment limitation and run it outside the nested sandbox rather than treating an unexplained skip as success.
- Review the final diff and confirm the pre-existing `pi/agent/settings.json` and `codex/config.toml` changes are untouched. Run `git diff --check`.

New failure-mode scenarios:

1. Start from an active TUI reporter, execute the real `ask_user_question` producer, and leave its custom overlay unresolved. The latest canonical report must be `blocked` with `waiting for feedback`.
2. Answer or cancel the questionnaire. The explicit event and wrapped UI source must clear without an intermediate false idle; the state returns to `working` while agent execution continues and only becomes `idle` after settlement.
3. Overlap the questionnaire with durable plan feedback or another blocking UI. Clearing any one source must not clear the aggregate blocked state.
4. Reload or shut down while a questionnaire is open. Retired listeners must emit no late state and the replacement session must establish its own authority normally.

Live canary after Stow deployment:

- Reload or restart Pi in the currently affected panes, open a structured questionnaire, and leave it unanswered.
- `herdr agent get <pane>` must show `agent_status: blocked` with the active Pi session; `herdr agent explain <pane> --json` must continue to show `full_lifecycle_hook_authority`, not a screen rule.
- Answer the questionnaire and verify Herdr immediately returns to `working`, then to `idle` when Pi settles.
- A visible questionnaire reported as `working`, a missing session reference, duplicate oscillation, or a state that remains blocked after completion is a failure.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Reproduce the questionnaire integration gap
- ☑ Make explicit questionnaire state authoritative
- ☑ Prevent another mock-only status repair
<!-- pi-plan-mode:progress:end -->
