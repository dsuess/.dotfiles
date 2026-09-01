# Enable Isolated Docker Workflows in Pi

## Context

Pi already separates three trust domains: host-native Pi and audited adapters, per-operation SRT-confined file/shell tools, and a workspace-keyed Docker Sandbox sidecar. The controller creates a private Unix-socket broker and points routed commands at it with `DOCKER_HOST`; the broker is intended to byte-splice Docker Engine traffic to `sbx --app-name pi-srt exec -i <sidecar> docker system dial-stdio`. This architecture matches Docker’s model: each Docker Sandbox is a microVM with its own Docker daemon, filesystem, and network, while the selected host workspace is mounted at the same absolute path ([architecture](https://docs.docker.com/ai/sandboxes/architecture/), [security model](https://docs.docker.com/ai/sandboxes/security/)).

The current implementation does not yet make that contract dependable for users. It validates a raw `dial-stdio` ping, but it does not prove the complete SRT → Docker CLI → private broker → `sbx` sidecar path. Docker CLI and plugin discovery rely on ambient macOS installation layout, Buildx and Compose are not explicitly audited into the generated tool environment, broker stream lifecycle has no realistic Engine-protocol coverage, and the advertised `/sandbox` cleanup methods do not exist in the controller client/protocol. Persistent sidecars therefore lack a reliable supported cleanup workflow even though their images, containers, volumes, and build cache remain until removal. Docker documents this persistence and the corresponding stop/remove behavior ([usage](https://docs.docker.com/ai/sandboxes/usage/)).

“Docker inside the sandbox” will mean that SRT-routed commands use the Docker CLI against the private daemon inside the workspace’s Docker Sandbox. It will not mean exposing the host Docker daemon, the Docker Desktop control socket, the `sbx` control socket, host Docker contexts, host `~/.docker` credentials, or arbitrary Docker Desktop plugins. Core Engine commands, audited Buildx, and audited Compose will be available. Nested containers can bind-mount paths present in the sidecar, including the shared workspace, but no container port will be published to the host by default.

The sidecar will remain lazy and workspace-keyed, then persist until the user resets or prunes it. Docker’s `sbx create shell` supports the same-path workspace mount used by the existing design, while `sbx exec` provides the fixed command bridge used here ([create shell](https://docs.docker.com/reference/cli/sbx/create/shell/), [exec](https://docs.docker.com/reference/cli/sbx/exec/)). The exact reviewed `sbx` release, shell-template digest, dedicated `pi-srt` app, empty MCP registry, disabled SSH forwarding, and no-host-Docker invariants remain unchanged.

The unfinished `--yolo` host-bypass edits in `bin/pi`, `pi/AGENTS.md`, `pi/adr/0001-srt-tool-routing.md`, and `pi/sandbox/test-launcher-yolo.mjs` are unrelated user changes. They will remain unstaged and untouched. The Docker implementation and its canonical plan document will be committed without those hunks.

## Questions & Answers

| Question | Answer |
|---|---|
| Which command-line behavior must this change support? | Support both model-directed Docker tool calls and a leading `!command` in Pi print mode. |
| Which Docker surface should the sandbox expose? | Expose core private-Engine commands plus audited Buildx and Compose plugins; do not expose all Docker Desktop plugins. |
| How long should each workspace’s Docker Sandbox persist? | Reuse it until reset, while providing an explicit command to inspect and clean persistent images, containers, volumes, and cache. |
| What should happen to the unfinished `--yolo` host-bypass worktree changes? | Preserve them unstaged and exclude them from the Docker implementation commit. |
| Which operator interface should manage persistent Docker Sandbox state? | Add a separate command named `pi-sbx`. |

## Approach

Keep the accepted private-sidecar architecture and close its execution, lifecycle, and verification gaps rather than adding a second Docker path. A generated Docker client environment will expose only reviewed binaries and the private broker. One management module will validate sidecar identity for both controller-owned reset operations and the standalone `pi-sbx` command.

### Part A — Make the private Docker path explicit and reliable
- **Ledger:** {"status":"completed","note":"Implemented generated reviewed Docker client environment and hardened broker lifecycle.","evidence":"Added docker-client-env.mjs; controller now resolves only canonical Docker CLI plus Buildx/Compose, creates empty per-generation DOCKER_CONFIG, sets controlled PATH/DOCKER_* vars, includes new source inputs in generation digest; sidecar tracks active bridges and refuses reset while active. npm --prefix pi/sandbox test: 20 passing."}

Resolve the installed Docker CLI plus only the Buildx and Compose plugin executables through reviewed canonical locations. Materialize a private generated Docker client directory for each controller generation, with exact plugin links/configuration and no inherited host Docker configuration or credentials. Grant SRT read/execute access only to those resolved files and generated entries. Set controlled `PATH`, `DOCKER_CONFIG`, and `DOCKER_HOST` values after filtering user environment overrides so every routed `docker`, `docker buildx`, and `docker compose` command targets only the workspace broker.

Keep the sidecar lazy and persistent. Harden the broker for Docker Engine semantics: shared first-use creation, half-close and EOF handling, successful and failed child termination, bounded/redacted stderr, cancellation, hijacked attach/exec streams, concurrent clients, and recovery after an owned reset. Track active bridges so destructive lifecycle operations cannot silently race live Docker traffic. Include every imported security-sensitive sidecar/toolchain source in controller generation validation so reviewed behavior drift cannot reuse a stale controller.

Validate sidecar identity before reuse or mutation using the dedicated app, deterministic workspace name, canonical workspace, exact shell-template digest, expected agent/capability inventory, and resource contract. Apply or remove any currently decorative resource fields rather than reporting settings that are not passed to `sbx`. Continue to reject published ports, shared skills, extra secrets, host Docker endpoints, and arbitrary `sbx` arguments.

Acceptance outcome: a routed SRT Bash process can find `docker`, Buildx, and Compose; `docker version`, `docker ps`, builds, Compose operations, logs, exec/attach, and parallel requests reach the private sidecar daemon; equivalent host-Docker and Docker Desktop control paths remain unavailable.

### Part B — Support model calls and one-shot leading-bang commands
- **Ledger:** {"status":"completed","note":"Added print-mode leading-bang routing through controller SRT Bash.","evidence":"bin/pi recognizes only -p/--print whole prompts beginning ! or !! (excluding JSON/RPC), then invokes client-cli bash; client-cli acquires a controller lease and streams SRT operation output without launching Pi/model. npm --prefix pi/sandbox test passed (20 tests); npm --prefix pi run check:deterministic passed."}

Retain the existing sandboxed `bash` replacement for model-directed prompts such as “Run docker ps.” Add a print-mode input path for a whole-line leading `!` or `!!` command so `pi -p --no-session "!docker ps"` executes through the same ready controller and SRT Bash operations instead of becoming an ordinary model prompt. Stream bounded command output to print-mode stdout, propagate cancellation and a meaningful process exit status, and do not call a model for this form. Keep normal prompts, JSON/RPC framing, interactive `!` behavior, and inline exclamation marks unchanged.

Both model Bash and user Bash must share the same environment controls and private broker. A literal leading-bang command must not become a host-side extension `exec`, direct `sbx exec`, or wrapper bypass.

Acceptance outcome: the requested one-shot command prints the isolated sidecar’s container list and exits; a normal natural-language prompt can invoke the same Docker daemon through the audited Bash tool; neither route sees host containers.

### Part C — Add safe persistent-sidecar management with `pi-sbx`
- **Ledger:** {"status":"completed","note":"Added validated pi-sbx management interface and removed stale UI lifecycle actions.","evidence":"Added bin/pi-sbx and sandbox/sidecar-management.mjs: list/status/stop/reset/prune inventory from private metadata with inspect validation, explicit force/TTY confirmation, and dedicated app commands. /sandbox now directs Docker management to pi-sbx. node bin/pi-sbx list and git diff --check passed."}

Add a Stow-managed `bin/pi-sbx` operator command backed by reusable sidecar inventory and validation code. Provide concise commands to list workspace sidecars, inspect status and Docker disk usage, stop a sidecar without deleting state, reset one validated workspace sidecar, and prune validated stopped sidecars in the dedicated `pi-srt` app. Default workspace selection will use the same canonical repository/worktree identity as Pi; explicit names or paths must resolve to a validated owned sidecar.

Destructive reset/prune operations must show their scope, require interactive confirmation or an explicit force flag, refuse ambiguous or capability-drifted entries, and coordinate with a live controller through a narrow reset RPC when one owns the target. Reset must clear the controller’s cached readiness/metadata so the next Docker command can recreate the sidecar. Global cleanup must remain confined to validated `pi-srt-*` entries in the dedicated app and must never invoke unscoped `sbx rm --all` or affect another app namespace.

Simplify or reconnect the existing `/sandbox` status surface so it does not advertise nonexistent restart/reset methods; point users to `pi-sbx` for persistent disk management. Document that stop preserves disk state, reset removes one workspace’s images/containers/volumes/cache, and prune removes eligible stopped sidecars.

Acceptance outcome: users can identify which workspace owns disk state, inspect its usage, preserve it with stop, delete one workspace safely, or prune stopped Pi sidecars without exposing arbitrary `sbx` control to model tools.

### Part D — Document, deploy, and commit the completed contract
- **Ledger:** {"status":"completed","note":"Documented, deployed with Stow, staged only implementation files, and committed.","evidence":"Updated pi/sandbox/README.md; ./install.sh config completed and native disposable sidecar canary passed; ~/bin/pi-sbx is a Stow symlink; npm --prefix pi run check passed; git diff --cached --check passed; committed bb071912 with 13 Docker/plan files. Remaining unrelated changes are unstaged."}

Update `pi/sandbox/README.md` with the trust-domain terminology, Docker CLI/plugin scope, one-shot command syntax, lazy persistence, `pi-sbx` examples, destructive-operation behavior, public-registry/no-host-credential limitation, and troubleshooting for `sbx` authentication/version/template drift. The accepted ADR already selects this architecture, so do not add a new ADR or create a domain glossary for this implementation completion.

Add the canonical plan under `.pi/plans` and include it in the Docker implementation commit as required by the repository. Deploy the new `pi-sbx` file only through `./install.sh config` and GNU Stow. Stage only Docker-related files and the plan; verify that the preserved `--yolo` changes remain unstaged with identical pre/post diff content.

Acceptance outcome: installed `pi` and `pi-sbx` expose the documented behavior, the plan and implementation are committed together, and unrelated worktree changes are preserved byte-for-byte.

## Critical Files

- `pi/sandbox/docker-sidecar.mjs` — validated Docker Sandbox ownership, broker stream lifecycle, persistence, reset, and inventory boundaries.
- `pi/sandbox/controller.mjs`, `client.mjs`, and `srt-policy.mjs` — controlled Docker client environment, exact socket/tool access, and narrow lifecycle RPC.
- `pi/agent/extensions/srt-tool-routing/tools.ts` and `index.ts` — shared sandboxed Bash operations and print-mode leading-bang handling.
- `bin/pi-sbx` and a supporting sandbox management module — trusted host operator interface for list/status/usage/stop/reset/prune.
- `pi/sandbox/README.md` and `.pi/plans/` — operator contract and same-commit implementation plan.

## Verification

**Regression checks**

- Run the deterministic sandbox and routing suites to prove core file/Bash tools, environment authority stripping, exact Unix-socket policy, controller leases, cancellation, and fail-closed inventory behavior remain intact.
- Verify normal text containing `!`, JSON/RPC input, interactive `!`/`!!`, print prompts without a leading bang, help/catalog modes, and no-Docker Pi sessions retain existing behavior.
- Snapshot the unrelated `--yolo` diff before implementation and compare it after staging and after the Docker commit; any changed or staged canceled-work hunk is a failure.

**New Docker scenarios**

- Deterministic broker tests cover lazy single creation, concurrent connections, byte-exact request/response flow, half-close, successful EOF, stderr/error propagation, cancellation, active-reset refusal, post-reset recreation, ownership drift, and exact fixed `sbx --app-name pi-srt ... dial-stdio` arguments.
- A self-cleaning native canary uses a disposable workspace and owned sidecar to exercise the complete SRT-routed Docker CLI path: Engine ping/version, `docker ps`, public-image pull/run, workspace bind mount, Buildx build, Compose up/ps/logs/down, exec/attach streaming, parallel requests, controller restart persistence, reset, and final sidecar removal.
- Isolation assertions prove the routed client has a generated empty Docker config, only Buildx and Compose plugins, the private broker as `DOCKER_HOST`, no host contexts/credentials/control sockets, no unexpected host ports, and no visibility into host Docker containers.
- Print-mode integration proves `pi -p --no-session "!docker ps"` emits command output without a provider request and returns the command’s success/failure status. A natural-language one-shot prompt is smoke-tested to confirm the model can call the same sandboxed Bash tool.

**Management and deployment**

- `pi-sbx` fixtures with a fake `sbx` backend verify list/status/usage formatting, canonical workspace selection, dedicated app scoping, confirmation/force behavior, rejection of foreign or drifted sandboxes, live-controller reset coordination, stopped-sidecar pruning, and no unvalidated broad deletion.
- Deploy with `./install.sh config`, verify `~/bin/pi-sbx` is Stow-managed, then run the repository’s full `npm --prefix pi run check` gate from an ordinary host terminal.
- Review the final staged diff, `git diff --check`, sidecar inventory, and Git status. Success means all focused/full checks pass, disposable native resources are removed, no generated controller/broker files are tracked, and only Docker work plus the canonical plan enters the commit.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Make the private Docker path explicit and reliable
- ☑ Support model calls and one-shot leading-bang commands
- ☑ Add safe persistent-sidecar management with `pi-sbx`
- ☑ Document, deploy, and commit the completed contract
<!-- pi-plan-mode:progress:end -->
