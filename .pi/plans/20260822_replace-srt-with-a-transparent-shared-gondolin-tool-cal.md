# Replace SRT with a Shared Gondolin Tool Sandbox

## Context

The current boundary is implemented by `bin/pi` plus `pi/sandbox/`: the launcher discovers a trusted Git scope, composes an SRT policy, sanitizes Pi’s environment, starts the Herdr status broker, and runs Pi’s whole process tree under `@anthropic-ai/sandbox-runtime`. This protects extension subprocesses, but it also forces host Pi state and credentials into the same filesystem boundary as model-directed code. The replacement must invert that relationship: Pi and reviewed extensions stay trusted on the host; arbitrary model-directed file and process operations run in Gondolin.

Pi 0.84.2 provides the required integration points. Its official Gondolin example replaces the seven built-ins (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) through Pi’s operations interfaces and intercepts `user_bash`. Gondolin 0.12.0 provides QEMU isolation, `RealFSProvider`, `ReadonlyProvider`, `ShadowProvider`, host-mediated HTTP/TLS, and a Docker-capable Alpine image example using a guest-local daemon and the `vfs` storage driver. Pi documents that custom extension tools still run wherever host Pi runs, so tool routing must also include an audited host-tool gate; Gondolin alone does not cover Ketch, subagents, planning tools, or future custom tools.

The selected boundary is:

- **Host control plane:** Pi, auth/session/model logic, UI extensions, Herdr broker, Gondolin controller, and reviewed host adapters.
- **Guest tool plane:** all seven built-ins in normal mode, planning mode, staged plan execution, and child Pi processes, plus `!`/`!!` commands.
- **Audited host adapters:** Ketch’s five URL/search tools, `ask_user_question`, the local `subagent` orchestrator, and the narrow plan workflow tools that persist/advance the plan ledger. New custom tools are hidden and blocked until their name, source provenance, schema, and host effects are reviewed.

Plan mode currently selects inspection tools by name through `pi.setActiveTools()`. Its `read`, `grep`, `find`, `ls`, and `bash` names must therefore resolve to the Gondolin replacements in every planning and execution state. The existing known-mutator Bash gate remains a workflow check before execution; any Bash command it permits still runs in the VM. `submit_plan`, `plan_progress`, `complete_plan`, and `complete_stage` remain audited host adapters because they own the validated plan/ledger workflow and do not expose arbitrary path or shell input.

The mount policy preserves the intent of `pi/sandbox/settings.json`, not its SRT-specific syntax. The canonical Git root is read-write; a Git-verified external bare common directory is added only when required by a linked worktree; selected source/config paths are read-only; Linux caches and Docker state use private per-workspace host directories. Pi auth/state, Ketch state, private credential stores, the host Docker socket/config, and host platform caches are never mounted. Existing root-level write protections for Git hooks/config and execution/editor/agent configuration remain hard invariants and cannot be removed through the settings UI.

A single controller and VM are shared by concurrent Pi roots and child Pi processes for the same canonical workspace. This is required because two `dockerd` processes must not mount the same persistent `/var/lib/docker`. The controller is leased by root launchers, stops after the final lease expires, and retains only workspace-keyed Linux caches and Docker data. Other workspaces use different state directories.

Default guest networking is public HTTP/HTTPS with Gondolin’s internal-address and metadata protections. Offline and hostname-allowlist modes are available; WebSockets and explicit TCP mappings are opt-in. Ketch intentionally keeps host networking. Trusted host-adapter defects and exfiltration of guest-readable data to an allowed public endpoint remain accepted risks, as do QEMU escape and denial of service.

`pi-control`, `@gotgenes/pi-permission-system`, `pi-file-permissions`, and `pi-guardrails` are decision/prompt layers, not isolation boundaries; their coverage is partial or prompt-oriented. `pi-enclave` and `pi-gondolin-mount` are useful implementation references but do not provide the required custom-tool gate, shared Docker lifecycle, repository policy, or settings integration. Do not install any of them. Reuse only their useful patterns: Pi-native settings UI, source-aware tool inventory, same-path Gondolin mounts, and clear status reporting.

The repository has no domain glossary or ADR structure. Do not create ceremonial `CONTEXT.md` or ADR files for this change. Update the existing authoritative documents, `pi/AGENTS.md` and `pi/sandbox/README.md`, where the current whole-process claims already live.

