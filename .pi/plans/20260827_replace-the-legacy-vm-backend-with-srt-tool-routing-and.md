# Replace the Legacy VM Backend with SRT Tool Routing

## Context

Normal `pi` launches currently depend on a QEMU-backed VM controller, image builder, guest policy, ingress layer, CLI, routing extension, and a large set of cross-extension contracts. The repository also contains an untracked partial replacement built around `@anthropic-ai/sandbox-runtime` (SRT) and Docker Sandboxes. The cutover must begin by removing the retired backend completely: implementation, package dependency, image and QEMU tooling, commands, tests, active documentation, and every one of the 31 current historical plan files that names it. The approved replacement plan must remain neutral, and the completed worktree must contain no file name or case-insensitive content reference to the retired proper name. Git history and inert machine-local caches outside the repository are not part of that working-tree guarantee.

The replacement keeps Pi, provider authentication, extension UI, permission dialogs, and audited host adapters on the host. Model-directed core file operations and shell commands run in short-lived, per-operation SRT processes owned by one trusted controller for each canonical workspace. Docker commands see only a private Unix socket broker connected to one persistent, workspace-keyed Docker Sandbox sidecar. “Tool plane” means the SRT-confined core operations; “Docker sidecar” means the separate Linux environment behind that broker; neither term implies that Pi itself runs inside the sidecar. A “workspace” is the canonical repository root, or canonical current directory outside a repository, with linked worktrees sharing their canonical common Git directory where required.

Repository and native inspection established several constraints that supersede optimistic claims in the source plan’s ledger:

- The 17 partial-prototype unit tests pass, but they do not validate the integrated native policy. Native probes showed that the current reviewed SRT patch drops `allowPty`, removes dangerous-write guards from unrelated read-write grants, places socket state in a writable directory that lets a tool unlink the broker socket, and puts Unix-socket options at the wrong configuration level.
- Stock SRT 0.0.74 protects Git hooks and repository configuration. A narrow, hash-verified macOS patch is still required to permit complete writes only under explicitly trusted canonical workspace roots while retaining those guards under every other read-write grant.
- Stock proxy routing supports proxy-aware HTTP clients but not arbitrary direct TCP clients. A native profile probe proved that an IP-only Seatbelt allow can provide direct unrestricted IP traffic while preserving path-specific Unix-socket rules. Because egress restriction is explicitly out of scope, the replacement may allow all IP traffic, including UDP and local binding, while granting only the exact DNS responder socket and private Docker broker socket as Unix-socket exceptions.
- Per-operation SRT wrapping measured about 25 ms at p50 and p95 on this machine. It gives exact command IDs for violation attribution, process-level cancellation, and clean policy changes without the nested wrappers and restart generations required by one long-lived sandboxed worker.
- Native SRT treats a pre-existing hard-link path inside an allowed workspace as workspace content. Creating a new hard link, symlink traversal, or rename from a denied path remains blocked. This path-based boundary is accepted.
- The configured SSH signing key is an unencrypted private key. The user explicitly accepts granting that exact file read-only to the tool plane, while all other SSH files and agent sockets remain denied.
- Stock `gh` cannot verify an SRT TLS-termination CA on macOS. Credential masking and token substitution are therefore removed entirely. Tool command processes receive the launching tool environment directly, and the controller adds the raw `github.com` token obtained through a fixed host-side `gh auth token` invocation. Values are neither persisted nor logged, but model-directed code can read and exfiltrate them; this is accepted.
- Docker Sandboxes must remain pinned to `sbx` v0.42.0-rc1 at commit `a6d7101a6c48908b39af0dad0103a2700c85ee4d`, use the reviewed shell-template digest, and operate through the separately authenticated `pi-srt` application. Its local policy is intentionally allow-all, SSH-agent forwarding is disabled, its MCP and secret registries must be empty, and the unavoidable built-in MCP gateway package is accepted only with no registered servers.

