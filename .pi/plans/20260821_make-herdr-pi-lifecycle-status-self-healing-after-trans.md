# Make Herdr Lifecycle Reports Self-Healing

## Context

Herdr receives authoritative Pi lifecycle state through `pi/agent/extensions/herdr-agent-state.ts`. Sandboxed Pi processes use the authenticated localhost broker in `pi/sandbox/herdr-status-broker.mjs`; the broker exposes only agent status, session, metadata, and release capabilities to the sandbox, then forwards canonical requests to Herdr’s host socket. Herdr correctly disables screen detection while this full lifecycle authority is active.

Two live panes demonstrate distinct stale-state outcomes:

- `w16:p8` (`new-sandbox`) displays the durable “Plan ready — what should happen next?” action dialog. Its semantic state is `blocked`, but Herdr remains `working` at state-change sequence 57.
- `w15:p9` (`report progress bar`) started at 16:48 after the latest deployment. Its Pi session log contains a final answer at 16:52:56 and its TUI is visibly idle, but Herdr remains `working` at state-change sequence 120.

This rules out screen classification and a purely pre-deployment extension generation. It also narrows the fault away from sandbox policy: the same broker previously established lifecycle authority and delivered `working`. The reliability defect is in the reporter’s acknowledgement semantics. Requests receive two immediate attempts, but if both fail, the reporter discards the pending delivery and waits for another lifecycle event. A terminal `idle` report or a `blocked` report that opens a long-lived dialog may have no later event, so Herdr can retain `working` indefinitely. The existing warning documents this weak behavior: “retrying on the next lifecycle event.”

The broker remains the correct security boundary. The repair will retain explicit producer events, Pi’s official lifecycle hooks, canonical `idle`/`working`/`blocked` states, session-before-state ordering, generation authority, and screen-detection exclusion. It will change delivery from edge-only best effort to acknowledged desired-state reconciliation. No Herdr socket or broader host capability will enter the sandbox.

## Questions & Answers

| Question | Answer |
|---|---|
| Which pane demonstrates the incorrect state? | The user first identified `new-sandbox`, where a pending plan action dialog still reports `working`, then supplied `report progress bar`, where Pi has completed and is idle but Herdr still reports `working`. |

## Approach

The reporter will retain the latest desired semantic state until Herdr acknowledges it. Lifecycle and feedback events remain the low-latency inputs, but a transient transport failure will schedule independent reconciliation rather than requiring an unrelated future event. A single generation-owned retry worker will preserve ordering and prevent stale extension instances from reporting after reload or shutdown.

### Part A — Reproduce terminal and long-lived delivery loss
- **Ledger:** {"status":"completed","note":"Added production-shaped regressions for terminal idle, durable blocked, startup authority, supersession, shutdown, and replacement-generation cleanup. Existing sequence/overlap coverage remains.","evidence":"`node --test /Users/dsuess/.dotfiles/pi/sandbox/test-herdr-agent-state.mjs` failed on the old reporter exactly at idle reconciliation, blocked reconciliation, authority reconciliation, and supersession; 8 prior/cleanup tests passed. This establishes red behavior before implementation."}

Add reporter regressions that exhaust both immediate acknowledgement attempts and then provide no new lifecycle edge. Cover a terminal `idle` transition and a long-lived `blocked` transition, because these are the two production failures shown by `w15:p9` and `w16:p8`.

The tests must prove that the latest desired state is retried and eventually acknowledged without another `agent_start`, `agent_settled`, or feedback event. Also cover authority establishment failure, since session and metadata reports must precede state and can otherwise suppress the terminal report. Verify that a newer desired state supersedes an older failed state, preventing a delayed `blocked` or `working` report from overwriting a later `idle` state.

Add reload and shutdown cases that prove pending retries belong only to the active reporter generation and stop after authority is released. Preserve the existing sequence and overlap regressions.

Acceptance outcome: the new tests fail against the current “next lifecycle event” behavior and distinguish state-delivery failure, authority-delivery failure, supersession, and generation cleanup.

### Part B — Reconcile desired state until acknowledged
- **Ledger:** {"status":"completed","note":"Refactored reporter delivery into generation-owned desired/acknowledged reconciliation with serialized authority-first requests, supersession checks, unreferenced bounded-backoff retries, and outage-episode diagnostics.","evidence":"Direct reporter suite passes 13/13 after implementation, including exhausted idle/blocked/authority retries, second outage warning reset, supersession, shutdown, replacement, overlap, and socket delivery."}

Refactor the delivery coordination in `pi/agent/extensions/herdr-agent-state.ts` around an explicit latest desired state and acknowledged state. Event handlers will update the desired snapshot immediately. A single serialized worker will:

1. confirm the current session reference and metadata authority;
2. send the latest effective state with existing `blocked > working > idle` precedence;
3. retain unacknowledged intent after the current immediate retries fail;
4. retry with bounded backoff while the same root-session generation owns authority; and
5. re-evaluate the latest desired state before each attempt so superseded states are not replayed.

Use an unreferenced timer so retrying cannot keep Pi alive. Bound the retry rate, not the retry lifetime: an active Pi process must continue reconciling until acknowledgement, replacement, or shutdown. Continue coalescing rapid transitions and serializing requests. Keep one non-secret warning per outage episode, but change it to state that retry is automatic; clear the episode after successful reconciliation so a later independent outage can be reported.