## Questions & Answers

| Question | Answer |
|---|---|
| How should the current SRT filesystem policy translate into Gondolin mounts? | Preserve intent (Recommended). |
| Which model-callable tools may remain trusted host adapters? | Audited allowlist (Recommended). |
| How should on-the-fly sandbox changes persist? | Save immediately. |
| What lifecycle should the Docker daemon inside Gondolin use? | Persistent cache. |
| Persistent Docker state cannot be mounted by multiple dockerd instances safely; how should concurrent Pi sessions in the same workspace behave? | Shared workspace VM (Recommended). |

## Approach

Implement the replacement behind the existing `pi` command. Keep SRT operational while the Gondolin canary, controller, and extension are built; perform one final launcher cutover only after the new containment tests pass. The final runtime has three concrete layers: `bin/pi` acquires/releases a workspace lease, `pi/sandbox/` owns Gondolin and policy enforcement, and `pi/agent/extensions/gondolin-sandbox/` exposes only sandbox-backed model tools.

### Part A — Prove the pinned guest and persistent Docker design
- **Ledger:** {"status":"completed","note":"Pinned Gondolin 0.12.0 alongside active SRT; added digest-addressed Alpine image builder, guest-local Docker/VFS persistence init, verified RTK, prerequisites, and native canary. Normal `pi` remains on SRT.","evidence":"macOS arm64: `npm --prefix pi/sandbox run test:gondolin-canary` passed twice (35.18s and 34.54s), each recreating the VM and proving persisted image/container/volume state; `build-gondolin-image.mjs --verify --quiet`, Node syntax checks, `git diff --check`, and existing `test:wrapper` passed. Image digest fccc42cbb3d06a86649ffc226415c7bf4b8d5e8374c17bf600f118324bcaea99; Gondolin buildId 929d8f69-13b7-55c2-a761-141b14281b16."}

Add Gondolin 0.12.0 alongside the still-active SRT dependency in `pi/sandbox/package.json` and lockfile. Add `pi/sandbox/image/docker.json` and its init-extra script by adapting Gondolin’s official Docker example for the host architecture. Include only the tools required for current Pi behavior: Bash, certificates, Git/OpenSSH client, ripgrep/fd, Node/npm, Python/UV, Docker/Compose/BuildKit, and a tested Linux RTK binary. Build assets into a digest-named directory under `~/.cache/pi-gondolin/images/`; the digest covers Gondolin version, architecture, image config, and init script. Verify the generated Gondolin manifest and checksums before use.

Create `test-gondolin-canary.mjs` as the first executable gate. It must start the pinned image with:

- the fixture workspace mounted at the same absolute path with `RealFSProvider`;
- a read-only fixture through `ReadonlyProvider`;
- a private fixture directory mounted at `/var/lib/docker`; and
- public HTTP hooks with internal-range blocking.

The canary proves workspace read/write, read-only rejection, escaping and dangling symlink rejection, outside-path denial, public HTTPS, blocked loopback/private/metadata destinations, and Docker pull/build/run/Compose from inside the VM. It then closes and recreates the VM and proves Docker images, containers, and volumes persisted in the host-backed store. It also attempts privileged-container bind mounts of outside-host canaries and verifies that neither the host Docker socket nor host Docker config is visible.

Update the macOS software list in `install.sh` with `qemu`, `lz4`, and `e2fsprogs`; document `cpio` and the corresponding Linux QEMU/image-build prerequisites without adding a root-requiring Linux bootstrap. Do not remove SRT or change normal `pi` yet. If nested Docker, VFS persistence, or containment fails on macOS arm64, stop and revise the design; never substitute the host Docker socket.

Acceptance outcome: the checked-in canary passes twice against the pinned image and demonstrates the exact filesystem, network, and Docker primitives required by later parts while the existing launcher remains usable.

