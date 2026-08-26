# Add workspace-scoped Gondolin HTTP ingress

## Context

The Pi controller currently supports guest egress but no host access to services running inside its Gondolin VM. Existing `network.tcpMappings` are specifically **egress mappings**: they map a guest-selected hostname and port to a host or upstream destination. Reusing that name for the reverse direction would make the settings ambiguous.

Gondolin 0.12.0 provides `vm.enableIngress()` for the reverse direction. Its supported boundary is a localhost HTTP/1.1 gateway with path routing to guest-loopback HTTP servers, including optional WebSocket upgrades. Gondolin explicitly documents that ingress is not a generic port forward and that its lower-level ingress stream must not become one. Preserve that boundary rather than patching private VM internals or exposing arbitrary guest TCP. See [Gondolin ingress](https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/ingress.md) and [SDK networking](https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/sdk-network.md).

A single path-routed host URL is insufficient for common development stacks. The Visonic Compose configuration publishes independent HTTP services on `localhost:28080`, `25173`, `26006`, `28083`, `28081`, and optionally `28082`; its browser UI also refers to the Manager by its preferred localhost port. The generalized capability therefore needs separate browser-facing localhost listeners while still terminating through one supported Gondolin HTTP ingress gateway. Debugger ports such as debugpy remain out of scope because they are raw TCP.

Call the new objects **ingress workspace profiles** and **host listeners**. A host listener is an explicit localhost HTTP endpoint mapped to one guest-loopback HTTP port. It is not an egress `tcpMapping`, a Docker port publication, or an arbitrary TCP tunnel.

Profiles will live in the Stow-managed Pi sandbox settings and match an exact canonical workspace root, like filesystem workspace overrides. This keeps target repositories unchanged and prevents one workspace’s listeners from applying globally. The existing settings version can remain backward compatible by treating a missing top-level `ingress` section as an empty profile list.

Every listener binds to `127.0.0.1`; LAN/public binding is not configurable. The host account remains trusted under Gondolin’s threat model, and any local process can reach an enabled listener. Ingress is independent of guest egress mode, so an explicit profile can remain available when egress is `offline`.

A preferred host port is attempted first. If it is occupied, the listener binds an ephemeral port instead and reports the substitution prominently. Other bind failures remain startup errors. This fallback can invalidate project code that hard-codes the preferred localhost port, as Visonic does for its Manager URL; the sandbox will report that condition but will not rewrite application configuration. This is an accepted operational risk from the selected fallback behavior.

No `CONTEXT.md` is warranted because these are general infrastructure terms rather than repository-specific domain language. No ADR is warranted because the supported HTTP-only boundary is already imposed and documented by Gondolin, and the profile design is reversible.

## Questions & Answers

| Question | Answer |
|---|---|
| What inbound transport should the generalized first version support? | HTTP + WebSocket (Recommended) |
| How should workspace exposure rules be configured? | Dotfiles workspace profiles (Recommended) |
| What should happen when a configured localhost port is already occupied? | Use random port |

## Approach

Implement a workspace-scoped HTTP exposure layer around Gondolin’s public ingress API. For each active profile, the controller will create one private ephemeral Gondolin gateway and one localhost-facing adapter per configured service. Each adapter will identify its route through a reserved internal path prefix, preserving the client’s original path, query, and Host header before Gondolin connects to the configured guest-loopback port. This gives services distinct host ports without turning the guest connector into generic TCP forwarding.

### Part A — Define workspace ingress profiles
- **Ledger:** {"status":"completed","note":"Added version-1-compatible workspace-scoped ingress settings, canonical exact profile selection, Visonic listener profile, and portable Stow-store persistence.","evidence":"node --test pi/sandbox/test-policy.mjs pi/agent/extensions/gondolin-sandbox/settings-store.test.mjs (13/13 pass); loadSandboxPolicy selected the Visonic profile with six listeners."}

Extend `pi/sandbox/settings.json`, the policy parser, and the extension settings store with an optional top-level `ingress.workspaceProfiles` array. Each profile contains:

- an existing absolute or `~/` workspace `root`;
- a workspace-wide `allowWebSockets` boolean;
- bounded named `listeners`, each with `name`, `hostPort`, and `guestPort`.

`hostPort: 0` requests an ephemeral endpoint directly; a nonzero host port is preferred and may fall back only on address-in-use. Guest ports must be 1–65535. Listener names and nonzero preferred host ports must be unique within a profile. Canonical workspace roots must be unique across profiles, with symlink aliases treated as duplicates. Bound profile and listener counts to prevent unbounded host listeners.

Select a profile only when its canonical root exactly equals the controller’s canonical workspace root. Preserve the portable configured root when the settings UI saves the Stow source. Include the selected effective ingress profile in `policyGeneration` so a change uses the existing authenticated reload-and-restart path. A missing `ingress` section normalizes to no profiles, preserving existing version-1 settings behavior.