Do not add polling of terminal contents, broaden broker methods, expose the Herdr socket, or alter Herdr’s canonical lifecycle authority. The producer signals are adequate; the missing property is durable acknowledgement.

Acceptance outcome: a transient broker or Herdr outage cannot leave a live Pi pane indefinitely at an older state, and recovery requires no user input or new agent turn.

### Part C — Preserve the broker boundary and operational contract
- **Ledger:** {"status":"completed","note":"Documented eventual acknowledgement, automatic bounded-backoff recovery, and multi-scenario canary requirements in the sandbox contract and scoped Pi guidance. Broker implementation remained unchanged.","evidence":"`node --test pi/sandbox/test-herdr-status-broker.mjs` passes; git diff shows no change to herdr-status-broker.mjs. Feedback-state suite passes 18/18. The wrapper-composed fixture reproduced its documented limitation: exit 1 with empty stderr, reported separately from passing direct suites."}

Keep `pi/sandbox/herdr-status-broker.mjs` fail-closed and capability-limited. Extend sandbox documentation and the repository prevention guidance to state that terminal lifecycle reports require eventual acknowledgement and must not depend on a future lifecycle edge. Record that a successful single canary is insufficient evidence for terminal-state reliability.

Only change broker code if a regression demonstrates that it violates the existing acknowledgement contract; do not use broker expansion as the reporter fix. Preserve unrelated worktree changes and deploy through `./install.sh config` only.

Acceptance outcome: security assertions remain unchanged, documentation describes automatic recovery accurately, and the deployed files are Stow-managed.

### Part D — Validate recovery in the live failing panes
- **Ledger:** {"status":"blocked","note":"Deployment and blocked-state live validation succeeded, but the required idle target w15:p9 no longer exists, so its exact stale sequence cannot be rechecked. A temporary fresh Pi pane validated canonical idle as a substitute and was removed.","evidence":"`./install.sh config` succeeded. After restarting w16:p8 on its existing session, `herdr agent get` reported blocked at state_change_seq 136 (was stale working at 57), and `herdr agent explain` reported full_lifecycle_hook_authority. Temporary canary w16:pH reported idle at seq 138 with the same authority and was closed. `herdr agent get w15:p9` returns agent_not_found."}

After deployment, reload or restart the two affected Pi processes so they load the repaired reporter. Use `w15:p9` as the idle canary: Herdr must converge from stale `working` to `idle`. Use `w16:p8` as the durable-feedback canary: while the plan action dialog remains unresolved, Herdr must converge to `blocked`; after the workflow genuinely resumes or ends, it must return to `working` or `idle` as appropriate.

Observe Herdr’s state and state-change sequence rather than inferring success from sidebar color alone. Confirm that screen detection remains skipped under full lifecycle authority. Do not alter or commit either pane’s project work as part of this repository repair.

Acceptance outcome: both concrete stale states self-correct under the new extension generation and subsequent transitions remain accurate.

## Critical Files

- `pi/agent/extensions/herdr-agent-state.ts` — lifecycle authority, desired-state calculation, request ordering, acknowledgement handling, and generation ownership.
- `pi/sandbox/test-herdr-agent-state.mjs` — direct production-shaped reporter regressions, including broker failures and lifecycle overlap.
- `pi/sandbox/herdr-status-broker.mjs` — read-only reference for the authenticated capability and acknowledgement boundary; modify only if tests expose a broker contract defect.
- `pi/agent/extensions/herdr-feedback-state/index.ts` — read-only semantic source for aggregate feedback waits; its `herdr:blocked` contract must remain intact.
- `pi/sandbox/README.md` and `AGENTS.md` — operational contract and reusable terminal-delivery prevention rule.

## Verification

Regression checks:

- Run the direct Herdr reporter suite, including lifecycle sequence, overlap, reload, shutdown, authority ordering, and the new exhausted-retry cases.
- Run the status broker suite to preserve authentication, allowed-method, canonicalization, session-root, timeout, ordering, and release behavior.
- Run the feedback-state and composed questionnaire/plan reporter suites so `blocked > working > idle` aggregation remains correct.
- Run wrapper/composed sandbox coverage where the current sandbox permits nested execution; if the known already-sandboxed wrapper fixture still exits without stderr, report that limitation separately rather than masking direct-suite results.
- Run `git diff --check` and review the final diff for unrelated changes.

New failure scenarios:

- Reject both immediate attempts for a terminal `idle` report, then restore the broker. Success means `idle` arrives without another lifecycle event.
- Reject both immediate attempts for `blocked`, leave the dialog unresolved, then restore the broker. Success means `blocked` arrives without user activity.
- Change desired state while a retry is pending. Success means only the latest effective state can become authoritative.
- Reload or shut down while a retry is pending. Success means the retired generation emits no later state.

Live signals:

- `herdr agent get w15:p9` converges to `idle` with an increased state-change sequence while Pi remains at its completed prompt.
- `herdr agent get w16:p8` converges to `blocked` while the plan action dialog remains unresolved.
- `herdr agent explain` continues to report `screen_detection_skip_reason: full_lifecycle_hook_authority` for both panes.
- A failed assumption is signaled by a pane remaining stale beyond the maximum retry backoff, repeated sequence regressions, post-shutdown reports, or any need to expose the native Herdr socket.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Reproduce terminal and long-lived delivery loss
- ☑ Reconcile desired state until acknowledged
- ☑ Preserve the broker boundary and operational contract
- ⛔ Validate recovery in the live failing panes
<!-- pi-plan-mode:progress:end -->
