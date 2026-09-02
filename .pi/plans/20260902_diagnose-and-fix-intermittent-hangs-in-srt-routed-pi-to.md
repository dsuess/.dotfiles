# Make SRT-Routed Tool Calls Fail Fast

## Context

Normal Pi launches replace the native `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools with adapters that send operations over a Unix socket to the detached workspace SRT controller. `pi --yolo` bypasses this route and therefore cannot exhibit controller-transport stalls.

The captured incident is not a grep invocation: the affected assistant turn submitted five parallel calls (`read`, `ls`, `find`, and two documentation reads). The TUI showed at least two reads as completed, but the session recorded no tool results for that batch before it was aborted roughly 117 seconds later. Pi finalizes a parallel tool batch only after all siblings settle, so one unresolved routed operation leaves the whole turn at `Working...` even when completed siblings are already visible.

The unbounded wait is in `pi/sandbox/client.mjs`. `ControllerClient` stores every RPC promise in `pending`, but after initial connection it does not reject those promises when the socket emits `error` or `close`; `destroy()` also leaves them pending. A controller exit, reset, broken socket, malformed-frame failure, or connection teardown after dispatch can therefore orphan a tool promise forever. The two-second extension status poll uses the same client and can become orphaned too, preventing the intended fail-closed transition. Controller-side operation timers do not protect this case because their response cannot reach a disconnected client. This explains both the apparent randomness and the absence in yolo mode. The current code has insufficient transport diagnostics to identify which specific disconnect triggered the captured occurrence, so the triggering event remains an accepted unknown; the unbounded client behavior is independently reproducible and must be removed.

There is also a current grep/find contract conflict that should be corrected while exercising this boundary. `tools.ts` now intentionally sends validated bare `rg` and `fd` executable names for inherited-PATH portability, and `pi/sandbox/README.md` documents that rule, but `protocol.mjs` still rejects every `exec` request whose `argv[0]` is not absolute. That mismatch should produce a prompt error rather than this hang, but it makes routed grep/find invalid under the reviewed protocol and would obscure transport verification.

The fix must preserve the existing host-Pi/per-operation-SRT architecture, root-only lease renewal, fail-closed tool inventory, parallel tool behavior, and explicit yolo bypass. It must not reconnect and replay arbitrary operations after transport loss, because a disconnected request may already have caused a write or shell side effect. No ADR is warranted: this restores failure semantics within the accepted controller architecture. Preserve the unrelated `pi/agent/settings.json` worktree change. The canonical plan document created for this work must be committed with the implementation, as required by the repository workflow.

## Approach

Introduce one terminal connection lifecycle for each controller client: every request either receives a validated response or rejects within a bounded period, and a broken transport can never retain pending promises. Keep recovery conservative—lease rejection remains the only transparently retryable condition.

### Part A — Terminate orphaned controller requests
- **Ledger:** {"status":"completed","note":"Implemented terminal client state, bounded per-method watchdogs, write-failure handling, and no-orphan request settlement.","evidence":"node --test pi/sandbox/test-client-lease-recovery.mjs (5 passing): concurrent close, malformed frame, explicit destroy, lease recovery."}

Refactor `ControllerClient` around an idempotent terminal-state transition. After initial connection, socket `error`, socket `close`, decoder/response validation failure, and explicit destruction must detach or stop transport processing, reject every entry in `pending` with a stable transport error, clear request resources, and make future requests reject immediately. Handle `socket.write` callback failures and close/error races without double settlement or uncaught exceptions. Initial connection failures must continue to reject readiness and clean up the client.

Add bounded request watchdogs that reflect the controller contract rather than one blanket timeout: short control/status calls, the controller’s 60-second filesystem helper bound plus grace, and the requested `exec` timeout plus transport grace. A watchdog expiration must terminally invalidate the connection and reject all siblings because response ordering and controller health are no longer trustworthy. Preserve abort-driven `exec` cancellation, but ensure cancellation itself cannot create another indefinitely pending RPC when the transport is already broken.

Do not automatically reconnect or replay a request after a transport failure. The existing root-only retry remains limited to explicit `lease_expired` or `invalid_lease` responses received before controller dispatch. This guards write/edit/bash at-most-once behavior from client-side replay.

Acceptance is observable when a mock controller closes before replying, closes with concurrent calls, emits malformed protocol data, or accepts a request without replying: every affected promise rejects predictably, `pending` becomes empty, later requests fail immediately, and the test process has no leaked timer or socket. Normal concurrent responses and root lease renewal must remain unchanged.

### Part B — Propagate transport failure through Pi’s fail-closed lifecycle
- **Ledger:** {"status":"completed","note":"Added terminal lifecycle subscription to fail closed immediately, while retirement and existing fatal paths suppress false replacement shutdowns; documented diagnostics.","evidence":"node --test pi/agent/extensions/srt-tool-routing/index.test.mjs pi/sandbox/test-client-lease-recovery.mjs (20 passing), including unexpected disconnect and retired-client cases."}

Make the routing extension treat a terminal client transport failure as controller unavailability without waiting for another model tool call. Use a narrow client lifecycle notification or equivalent connection-health hook so `index.ts` can invoke its existing idempotent `failClosed` path: disable active routed tools, publish failed sandbox status, release or destroy ownership correctly, clear inherited capabilities where appropriate, notify the user, and request graceful shutdown. Ensure session replacement and deliberate `destroy()` during `/new`, `/resume`, `/fork`, or `/reload` are classified as expected retirement and cannot fail the replacement runtime.

Keep tool-level error reporting useful: the in-flight tool should finish with a concise controller-transport error rather than remain visually active. Add bounded, redacted diagnostics sufficient to distinguish peer close, socket error, protocol failure, and response timeout without logging capabilities, environment secrets, request payload contents, or filesystem data. Update the SRT troubleshooting documentation to explain that a parallel batch can appear stuck behind one sibling, that transport loss now fails closed, and where the safe diagnostic appears.

Acceptance is observable when an unexpected disconnect disables routed tools and settles the turn, while an intentional session replacement reconnects normally and retains the root lease exactly once. Yolo mode remains inert with native tools.

### Part C — Reconcile portable grep/find execution with the protocol
- **Ledger:** {"status":"completed","note":"Allowed strict bare executable names alongside absolute paths and added protocol plus controller PATH-fixture coverage.","evidence":"Focused controller/client suite: 14 pass including bare fixture and unsafe-form rejection; one pre-existing macOS stderr assertion fails (read-only write diagnostics appended to expected output)."}

Align `protocol.mjs` with the documented optional-host-tool rule. Permit `exec.argv[0]` when it is either an absolute path or a strictly validated bare executable name; continue rejecting relative/path-qualified values, separators, shell syntax, empty values, and oversized arguments. Keep direct `spawn` argument-vector execution with `shell: false`, inherited controller PATH discovery, and SRT filesystem policy as the authority boundary.

Retain `tools.ts` use of bare `rg` and `fd`; do not resolve them through a shell, `which`, a hard-coded installation prefix, or a new filesystem grant. Extend protocol and native-controller coverage so basename execution succeeds for a reviewed PATH-installed fixture while malformed executable forms fail before dispatch. This removes the current documentation/code conflict and makes grep/find valid test cases for the repaired transport.

Acceptance is normal routed grep/find completion through inherited PATH, clear bounded errors for missing executables, and protocol rejection of unsafe executable forms.

## Critical Files

- `pi/sandbox/client.mjs` — controller RPC lifecycle, pending-request settlement, deadlines, cancellation, and terminal transport state.
- `pi/sandbox/protocol.mjs` and `controller.mjs` — executable validation and the controller-side timeout/response contract.
- `pi/agent/extensions/srt-tool-routing/index.ts` — fail-closed lifecycle and distinction between unexpected disconnect and intentional runtime retirement.
- `pi/agent/extensions/srt-tool-routing/tools.ts` — grep/find execution timeout and inherited-PATH behavior; expected to need little or no structural change.
- `pi/sandbox/test-client-lease-recovery.mjs`, controller lifecycle tests, and routing-extension tests — regression boundaries for disconnects, deadlines, lease renewal, replacement, and portable searches.
- `pi/sandbox/README.md` — operator-facing transport failure and parallel-batch troubleshooting contract.

## Verification

Regression checks:

- Run focused controller-client tests for normal responses, concurrent requests, explicit destroy, lease expiry/renewal, abort cancellation, and release behavior.
- Run routing-extension lifecycle tests for startup, periodic status, fail-closed handling, root ownership, child attachment, `/new`/`resume`/`fork`/`reload`, final quit, inventory enforcement, and yolo inertness.
- Run focused routed-tool and protocol tests, then `npm --prefix pi run check:deterministic`.
- Deploy only through `./install.sh config`, then run the required `npm --prefix pi run check` from an ordinary host terminal.
- Run `git diff --check` and inspect the final diff and commit contents to ensure the unrelated settings change is preserved and excluded, while the saved canonical plan is included.

New failure scenarios:

- Close a mock controller socket before one reply and during several parallel requests. Success means all promises reject promptly, no pending entries or timers remain, and no request is replayed.
- Send an invalid or truncated response frame. Success means a controlled transport failure rather than an uncaught exception or permanent `Working...` state.
- Accept but never answer filesystem, status, and exec requests. Success means method-appropriate deadlines settle them and invalidate the client; the exec deadline respects the caller’s configured timeout.
- Disconnect during an active Pi tool batch. Success means completed siblings remain represented, the blocked sibling receives an error, active routed tools are disabled, and lifecycle status reports failure without waiting indefinitely for the status poll.
- Destroy the old client during each supported session replacement. Success means no false fail-closed notification, one replacement connection, retained root lease authority, and one final release.
- Execute routed grep and find against a small known repository and invoke a synthetic PATH-installed fixture by basename. Success means expected results without installation-prefix assumptions. Unsafe relative or path-qualified executable names must be rejected before spawn.

Failure signals include any unresolved request after socket teardown or deadline, uncaught socket/decoder errors, automatic replay after ambiguous transport loss, duplicate lease release, shutdown during intentional replacement, fallback to native host tools, capability or secret leakage in diagnostics, or continued disagreement between bare-name adapter calls and protocol validation.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Terminate orphaned controller requests
- ☑ Propagate transport failure through Pi’s fail-closed lifecycle
- ☑ Reconcile portable grep/find execution with the protocol
<!-- pi-plan-mode:progress:end -->