Keep ingress separate from `network`: current network modes and `tcpMappings` govern guest egress, while this section governs explicit host-to-guest HTTP access. Do not disable ingress automatically when egress is offline.

Add a Visonic profile only in the dotfiles settings, with named listeners for the six application HTTP ports and WebSockets enabled for browser development. Do not include debug ports and do not modify `/Users/dsuess/src/visonic/dev`.

Acceptance outcome: unrelated workspaces start with no host listeners; canonical launches anywhere inside Visonic select the same profile; malformed, duplicate, or over-broad profiles fail validation before VM startup.

### Part B — Own ingress in the controller lifecycle
- **Ledger:** {"status":"completed","note":"Added VM-owned Gondolin gateway and localhost HTTP adapters with request-line-only rewriting, EADDRINUSE fallback, authenticated status, and VM lifecycle cleanup.","evidence":"node --test pi/sandbox/test-controller.mjs (19/19 pass), including fragmented streaming request forwarding, Host/path preservation, raw/absolute-form rejection, fallback, status shape, and listener replacement."}

Add a small controller-owned ingress manager with one lifecycle per VM. After the VM starts, configure one private `vm.enableIngress()` gateway on `127.0.0.1` with an ephemeral host port and set bounded routes to the selected guest-loopback ports. The private gateway must reject requests that do not carry one of the controller’s reserved route prefixes.

For each configured service, bind a host adapter to `127.0.0.1` on its preferred port. The adapter may inspect and rewrite only the bounded initial HTTP request line needed to prepend its reserved private route prefix; Gondolin then strips that prefix before forwarding. Preserve method, original target path and query, Host header, request/response streaming, and WebSocket bytes after upgrade. Reject malformed, absolute-form, non-HTTP, or oversized request lines rather than treating the adapter as raw TCP.

If the preferred port returns `EADDRINUSE`, retry once on port `0`. Record both the preferred and actual ports and mark the fallback. Do not fall back for permission, invalid-address, resource-exhaustion, or other listener errors. If the private gateway or any listener cannot start under those rules, close all partially created endpoints and fail controller startup.

Close public adapters and the private gateway before closing or replacing the VM. Recreate them after restart, reset, or settings reload; actual fallback ports may therefore change. Backend readiness is not a controller startup condition because services often start later. A bound gateway is healthy even when requests temporarily receive a 502 because the guest service is absent.

Expose a bounded `ingress` object from controller status containing infrastructure health and each listener’s name, localhost URL, preferred port, actual port, guest port, and fallback flag. Keep it authenticated through the existing controller status path; do not add unauthenticated control methods or place routing secrets in the launcher descriptor.

Acceptance outcome: configured HTTP, SSE, and WebSocket clients can reach only declared guest ports through localhost; raw protocols are not forwarded; VM replacement removes old listeners; and partial startup never leaves orphan host ports.

### Part C — Make listener state operable and visible
- **Ledger:** {"status":"completed","note":"Made active ingress profile and listener URLs visible in /sandbox and non-TUI output, added current-profile listener/WebSocket editing, fallback notifications, and documented the contract.","evidence":"npm --prefix pi/sandbox run test:extension (23/23 pass); README documents schema, lifecycle, HTTP/WebSocket-only boundary, fallback, Visonic profile, and egress/Docker/raw-TCP distinctions."}

Extend `/sandbox` to show the current workspace profile separately from egress network settings. Display each mapping as a named localhost URL to guest port, clearly marking preferred-port fallback. Add current-workspace profile editing using a compact, validated listener format and the existing locked atomic Stow-source save. Editing another workspace’s profile is out of scope for the current-workspace UI, though all profiles must be preserved byte-for-data through a save.

On session startup and after controller restart, notify the user when any listener fell back to an ephemeral port. Normal fixed listeners need only appear in `/sandbox`; fallback URLs must be immediately visible because the preferred URL is no longer valid. Non-TUI `/sandbox` output must include the same listener summary.

Update `pi/sandbox/README.md` with the canonical terminology, schema, localhost-only security boundary, HTTP/1.1/WebSocket scope, profile matching, lifecycle, preferred-port fallback, application-readiness distinction, and examples. Explicitly contrast ingress host listeners with egress `tcpMappings`, Docker’s guest port publications, and unsupported raw debugger/database protocols.

No footer integration is needed in the first version. This avoids adding another cross-extension lifecycle contract when detailed status and fallback notifications satisfy discovery.

Acceptance outcome: operators can identify every active URL, understand why a fallback occurred, edit only the active workspace profile safely, and never mistake an HTTP listener for arbitrary TCP exposure.