Additional accepted risks are deliberate: the active dotfiles workspace can modify its own routing source and tracked settings; environment credentials and the exact signing key can leave through unrestricted egress; Docker workspace mounts are path-based and fully writable; and deleting the prior implementation first means there is no working fallback if a later compatibility gate fails. The implementation must stop at that gate rather than restore or silently bypass the retired backend. Unrelated worktree changes in `codex/config.toml`, `pi/agent/settings.json`, the `oh-my-zsh` submodule, an unrelated deleted plan, and unrelated user-created files must remain untouched.

## Questions & Answers

| Question | Answer |
|---|---|
| What should the legacy-backend purge include? | Zero repository working-tree references: remove live code, dependency, image and QEMU tooling, tests, docs, and all 31 current historical plans that name it. |
| How should a pre-existing hard-link alias inside the approved workspace be treated? | The workspace path wins. Treat it as workspace content; continue to block creation, rename, and symlink traversal from denied paths. |
| How should Git signing handle the configured unencrypted private key? | Expose that exact signing-key file read-only to the SRT tool plane; keep other SSH files and the SSH agent denied. |
| How should authenticated `gh` work after the SRT CA-masking probe failed? | Do no masking or token substitution. Expose secrets directly to the sandboxed tool process. |
| Which direct-secret scope should be used? | Tool environment secrets: pass secret-valued variables from the launching tool environment, while credential files, agent sockets, and Keychain remain denied except for the separately approved signing key and raw GitHub token. |
| Should operations use one long-lived sandboxed worker or separate SRT wrappers? | Use per-operation SRT wrappers; keep the trusted controller, network support, and Docker sidecar persistent. |

## Approach

Use a single hard cutover with no compatibility aliases or dual routing. First establish a zero-reference repository baseline. Then build and gate the new runtime from independently testable layers: pinned native prerequisites, trusted controller and SRT executors, host-native tool behavior, private Docker transport, permissions and settings, and finally cross-extension integration and deployment.

### Part A — Purge the retired backend before replacement work
- **Ledger:** {"status":"completed","note":"Removed VM-era controller, image, ingress, CLI, extension, dependencies, tests, and 30 historical documents; retained only backend-neutral primitives. Replaced launcher and cross-extension namespace so no normal launcher path can start the removed runtime.","evidence":"Source-boundary scan excluding .git, nested worktree, and generated node_modules returned zero case-insensitive Gondolin/PiVM references and zero retired-name filenames; QEMU/package/lock implementation artifacts removed."}

Delete the complete VM-era implementation and every repository artifact coupled to it: controller and guest code, routing extension, image/rootfs builder, QEMU and mount patches, ingress and network policy, CLI and wrapper tests, dependency and lockfile entries, installer prerequisites, commands, documentation, and all 31 current plan documents containing the retired proper name, including the source plan. Remove stale generated dependency state through a clean package install rather than retaining an ignored package directory.

Update repository instructions, test-gate labels, cross-extension events, status types, child capability names, environment variables, cache names, and documentation to neutral SRT/tool-routing terminology. Do not leave deprecated aliases, migration shims, comments, or tests carrying the old namespace. Generic repository discovery, worktree identity, bounded framing, model-scope caching, audited tool schemas, and lifecycle patterns may be retained only where they are genuinely backend-neutral; VM/image/guest behavior must not be carried forward under a new name.

Before adding the replacement implementation, perform a case-insensitive working-tree content scan and a file-name scan for the retired proper name and require both to return empty. Preserve the approved neutral plan and all unrelated user changes listed in Context. This Part is complete only when the repository has a clean migration boundary and no normal launcher path remains that can start the old runtime.

### Part B — Establish pinned native compatibility gates
- **Ledger:** {"status":"completed","note":"Pinned and clean-installed SRT 0.0.74, added hash-verified workspace-write/direct-IP supplement, rebuilt the policy with controller/broker separation, and validated dedicated Docker Sandboxes prerequisites.","evidence":"npm --prefix pi/sandbox test: 14/14 pass; npm --prefix pi/sandbox run canary:srt passed Unix-socket and complete-workspace-write native canaries; node pi/sandbox/srt-compatibility-canary.mjs passed exact sbx/app/template disposable-sidecar compatibility canary."}