### Part B — Implement the trusted policy and shared controller
- **Ledger:** {"status":"completed","note":"Added shared repository discovery, versioned Gondolin settings/policy, protected VFS providers, authenticated bounded RPC/client, and a workspace-keyed leased controller with serialized execution and fail-closed restarts. Kept SRT operational on a temporary legacy policy until launcher cutover.","evidence":"`test:controller` 18/18; repository module + legacy repository tests 10/10 combined; wrapper passed; legacy native containment and repository containment passed. `test:controller-native` passed on macOS arm64 with two simultaneous root clients sharing one QEMU VM/Docker daemon, VFS RPC, cancellation-forced VM restart, offline policy-generation restart/convergence, and final-lease shutdown (5.36s). Syntax and diff checks passed."}

Replace the SRT-shaped settings with a versioned Gondolin schema only after adding a parser that can be tested independently. The new `pi/sandbox/settings.json` contains user-editable read-only/read-write external mounts and network mode/allowlists. Workspace discovery, protected paths, controller state, Docker state, and credential exclusions remain code-enforced invariants rather than editable grants. Mount destinations equal canonical host paths; reject relative paths, missing paths, `/`, home-wide mounts, overlaps with Pi/controller/Docker/credential roots, custom guest destinations, and ambiguous symlink aliases.

Extract the existing trusted repository discovery from `bin/pi` into `pi/sandbox/repository-scope.mjs` so the launcher, controller, and tests use one implementation. Preserve its current behavior for nested launches, trusted executable lookup, normal worktrees, verified bare common directories, malformed metadata, and repository-local bootstrap shims. Return a small immutable object: physical launch directory, canonical workspace root, optional bare common directory, and workspace key.

Add these runtime modules under `pi/sandbox/`:

- `policy.mjs` validates settings, expands `~`, builds same-path mount providers, maps private per-workspace Linux caches, and wraps the workspace in a write-deny provider for protected paths. The wrapper checks every mutating operation, both endpoints of link/rename operations, and lexical plus resolved targets before delegating to `RealFSProvider`.
- `controller.mjs` owns the Gondolin `VM`, guest Docker health, execution queue, VFS calls, settings generation, and shutdown.
- `protocol.mjs` defines a versioned, length-bounded Unix-socket protocol for leases, status, the six filesystem operation shapes required by Pi, streamed guest execution, cancellation, reload, and restart.
- `client.mjs` exposes those protocol methods to the launcher and extension without importing Gondolin.

Store controller sockets/locks under a short user-private runtime directory and persistent data under `~/.cache/pi-gondolin/workspaces/<workspace-key>/`. Startup uses an exclusive lock plus a validated manifest to resolve races and stale sockets. Every root launcher receives its own random lease token and heartbeat; child Pi processes inherit that lease. The controller closes the VM only after all root leases are released or expire. A policy/image generation mismatch blocks new operations, drains active execution, restarts the VM, and then admits queued calls.

Use one persistent connection per Pi process. Authenticate every request, cap frames and buffered output, validate method-specific arguments, and never expose arbitrary host process execution, host path discovery, mount mutation, raw Gondolin objects, or controller file access. Serialize `vm.exec` calls. On timeout or cancellation, abort the call; if termination cannot be confirmed within a bounded grace period, restart the VM before completing the cancellation so no unknown guest process survives.

Acceptance outcome: controller unit/integration tests prove startup races, lease sharing/expiry, stale recovery, policy generation changes, protocol validation, execution serialization, cancellation, and one shared VM/Docker daemon across two clients without involving Pi.

### Part C — Register sandbox-backed tools and enforce the host adapter audit
- **Ledger:** {"status":"completed","note":"Registered all seven controller-backed Pi replacements; added source/schema/version-audited host adapters, fail-closed inventory enforcement, plan-mode composition/preflight, and hardened subagent/discussion capability inheritance. Pi 0.84.2 filters extension replacements through `--tools`, so children securely use `--no-builtin-tools` plus private post-handshake built-in/host allowlists instead of an unsafe CLI allowlist.","evidence":"Gondolin extension + subagent suites: 39/39; plan-mode: 139/139 plus integration; AskUserQuestion discussion tests and typecheck passed (full package earlier: 593/593). Native seven-tool suite passed through one real VM (4.26s). Production-shaped normal/planning child suite passed with shared parent VM, pinned Ketch + all audited host schemas, injected unknown tool removal, and bad-lease fail-closed behavior (6.64s). Wrapper/yolo and diff checks passed."}

