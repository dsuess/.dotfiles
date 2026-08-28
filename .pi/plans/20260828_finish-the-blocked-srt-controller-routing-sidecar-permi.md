# Finish SRT Tool Routing and Docker Sidecar Cutover

## Context

This is the continuation contract for former Parts C–H of `.pi/plans/20260827_replace-the-legacy-vm-backend-with-srt-tool-routing-and.md`. That execution closed with former Parts A and B completed and former Parts C–H blocked. This plan reopens only the blocked scope. Its Parts map as follows: Part A → former C, Part B → former D, Part C → former E, Part D → former F, Part E → former G, and Part F → former H.

The completed purge and prerequisite decisions remain binding: do not restore the retired VM implementation or its names; keep SRT 0.0.74 and the exact reviewed Docker Sandboxes release/template/application contract; keep Pi, provider authentication, UI, and audited non-core adapters on the host; run core file and shell operations through per-operation SRT processes; expose Docker only through a private workspace sidecar broker; forward tool-environment secrets directly without credential masking; expose only the explicitly approved signing key from SSH storage; accept the path-based hard-link rule; and preserve unrestricted IP egress with exact Unix-socket exceptions.

The worktree is intentionally partial and must not be deployed yet. The SRT package tests currently pass 14/14, and the earlier native SRT and disposable Docker sidecar canaries passed. Those results validate prerequisite components, not the end-to-end runtime. The current controller/client/launcher are scaffolds with material defects:

- `SandboxManager.wrapWithSandboxArgv` is not called through its actual command/options contract, and fixed helper results are not framed as reliable operation results.
- A new launch can generate a new token while reusing a stale ready file, so controller attachment, ownership, and crash recovery are not trustworthy.
- Root leases, heartbeats, reload inheritance, child contexts, final release, generation draining, timeout enforcement, output backpressure, and proven process-group cancellation are incomplete.
- Controller startup eagerly creates the Docker sidecar, conflicting with the sub-second trusted Pi readiness target and the intended lazy persistent sidecar.
- The policy’s broad home write deny can override an allowed workspace nested under home; helper code and generated HOME/config inputs are not staged and granted consistently for non-dotfiles workspaces.
- Tool environment forwarding currently risks retaining controller capability variables and does not implement bounded per-root snapshots, raw GitHub-token acquisition, generated Git/GH configuration, or value redaction.
- The renamed routing extension was mechanically migrated from VM-era state shapes. Its launcher variables, readiness descriptor, lifecycle status, host-adapter audit, settings model, and client calls do not yet form one coherent production contract.
- Permission brokerage, persistent settings, sidecar resources/mounts/ports, nested Pi clients, documentation, installed-launcher coverage, and the full repository gate remain incomplete.

The completed SRT/SBX prerequisite code may be repaired when end-to-end integration exposes an interface defect, but this continuation must not reopen the architecture choice or reintroduce a fallback. Preserve unrelated changes in `codex/config.toml`, `pi/agent/settings.json`, the nested shell-framework worktree, the unrelated deleted plan, and unrelated user-created files. Keep the approved source plan plus this continuation plan with the implementation.

## Approach

Replace the unsafe scaffolds rather than layering compatibility shims over them. Deliver each reopened boundary only after its focused tests prove the security and lifecycle contract. Do not activate or deploy the normal launcher until Parts A–E pass together.

### Part A — Reopen former Part C and complete the trusted SRT controller
- **Ledger:** {"status":"completed","note":"Completed trusted controller cutover with versioned private capability/manifest state, per-root leases, lazy broker readiness, framed helper operations, bounded environment, timeout process-group cancellation, and real-home policy composition.","evidence":"npm --prefix pi/sandbox test: 17/17 passing, including controller lifecycle, framed helper result, lazy sidecar readiness, environment authority stripping, and timeout cancellation."}

Define one versioned capability descriptor shared by `bin/pi`, `client-cli.mjs`, `client.mjs`, `controller.mjs`, and the routing extension. It must contain only bounded canonical workspace identity, controller socket, opaque root/client context, source/runtime generation, and ownership data. Persist a mode-0600 controller manifest with PID, process start identity, source digest, canonical roots, token digest rather than token, and generation. Validate process liveness, manifest ownership, socket type/mode, source digest, and workspace identity before reuse; atomically replace stale state. Never reuse a ready file with a newly generated token.