Rename the sandbox package to a neutral SRT runtime and pin `@anthropic-ai/sandbox-runtime` exactly at 0.0.74 in both manifest and lockfile. Install with lifecycle scripts disabled, then apply a checked-in, narrow patch that refuses unknown pre- or post-image hashes. The patch must:

- preserve and test `allowPty` plumbing;
- add an explicit canonical-root capability such as `allowCompleteWorkspaceWrites`, removing stock dangerous-write denies only under those complete roots;
- retain stock hook, repository-config, and other dangerous-write denies under caches and every additional read-write grant, including overlapping-root validation;
- add an explicit network option such as `network.allowUnrestrictedIp` that emits IP-only bind, inbound, and outbound rules without broad Unix-socket access; and
- update only the runtime/schema/type artifacts required by those behaviors, with generated-profile and native regression tests for every changed rule.

Rebuild the policy generator rather than extending the current prototype. Put `allowUnixSockets`, local binding, and related controls in SRT’s `network` object; allow only `/var/run/mDNSResponder` and the exact private Docker broker socket; keep the broker’s containing directory outside all write grants; and remove SRT-injected proxy variables when direct unrestricted IP mode is active. Native canaries must prove direct hostname and IP TCP, UDP, IPv4/IPv6 where available, local binding, PTY behavior, exact broker connection, denial of sibling and controller sockets, and denial of unlink/rebind/replacement of the broker path.

Validate Docker Sandboxes by exact version and commit, reviewed template digest, manual authentication state for the dedicated application, allow-all local policy, disabled SSH forwarding, empty MCP/skills/secret registries, and expected app settings. Never switch or mutate the user’s default Docker Sandboxes application. A disposable canary must create two concurrent shell sidecars, inspect their mounts and capabilities, exercise raw Docker `dial-stdio`, and remove them. Installer and upgrade paths must run the relevant hash/version/profile checks; any drift is a hard stop before the new launcher becomes usable.

### Part C — Build the trusted controller and per-operation SRT tool plane
- **Ledger:** {"status":"blocked","note":"Controller scaffold is present, but lease lifecycle, environment snapshot/redaction, staged helper framing, cancellation proof, and generation draining remain incomplete.","evidence":"npm --prefix pi/sandbox test passes 14/14 and controller/client syntax checks pass; no integrated controller invariant suite exists yet."}

Create one detached trusted controller per canonical workspace identity, using repository root plus canonical common Git directory where applicable. Store only private ownership metadata, leases, generation numbers, staged helper code, and sockets in mode-0700 controller directories; derive stable workspace keys without leaking paths in process names. Root Pi processes own leases across `/new`, `/resume`, `/fork`, and `/reload`; child clients inherit an opaque parent context and never start, adopt, or release a controller. Final root quit releases the lease, while crash expiry cleans stale clients. The Docker sidecar remains persistent independently of controller lifetime.

Expose a private, bounded, length-framed control protocol with request IDs, schema validation, output limits, cancellation, and explicit error codes. The controller must never evaluate a model command on the host. Each core operation launches either a fixed staged helper or `/bin/bash -lc` through `SandboxManager.wrapWithSandboxArgv(..., { commandId })`, with `shell: false` at the host spawn boundary and the canonical workspace as CWD. File helpers implement the exact Pi read/write/edit/grep/find/list contracts inside SRT. Shell children receive their own process groups; cancellation escalates TERM to KILL, waits for descendants, and fails closed if cleanup cannot be proven. SRT violation events are correlated by the unique command ID and bounded before being returned or converted into a permission request.

Build an immutable policy snapshot for each generation. Deny the real home and user-data roots by default, then re-allow only the complete canonical workspace, linked-worktree common directory when required, generated HOME/temp/cache roots, exact reviewed host configuration files, canonical toolchain roots, the exact signing key, and explicit grants. Writes are allow-only: complete writes for workspace/common roots, ordinary guarded writes for caches and external read-write grants, and no write access to controller or broker state. Staged helper code is exact read-only input. System and toolchain data remain readable but not writable. The dotfiles workspace exception follows naturally from its canonical workspace grant and must be called out in status and documentation.