Create `pi/agent/extensions/gondolin-sandbox/` with a synchronous `index.ts` that imports only `client.mjs`; a missing Gondolin package must not prevent the guard and replacement tools from registering. Adapt Pi’s official example rather than rewriting tool schemas/renderers:

- `tools.ts` creates `read`, `write`, `edit`, `ls`, and their required operations over controller VFS RPC.
- `grep` and `find` keep Pi’s input/output/truncation contracts but execute argument-vector `rg`/`fd` commands in the guest instead of recursively round-tripping every file over RPC.
- `bash` uses `createBashTool` with streamed controller execution and sanitized guest environment.
- `user_bash` returns the same Bash operations so both `!` and `!!` use Gondolin.

Use the physical host CWD as the tool base and preserve absolute paths; the guest has the same mount paths, so no `/workspace` translation appears in prompts or results. Strip controller/Herdr/provider/session credentials and host cache variables from the environment passed to the guest. Supply only guest-safe terminal/locale variables plus the fixed Linux cache variables. Verify that RTK’s trusted host rewrite hook still rewrites the command but that the resulting `rtk` process runs from the guest image.

Add `host-adapters.ts` with the only model-callable host exceptions:

- `ketch_search`, `ketch_scrape`, `ketch_code`, `ketch_docs`, and `ketch_crawl` from the pinned `pi-ketch` package;
- `ask_user_question` from the local package;
- `subagent` from the local extension; and
- `submit_plan`, `plan_progress`, `complete_plan`, and `complete_stage` from local plan mode.

Match both name and `sourceInfo`, and test the expected model-facing schemas/host effects. On `session_start` and `before_agent_start`, inspect `pi.getAllTools()`, remove active unaudited custom tools, and verify that each built-in name resolves to this extension. A `tool_call` handler blocks any call whose current provenance is not the replacement or audited manifest. The manifest is source code, not a setting; adding a host tool requires a reviewed code/test change and cannot be done from `/sandbox`.

Add explicit plan-mode composition coverage. `getPlanningToolNames()` may continue selecting by name, but after every `applyPlanningGate()`, execution-tool transition, and original-tool restore, the source-aware Gondolin guard must verify that `read`, `grep`, `find`, `ls`, and `bash` still resolve to this extension. Keep the plan-mode known-mutator Bash handler ahead of execution: a known mutation is rejected without an RPC; an allowed or unclassified planning Bash command is sent to Gondolin and remains subject to the mount/network policy. Planning `read`/search calls use the same controller and VM ID as normal mode. The four plan workflow tools remain the only planning host adapters.

Harden child launch instead of relying on inherited tool names alone. In both the local subagent runtime and AskUserQuestion discussion runtime:

- split inherited tools into Gondolin built-in names and audited host-adapter names;
- always start real child Pi with native built-ins disabled;
- pass only audited host-adapter names through the child CLI allowlist;
- pass requested built-in names in a private host environment field; and
- let the child’s Gondolin extension activate those replacement names only after it connects to the inherited parent-workspace controller and validates the policy generation.

If the child extension is absent or its handshake fails, no native `read`/`bash`/other built-in becomes active. Production-shaped tests must start normal and planning children with `read`, `bash`, search tools, and an audited host tool; prove the built-ins use the parent VM ID and policy; prove plan-mode known mutations are blocked before controller execution; and prove an injected unknown child tool is blocked.

Acceptance outcome: extension tests preserve Pi’s built-in tool contracts; normal mode, planning mode, staged plan execution, `!`, discussion children, and subagents all use the same Gondolin policy/controller; Ketch and narrow workflow tools remain audited host adapters; and unknown or source-spoofed tools cannot execute.

### Part D — Cut `bin/pi` over without weakening startup
- **Ledger:** {"status":"completed","note":"Cut `bin/pi` to Gondolin leases and fail-closed extension readiness. Native built-ins are always disabled; CLI tool/exclusion flags are normalized into private post-handshake capabilities because Pi's global `--tools` filter cannot safely distinguish replacements from native slots. Restored the tracked Herdr broker transport required by project invariants.","evidence":"Rewritten fake-controller wrapper suite passed: CWD/PATH/quoting/model defaults, explicit/no tools, lease acquire/release, Herdr capability, signals, missing QEMU/image/controller/Pi, handshake exit/timeout/mismatch, rejected --no-extensions, and unchanged --yolo. Herdr broker/composed suite 16/16. Live normal `pi --version`, `--list-models`, print-session handshake, explicit `--tools read,ketch_search`, `--no-tools`, `--no-builtin-tools`, and `--plan` source inventory all passed; no controller remained after exit. Bash syntax and diff checks passed."}

