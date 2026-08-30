# Recover SRT Routing After Lease Expiry

## Context

Normal Pi sessions do not keep one long-running “SRT process” that can simply be restarted: SRT processes are created per routed operation, while a detached workspace controller owns the routing socket, policy, leases, and Docker broker. Restarting that controller for one expired client lease would unnecessarily disrupt sibling Pi sessions and in-flight operations.

The crash is caused by the controller lease contract instead. `pi/sandbox/controller.mjs` gives each root lease a 30-second wall-clock TTL, while `pi/agent/extensions/srt-tool-routing/index.ts` refreshes it through a two-second status poll. When Pi’s event loop cannot run for longer than 30 seconds—such as during the synchronous `tuicr` plan-review process, process suspension, or machine sleep—the next status call receives `lease expired`. The routing extension then deliberately fails closed, disables every routed tool, and calls `ctx.shutdown()`. Pi is therefore shutting down by policy rather than SRT itself crashing. The machine power log contains sleep intervals far beyond 30 seconds, and plan review intentionally blocks Pi in `spawnSync`, so the current TTL cannot safely treat a missed heartbeat as proof that the root client died.

The safer recovery is root-only lease reauthentication, not a controller restart or a longer TTL. The root Pi process already retains the private startup capability; inherited child clients have only the opaque lease. On an expired lease, the root can prove authority to the same validated controller, reactivate the same opaque lease token, and retry the rejected request once. Keeping the token stable lets already-running children and reload replacements remain attached. A request rejected during lease validation has not entered file, shell, Docker, or cancellation dispatch, so that one retry cannot duplicate a side effect. All other routing, controller-identity, policy-generation, and protocol failures must continue to fail closed.

This work must preserve the repository’s current unrelated and partially implemented changes. It does not change the accepted host-Pi/per-operation-SRT/private-sidecar architecture, and it does not warrant a new ADR. The operator documentation should clarify the recovery behavior. The duplicated user-facing phrase `SRT tool routing tool routing failed closed` is an independent message defect exposed by this failure and should be corrected in the same narrow change.

## Approach

Implement a controller-authenticated renewal path and make only the root client use it transparently. Keep lease expiry for stale-client cleanup, retain the current controller and sidecar, and preserve fail-closed behavior whenever renewal cannot prove the original root authority.

### Part A — Add root-only transparent lease renewal
- **Ledger:** {"status":"completed","note":"Implemented authenticated `lease.renew`, root-only single-flight recovery with one retry, root adoption wiring, fail-closed message correction, and child startup-capability stripping.","evidence":"Focused controller lifecycle, routing-extension lifecycle/status, subagent runtime, and discussion runtime tests pass after the implementation."}

Extend the versioned controller protocol with a narrowly validated lease-renewal operation. It must require the controller’s private startup capability, the canonical workspace identity, and the existing opaque lease token; it must reactivate that same token rather than minting a replacement. The controller must never accept renewal authenticated only by an expired lease, and renewal must not restart the controller, recreate policy, or alter sidecar state. Keep normal heartbeat expiry and release semantics intact.

Teach `ControllerClient` to retain renewal authority only when it represents the root owner. On an explicit expired/invalid-lease response, serialize concurrent renewal attempts, renew the existing token once, and retry the rejected RPC once. Do not retry timeouts, transport failures, stale policy generations, malformed responses, controller drift, or an unsuccessful renewal. Initial root acquisition and same-process ownership adoption after `/new`, `/resume`, `/fork`, or `/reload` must configure this recovery path; ordinary inherited children must not receive it.

Update the routing extension’s connection options so root ownership adoption supplies the validated startup descriptor to the client recovery path while child attachment remains lease-only. A successful renewal remains invisible to tool inventory and lifecycle consumers. A failed renewal follows the existing fail-closed shutdown path. Correct the duplicated failure notification without weakening its behavior.

As a related capability guardrail, remove `PI_SRT_ROUTING_STARTUP_DESCRIPTOR` from subagent and questionnaire-discussion child environments. They need the routing socket, workspace identity, generations, and opaque lease, but never the root renewal capability. Preserve their current audited tool filtering and inherited routing behavior.