Capture a bounded execution-environment snapshot per root client and keep it only in controller memory. Tool commands inherit that environment wholesale, including secret-valued variables, except for boundary-integrity overrides: generated `HOME`/temp/cache locations, SRT internals, controller capabilities, `SSH_AUTH_SOCK`, Docker/SBX control variables, and host Docker endpoints. Child clients reference the parent snapshot rather than carrying secrets in host-process environment variables. Add the raw GitHub token to this snapshot through one fixed, canonical `gh auth token --hostname github.com` host spawn. Never mask, substitute, write, echo, or include secret values in diagnostics.

A policy change drains in-flight operations, increments the generation, updates SRT, and resumes new requests; already running Seatbelt processes never gain broader access. Warm controller attachment and SRT readiness must remain below one second, with the measured per-operation process cost tracked as a regression metric. Any initialization or inventory failure leaves native core tools disabled and blocks agent input and user shell commands.

### Part D — Restore Pi’s host-native tool behavior without host fallback
- **Ledger:** {"status":"blocked","note":"Blocked by Part C: activating routed built-ins before complete controller guarantees would violate the fail-closed boundary.","evidence":"Part C lacks its required integrated operation and cancellation validation."}

Create a neutrally named routing extension that disables Pi’s native core tools at launch, registers audited replacements under the exact built-in names, and activates them only after controller readiness and inventory verification. Override `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash`, preserving current parameter schemas, validation, image handling, truncation, rendering, streaming, cancellation, and error semantics. Intercept both `!` and `!!` through controller-backed user Bash operations. A global `tool_call` gate must allow only the verified replacements and host adapters whose name, source/package identity, version, and schema match the checked-in manifest; unknown or shadowed tools terminate the turn. There is no host-built-in bypass flag.

Generate a minimal private HOME instead of exposing broad host configuration directories. Resolve Git include origins and related safe files with fixed canonical host spawns, copy or expose only the exact inputs needed by Git, GH, UV, and the selected shell behavior, and use a fixed PATH assembled from reviewed executable roots. Do not expose GH host credential storage or Keychain. Set the raw `GH_TOKEN` in the tool environment and configure Git’s normal GitHub credential path to use `gh auth git-credential`, without writing the token. Expose the configured signing key exactly read-only so signed commits and tags work; verify that every sibling private key and agent socket remains inaccessible. Parent environment secrets intentionally remain visible to commands, but values must be redacted from status, protocol errors, tests, and retained output paths.

Keep Ketch and the other already audited non-core adapters host-side. Preserve plan-mode mutation classification before routed planning Bash, and keep every model-directed file or shell path inside SRT even when invoked from a host adapter, subagent, or discussion child.

### Part E — Add one persistent private Docker sidecar per workspace
- **Ledger:** {"status":"blocked","note":"Blocked by Part C: a persistent sidecar cannot be accepted without validated controller ownership and lifecycle semantics.","evidence":"Only the independent Docker Sandboxes compatibility canary has passed; controller-side ownership integration is incomplete."}

Create or attach a deterministic Docker Sandbox sidecar keyed by the same canonical workspace identity. Pin the shell template by digest, mount only the canonical workspace read-write and the bare common directory when needed, and create it without host Docker configuration, Docker socket, SSH agent, Pi/provider auth, secrets, skills, kits, host MCP registrations, or published ports. Additional SRT filesystem grants do not automatically become sidecar mounts; expose extra sidecar paths only through a separate explicit persistent Docker-mount setting whose read-only/read-write semantics and recreation warning are clear. Treat a sidecar read-write mount as complete access to that mounted root.