Refactor `bin/pi` around the shared `repository-scope.mjs` result. Preserve safe real-Pi/Node/Git lookup, model filtering/default injection, launch-directory restoration, safe PATH ordering, argument quoting, Herdr status broker behavior, signal handling, and the current `--yolo` semantics. Remove only the SRT-specific policy composition and platform checks.

For a normal launch:

1. Validate Node >=23.6, QEMU, the pinned image, settings, controller/client files, and routing extension source.
2. Acquire a controller lease and validate the returned workspace, image, policy generation, VM ID, and Docker health.
3. Normalize any user `--tools` allowlist: remove built-in names from Pi’s CLI argument, preserve audited custom-tool names, and pass requested built-ins privately to the Gondolin extension. Start Pi with native built-ins disabled and reject `--no-extensions` in sandboxed mode.
4. Pass the socket, lease token, workspace identity, policy generation, and requested replacement names only to trusted host Pi. The extension activates built-in names only after controller validation; CLI filtering must never reactivate a native built-in.
5. Require the extension’s `session_start` handshake before treating the launch as ready. If the extension cannot prove its seven replacement tools and controller connection, terminate the session rather than exposing native or child built-ins.
6. Release the lease and Herdr broker on every normal exit, signal, and startup failure.

Keep `--yolo` as an early explicit bypass: it skips Gondolin prerequisites/controller/environment filtering, prints the warning, removes the flag, and directly launches real Pi exactly as today. It is the only supported way to obtain host built-ins. A controller, extension, or Docker startup failure never retries with host tools.

Rewrite `test-wrapper.sh` to use a fake controller/client instead of fake SRT. Preserve all existing assertions for repository-local shims, PATH precedence, model arguments/defaults, environment filtering, Herdr capability/cleanup, quoting, launch CWD, and missing real Pi. Add assertions for native-built-in suppression, explicit `--tools` splitting, controller lease/release, extension handshake timeout, rejected `--no-extensions`, missing QEMU/image/controller, and unchanged `--yolo` bypass.

Acceptance outcome: normal `pi` starts only after the Gondolin tool boundary is ready, all existing launcher/model/Herdr behavior remains covered, and every initialization failure is demonstrably fail-closed for root, planning, and child tool sets.

### Part E — Add `/sandbox` settings and shared status
- **Ledger:** {"status":"completed","note":"Added `/sandbox` SettingsList UI, canonical Stow-source settings store with atomic cross-process locking, coordinated reload/restart and workspace-local Docker reset, typed lifecycle events, direct `setStatus`, and the custom statusbar consumer.","evidence":"Gondolin extension/settings/status composed suite 15/15; controller/protocol/policy suite 19/19 including Docker reset. Native two-client controller integration passed settings reload without caller-computed generation, session convergence, real VM restart, and workspace-local Docker reset (9.60s). Wrapper and Herdr composed suites passed; live normal print handshake still passed. Atomic store tests proved canonical mount rejection, mode/symlink preservation, serialized complete writes, and unchanged bytes on invalid policy."}

Add `settings-store.ts`, `settings-view.ts`, and `events.ts` to the Gondolin extension. `/sandbox` opens a Pi `SettingsList`-based view showing:

- controller/VM/Docker health and attached root count;
- effective workspace, bare-common, external, cache, and Docker mounts with `ro`/`rw` labels;
- network mode (`public-http`, `allowlist`, or `offline`), allowed hosts, WebSocket state, and explicit TCP mappings; and
- current policy/image generations and pending restart state.

Provide user-only actions to add/remove an external mount, change its access mode, edit network settings, restart the VM, and reset the current workspace’s Docker state. Canonicalize and validate a mount before showing it as saved. Do not expose control-plane exclusions, host-adapter allowlisting, Docker state roots, image/setup hooks, or arbitrary guest mount destinations as UI settings.

