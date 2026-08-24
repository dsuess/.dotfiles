# Reuse the Workspace VM Across Pi Session Replacement

## Context

`bin/pi` already starts one host Pi process with one startup descriptor for the canonical workspace. The hang is caused later in `pi/agent/extensions/gondolin-sandbox/index.ts`: Pi implements `/new` by emitting `session_shutdown`, tearing down and recreating the extension runtime, then emitting `session_start { reason: "new" }`. The sandbox extension currently treats every `session_shutdown` as final process shutdown. It releases the root lease, clears the inherited capability environment, and can stop the workspace controller before the replacement runtime reconnects. The replacement runtime then has only the original startup descriptor, which points at a controller that is stopping or gone, so readiness remains at `starting` until a long controller timeout.

Use **conversation session/runtime** for the replaceable Pi state and **root Pi process lease** for the workspace-controller lease. The root Pi process lease must survive `new`, `resume`, `fork`, and `reload` runtime replacement and end only on final process quit or a fatal routing failure. This aligns with the existing architecture rule of one controller and one VM per canonical workspace while keeping child Pi processes on the same parent lease.

The current README wording that a “root extension” or “root session” owns the lease is ambiguous and conflicts with this lifecycle. Update it to make process ownership explicit. No glossary or ADR is warranted: this is a reversible lifecycle bug fix that restores the documented shared-controller invariant. A process crash or replacement-runtime creation failure may continue to rely on the bounded lease-expiry backstop.

## Approach

Keep the launcher’s one-process startup descriptor and controller model unchanged. Make lease ownership transferable between extension runtimes inside that process, reconnect each replacement runtime to the existing verified lease and VM, and distinguish replacement teardown from final shutdown.

### Part A — Reproduce the replacement lifecycle failure
- **Ledger:** {"status":"completed","note":"Added deterministic sequential-runtime coverage for ready, pending, and child replacement lifecycles.","evidence":"npm --prefix pi/sandbox run test:extension (20 passing); new tests record reuse via lease acquisition count, inherited connection/adoption, release count, VM ID, active tools, and lifecycle reasons."}

Add a focused regression harness that runs two fresh Gondolin extension instances sequentially against shared process environment, matching Pi’s actual `session_shutdown` followed by a newly loaded extension and `session_start`. First acquire a root lease, shut the first runtime down with `reason: "new"`, and prove the second runtime currently cannot reliably become healthy without reacquiring or restarting controller state.

Cover both lifecycle positions: replacement after the VM is healthy and replacement while lazy controller acquisition is still pending. Record acquisition, inherited connection, release, controller-stop, VM identity, active tools, and lifecycle events so the tests can distinguish reuse from a hidden restart. The accepted behavior is a bounded replacement that retains one lease and the same VM identity; a second acquisition, a controller stop, or indefinite `starting` is a failure.

Use the same harness to define adjacent replacement behavior for `resume`, `fork`, and `reload`, since Pi emits the same teardown/rebind sequence for them. Include an inherited child case so a child can replace its conversation runtime without releasing or adopting the parent’s root lease.

### Part B — Transfer the root process lease safely
- **Ledger:** {"status":"completed","note":"Root lease ownership now transfers only across runtimes in the same Pi process; replacement teardown retires connections and final cleanup releases once.","evidence":"Focused tests cover all replacement reasons, pending handoff, stale status callback suppression, root-owner adoption, child non-ownership, fatal-release ordering, and exact-once quit release (npm --prefix pi/sandbox run test:extension: 22 passing)."}

Update the Gondolin extension lifecycle so replacement shutdown retires only the old extension runtime. Stop its status polling, abort and settle any old readiness waiter, suppress stale failure/status callbacks, and close its client connection without releasing the lease. Preserve the verified capability environment for the replacement runtime. If replacement occurs before lease acquisition, leave the uniquely started controller running so the new runtime can continue from the same startup descriptor rather than killing and restarting the VM.

After the initial verified root acquisition, publish a non-secret owner identity tied to the current host Pi PID alongside the existing in-process capability environment. On a replacement `session_start`, reconnect through the existing socket and lease token. Adopt release ownership only when that owner PID matches `process.pid`; separately spawned children inherit the marker but cannot match it, so they remain non-owning clients. Extend the controller client connection API only as needed to represent this explicit lease adoption without acquiring another lease.