Expose Docker Engine only through a mode-0600 broker socket in a non-writable private directory. For each client stream, the trusted controller runs fixed `sbx --app-name pi-srt exec -i <validated-name> docker system dial-stdio` arguments under a sanitized fixed environment and byte-splices stdin/stdout without parsing or buffering the Engine protocol. Set `DOCKER_HOST` only to this broker inside tool-command environments; remove Docker contexts, TLS variables, host sockets, and SBX controls. Preserve half-close, upgrade, hijack, cancellation, BuildKit session, and parallel-stream semantics, and bound only diagnostic stderr.

Persist ownership metadata containing canonical identity, sidecar ID, template digest, resources, mount set, and generation digest. Refuse attach/reset/delete on any mismatch. CPU, memory, and Docker-volume size are validated settings; use the dedicated one-sandbox Docker-volume override at creation, and mark changes as recreate-required. `/sandbox reset` destroys only the validated owned sidecar and recreates it on demand. Docker layers, images, containers, and volumes survive ordinary Pi/controller exits.

Keep host ingress absent by default. Manage exposure only through validated `sbx ports` calls owned by the controller, allow loopback bindings only, persist named workspace profiles, reconcile add/remove operations, and display the exact mappings. `docker compose up` must otherwise expose ports only inside the sidecar. The sidecar never automatically receives the raw tool environment, although a model that can read those variables may explicitly pass them to Docker; this follows the accepted secret-exposure risk.

### Part F — Implement canonical permissions, persistent settings, and user controls
- **Ledger:** {"status":"blocked","note":"Blocked by Parts C and D: permission scopes must be applied through completed generation draining and routed preflight.","evidence":"Existing broker unit code is not integrated with the incomplete controller."}

Centralize permission decisions in the controller so concurrent Pi clients cannot race prompts or policy generations. Canonicalize existing paths with `realpath`; for missing write targets, resolve the nearest existing ancestor and reject symlink traversal, control-state overlap, whole-home/root grants, credential roots, Docker/SBX sockets, and malformed requests. Coalesce identical pending requests and serialize all others. Explicit file-tool preflight requests may prompt before execution; an attributable native Bash denial may offer a user-approved retry. Ambiguous violations never prompt or widen policy.

Support exactly three scopes: once, session, and persistent. A once grant applies to one retried operation and is removed in the next drained generation; a session grant remains only in controller memory; a persistent grant is atomically saved under a lock to the resolved Stow source and revalidated on every load. Esc, timeout, client disconnect, shutdown, malformed choices, non-UI clients, and prompt errors all deny without retry. Only trusted TUI contexts use `ctx.ui.select`; RPC/print/subagent/discussion contexts fail closed unless an existing session or persistent grant already covers the path.

Replace the settings schema with the minimum SRT-era model: additional tool-plane paths, explicit extra sidecar mounts, workspace-keyed loopback port profiles, and CPU/memory/Docker-volume defaults or overrides. Remove destination network modes, VM resource fields, write-protection exceptions that no longer match the new policy, and all obsolete names. `/sandbox` must show controller/policy health, canonical roots, exact exposed signing key, names (not values) of forwarded secret variables, sidecar identity/resources/template/mounts, Docker broker health, grants by scope, pending recreation, and loopback ports. It must support validated grant removal, resource changes, port reconciliation, sidecar reset, and policy restart without exposing a generic command runner.

Emit a typed neutral lifecycle event for status consumers after every meaningful transition. Health, pending restart/recreate, generation, attached roots, and sidecar/broker state must come from controller truth rather than prose or terminal scraping.

### Part G — Migrate children, cross-extension contracts, tests, and documentation
- **Ledger:** {"status":"blocked","note":"Blocked by Parts C–F: child capability inheritance and documentation cannot truthfully describe an incomplete controller and routing contract.","evidence":"Only neutral namespace migration and the repository credential-forwarding rule were applied."}

Update plan mode, status bar, subagent spawning, and ask-user-question discussions to use neutral capability pointers, events, and status types. Parent and child runtimes must share the same controller, policy generation, Docker sidecar, and root execution-environment context. Children cannot autostart a controller, gain native host built-ins, inherit Docker/SBX/SSH-agent control sockets, prompt without UI, or release the parent lease. Preserve child tool partitioning and audited host-adapter schema checks.

