# Make Pi-to-Herdr Status Deterministic

## Context

Herdr has three reportable lifecycle states for this integration: `working`, `blocked`, and `idle`. Herdr derives `done` when an idle completion has not yet been seen; Pi does not report `done` directly. Pi’s documented `agent_start` and `agent_settled` events explicitly identify active work and a run with no retry, compaction, or queued continuation. They do not distinguish a plain-text assistant question from any other settled response. A real decision wait is available without guesswork only when a producer owns an explicit lifecycle, such as `rpiv:ask-user:blocked`, `plan-mode:workflow-state`, or an unresolved `ctx.ui` operation. This matches Herdr’s authority model: an installed Pi lifecycle integration is the sole state authority, and screen detection is disabled while it is active ([Herdr agents](https://herdr.dev/docs/agents/), [Herdr integrations](https://herdr.dev/docs/integrations/), [Pi extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)).

The repository currently implements a much larger system than Herdr’s generated Pi integration:

- Herdr’s generated v8 `pi/agent/extensions/herdr-agent-state.ts` normally reports Pi session identity and `agent_start`/`agent_settled` state directly to the Herdr Unix socket. The tracked file retains the generated marker but has been extensively modified with local generation ownership, plan-completion semantics, acknowledged desired-state reconciliation, retries, metadata, and HTTP-broker transport.
- `pi/agent/extensions/herdr-feedback-state/index.ts` is entirely local. It combines structured-question events, plan-workflow events, monkey-patched UI methods, and a punctuation heuristic for settled assistant text into `herdr:blocked` boolean edges.
- `bin/pi` launches `pi/sandbox/herdr-status-broker.mjs` outside the sandbox and gives Pi a loopback port plus token instead of `HERDR_SOCKET_PATH`. The broker canonicalizes and forwards status, session, metadata, and release requests.
- The custom plan-mode extension emits durable `mode` and `feedbackPending` state; the custom questionnaire package emits its own blocked lifecycle. Tests separately cover these producers, the reporter, broker, wrapper, and selected composed scenarios.

The reported live failure is confirmed in pane `w16:pF`, tab `herdr status`. Its Pi session persisted `plan-mode-state.mode: "completed"` at `2026-08-22T14:41:48.422Z`, `complete_plan` returned successfully, and the terminal is visibly settled. Herdr nevertheless reports `blocked` for the correct current session. `herdr agent explain w16:pF --json` reports `full_lifecycle_hook_authority`, so screen matching is not involved. This localizes the failure to semantic-state production/reduction or its report path, not sidebar rendering or process detection.

The strongest current root-cause candidate is a state-model mismatch: `herdr-feedback-state` emits an aggregate boolean level only when that level changes, but `herdr-agent-state.ts` treats every `active: true` as a counted acquisition and every false as one release. A duplicate/replayed true, missed clear, or reload boundary can permanently ratchet `blockedCount` above zero. Because `blocked` has precedence over the new completed-workflow idle override, a valid completion event cannot recover the pane. The code has no diagnostic surface for active sources, the count, desired state, acknowledged state, or last broker result, so this cannot be proven from the live pane after the fact.

This is one example of a systemic reliability problem rather than an isolated bug:

- Thirteen Herdr-related commits exist, including repeated repairs for sandbox exposure, reload authority, structured questionnaires, terminal delivery, and completed plans. The generated integration has become a local fork without an explicit ownership boundary; `herdr integration status` reports “current (v8)” from its marker even though the implementation materially differs. Reinstalling the official integration can overwrite local transport and semantics.
- The system translates mutable edges across four independently reloaded components. It mixes explicit producer events with UI monkey-patching and natural-language punctuation inference. This allows duplicated, missing, reordered, and stale transitions.
- Broker and reporter sequence semantics disagree. The reporter retries one logical request with its original sequence, but the broker discards that sequence and assigns a new one on every HTTP attempt. Tests that assert reporter retry sequence preservation therefore do not prove the sequence Herdr receives.
- A 2xx response means the broker received a success response, not that Herdr’s observable pane state changed. Herdr has historically returned success for stale sequence reports; that behavior was documented in [herdr issue #667](https://github.com/ogulcancelik/herdr/issues/667), which was closed as not planned. The current pipeline calls this an acknowledgement without checking the postcondition.
- The test suites are green despite the live completed-but-blocked pane. The missing scenario is the complete production lifecycle: approval plus overlapping dialog, execution, `complete_plan`, producer clear, semantic reduction, broker forwarding, and final observable idle/done. The wrapper-composed test also cannot nest inside the current Pi sandbox and fails without stderr, so it must be run at an unsandboxed boundary rather than counted as passing coverage.
- Diagnostics are insufficient. The broker’s temporary stderr is retained only for startup failure and then removed; the reporter exposes only a generic delivery warning; Herdr can explain only the final authoritative state, not which Pi source held it.

There is also a security/documentation conflict. The repository says the broker is a status-only capability and the real Herdr socket is unavailable to sandboxed Pi, but `pi/sandbox/settings.json` sets `allowAllUnixSockets: true` and explicitly allows Herdr config reads. From this sandboxed session, ordinary `herdr agent get`, `herdr pane get`, and `herdr api snapshot` calls reached the default Herdr socket without `HERDR_SOCKET_PATH`. The broker therefore adds complexity without currently enforcing the claimed isolation. Sandbox Runtime supports path-scoped Unix-socket allowlists on macOS; on Linux, path lists are ignored and seccomp can only block all Unix sockets or allow all ([Sandbox Runtime documentation](https://github.com/anthropic-experimental/sandbox-runtime#unix-socket-settings)). The accepted direction is to enforce the isolation, accepting that Linux and some subprocess IPC need explicit compatibility validation.

## Questions & Answers

| Question | Answer |
|---|---|
| The sandbox can already reach Herdr’s predictable Unix socket and run the Herdr API, so the status-only broker does not enforce its claimed capability boundary. Which architecture should the reliability plan target? | Enforce isolation. |
| Should plain assistant text ending in a question continue to author authoritative Herdr `blocked` status? | “Shouldn't there be some way that Pi reports WHEN it's expecting a user input? This shouldn't require guesswork!!!!” The implementation will use only explicit Pi/producer lifecycles for authoritative blocking. Pi’s public API has no distinct event for a plain-text question; `agent_settled` means ready for the next prompt. Plain text will therefore settle to idle/done, while decisions must use the structured question or explicit UI lifecycle. |

## Approach

Replace the current edge-driven chain with one observable, idempotent semantic state machine and a verifiable delivery contract. Keep the broker as the narrow host capability, but make the OS sandbox actually deny direct Herdr socket access. Separate the official generated integration from local broker-specific code so Herdr upgrades cannot silently erase local behavior.

### Part A — Reproduce the full completed-but-blocked lifecycle
- **Ledger:** {"status":"completed","note":"Added a production-shaped brokered regression under the feedback extension. It deliberately fails before the repair when a replayed blocked snapshot survives overlapping approval/UI/questionnaire waits and a real completed-plan transition.","evidence":"`node --test pi/agent/extensions/herdr-feedback-state/herdr-lifecycle.test.mjs` fails deterministically at the expected terminal-idle postcondition; focused pre-existing feedback and broker suites pass (18 feedback tests; 1 broker test)."}

Add a production-shaped regression that composes the real plan-mode producer, questionnaire event contract, feedback reducer, brokered reporter, status broker, and a controlled fake Herdr endpoint. Drive the lifecycle that failed in `w16:pF`: active work, plan approval, overlapping plan workflow and UI wait, approval into execution, terminal `complete_plan`, and settlement. The observable sequence must converge through `working → blocked → working → idle` (or Herdr’s derived `done` view for an unseen idle completion), with the same current Pi session reference throughout.

Add adversarial cases for duplicate active snapshots, duplicate clears, a clear lost and then restored by a full snapshot, source overlap, reload/session replacement, and a completion event while a prior wait existed. The pre-repair test must fail because stale blocked bookkeeping survives completion, not because a mock omitted transport setup. Preserve the live session evidence in the test rationale without modifying or using that session as a fixture.

This Part is accepted when the current implementation fails a deterministic test matching the live pane while the existing isolated suites continue to identify transport failures separately.

### Part B — Make explicit source state idempotent and inspectable
- **Ledger:** {"status":"completed","note":"Replaced edge/count semantics with full source snapshots, removed free-form question inference, and added the read-only `/herdr-status` reporter diagnostics.","evidence":"`node --test pi/agent/extensions/herdr-feedback-state/test.mjs pi/agent/extensions/herdr-feedback-state/herdr-lifecycle.test.mjs` passes 12 reducer/lifecycle tests. Coverage includes duplicate active/clear, source overlap, session replacement, UI handoff, completed-plan idle, and diagnostics with no broker token."}

Redesign `herdr-feedback-state` as the sole reducer for human-feedback sources. Maintain a source-keyed snapshot rather than a single edge and publish the complete current snapshot whenever a source changes or a session is restored. Stable sources include the questionnaire package, durable plan workflow, and individually tracked active UI operations used only as fallback for extensions without a semantic event. Replaying the same snapshot must be a no-op; clearing one source must not clear another; session replacement must replace rather than increment state.

Change the reporter to assign the received aggregate level or replace the full source snapshot. Remove `blockedCount` acquisition/release behavior. Keep explicit precedence `active feedback > completed workflow idle > active agent > settled idle`, but ensure a real `mode: "completed"` event with no active source cannot be masked by stale bookkeeping.

Delete authoritative punctuation inference from `asksForFeedback`. Pi always waits in its editor after `agent_settled`, and its public extension API does not expose a separate semantic event for a plain assistant question. User decisions must use `ask_user_question` or another explicit UI lifecycle, which already emits a structured blocked event. A plain settled answer or question reports idle/done rather than guessing from prose.

Expose a read-only `/herdr-status` diagnostic command showing the active semantic sources, Pi lifecycle input, plan-completion override, effective desired state, last acknowledged state, retry/outage status, current session reference, and transport mode. Never display the broker token or native socket path. Keep a small bounded in-memory transition history so a stale state can be attributed to producer, reducer, or transport without inspecting private process memory.

This Part is accepted when duplicate/reordered semantic updates cannot ratchet state, the completed-plan regression reaches idle, and diagnostics identify every source contributing to an intentional block.

### Part C — Establish one verifiable delivery and upgrade boundary
- **Ledger:** {"status":"blocked","note":"The generated v8 file and separate broker reporter are in place, but this sandbox deliberately denies writes to `pi/sandbox/`. I cannot implement the broker's canonical logical-ID/sequence dedupe and postcondition verifier or update its test suite from this session.","evidence":"`functions.edit` on `pi/sandbox/test-herdr-agent-state.mjs` fails EPERM. After restoring generated v8, the existing sandbox reporter suite is necessarily stale and fails 14/14 because it still imports the generated file for broker transport. The new separate-reporter lifecycle and integration-upgrade tests pass."}

Restore `pi/agent/extensions/herdr-agent-state.ts` to Herdr’s generated v8 content and stop placing local code in a file that declares itself Herdr-managed. Add a separate locally owned broker reporter enabled only by `HERDR_PI_STATUS_PORT` and token. In a normal sandbox launch, the generated extension remains disabled because it receives no native socket; the local reporter owns brokered status. In explicit `--yolo` mode, the broker reporter is disabled and the generated official integration owns direct reporting. Preserve one `herdr:pi` authority per launch mode.

Make logical request identity and sequence ownership consistent. The broker assigns one canonical Herdr sequence to one logical request ID, deduplicates concurrent or retried copies, and does not allocate a new sequence merely because Pi retried the same HTTP request. The reporter retains desired state until the broker confirms the logical request.

After Herdr acknowledges a state/session/metadata request, have the unsandboxed broker verify the relevant read-only postcondition before returning 2xx: current session reference, display agent, and requested state, accepting Herdr `done` as the unseen presentation of a requested idle completion. A silent stale-sequence drop or wrong-pane application must return a bounded non-secret mismatch reason and remain retryable. Serialize verification with forwarding so a newer desired state cannot invalidate an older request before its check.

This Part is accepted when Herdr integration reinstall/update can replace only the generated file without losing local broker behavior, retries are at-most-once per logical request at the broker boundary, and a 2xx response proves the observable pane postcondition rather than only socket delivery.

### Part D — Enforce the status-only sandbox capability
- **Ledger:** {"status":"blocked","note":"The required least-privilege socket policy belongs to `pi/sandbox/settings.json` and launcher/containment files, all intentionally write-denied to this sandboxed Pi process. Direct policy edit is blocked by the OS boundary.","evidence":"`functions.edit` changing `allowAllUnixSockets` to an empty `allowUnixSockets` allowlist plus `false` fails EPERM. Runtime source confirms this is the correct policy: macOS path lists; Linux seccomp blocks AF_UNIX when `allowAllUnixSockets` is false."}

Replace `allowAllUnixSockets: true` with a least-privilege policy. On macOS, use Sandbox Runtime’s `allowUnixSockets` allowlist only for explicitly required non-Herdr sockets; the real Herdr socket and its config/session directory remain inaccessible. On Linux, where path allowlists are ignored, enable seccomp Unix-socket blocking and validate required Pi/Ketch/Git workflows without AF_UNIX access. Keep the authenticated loopback status broker available through the existing local TCP binding.

Add containment tests that attempt both a direct Node Unix-socket connection and read-only Herdr CLI API access from inside sandboxed Pi; both must fail. A brokered lifecycle canary must still establish a session and report state. Also verify that a model subprocess cannot invoke Herdr pane control through the predictable default socket. Do not weaken the boundary by hiding only environment variables or binaries; the OS connect denial is the acceptance signal.

Inventory functional fallout before adding any socket exception. SSH/GPG agents and arbitrary local daemons are not implicitly trusted. Add a macOS path exception only for a demonstrated required workflow and document why; on Linux, report any incompatible workflow instead of silently setting `allowAllUnixSockets` again.

Record this security/functionality tradeoff in a concise ADR because it changes the whole-process IPC boundary, is surprising across platforms, and was an explicit user decision. Update `pi/sandbox/README.md` and scoped `pi/AGENTS.md` so they no longer claim unrestricted Unix traffic and status-only Herdr isolation simultaneously.

This Part is accepted when direct Herdr access is denied by the sandbox on both supported platforms while authenticated broker status remains functional and the documented policy matches the enforced one.

### Part E — Consolidate reliability tests and operational diagnostics
- **Ledger:** {"status":"blocked","note":"The primary wrapper, broker, containment, and operational-documentation tests are under `pi/sandbox/`, which this session cannot modify. They must be migrated to the separate reporter and run unsandboxed after C/D are implemented.","evidence":"`node --test pi/sandbox/test-herdr-agent-state.mjs` fails 14/14 after the correct generated-v8 restoration because its stale assertions still expect broker transport in the generated file. New agent-owned lifecycle/upgrade tests pass, but the required sandbox suite cannot be updated here."}

Promote the full lifecycle scenario to the primary acceptance boundary. Keep focused producer, reducer, reporter, broker, and wrapper tests, but remove assertions that no longer prove production behavior, such as extension-side sequence preservation when the broker owns the canonical sequence. Run the wrapper/containment suite from an unsandboxed terminal so nested-sandbox rejection is not mistaken for a product failure or skipped success.

Cover startup, reload, session replacement, approval cancellation, questionnaire answer/cancellation/error, completed plan, ordinary settled answer, transport outage, silent upstream no-op, broker restart, Pi shutdown, and Herdr server restart. Every failure should identify a stage and include non-secret expected/observed state. Add an upgrade regression that compares the tracked generated integration marker/content with Herdr’s installed v8 artifact while confirming the separate local reporter remains untouched.

Update operational guidance to start diagnosis with `/herdr-status`, then compare `herdr agent get <pane>` and `herdr agent explain <pane>`. Define failure signals precisely: stale active source, desired/acknowledged mismatch, postcondition verification failure, missing current session, screen fallback, or forbidden direct socket access. Do not advise adding screen patterns or manually forcing a state as recovery.

This Part is accepted when the exact current failure would name the stale source or delivery mismatch locally, all status/security suites pass at their correct execution boundary, and a future regression fails before it reaches the sidebar.

## Critical Files

- `pi/agent/extensions/herdr-agent-state.ts` — Herdr-managed generated integration; return it to an upgrade-safe upstream boundary.
- `pi/agent/extensions/herdr-feedback-state/index.ts` — local semantic feedback reducer; replace edge/count assumptions with source snapshots and remove prose inference.
- `pi/agent/extensions/plan-mode/events.ts` and `pi/agent/packages/ask-user-question/events.ts` — explicit producer contracts for completion and user-decision waits.
- `bin/pi`, `pi/sandbox/settings.json`, and `pi/sandbox/unrestricted-network.mjs` — launcher and OS boundary that must deny direct Herdr Unix-socket access while retaining broker TCP.
- `pi/sandbox/herdr-status-broker.mjs` — narrow host capability, canonical sequence owner, logical-request deduplicator, and postcondition verifier.
- `pi/sandbox/test-herdr-agent-state.mjs`, `pi/sandbox/test-herdr-sandbox-composed.mjs`, and containment tests — primary lifecycle, transport, wrapper, and isolation acceptance boundaries.
- `pi/sandbox/README.md` and a new sandbox-boundary ADR — operational contract and explicit security/functionality decision.

## Verification

Regression checks:

- Run the feedback reducer, plan workflow, questionnaire producer, reporter, broker, wrapper, repository-containment, and sandbox-containment suites. Existing current-session ordering, generation retirement, terminal retry, cancellation, and fail-closed startup behavior must remain green.
- Run native sandbox containment from an unsandboxed terminal. Direct connection to the default Herdr socket and `herdr api snapshot` from inside Pi must fail; the authenticated status broker must still report a current Pi session and authoritative lifecycle state.
- Reinstall the Herdr Pi integration in an isolated HOME fixture. The generated file may change, but the separate local reporter and broker behavior must remain intact.
- Review the final diff for unrelated worktree changes and run whitespace/type/smoke checks at each modified package boundary.

New end-to-end scenarios:

1. Open plan approval and leave it unresolved: `/herdr-status` names the plan/UI sources and Herdr reports blocked.
2. Approve execution: overlapping sources clear idempotently and Herdr returns to working without an intermediate false idle.
3. Call `complete_plan`: the durable completed event produces verified idle/done without waiting for another lifecycle edge; no stale feedback source remains.
4. Replay duplicate active/clear events and reload during each phase: the source snapshot and final state remain unchanged.
5. Make Herdr return success without applying the report: broker postcondition verification rejects it and the reporter continues bounded-backoff reconciliation.
6. Stop/restart broker or Herdr: only the latest desired state is applied after recovery, with no retired-generation report.
7. Finish an ordinary assistant response, including plain text ending in `?`: Pi reports settled idle/done unless an explicit structured/UI wait is active.

Live canary after Stow deployment and process reload:

- Re-run the completed-plan flow in a fresh normal sandboxed Pi pane. `herdr agent get <pane>` must show the current Pi session and idle/done after completion; `herdr agent explain <pane>` must retain `full_lifecycle_hook_authority`.
- Leave a real structured questionnaire and a plan approval unresolved, then answer each. Herdr must show blocked only while the explicit source is active, working while execution resumes, and idle/done after settlement.
- Confirm `/herdr-status` agrees with Herdr at each phase and exposes no credentials.
- Confirm direct Herdr CLI/socket access from a model subprocess is denied. Any successful direct API call, stale source after completion, unverified 2xx acknowledgement, missing session reference, or screen fallback is a release blocker.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Reproduce the full completed-but-blocked lifecycle
- ☑ Make explicit source state idempotent and inspectable
- ⛔ Establish one verifiable delivery and upgrade boundary
- ⛔ Enforce the status-only sandbox capability
- ⛔ Consolidate reliability tests and operational diagnostics
<!-- pi-plan-mode:progress:end -->