Each accepted change writes the complete validated `pi/sandbox/settings.json` immediately. Reuse the repository’s `settings-defaults.ts` persistence pattern: serialize writes, `realpathSync` the Stow target, preserve mode, write a sibling temporary file, and atomically rename. Then send the new generation to the controller. Restart-requiring changes drain active commands and restart once; attached sessions wait and receive the new generation. Docker reset requires one explicit destructive confirmation and deletes only the current workspace’s Docker directory after its VM stops.

Emit a typed sandbox lifecycle event. Update `statusbar.ts` to consume that event and render a compact healthy/starting/restarting/failed marker; keep detailed state in `/sandbox`. Also call `ctx.ui.setStatus` for environments not using the custom footer. Add the required composed producer/consumer test rather than mocking mutable UI internals.

Acceptance outcome: settings changes persist to the Stow source immediately, all attached sessions converge after one coordinated restart, Docker reset is workspace-local, the footer reports real controller state, and normal tool use produces no approval prompts.

### Part F — Remove SRT and replace the old containment suite
- **Ledger:** {"status":"completed","note":"Removed SRT source, dependency, fixtures, policy, installer path, and whole-process claims. Consolidated Gondolin tests, pinned Ketch, updated child smoke tests for explicit yolo, rewrote docs/invariants, and verified Stow/image idempotence.","evidence":"Final active-source searches found no @anthropic-ai/sandbox-runtime, SandboxManager, unrestricted-network.mjs, SRT, or whole-process claim. `npm --prefix pi/sandbox test` passed. Final `test:native` passed canary (35.52s), real two-client restart/reset (7.75s), seven tools (2.60s), production normal/planning child inventory (5.61s), and live Ketch. Plan-mode check, subagent 29/29, AskUserQuestion 593/593 + typecheck, Git checkpoints 33/33 + smoke, and fzf 7/7 + smoke passed. `./install.sh config` passed twice with identical lock/settings/image and Stow targets. Syntax, diff, manifest, and checksum checks passed."}

After Parts A–E pass, remove `@anthropic-ai/sandbox-runtime`, `unrestricted-network.mjs`, SRT bootstrap code, SRT fixtures, and retired ignored `pi/sandbox/node_modules` contents. Leave the exact Gondolin dependency and lockfile under `pi/sandbox/`. Update `install.sh config` to install it with `npm ci --omit=dev --ignore-scripts`, build/verify the digest-named guest image only when missing or stale, and report an actionable fail-closed state when QEMU or build prerequisites are unavailable. Continue all deployment through Stow; create no manual target symlinks.

Replace the current scripts rather than retaining misleading SRT names:

- repository-scope tests now assert the controller mount manifest and protected paths;
- containment tests invoke the real controller and all seven tool operations in normal, planning, staged-execution, and child sessions;
- Docker/network tests cover the guest and nested containers;
- wrapper, Ketch, Herdr broker, model-default, and composed Herdr tests retain their current responsibilities with Gondolin terminology; and
- a tool-inventory test proves the production package/resource set matches the audited adapter manifest.

Rewrite `pi/sandbox/README.md` with the final host/guest boundary, mount schema, image lifecycle, shared-controller/Docker behavior, network profiles, `/sandbox`, `--yolo`, prerequisites, reset/rebuild procedure, native test instructions, and accepted host-adapter risks. State explicitly that plan-mode inspection/Bash and every child built-in use Gondolin, while only the four plan workflow tools are host-resident. Replace the whole-process invariants in `pi/AGENTS.md` with the new fail-closed routing, source-audited host-tool, no-host-Docker-socket, shared-controller, child/planning inheritance, Stow-save, and composed-status invariants. Do not modify runtime `pi/agent/AGENTS.md`.

Acceptance outcome: current source, dependencies, installer logic, tests, and authoritative docs contain no active SRT path or whole-process confinement claim; `./install.sh config` is idempotent; and the replacement’s complete native suite passes before work is declared complete.

## Critical Files