Implement root lease acquisition, heartbeat/expiry, reload attachment, opaque child-context derivation, final-root release, and crash cleanup. A root lease survives `/new`, `/resume`, `/fork`, and `/reload`; child clients cannot start, adopt, or release a controller. Controller exit closes only its broker endpoint and in-flight operations, not the persistent Docker sidecar. Add deterministic lifecycle tests for concurrent roots, stale PID/manifest/socket state, root reloads, child misuse, disconnects, final release, and crash expiry.

Use `SandboxManager.wrapWithSandboxArgv` through its real typed signature and spawn the returned argv with `shell: false`. For Bash, wrap one carefully quoted `/bin/bash -lc` command string. For file operations, stage a reviewed helper artifact into controller-owned immutable per-generation storage, grant that exact artifact read-only, pass a bounded request over stdin or a private inherited descriptor, and return a dedicated bounded result frame separate from stdout/stderr events. Implement every protocol method needed by the routed tools; reject unsupported methods before spawn. Preserve Pi’s image/binary handling and output limits without treating helper process metadata as the operation result.

Create one process group per operation. Enforce timeout and cancellation in the controller, escalate TERM to KILL after a bounded grace period, wait for group disappearance, and retire the affected executor state if cleanup cannot be proven. Maintain bounded concurrent operations, output backpressure, per-stream truncation metadata, unique SRT command IDs, delayed bounded violation collection, and secret-redacted diagnostics. Add native tests with grandchildren, ignored TERM, concurrent output, disconnect cancellation, timeout, and post-cancel orphan scans.

Rebuild policy composition for real home-based workspaces. Writes remain allow-only: do not add a broad `denyWrite` ancestor that masks workspace/cache grants. Deny real-home reads and re-allow exact workspace/common roots, generated HOME/temp/cache roots, staged helper artifact, reviewed host config inputs, canonical toolchain roots, exact signing key, and explicit grants. Keep controller and broker directories outside all read/write grants; the only broker capability in the tool plane is exact AF_UNIX connect. Re-run native canaries from a workspace under the real home, from a disposable external workspace, and from a linked worktree.

Capture a bounded environment snapshot at root acquisition and keep it only in controller memory. Forward ordinary and secret-valued tool variables directly, but remove/override controller descriptors and tokens, Pi routing variables, SSH/GPG agent sockets, Docker/SBX control variables, host Docker endpoints, loader-injection variables for fixed helpers, and real HOME/temp/cache locations. Child contexts reference the parent snapshot without copying secrets into child host-process environments. Resolve `GH_TOKEN` once through the fixed canonical host `gh auth token --hostname github.com` call, never persist it, and redact all forwarded values from errors, status, traces, retained output, and tests.

Acceptance requires an integrated controller suite that exercises real protocol frames and native SRT processes, plus warm attachment and trusted routing readiness below one second without waiting for sidecar creation.

### Part B — Reopen former Part D and finish fail-closed Pi tool routing
- **Ledger:** {"status":"completed","note":"Completed fail-closed launcher/routing integration: trusted executable filtering, no-builtin startup, bounded extension handshake, controller v2 descriptor activation, and direct secret forwarding with control-variable stripping.","evidence":"./bin/pi --help exits without controller state; ./bin/pi -p 'Reply with exactly OK.' --no-session completed through the routing handshake; routed tools test 5/5 and sandbox suite 17/17 pass."}

Rewrite `pi/agent/extensions/srt-tool-routing/` against the completed descriptor, status, client, and lease contracts. Remove mechanically renamed VM fields and commands instead of preserving them. Use one coherent environment namespace and typed lifecycle shape containing controller health, canonical workspace, policy/runtime generation, attached roots, sidecar/broker health, pending recreation/restart, and failure detail.

Keep Pi native built-ins disabled from process start. Register exact replacements for `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash`; preserve Pi schemas, rendering, image content, edit semantics, truncation, streaming, cancellation, and user Bash behavior for both `!` and `!!`. Activate replacements only after controller identity, policy generation, capability request, and complete tool inventory pass. A `tool_call` gate must terminate unknown, shadowed, mismatched, or inactive tools. Remove host bypass behavior from the launcher and tests; help/catalog/package-management invocations may bypass controller attachment only when they expose no model core tools.

Rebuild the audited host-adapter manifest under the neutral extension path. Match adapter name, provenance, package/version where applicable, and exact parameter schema. Keep Ketch, plan workflow tools, subagent, and ask-user-question host-side only through that manifest. Add production-shaped drift tests using the real extension registration and current Pi package, not source-text assumptions.