Keep all existing workspace, policy generation, image generation, VM identity, Docker health, tool inventory, and host-adapter audits on every replacement runtime before tools become active. The replacement may briefly publish `starting` while reconnecting, but it must return to `healthy` with the same VM and activate tools once. It must not expose a new capability or create another workspace controller.

On `session_shutdown { reason: "quit" }`, release the adopted root lease exactly once, clear all capability and owner fields, and allow the controller to stop normally. On final quit during pending cold startup, retain the existing cancellation behavior that stops a uniquely started controller. On fatal routing failure, capture the active client before clearing local state so an owned lease is actually released; keep child failures non-owning. If replacement-runtime construction fails after the handoff, allow lease expiry to clean up rather than letting a retired runtime act on the new session.

### Part C — Lock in process-lifetime reuse and document it
- **Ledger:** {"status":"completed","note":"Added the real wrapper/RPC new_session smoke test, documented process-level ownership, verified all suites, and committed the implementation plan with the change.","evidence":"npm --prefix pi/sandbox test passed; npm --prefix pi/sandbox run test:native passed (including production RPC/inventory); commit 410b728b."}

Extend extension tests for ready and pending replacement, stale callback suppression, exact-once final release, root-owner adoption, non-owning child behavior, and unchanged fail-closed inventory enforcement. Add a production-shaped RPC scenario using Pi’s `new_session` command so the test exercises real extension teardown and reloading, then run sandbox Bash after replacement and confirm the controller reports the original VM with the expected lease count.

Update `pi/sandbox/README.md` and `pi/AGENTS.md` to state that the root Pi process, not an individual conversation runtime, owns the workspace lease; conversation replacement reconnects to the same VM; child processes never adopt or release that lease; and final quit/fatal failure remains the release boundary. Keep `bin/pi` unchanged unless the regression demonstrates a launcher-level lifecycle gap. Commit the generated plan document with the implementation, as required by repository policy.

## Critical Files

- `pi/agent/extensions/gondolin-sandbox/index.ts` — replacement-aware readiness, ownership handoff, stale-runtime retirement, and final cleanup.
- `pi/sandbox/client.mjs` — explicit reconnect/adopt semantics for an already acquired root lease.
- `pi/agent/extensions/gondolin-sandbox/index.test.mjs` — deterministic root, pending-startup, child, and exact-once lifecycle regressions.
- `pi/sandbox/test-gondolin-extension-production.mjs` — real Pi RPC `new_session` and post-replacement routing smoke test.
- `pi/sandbox/README.md` and `pi/AGENTS.md` — process-lifetime lease and one-VM-per-workspace contract.
- `bin/pi` — read-only reference for the one-process startup descriptor and capability environment boundary unless evidence requires a launcher change.

## Verification

- **Focused regression:** Run `npm --prefix pi/sandbox run test:extension`. Verify every replacement reason reconnects promptly, keeps the same VM ID, performs no second root lease acquisition, and leaves exactly one attached root lease.
- **Repository regression:** Run `npm --prefix pi/sandbox test` and confirm wrapper startup, readiness gating, controller cleanup, inventory auditing, planning tools, model scoping, and `--yolo` behavior remain unchanged.
- **Production-shaped scenario:** Run the inventory/native replacement test through a real Pi RPC process. Send `new_session`, require a bounded successful response, execute sandbox Bash afterward, and verify the controller and VM identity did not change.
- **Full sandbox check:** From an unsandboxed terminal, run `npm --prefix pi/sandbox run test:native` as required by `pi/AGENTS.md`.
- **Manual smoke:** In one sandboxed TUI, record `/gondolin-status` or `pivm vm list`, run `/new`, and confirm the status returns to `healthy` with the same VM ID and working Bash/tools. A timeout on `starting`, a changed VM ID, a disappearing controller manifest, duplicate attached roots, host-tool fallback, or failure to release on final quit is a failure signal.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Reproduce the replacement lifecycle failure
- ☑ Transfer the root process lease safely
- ☑ Lock in process-lifetime reuse and document it
<!-- pi-plan-mode:progress:end -->
