# Add a Hybrid vmpi Command with Pi’s Gondolin Routing

## Context

Pi 0.84.2 does **not** have a built-in sandbox. Its security documentation explicitly says that extensions run with Pi’s user permissions and that real isolation must come from an OS, container, or VM boundary. Pi does, however, ship documented integration patterns for Gondolin tool routing, whole-process Docker, and NVIDIA OpenShell ([Pi security](https://pi.dev/docs/latest/security), [Pi containerization](https://pi.dev/docs/latest/containerization)). The useful integrated primitive is not a hidden sandbox switch; it is Pi’s pluggable tool-operations API (`createBashTool`, `BashOperations`, and `user_bash`) plus the official Gondolin extension example.

Keep the existing `pi` command and its whole-process `@anthropic-ai/sandbox-runtime` (SRT) boundary. Add a separate `vmpi` command that launches the same host Pi configuration while routing shell execution into a private Gondolin microVM. This is a **hybrid containment** design:

- **Host Pi boundary:** Pi, provider auth, sessions, UI, Ketch, custom extensions, MCPs, plan mode, Git checkpoints, Herdr, and subagent processes remain on the host but inside the existing fail-closed SRT boundary.
- **Guest execution boundary:** built-in `bash`, user `!` commands, and inherited subagent Bash calls execute in one Gondolin VM with the validated Git root mounted at `/workspace`; Docker runs only inside that VM.
- **Trusted control plane:** an unsandboxed, host-owned controller creates the VM and exposes only authenticated guest-command execution over loopback TCP. The model cannot ask it to execute a host command, change mounts, read an arbitrary host path, or reconfigure policy.

This is not “the whole Pi process is hardware-isolated,” and the UI/documentation must not claim that. It is a better compromise for this repository because SRT already contains all host-side extension code, while the microVM isolates the highest-risk project-controlled execution path and supplies private Docker. Pi configuration, auth, sessions, Ketch, model defaults, package resources, Herdr, and plan-mode persistence no longer need cross-architecture materialization or synchronization.

**Why the official Gondolin extension cannot be used unchanged.** Pi’s example mounts the current directory and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `user_bash`; Pi itself and every other extension remain on the host ([official example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/gondolin)). That is appropriate when host Pi is otherwise trusted. Here, the current SRT wrapper already protects host file operations and extension processes, so routing every file tool through another translation layer adds complexity without adding a new host permission.

The unchanged example also creates Gondolin in the Pi process. Gondolin’s QEMU backend uses host Unix sockets for virtio control, VFS, networking, sessions, and ingress. The requested SRT hardening blocks Unix sockets. On Linux, SRT uses seccomp to block creation of every `AF_UNIX` socket and explicitly ignores `allowUnixSockets` paths; only `allowAllUnixSockets: true` disables that filter. A direct in-process Gondolin extension would therefore either fail on Linux or reopen every host Unix socket—including Docker—to all model-invoked host code. The cross-platform safe adaptation is to run Gondolin in a trusted sibling controller outside SRT and let Pi’s integrated `BashOperations` client use a narrow loopback TCP capability.

**How operations behave.**

| Operation | Execution location | Authoritative boundary |
|---|---|---|
| `read`, `write`, `edit`, `grep`, `find`, `ls` | Host, at the user’s normal paths | Existing SRT filesystem policy and validated Git-root grants |
| `bash` and `!` | Gondolin guest, with host CWD translated under `/workspace` | QEMU plus fixed host-side Gondolin VFS providers |
| Docker/Compose/BuildKit | Private daemon in the Gondolin guest | Guest kernel; no host Docker socket or state |
| Ketch and enabled custom tools | Host child processes | Existing whole-process SRT; direct-spawn Ketch remains unchanged |
| Subagents | Host Pi children inheriting SRT and the same VM Bash capability | SRT for child Pi; shared Gondolin controller for Bash, serialized when required |
| Git checkpoint/session/UI/Herdr logic | Host Pi | Existing SRT and authenticated Herdr TCP broker |
| Git commands issued through Bash | Guest | Gondolin VFS workspace plus guest-only Git identity/signing key copy |

The split is intentionally transparent: model-visible file paths remain normal host paths, edits appear immediately, existing extensions keep working, and the Bash operations adapter translates only the command CWD to the equivalent guest path. The system prompt/status must state that the shell is Linux in a VM while file tools are SRT-confined host operations, avoiding false assumptions about host binaries, caches, or paths.

**Existing SRT hardening.** The current policy sets `allowAllUnixSockets: true`. That is unnecessary for Herdr because the wrapper already replaces the Herdr socket with an authenticated loopback TCP broker. It is dangerous because a host Docker socket lets the daemon bind-mount arbitrary host files, defeating the filesystem boundary ([SRT](https://github.com/anthropic-experimental/sandbox-runtime), [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)). Set it to `false` for normal `pi` and hybrid `vmpi`. Preserve unrestricted host IP networking and local TCP binding. The Gondolin controller remains outside SRT, so no exception is needed.

**Host and guest filesystem scope.** Both boundaries use the current wrapper’s trusted Git discovery. For an ordinary non-bare repository, the complete canonical Git root is read-write even when launched from a nested directory, while Pi and the shell retain the original relative CWD. A verified external bare common directory is mounted at the same guest absolute path when required by a linked worktree. Root execution configuration, Git hooks/config, `bin/pi`, `bin/vmpi`, `pi/sandbox`, and `pi/vmpi` remain protected by equivalent SRT and host-side Gondolin Shadow/readonly rules. Refuse `vmpi` for the dotfiles/control-plane workspace, as previously accepted; use normal `pi` there.

No host home, `~/.pi`, `~/.agents`, `~/.dotfiles`, host binary directory, Docker path, or cache is mounted in the guest. The guest does not need Pi configuration because Pi stays on the host. The trusted controller writes only a generated Git config, ignore file, known-host data, and the configured SSH signing-key copy into guest-private storage. The signing key is readable by guest commands, as explicitly requested, but the source key is never mounted or writable and is removed with the VM. Guest Docker privilege ends at the VM and fixed VFS providers.

**Evaluation of Pi’s other documented options.**

| Pi-documented pattern | Benefit | Why it is not the selected compromise |
|---|---|---|
| Official Gondolin extension unchanged | Small, upstream example; keeps provider auth on host | Leaves custom extension tools on an otherwise unrestricted host; cannot create Gondolin inside the hardened Linux SRT without allowing all Unix sockets; no Docker provisioning or trusted Git-root policy |
| Official SRT sandbox extension | Uses Pi tool overrides and has a status UI | Sandboxes only Bash and can be disabled/configured in-process; the current whole-process wrapper is stronger and already covers every extension child process |
| Plain Docker | Simplest whole-process environment | Explicitly excluded by the no-Docker-based-sandbox requirement; a host daemon/socket would also violate host-file isolation |
| NVIDIA OpenShell | Whole-process policy, managed credentials/inference, persistent services; Pi has a bundled image | Requires a gateway and a VM compute driver that is not auto-detected, currently ignores VM CPU/memory requests, and does not provide the current live local-worktree/Stow/Herdr experience without substantial transfer/config work. Nested private Docker inside its restricted Pi image is not a documented guarantee. It is the better future option only if whole-process network/credential isolation becomes more important than local transparency ([OpenShell drivers](https://docs.nvidia.com/openshell/reference/sandbox-compute-drivers), [supported agents](https://docs.nvidia.com/openshell/about/supported-agents)). |
| Stock `@the-agency/vmpi` | Whole Pi in Gondolin, checkpoint/session lifecycle, network configuration | Duplicates Pi config into Linux, preserves this repository’s external Stow symlinks incorrectly, builds Pi packages on the macOS host, accepts repository `.vmpirc` mounts/hooks, does not select the Git root, has no Docker, is untested on macOS/aarch64, loses Herdr integration, and discards most mutable Pi state ([vmpi](https://github.com/JoshMock/the-agency/tree/main/packages/vmpi)). |

Use exact `@earendil-works/gondolin` 0.12.0, matching Pi’s bundled example, instead of vmpi’s older `^0.10.0` dependency. Gondolin 0.12 provides runtime `rootfs.size`, disk checkpoints, host-mediated VFS, optional HTTP/WebSocket ingress, mapped egress, and QEMU/HVF support ([storage SDK](https://earendil-works.github.io/gondolin/sdk-storage/), [network SDK](https://earendil-works.github.io/gondolin/sdk-network/)). Build the Docker-capable base checkpoint inside Gondolin; do not use host Docker to build the sandbox.

**Network scope.** Host Pi/Ketch retain the current unrestricted SRT IP networking. The optional Gondolin network mode applies to VM Bash and Docker traffic only: default `allow-all` for transparent package/project work, `custom` for approved HTTP/TLS and explicit SSH/TCP destinations, or `deny-all` for offline shell work. This split is an accepted compromise. Whole-session network confinement would require moving all Pi/extensions into vmpi/OpenShell and reintroducing the configuration/state costs this revision avoids.

**Docker scope.** “Full Docker” means normal non-interactive Engine API use from Bash: build, run, Compose, BuildKit, images, containers, service networks, named volumes, bind mounts of `/workspace`, and privileged containers. State is session-ephemeral initially: each `vmpi` starts from the Docker-capable base checkpoint and discards runtime images/containers/volumes on exit. Gondolin HTTP/WebSocket ingress provides a loopback host URL for guest/container web services; arbitrary raw host-to-guest port forwarding and cross-session Docker persistence remain deferred.

Do not add Guardrails or another permission plugin. It would only prompt for mistakes inside the intentionally writable workspace or remote side effects; it would not strengthen SRT, QEMU, Docker, the VFS provider, or the controller capability. Pi’s integrated status APIs are useful, so adapt the official Gondolin status pattern without adding approval prompts.

**Complexity estimate.** The integrated operations API removes Pi config/session/package synchronization, but the out-of-SRT controller and authenticated streaming bridge are security-critical custom code.

| Custom work | Estimated production LOC | Estimated test LOC |
|---|---:|---:|
| SRT Unix-socket hardening and explicit `vmpi` capability handoff | 40–80 | 70–130 |
| `bin/vmpi`, trusted Git/workspace discovery, lifecycle and cleanup | 130–210 | 140–230 |
| Gondolin controller, fixed VFS policy, authenticated streaming/cancellation broker | 300–460 | 280–430 |
| Pi `BashOperations`/`user_bash` bridge, CWD/env translation, status/commands | 170–260 | 200–320 |
| Docker base checkpoint, Git/signing/network/ingress setup | 180–300 | 240–390 |
| Installer and configuration integration | 60–110 | 50–90 |
| **Subtotal** | **880–1,420** | **980–1,590** |

Expect 200–320 documentation/ADR lines, for approximately **2,100–3,300 custom lines changed or added**, excluding npm lockfiles and upstream code. A focused implementation plus macOS-arm64 canary is approximately 5–8 engineering days; verified Linux parity adds 1–2 days. This is somewhat more custom transport code than the prior stock-vmpi plan, but it removes its highest-risk compatibility work and preserves substantially more existing functionality. If the stock Gondolin image cannot support Docker’s required kernel/cgroup/storage behavior, stop at the prototype gate rather than weakening isolation or silently growing a custom VM runtime.

## Questions & Answers

| Question | Answer |
|---|---|
| How should the VM command coexist with the current sandbox? | Keep `pi` as-is and add a parallel `vmpi` command. `vmpi` invokes the same SRT-confined host Pi with VM-routed Bash. |
| Which Pi-integrated sandboxing feature improves the design? | Use Pi’s official pluggable `BashOperations` and `user_bash` routing pattern from the Gondolin example, but place the Gondolin controller outside SRT behind a narrow authenticated loopback broker. |
| Why not run Pi’s Gondolin extension directly inside the current wrapper? | Hardened Linux SRT blocks all new Unix sockets, while Gondolin requires them. Enabling them would reopen every host Unix socket to model-invoked host code. |
| What should change in the old containment system? | Turn broad Unix-socket access off while preserving its filesystem boundary and unrestricted host IP networking. |
| What workspace must be writable? | The complete non-bare Git root is read-write from both host file tools and guest Bash, even from a nested launch; verified bare common Git metadata is added when required. |
| How does the VM use Pi configuration without mounting `~/.dotfiles`? | It does not need Pi configuration. Pi, auth, sessions, extensions, skills, Ketch, and UI remain on the SRT-confined host; only generated guest Git/signing/tool configuration enters the VM. |
| Should Git signing be available? | Yes. The trusted controller copies the configured SSH signing key into guest-private storage, while the original remains unmounted and unchanged. |
| Why not use stock `@the-agency/vmpi`? | Pi’s integrated tool routing preserves host Pi state/UX and avoids Stow, cross-architecture package, session, Herdr, and repository-config problems. Stock vmpi still provides useful lifecycle reference, not the implementation base. |
| Must `vmpi` protect its control plane while editing dotfiles? | The primary goal is strong sandboxing outside `~/.dotfiles`; refuse dotfiles/control-plane work in `vmpi` and use normal `pi` there. |
| What does Guardrails provide beyond this design? | Only prompts/denies for allowed-workspace or remote mistakes. It does not strengthen either containment boundary, so omit it. |
| What Docker environment is controlled? | A private daemon inside the Gondolin guest. Host Docker is unreachable; runtime Docker state is initially ephemeral and HTTP/WebSocket ingress is loopback-only. |
| What do optional network restrictions cover? | VM Bash and Docker traffic. Host Pi/Ketch keep current unrestricted SRT IP networking; whole-session restriction is deferred. |

## Approach

Implement the hybrid as one explicit launch path, not as a global behavior change. Normal `pi` receives only the Unix-socket hardening. `vmpi` starts the trusted Gondolin controller, waits for a verified ready manifest, and then starts the current `pi` wrapper with a per-run loopback capability. A global no-op bridge extension activates only when that validated capability exists, so subagent Pi children inherit the same VM while normal Pi sessions remain unaffected.

### Part A — Record the hybrid boundary and harden host Unix sockets

Add an ADR because choosing dual SRT/Gondolin containment over whole-process vmpi/OpenShell is hard to reverse, surprising without context, and based on real security/ergonomic trade-offs. Define the canonical terms **host Pi boundary**, **guest execution boundary**, **trusted controller**, and **VM-routed Bash**. Update sandbox documentation and `pi/AGENTS.md` to state which operation belongs to which boundary and prohibit claims that all of Pi runs in the VM.

Set `network.allowAllUnixSockets` to `false` in `pi/sandbox/settings.json`. Keep `unrestricted-network.mjs` removing the HTTP-domain boundary after initialization, so public/private/loopback IP networking remains unchanged. Invert the native arbitrary-socket fixture and add a negative host-Docker-socket canary when such a socket exists. Preserve Ketch, arbitrary HTTPS, local TCP binding, PTY raw mode, macOS trust lookup, and the Herdr loopback broker.

Protect the new control-plane sources in both checked-in base and effective policy: `~/bin/vmpi`, `~/.pi/vmpi`, `~/.dotfiles/bin/vmpi`, and `~/.dotfiles/pi/vmpi`. Normal model-invoked Pi must not mutate the code a future trusted launch will execute.

Acceptance outcome: normal `pi` behaves as before except arbitrary host Unix sockets are inaccessible; documentation distinguishes the hybrid boundaries; all current native containment and integration tests pass.

### Part B — Prove a Docker-capable Gondolin guest before building the bridge

Create a bounded setup/canary program using exact Gondolin 0.12.0. Start from pinned Gondolin guest assets, use `rootfs: { mode: "cow", size: "8G" }`, install Docker Engine/CLI, Compose, BuildKit support, Git, OpenSSH client, Bash, certificates, and required development basics inside the setup VM, enable required services, and save a trusted base checkpoint under private controller state outside every SRT filesystem grant. Do not resize Gondolin’s shared cached base image and do not invoke host Docker.

Verify on macOS arm64 that the guest kernel supports cgroup v2, namespaces, bridge/netfilter behavior, IP forwarding, overlay storage, and privileged containers. Require `overlay2` or another explicitly reviewed production driver; a silent `vfs` fallback is not completion. Exercise container HTTP egress through Gondolin’s network stack and confirm policy hooks see container traffic. This is a hard prototype gate: if Docker cannot work with the stock guest assets, report the incompatibility and revisit the architecture/estimate rather than mount host Docker or implement an unplanned kernel/image system.

Checkpoint only the installed base. Runtime VMs resume with a throwaway copy-on-write overlay, start `dockerd`, wait for `docker info`, and discard Docker state at shutdown. Add a digest over Gondolin version, guest asset build ID, setup package list, rootfs size, and setup script; rebuild only when that digest changes. Serialize setup and atomically publish the last verified checkpoint.

Acceptance outcome: the direct canary demonstrates the promised in-guest Docker surface and network enforcement on macOS arm64 before any Pi routing code depends on it.

### Part C — Build the fixed-policy controller and parallel launcher

Add `bin/vmpi` as a trusted parallel launcher. Reuse or faithfully share the current wrapper’s canonical-path, safe-executable, and trusted-Git discovery semantics without sourcing repository code. Preserve the original launch directory and calculate its relative path under the canonical Git root. Reject dotfiles/control-plane work, malformed metadata, unsupported non-bare external common metadata, and any path that cannot be represented literally. Permit a Git-verified external bare common directory exactly as current `pi` does.

Start a host controller outside SRT with a minimal environment, fixed Stow-managed policy, private state, and no repository configuration. It resumes the verified base checkpoint and creates only these host-backed providers:

1. canonical workspace root read-write at `/workspace`;
2. optional verified bare common Git directory at the same guest absolute path;
3. Gondolin’s own ephemeral ingress control mount.

Wrap workspace/Git providers with host-side Shadow/readonly rules matching current mandatory denies for root execution config, Git hooks/config, and all Pi/vmpi control-plane files. The provider root and mount table are immutable after startup. Repository files cannot supply mounts, images, setup hooks, egress rules, ingress host interfaces, or secrets.

Expose a random loopback TCP port with a 256-bit per-run token. Keep the protocol deliberately smaller than Gondolin’s API:

- `status` returns fixed workspace/guest/version/Docker/network/ingress metadata;
- `exec` accepts a command, an already-mapped guest CWD under `/workspace`, a filtered environment, timeout, and unique call ID, then streams guest stdout/stderr/exit status;
- `cancel` targets only an active call owned by that token.

Do not expose host file APIs, arbitrary VM filesystem methods, mount mutation, host process spawning, controller configuration, checkpoint paths, host network connections, or raw Gondolin objects. Validate frame sizes, IDs, CWD containment, environment keys, timeout bounds, concurrency, and output backpressure. Serialize guest executions if required by Gondolin 0.12 while allowing cancellation and clear queued status. Never pass controller/Herdr tokens, host session paths, or host-only credentials into guest command environments.

Before reporting ready, inject a generated guest Git config/ignore, the configured SSH signing private/public key with restrictive modes, and known-host material into guest-private storage. Resolve the key through trusted host Git configuration, require SSH signing format, and fail clearly if it is absent/unreadable. Optionally configure Gondolin’s host-side SSH egress credentials for approved Git remotes; signing still uses the guest copy. The original key is never a VFS mount and receives no guest writes.

Write a private ready manifest containing controller PID, parent PID, loopback port, token, policy/base digest, workspace mappings, network mode, Docker health, and ingress URL. `bin/vmpi` validates it, passes only the required capability through the existing `bin/pi` safe-environment construction, forwards signals, and always closes the controller/VM. Controller death terminates the `vmpi` session; Pi startup failure tears down the controller. No failure falls back to host Bash.

Acceptance outcome: an authenticated client can execute and cancel commands only inside the fixed guest; invalid tokens/methods/paths/config are rejected; lifecycle crashes leave no controller, listener, staging key, or mutable checkpoint; normal `pi` never receives a vmpi capability.

### Part D — Route Pi Bash through the integrated operations API

Add a global bridge extension that is inert unless the validated `PI_VMPI_*` capability is present. Adapt Pi’s official Gondolin example rather than replacing Pi’s tool schemas or renderers:

- override only `bash` with `createBashTool(..., { operations })` and a broker-backed `BashOperations.exec`;
- return the same operations from `user_bash` so `!` commands share the VM;
- translate any host CWD inside the validated workspace to `/workspace/<relative>`, preserving nested launch behavior;
- reject outside-workspace CWDs instead of converting them to guest absolute host-looking paths;
- filter/rewrite command environment values and remove broker, Herdr, provider/session-path, host cache, and other host-only variables before RPC;
- preserve streaming output, aborts, timeouts, exit codes, truncation, tool rendering, and Bash session metadata semantics where guest-safe.

Leave `read`, `write`, `edit`, `grep`, `find`, and `ls` unchanged on the SRT-confined host. This avoids path/UI reimplementation and lets generated Dockerfiles or source edits appear immediately in both planes through the shared workspace provider. Add a precise system-prompt note: file tools use host paths under SRT; shell commands use Linux paths/toolchains in the VM.

Use Pi status APIs for a compact `VM bash · docker:private · net:<mode>` indicator. `/vmpi` shows host/guest workspace mapping, original CWD, controller/base digest, VM ID, Docker health/storage driver, network mode, queued/active command count, and loopback ingress URL. Configure Gondolin HTTP/WebSocket ingress on an ephemeral `127.0.0.1` port; guest `/etc/gondolin/listeners` routes selected Docker/guest web ports. Do not add raw host port forwarding or a permission prompt layer.

Subagent children inherit the broker capability through the existing sanitized parent environment and auto-discover the no-op/active bridge extension. They share the same VM/workspace/Docker session. The controller serializes concurrent Bash requests if Gondolin requires it; file/web/custom tools continue independently under SRT. Add composed tests for plan-mode `tool_call` and `user_bash` blocking, RTK/Bash wrappers, subagent startup/concurrency/cancellation, Herdr lifecycle, and extension reload/shutdown so routing cannot be bypassed by handler order.

Acceptance outcome: ordinary file tools and all current UI/extensions behave as normal; every Bash/`!`/subagent Bash command reaches the same private VM; no normal workflow prompt is added; disabling or crashing the bridge fails Bash closed rather than running locally.

### Part E — Install, document, and canary both boundaries

Update `install.sh` through the repository’s Stow workflow. Install/check QEMU and the Node version required by Gondolin; install the exact controller dependency with a lockfile and `--ignore-scripts`. On macOS use QEMU/HVF. On Linux require QEMU/KVM for the supported path and name missing prerequisites without changing the no-root bootstrap contract. TCG may be an explicit diagnostic mode, never an unnoticed production fallback.

Keep normal `pi` installation and resources unchanged. Stow `bin/vmpi`, the controller/config/tests under `pi/vmpi`, and the inert bridge extension under the global extension tree so inherited child Pi processes can activate it. Do not install `@the-agency/vmpi`, OpenShell, Guardrails, another permission package, or a global mutable Gondolin binary.

Document setup, first checkpoint build, operation-location table, trusted controller protocol, root/nested/worktree behavior, dotfiles refusal, Linux-vs-macOS acceleration, signing-key/auth differences, network-scope split, Docker ephemerality, HTTP ingress, cancellation/serialization, reset/rebuild, disk usage, threat model, and failure recovery. State that Pi auth never enters the guest, the SSH signing key does, host custom tools remain SRT-confined rather than VM-confined, and network restriction is guest-only. Include the comparison/complexity tables and maintenance procedure for Gondolin/guest asset updates.

Switch `vmpi` from canary-only to normal use only after macOS-arm64 Docker, controller, composed Pi, and adversarial containment suites pass from an unsandboxed terminal. Linux parity is claimed only after the same native checks under QEMU/KVM.

Acceptance outcome: `./install.sh config` deploys both commands idempotently; `pi` remains the existing default; `vmpi` visibly and reliably routes Bash/Docker to the VM while preserving host Pi UX and SRT containment.

## Critical Files

- `bin/pi` — existing whole-process SRT entrypoint; only pass a validated explicit vmpi capability in that launch mode and otherwise preserve behavior.
- `bin/vmpi` — new trusted parallel lifecycle wrapper, workspace discovery, controller readiness validation, signal forwarding, and cleanup.
- `pi/sandbox/settings.json`, `unrestricted-network.mjs`, tests, and `README.md` — disable broad Unix sockets and document the host Pi boundary.
- `pi/vmpi/` — exact Gondolin dependency, Docker base setup, fixed-policy controller/broker, trusted configuration, state/reset helpers, and native tests.
- `pi/agent/extensions/vmpi-bridge/` — inert-by-default Pi operations adapter for Bash, `!`, subagents, system-prompt clarification, status, and `/vmpi`.
- `install.sh` — install/stow the parallel runtime and host prerequisites without replacing current Pi setup.
- `pi/AGENTS.md` and a new ADR — preserve the dual-boundary terminology, no-host-socket rule, threat model, and maintenance rationale.

## Verification

**Existing `pi` regression.** Run the complete current wrapper, repository-scope, containment, Ketch, broker, Herdr, plan-mode, model-default, and composed integration suites. Confirm arbitrary Unix sockets and any host Docker socket fail while arbitrary host IP/Ketch, local TCP, raw PTY, trust lookup, non-bare root writes, verified bare worktrees, nested subagents, and authenticated Herdr reporting remain unchanged. Compare a normal `pi` launch before/after to prove the bridge is inert and no vmpi variables/status/tools appear.

**Docker prototype gate.** On macOS arm64, build the base without host Docker and verify guest asset/build digest, cgroup v2, `overlay2`, BuildKit, Docker Compose, normal and privileged containers, service networks, named volumes, workspace bind mounts, bridge DNS, container egress, and guest access to published container ports. Prove policy hooks govern container traffic. Failure of kernel, storage, or network prerequisites stops implementation before the Pi bridge is treated as complete.

**Controller capability and lifecycle.** Exercise missing/wrong/replayed tokens, unknown methods, malformed/oversized frames, duplicate IDs, CWD traversal, hostile environment values, invalid timeout, cancellation races, output backpressure, queued concurrency, parent death, controller death, Pi startup failure, signals, and repeated cleanup. Verify the listener is loopback-only, the parent/token are bound to one run, and protocol calls can never execute on the host or mutate mounts/policy/checkpoints. Hash control-plane files and the source signing key before/after.

**Filesystem containment.** From host file tools, host custom extensions, guest Bash, nested subagent Bash, and privileged Docker containers, write the complete approved repository scope but fail to reach host-home, sibling-repository, parent, dotfiles, `.ssh`, cloud, canonical Pi, controller state, and host-socket canaries. Exercise absolute/relative traversal, escaping and dangling symlinks, `/proc` aliases, Docker bind mounts, protected root files, Git hooks/config, and linked-worktree metadata. Inspect both SRT effective policy and Gondolin provider manifest; each must list only its approved paths.

**Git and signing.** Launch from repository root and nested directories, and test ordinary non-bare and verified bare-common worktrees. Host file tools and guest Bash must observe the same live changes. Sign and verify a guest commit and tag, attempt to overwrite/delete the guest key, and prove the source key hash/mode is unchanged. Validate approved SSH egress and host-key checking if enabled. Missing or non-SSH signing configuration must fail clearly before Pi starts.

**Pi operations composition.** Compare built-in Bash rendering, streaming, timeout, abort, exit, environment, and `!` behavior with normal Pi. Verify plan-mode known mutations are blocked before RPC, unknown commands retain the existing fail-open planning semantics but execute in the VM, RTK optimization does not bypass routing, and bridge/controller failure never falls back to local Bash. Run parent and subagent commands concurrently and verify documented serialization/cancellation without token leakage into guest `env` or output. Confirm Ketch, AskUserQuestion, Git checkpoints, sessions, model selection, statusbar, and Herdr remain host-functional.

**Network and ingress.** Exercise VM `allow-all`, representative `custom`, and `deny-all` modes from guest Bash and Docker. Confirm host Pi/Ketch networking remains intentionally unrestricted and docs/UI identify that split. Expose guest and Docker HTTP/WebSocket services through Gondolin ingress on host loopback, validate route changes/collisions/shutdown, and prove ingress cannot reach host services or bind non-loopback. Confirm arbitrary raw guest ports are not host-reachable in this phase.

**Installation and parity.** Run `./install.sh config` twice and verify Stow idempotence, exact dependency locks, protected control-plane paths, private state modes, deterministic base rebuild/reset, and absence of manual symlinks or host Docker dependencies. Run the full native suite under macOS QEMU/HVF before enabling normal use and under Linux QEMU/KVM before claiming parity. Treat TCG-only results, unverified container egress enforcement, or any host fallback as failure evidence rather than acceptance.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☐ Record the hybrid boundary and harden host Unix sockets
- ☐ Prove a Docker-capable Gondolin guest before building the bridge
- ☐ Build the fixed-policy controller and parallel launcher
- ☐ Route Pi Bash through the integrated operations API
- ☐ Install, document, and canary both boundaries
<!-- pi-plan-mode:progress:end -->