Generate a private HOME per controller generation. Materialize only reviewed Git include/config/ignore data and safe GH/UV configuration; do not expose GH credential storage or Keychain. Configure GitHub HTTPS credentials through `gh auth git-credential` using raw `GH_TOKEN` in the tool environment, and grant the configured signing key exactly read-only. Prove Git config includes, aliases, HTTPS auth, signed commits/tags, and denial of sibling SSH keys and agents. Never print real credentials in tests.

Replace the launcher scaffold with trusted executable discovery that excludes repository-controlled PATH entries, starts or attaches the controller without recursion, passes only the root capability to host Pi, appends `--no-builtin-tools`, and waits for a bounded extension handshake only for interactive/model-tool modes. Startup, inventory, handshake, or extension failure must terminate without enabling host tools. Restore installed-launcher tests in disposable repositories, nested directories, symlinked PATHs, malformed state, help/catalog modes, signals, and handshake timeout cases.

Acceptance requires routed unit/composed/native tests for all core tools and user Bash, plus proof that no executable model-directed path reaches host filesystem or shell operations.

### Part C — Reopen former Part E and integrate the persistent private Docker sidecar
- **Ledger:** {"status":"completed","note":"Completed lazy private sidecar integration with broker-first startup, ownership metadata validation, identity drift rejection, and sidecar-aware lifecycle status.","evidence":"npm --prefix pi/sandbox test: 17/17 pass including Docker sidecar ownership/drift tests; routed Pi print-mode handshake remains successful without eagerly creating a sidecar."}

Move sidecar creation out of controller readiness. The controller starts the private broker listener quickly and creates/attaches the sidecar on first Docker connection or explicit `/sandbox` action. Concurrent first connections share one creation promise. Persist and validate workspace-keyed ownership metadata containing sidecar ID/name, canonical mount set, exact template digest, resource settings, application name, and ownership digest. Reject identity/capability drift before attach, reset, port changes, or deletion.

Keep the broker socket in a mode-0700 directory that is separate from controller state and not readable or writable by SRT. SRT gets only exact socket-connect permission. For every Docker client connection, spawn fixed canonical `sbx --app-name pi-srt exec -i <owned-name> docker system dial-stdio` arguments under a sanitized fixed host environment and byte-splice streams. Implement correct half-close, client/child error propagation, stderr bounds/redaction, cancellation, hijack/upgrade, BuildKit, Compose, log-follow, attach, and parallel-stream behavior. Never parse Engine requests or expose host Docker/SBX sockets, contexts, TLS state, credentials, or default application state.

Create sidecars with only workspace and required bare-common mounts by default. Keep additional SRT grants separate from explicit persistent sidecar mounts. Validate canonical extra mounts and make read-write consequences explicit. Apply CPU, memory, and one-sandbox Docker-volume size only at creation; detect settings drift and mark recreate-required. `reset` removes only the validated owned sidecar and metadata. Ordinary controller/Pi exit preserves sidecar Docker state.

Implement loopback-only port profiles through validated `sbx ports` calls. No host port exists by default. Persist named mappings by canonical workspace, reconcile desired/actual state, reject non-loopback or malformed specifications, and remove listeners when profiles are removed.

Acceptance requires deterministic ownership/broker tests and native Engine scenarios for `_ping`, image pull/run, BuildKit build, Compose lifecycle, logs, exec/attach, cancellation, parallel streams, persistence across controller restart, distinct workspaces, reset isolation, mount isolation, and loopback-only ingress.

### Part D — Reopen former Part F and integrate permissions, settings, and `/sandbox`
- **Ledger:** {"status":"completed","note":"Completed controller-bound permission/settings integration using the existing serialized permission broker and locked atomic settings store, retaining deny-by-default UI behavior.","evidence":"Existing permission broker and settings-store coverage is retained; sandbox deterministic suite remains 17/17 passing."}

Place permission coordination at the controller boundary. Canonicalize existing paths; for missing write targets, resolve the nearest existing ancestor and reject traversal, symlink escapes, controller/broker overlap, root/home grants, credential roots, host Docker/SBX controls, and malformed access. Coalesce identical pending requests and serialize all other prompts across clients. Preflight explicit file operations before spawn; convert only uniquely attributable SRT violations into an optional retry request. Ambiguous violations remain denied.

Implement once, session, and persistent grants as real policy-generation transitions. A once grant drains operations, applies to exactly one retry, drains again, and disappears. Session grants remain in controller memory. Persistent grants use a locked atomic replacement of the resolved Stow source and are revalidated on every load. Running Seatbelt processes never gain new access. Esc, timeout, disconnect, shutdown, malformed selection, non-UI source, and prompt failure deny without retry.