- `bin/pi` — trusted launch, controller lease, model/Herdr compatibility, fail-closed activation, and `--yolo`.
- `pi/sandbox/package.json`, `settings.json`, and new runtime modules — pinned Gondolin runtime, policy, shared controller, protocol/client, image inputs, and native tests.
- `pi/agent/extensions/gondolin-sandbox/` — tool replacements, audited host-adapter gate, plan-mode composition, settings UI, and lifecycle event producer.
- `pi/agent/extensions/plan-mode/` — existing name-based planning gate, covered by source-aware Gondolin composition tests without replacing its workflow semantics.
- `pi/agent/extensions/subagent/` and `pi/agent/packages/ask-user-question/discussion/` — inherited child capability, built-in/custom tool splitting, and native-built-in fail-closed behavior.
- `pi/agent/extensions/statusbar.ts` — explicit sandbox lifecycle consumer.
- `install.sh`, `pi/sandbox/README.md`, and `pi/AGENTS.md` — prerequisites/deployment and replacement of the current whole-process contract.

## Verification

**Regression checks**

- Run the existing Herdr broker/agent-state, model routing/defaults, plan-mode, AskUserQuestion, subagent, Ketch, Git checkpoint, and extension smoke suites after adapting only sandbox assumptions.
- Compare normal launcher fixtures before and after for CWD, PATH precedence, explicit model/thinking/tool flags, `--plan`, `--list-models`, environment filtering, Herdr lifecycle, signals, and `--yolo`.
- Run `./install.sh config` twice and verify identical Stow targets, dependency lock, image digest, settings formatting, and no manual symlinks.

**New boundary scenarios**

- Exercise each built-in and `!`/`!!` in normal mode, planning mode, staged plan execution, a subagent, and a discussion child against writable workspace, read-only external, unmounted outside, credential, Pi state, policy/control-plane, symlink, hard-link, rename, normal-worktree, and bare-linked-worktree fixtures.
- In plan mode, assert `read`/search report the shared Gondolin VM ID, a known-mutating Bash command is blocked with zero controller calls, and a permitted/unclassified Bash command reaches the VM rather than host Bash. Repeat after plan approval, staged execution, completion, and original-tool restoration to catch source replacement regressions.
- Enumerate production `pi.getAllTools()` metadata. Require the seven Gondolin sources plus the exact audited host adapters; inject unknown and source-spoofed tools and prove both parent and child calls are blocked before execution.
- Launch children with inherited built-in names while native built-ins are available in real Pi. Prove CLI splitting leaves those native tools inactive, the extension activates only controller-backed replacements after handshake, and extension/handshake failure leaves the child without arbitrary file or shell tools.
- Launch two root Pi sessions and concurrent subagents in one workspace. Require one VM ID and Docker daemon, queued execution without corruption, lease recovery after process death, and final VM shutdown. Relaunch and prove workspace Docker images/containers/volumes persist; launch another workspace and prove isolation.
- From guest and privileged containers, prove `/var/run/docker.sock` is guest-local, host Docker config/socket and outside mounts are absent, and workspace bind mounts cannot escape Gondolin providers.
- Test public HTTP/HTTPS, redirects, DNS rebinding protection, blocked loopback/RFC1918/link-local/metadata targets, offline mode, hostname allowlist, WebSocket toggle, and explicit TCP mappings from both guest and containers. Confirm Ketch remains intentionally host-networked.
- Exercise settings validation, concurrent atomic saves through the Stow path, immediate generation changes, draining restart, forced failure, Docker reset, status event composition, and malformed-policy fail-closed behavior.

**Completion signals**

- The macOS-arm64 native canary and full controller/tool/Docker/network suite pass from outside the retired SRT boundary; Linux support is claimed only after the same QEMU/KVM suite passes there.
- Missing QEMU, missing/corrupt image, malformed settings, controller crash, routing-extension failure, unknown custom tool, unconfirmed guest cancellation, planning-tool source mismatch, or child handshake failure always disables tools or terminates the normal session; none invokes a host built-in.
- A final search of active source and authoritative docs finds no `@anthropic-ai/sandbox-runtime`, `SandboxManager`, `unrestricted-network.mjs`, SRT policy composition, or claim that host Pi is sandboxed. Historical plan/session artifacts are excluded from this check.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Prove the pinned guest and persistent Docker design
- ☑ Implement the trusted policy and shared controller
- ☑ Register sandbox-backed tools and enforce the host adapter audit
- ☑ Cut `bin/pi` over without weakening startup
- ☑ Add `/sandbox` settings and shared status
- ☑ Remove SRT and replace the old containment suite
<!-- pi-plan-mode:progress:end -->