Rewrite the sandbox README and Pi development instructions around the SRT tool plane, direct environment-secret exposure, path-based workspace boundary, exact signing-key exception, private Docker sidecar, dedicated app prerequisite, permission scopes, reset/recreate semantics, loopback ingress, and fail-closed troubleshooting. Add a Pi-scoped accepted ADR for “host Pi plus per-operation SRT tools and a persistent private Docker sidecar,” including rejected VM, all-in-sidecar, host-built-in, token-masking, broad Docker-socket, and long-lived sandbox-worker alternatives. No `CONTEXT.md` is warranted because this repository has no domain-model context document and the change is architectural rather than domain terminology.

Record the user correction in repository `AGENTS.md` as a concrete prevention rule: Pi SRT routing must not add proxy-side credential masking or token substitution; tool environment secrets are forwarded directly while credential files and control sockets remain denied unless explicitly approved. Do not modify `pi/agent/AGENTS.md`, which is the runtime system prompt.

Rename and rebuild the deterministic and native test suites around the new contracts. Remove all obsolete tests instead of translating VM/image assertions mechanically. Keep the approved neutral plan in the implementation commit, and do not stage or rewrite unrelated worktree changes.

### Part H — Deploy the cutover through Stow and fail closed
- **Ledger:** {"status":"blocked","note":"Blocked by Parts C–G: deployment would expose an incomplete fail-closed runtime.","evidence":"npm --prefix pi run check:deterministic was rerun; plan-mode passed but the initial run exposed and removed obsolete host-bypass test arguments. Full end-to-end gate has not passed."}

Update `install.sh` to remove QEMU/image dependencies and to perform the exact npm install, reviewed patch, SRT native profile check, dedicated Docker Sandboxes app preflight, and checked-in compatibility canary required by this runtime. On unsupported platforms, stop with a clear message rather than claiming isolation. On macOS, install only through `./install.sh config`; do not create manual links or copies.

The launcher must resolve and exec the real Pi binary without recursion, establish or attach the controller, pass only host capability pointers to Pi, start with native core tools disabled, and permit trusted UI startup only while all model input and shell/tool execution remain behind the readiness gate. Version, patch, policy, sidecar, inventory, or handshake drift must produce an actionable fail-closed error. Do not resurrect a compatibility path if deployment fails.

Review the final diff for scope, stale names, dead imports, generated artifacts, permissions, and unrelated worktree changes before committing. The plan document and implementation belong in the same commit; generated dependency directories and machine-local controller/sidecar state do not.

## Critical Files

- `bin/pi` and `install.sh` — normal-launch fail-closed boundary, real-Pi resolution, dependency setup, native preflight, and Stow deployment.
- `pi/sandbox/` — pinned SRT patch, canonical policy, controller/protocol, fixed operation helpers, repository identity, settings, Docker sidecar ownership, broker, and native canaries.
- `pi/agent/extensions/srt-tool-routing/` — audited built-in replacements, inventory gate, controller client, permission UI, `/sandbox`, lifecycle events, and host-adapter manifest.
- `pi/agent/extensions/statusbar.ts`, `pi/agent/extensions/plan-mode/`, `pi/agent/extensions/subagent/`, and `pi/agent/packages/ask-user-question/` — trusted cross-extension and child-runtime integration boundaries.
- `pi/package.json`, `pi/test-gate.mjs`, and `pi/sandbox/package.json` — deterministic/native verification orchestration and exact dependency contract.
- `AGENTS.md`, `pi/AGENTS.md`, `pi/sandbox/README.md`, and the new Pi ADR — repository correction lesson, development invariants, operator contract, and architectural rationale.
- `.pi/plans/` — deletion boundary for the 31 named historical plans and home of this neutral approved implementation plan.

## Verification

**Regression checks**