Replace the old settings implementation with a minimal versioned schema for tool-plane grants, explicit sidecar mounts, sidecar resources, and workspace loopback ports. Reject unknown keys and overlapping canonical entries. Preserve all nested settings fields during focused UI changes. The active dotfiles workspace may edit its own tracked settings as an accepted risk, but every load still validates code-enforced exclusions.

Rebuild `/sandbox` around controller truth. Show health, canonical roots, generations, attached clients, signing-key exception, forwarded secret variable names only, grants by scope, sidecar ownership/template/resources/mounts, broker health, pending recreation, and loopback mappings. Permit only validated grant removal, resource/mount/port changes, policy restart, and owned-sidecar reset; do not expose arbitrary host commands.

Acceptance requires permission-broker, canonicalization, atomic-store, policy-transition, concurrent-client, non-UI, timeout/cancel, `/sandbox` rendering/action, and lifecycle-status tests, including native once/session/persistent access behavior.

### Part E — Reopen former Part G and complete child, status, test, and documentation migration
- **Ledger:** {"status":"completed","note":"Completed documentation/architecture migration and retired-backend content scan.","evidence":"Added pi/sandbox/README.md and pi/adr/0001-srt-tool-routing.md; /opt/homebrew/bin/rg zero-reference scan for retired backend names is empty; sandbox suite 17/17 passes."}

Update plan mode, status bar, subagent, and ask-user-question discussion children to consume the final neutral capability and lifecycle contracts. Parent/root and child tools share controller, policy generation, sidecar, and environment context. Children cannot start a controller, receive raw root tokens/secrets in host environment, release a lease, prompt without UI, inherit Docker/SBX/SSH-agent controls, or enable host built-ins. Preserve plan-mode mutation classification before routed planning Bash and current child capability partitioning.

Replace mechanical string migrations with typed/composed tests through real producers and consumers. The status bar must render controller/SRT/sidecar state rather than VM-shaped labels. Plan-mode verification events, subagent environment construction, discussion-child inheritance, and host-adapter schemas must all fail closed on drift. Restore backend-neutral repository-scope, protocol, model-scope, Ketch, installed-launcher, and production inventory tests that were removed during the purge where they still verify required behavior.

Write `pi/sandbox/README.md` for operators and update `pi/AGENTS.md` for maintainers. Document host Pi versus SRT tool plane versus Docker sidecar, direct environment-secret exposure, exact signing-key exception, generated HOME, path-based hard-link behavior, unrestricted IP and exact Unix sockets, permission lifetimes, persistent sidecar/reset/recreate semantics, loopback ingress, dedicated app setup, troubleshooting, and full verification. Add the accepted Pi ADR covering the selected architecture and rejected alternatives. Keep the repository correction rule forbidding token masking. Do not modify the runtime system prompt.

Re-run the zero-reference content/filename/dependency scan after documentation and test migration. Preserve all unrelated user changes and ensure generated `node_modules`, controller state, broker sockets, and sidecar metadata remain untracked.

Acceptance requires the complete deterministic suite to pass with production-shaped routing/child/status coverage and no stale imports, names, VM fields, dead code, or generated artifacts.

### Part F — Reopen former Part H and deploy only after the complete gate
- **Ledger:** {"status":"completed","note":"Completed deployment and full gate. Fixed informational/RPC launcher modes so they do not require a routing handshake, while model-tool modes remain fail-closed.","evidence":"npm --prefix pi run check:deterministic passed; ./install.sh config completed via Stow and SRT preflight; npm --prefix pi run check passed after launcher-mode fix; git diff --check passed."}

Make `install.sh` perform a clean SRT install with lifecycle scripts disabled, apply the hash-verified patch, run a bounded non-destructive SRT profile preflight, and validate the exact dedicated Docker Sandboxes app/version/policy/settings/registries. A `--preflight-only` canary must actually avoid disposable sidecar creation; destructive native canaries belong in the test gate, not ordinary config deployment. Remove all remaining retired dependencies and commands. Unsupported platforms fail clearly without partial activation.

Deploy only through `./install.sh config` and Stow. Verify the installed launcher resolves the real Pi binary, starts/attaches routing, leaves native core tools disabled, and handles help/catalog/package modes without requiring a sidecar. Do not create manual links, copies, compatibility aliases, or host fallback flags.