### Part D — Prove the boundary and real development workflow
- **Ledger:** {"status":"completed","note":"Added native ingress regression coverage and completed the real Visonic stack canary through a persistent controller lease.","evidence":"npm --prefix pi/sandbox test (all suites pass); npm --prefix pi/sandbox run test:controller-native (real QEMU HTTP, Docker publication, occupied-port fallback, raw probe, lifecycle/reload pass); controller unit tests 20/20 include WebSocket-byte tunneling; Visonic .dev/dev-start.sh docker canary returned 0 and reached Manager/UI/Storybook/Conductor/ProcessorCPU through reported listeners; target status baseline diff was empty; /opt/homebrew/bin/git diff --check passed."}

Add vertical regression coverage across settings, policy, controller lifecycle, host adapters, extension UI, and native QEMU behavior.

Parser and store tests must cover omitted ingress defaults, portable/canonical roots, symlink duplicates, listener bounds, name/port duplicates, `hostPort: 0`, exact profile selection, preservation of sibling profiles, policy-generation changes, and ingress coexisting with offline egress.

Controller tests must cover fragmented request lines, path/query preservation, Host preservation, streamed bodies/responses, WebSocket upgrade tunneling, unsupported raw bytes, unknown reserved prefixes, fixed binding, occupied-port fallback, non-collision bind failure, status shape, cleanup after partial startup, restart/reload endpoint replacement, and backend-not-ready 502 behavior.

Extend native integration coverage with a guest-loopback HTTP server and a Docker container published onto a guest host port. Reach both from the host through configured listeners, verify an occupied preferred port produces a reported working ephemeral URL, and verify old URLs stop accepting connections after VM replacement. Include a WebSocket exchange and a negative raw-TCP probe.

Finally, repeat the Visonic workflow through a persistent sandboxed Pi/controller lease: run `.dev/dev-start.sh docker` inside `/Users/dsuess/src/visonic/dev`, then make host requests to Manager, UI, Storybook, Conductor, and ProcessorCPU through their reported listeners. Preserve the target repository’s tracked and untracked baseline before and after. Do not require ProcessorGPU unless its profile is started.

Acceptance outcome: the generalized native tests pass independently of Visonic, and the real stack is browser-accessible from the host without any target-repository changes.

## Critical Files

- `pi/sandbox/policy.mjs` and `pi/sandbox/settings.json` — versioned profile validation, canonical workspace selection, and the concrete dotfiles-owned Visonic profile.
- `pi/sandbox/controller.mjs` — VM-owned private gateway, localhost listener adapters, fallback behavior, lifecycle cleanup, and authenticated status.
- `pi/agent/extensions/gondolin-sandbox/settings-store.ts` and `settings-view.ts` — portable profile persistence, active-workspace editing, visibility, and fallback notifications.
- `pi/sandbox/test-controller.mjs` and `test-controller-integration.mjs` — deterministic adapter/lifecycle regressions and real QEMU ingress proof.
- `pi/sandbox/README.md` — canonical operator contract and terminology boundary.
- `@earendil-works/gondolin` 0.12.0 ingress API and documentation — read-only architectural constraint; do not patch it for generic TCP forwarding.

## Verification

- **Regression checks:** run focused policy, controller, settings-store, extension, wrapper, and protocol tests, then `npm --prefix pi/sandbox test` and `git diff --check`.
- **New HTTP scenarios:** verify fixed and directly ephemeral listeners preserve methods, paths, queries, Host headers, request/response streaming, SSE, status codes, and application errors.
- **WebSocket scenario:** complete a real upgrade and bidirectional message exchange when enabled; verify an upgrade is rejected when the active profile disables WebSockets.
- **Fallback scenario:** occupy a preferred host port before controller startup. Success means the sandbox remains healthy, status and `/sandbox` report a different working URL and `fallback: true`, and no fallback occurs for errors other than `EADDRINUSE`.
- **Lifecycle scenario:** restart, settings reload, cancellation-driven VM replacement, Docker reset, and final lease release all close stale host listeners and leave no orphan ports.
- **Security scenarios:** bind only `127.0.0.1`; reject undeclared prefixes, malformed or oversized request lines, and raw debugger-like bytes; prove offline egress remains offline while explicitly configured ingress works.
- **Native Docker scenario:** publish an HTTP container port inside a real Gondolin VM and reach it from the host solely through the declared listener. Retain existing host-isolation and Docker-socket tests.
- **Visonic canary:** while one sandboxed Pi lease remains active, complete `.dev/dev-start.sh docker` and request the five started HTTP services through their reported host URLs. A preferred-port fallback is successful only when reported; note that hard-coded cross-service preferred URLs may still require the preferred ports to be free.
- **Repository safety:** compare `/Users/dsuess/src/visonic/dev` status before and after the canary and require no new tracked or untracked target-repository changes.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Define workspace ingress profiles
- ☑ Own ingress in the controller lifecycle
- ☑ Make listener state operable and visible
- ☑ Prove the boundary and real development workflow
<!-- pi-plan-mode:progress:end -->