- Run focused unit tests while building each layer, then run `npm --prefix pi run check:deterministic`. It must cover repository/worktree identity, protocol bounds, patch pre/post hashes, profile rendering, tool schemas/rendering, inventory rejection, permission serialization and persistence, environment redaction, settings locking, sidecar ownership, broker stream behavior, status composition, plan-mode gating, and child capability inheritance.
- Run `git diff --check`, inspect every changed/deleted path, and confirm the unrelated worktree changes listed in Context are byte-for-byte untouched.
- Perform case-insensitive content and filename scans for the retired proper name across the working tree (excluding `.git` history). Both must return zero; the old package must also be absent from the clean npm dependency tree and generated install state.

**New native scenarios**

- Run the patched SRT canary against generated and native profiles: complete workspace writes including hooks/config; retained dangerous-write denial in an external read-write grant; outside-home read denial; exact signing-key read with sibling-key denial; symlink and outside hard-link/rename denial; accepted pre-existing workspace hard-link behavior; PTY; direct DNS/IP TCP and UDP; IPv4/IPv6 where available; local binding; exact DNS and Docker Unix sockets; and denied sibling/controller/socket unlink/rebind attempts.
- Exercise every core tool and `!`/`!!` through an installed normal launcher in a disposable workspace. Prove native host tools are absent, unknown adapters terminate, image/binary reads and truncation match Pi, denied Bash operations are attributed, cancellation leaves no descendants, non-UI permissions fail closed, and once/session/persistent grants have the promised lifetimes.
- Use synthetic environment secrets to prove per-client forwarding, child-context reuse, boundary-variable removal, and value redaction. With the real approved configuration, verify `gh auth status` or a bounded authenticated API call, Git HTTPS credentials through `gh auth git-credential`, and a signed disposable commit/tag. No test output may print the token or private-key contents.
- Run the exact Docker Sandboxes compatibility canary, then use the private broker for Engine `_ping`, pull/run, BuildKit build, Compose lifecycle, log follow, exec/attach, cancellation, and parallel streams. Prove two workspaces get distinct sidecars, a second Pi root shares the correct sidecar, state survives controller exit, attach reaches trusted Pi readiness within one second, and reset affects only the validated owned sidecar.
- From inside both SRT and the sidecar, prove that controller state, host Docker/SBX controls, unrelated home files, Keychain, SSH agent, other private keys, provider auth files, and outside-workspace paths are unavailable. Prove that no sidecar host port exists by default, an approved mapping binds loopback only and persists, and removing the profile removes the host listener.
- Run production-shaped plan-mode, subagent, and discussion-child cases to prove all routed operations remain on the parent controller and sidecar, mutation checks run before planning Bash, children cannot autostart or bypass routing, and lifecycle status composes through the real status bar.

**Full gate and failure signals**

- Run `./install.sh config`, then `npm --prefix pi run check` from an ordinary host terminal. The full gate must include the installed-launcher canary, SRT native checks, Docker app/template/capability inspection, tool-routing integration, child-runtime checks, live Git/GH checks, Docker Engine compatibility, and warm/cold startup timing.
- Treat any SRT hash/profile drift, direct-IP rule that broadens Unix sockets, broker-path mutation, unsupported platform, Docker Sandboxes version/commit drift, template or capability drift, non-empty dedicated-app registry, sidecar ownership mismatch, tool inventory mismatch, secret in diagnostics, host fallback, orphan process, or startup over the one-second readiness target as a failure. Stop the cutover and report the failed invariant; do not re-enable the retired backend.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Purge the retired backend before replacement work
- ☑ Establish pinned native compatibility gates
- ⛔ Build the trusted controller and per-operation SRT tool plane
- ⛔ Restore Pi’s host-native tool behavior without host fallback
- ⛔ Add one persistent private Docker sidecar per workspace
- ⛔ Implement canonical permissions, persistent settings, and user controls
- ⛔ Migrate children, cross-extension contracts, tests, and documentation
- ⛔ Deploy the cutover through Stow and fail closed
<!-- pi-plan-mode:progress:end -->