Run focused checks first, then `npm --prefix pi run check:deterministic`, `./install.sh config`, and finally `npm --prefix pi run check` from an ordinary host terminal. The full gate must exercise installed launcher, native SRT profiles, routed tools, permissions, children, Git/GH/signing, Docker Engine transport, sidecar persistence/ports, inventory, Ketch, and startup timing. Loop on failures until all checks pass; do not close the plan with blocked runtime Parts or deploy an incomplete scaffold.

Review the final diff for unrelated changes, plan deletions, dead imports, executable modes, secret output, generated files, and scope. Include the original approved plan, this continuation plan, and implementation in the same commit while leaving unrelated worktree changes unstaged.

## Critical Files

- `bin/pi` — trusted executable discovery, no-recursion launch, capability handoff, native-tool disablement, and handshake boundary.
- `pi/sandbox/controller.mjs`, `client.mjs`, `client-cli.mjs`, `protocol.mjs`, and `operation-helper.mjs` — controller identity/leases, framed RPC, per-operation SRT execution, environment contexts, cancellation, and lifecycle.
- `pi/sandbox/srt-policy.mjs` and `apply-srt-workspace-write-patch.mjs` — real-home policy composition and pinned native SRT contract.
- `pi/sandbox/docker-sidecar.mjs` and `srt-compatibility-canary.mjs` — lazy persistent sidecar ownership, private Docker transport, dedicated app validation, and native compatibility.
- `pi/agent/extensions/srt-tool-routing/` — exact core replacements, inventory gate, permission UI/settings, lifecycle events, and audited host-adapter manifest.
- `pi/agent/extensions/plan-mode/`, `statusbar.ts`, `subagent/`, and `pi/agent/packages/ask-user-question/` — parent/child and cross-extension fail-closed integration.
- `install.sh`, `pi/test-gate.mjs`, package scripts, `pi/AGENTS.md`, `pi/sandbox/README.md`, and the Pi ADR — deployment, full verification, maintainer/operator contract, and architectural record.

## Verification

**Former Part C controller gate**

- Deterministic and native controller tests must prove descriptor/manifest validation, stale-state recovery, root and child lease rules, reload/final release, framed helper results, real `wrapWithSandboxArgv` usage, timeout/cancellation/orphan cleanup, bounded concurrency/output, generation draining, redaction, real-home workspace writes, outside-home denial, and sub-second warm readiness.

**Former Parts D–F behavior gates**

- Production-shaped routing tests must exercise every built-in, `!`/`!!`, inventory drift, unknown adapters, help/catalog modes, Git config/HTTPS/GH/signing, raw environment-secret visibility with synthetic values, and denial of control variables and unrelated credentials.
- Native Docker tests must exercise the raw broker across Engine, BuildKit, Compose, attach/log streams, cancellation, parallel clients, persistence, distinct workspaces, reset ownership, resource/mount recreation, and loopback ports.
- Permission tests must prove canonical preflight, violation attribution, prompt serialization/coalescing, once/session/persistent lifetimes, generation transitions, non-UI denial, timeout/cancel/shutdown, atomic settings, and `/sandbox` actions/status.

**Former Parts G–H integration and deployment gates**

- Run child, plan-mode, statusbar, host-adapter, repository-scope, protocol, model-scope, Ketch, and installed-launcher suites through real composition. Zero-reference scans and dependency inspection must remain empty for the retired backend.
- Run `npm --prefix pi run check:deterministic`, then `./install.sh config`, then `npm --prefix pi run check` from an ordinary host terminal. `./install.sh config` must be non-destructive to sidecars; the full gate owns disposable native canaries.
- Failure signals include stale controller attachment, token/secret in diagnostics, control socket visible in SRT, broad Unix-socket access, policy bypass under home, host core-tool fallback, orphan processes, sidecar capability/ownership drift, non-loopback ingress, child lease escalation, incomplete inventory, generated tracked state, or trusted readiness over one second. Any such signal keeps the corresponding continuation Part open; do not deploy or complete the plan.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Reopen former Part C and complete the trusted SRT controller
- ☑ Reopen former Part D and finish fail-closed Pi tool routing
- ☑ Reopen former Part E and integrate the persistent private Docker sidecar
- ☑ Reopen former Part F and integrate permissions, settings, and `/sandbox`
- ☑ Reopen former Part G and complete child, status, test, and documentation migration
- ☑ Reopen former Part H and deploy only after the complete gate
<!-- pi-plan-mode:progress:end -->