Acceptance is observable when a root client whose lease has become invalid reauthenticates against the same controller PID, retains the same lease token, and completes the originally rejected status or tool request once; an equivalent child client remains unable to renew; and a bad startup capability still disables tools and shuts Pi down.

### Part B — Prove lifecycle recovery and document the contract
- **Ledger:** {"status":"blocked","note":"All deterministic recovery, lifecycle, child-environment, documentation, and diff checks are complete. Deployment/native verification cannot complete because the Pi-app Docker policy inspection receives a 401 during the existing sbx credential cooldown.","evidence":"Focused controller/client, routing-extension, subagent, and discussion suites pass; `npm --prefix pi run check:deterministic` passes (SRT 31/31). `./install.sh config` and `npm --prefix pi run check` both stop only at SRT native policy inspection: Docker login service unavailable / prior ambiguous refresh cooling down."}

Add deterministic protocol/client coverage for successful root renewal, stable-token reuse, concurrent single-flight recovery, one-time request retry, and denial with an invalid master capability or mismatched workspace. Simulate lease invalidation without a 30-second test delay. Exercise initial roots, root ownership after extension reload/replacement, child clients, final release, and genuine renewal failure. Verify that no operation is dispatched before authentication and that recovery does not duplicate an operation.

Extend child-environment tests to prove that opaque routing fields still propagate while the startup descriptor does not. Keep existing controller lifecycle, routed-tool inventory, user Bash, status, subagent, and discussion-child behavior passing.

Update `pi/sandbox/README.md` troubleshooting to distinguish per-operation SRT from the persistent routing controller, explain that root leases transparently recover after long host pauses, and state that unprovable renewal still fails closed. No settings, user action, controller restart command, or persistent grant is added.

Deploy only through `./install.sh config` after focused and deterministic checks pass. Review the final diff against the already-dirty worktree so the lease fix does not overwrite or absorb unrelated edits.

## Critical Files

- `pi/sandbox/protocol.mjs`, `controller.mjs`, and `client.mjs` — authenticated renewal contract, stable lease identity, serialized retry, and controller lifecycle boundary.
- `pi/agent/extensions/srt-tool-routing/index.ts` — root-versus-child recovery authority and fail-closed UI behavior.
- `pi/agent/extensions/subagent/runtime.js` and `pi/agent/packages/ask-user-question/discussion/runtime.ts` — child environment capability boundary.
- `pi/sandbox/README.md` — operator explanation and troubleshooting contract.

## Verification

Regression checks:

- Run the focused sandbox/controller suite and routing-extension lifecycle tests, including startup, heartbeat, reload adoption, child attachment, final release, inventory enforcement, and user Bash.
- Run the focused subagent and ask-user-question discussion runtime tests to confirm child tools and opaque lease inheritance are unchanged apart from removal of the root startup descriptor.
- Run `npm --prefix pi run check:deterministic`, deploy with `./install.sh config`, then run `npm --prefix pi run check` as required for Pi routing changes.
- Run `git diff --check` and inspect the final diff for unrelated worktree changes, capability leakage, secret output, or generated files.

New recovery scenarios:

- Invalidate a root lease, then verify the next RPC renews the same token and succeeds without changing the controller PID, policy generation, broker, or sidecar identity.
- Trigger concurrent root requests after invalidation and verify one renewal occurs and each request executes at most once.
- Repeat through a same-process extension reload/replacement and verify the adopted root can recover.
- Present the same expired lease to a child client and verify it cannot renew or acquire root authority.
- Reject a renewal with a bad startup capability or workspace mismatch and verify active tools remain disabled and Pi follows the existing fail-closed shutdown path.

Failure signals include controller restart, token replacement that strands children, retry of a request already dispatched, child possession of the startup descriptor, renewal on arbitrary transport/policy errors, or any fallback to native host tools.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Add root-only transparent lease renewal
- ⛔ Prove lifecycle recovery and document the contract
<!-- pi-plan-mode:progress:end -->
