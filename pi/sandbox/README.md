# Pi Gondolin tool sandbox

`~/bin/pi` keeps Pi on the host. It runs model-directed tools in a Gondolin Linux VM.

The boundary has three parts:

- The host control plane runs Pi, model access, sessions, reviewed extensions, and the Gondolin controller.
- The guest tool plane runs `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `!`, and `!!`.
- Audited host adapters run Ketch, structured questions, child orchestration, and plan ledger operations.

A custom Pi extension still runs on the host. Gondolin does not isolate extension code.

## Startup

A normal launch uses this sequence:

1. The launcher finds trusted QEMU and the real Pi binary from one canonical safe PATH.
2. One trusted Node preflight discovers and validates the repository scope.
3. The preflight begins or joins one controller and starts the read-only preferred-model cache probe. Its startup descriptor contains only expected workspace identity and private paths; it contains no controller token, lease, generation, or VM identity.
4. The launcher creates a private handshake directory, disables native Pi built-ins, and starts one normal host Pi process while a cold controller verifies the complete pinned image, creates the policy, starts the VM, and checks guest Docker.
5. The routing extension publishes `starting`, acquires the root Pi-process lease, verifies the workspace, generations, VM, Docker health, inventory, and host-adapter provenance, then activates the permitted replacements and writes the readiness handshake.
6. A submitted prompt or `!`/`!!` command while `starting` waits before message construction, model execution, or Bash RPC. It continues automatically after `healthy`; a failure handles queued input, leaves tools inactive, reports the error, and shuts Pi down.
7. RPC, JSON, and print modes wait for the same readiness promise before their externally observable startup completes.

A cache-hit launch uses one preflight process and one normal Pi process. A refresh adds one metadata Pi process. Trusted model-scope work may overlap controller startup; it grants neither tool access nor a controller capability.

Pi selects the planning default during the plan-mode `session_start` event. An explicit CLI model has higher priority.

The launch stops if a sandbox step fails. The launcher never retries with host built-ins.

### Preferred-model cache

The canonical preferred list is `enabledModels` in `~/.pi/agent/settings.json`.
The launcher stores catalog metadata in `~/.cache/pi-gondolin/model-scope.json`.
The cache directory has mode `0700`. The cache file has mode `0600`.

The host code-cache root is `~/.cache/pi-gondolin/host/`.

Its `node-compile` and `jiti` directories have mode `0700`. `NODE_COMPILE_CACHE` and `JITI_FS_CACHE` use these directories for Pi and the controller.

Node and Jiti invalidate changed source and runtime versions. A missing, damaged, or stale code cache is only a performance miss.

These caches do not contain credentials, lease tokens, controller manifests, policies, inventories, or image attestations.

The metadata process uses Pi's authenticated `--list-models` catalog. It does not create a session or send a model request.
It disables tools, extensions, skills, prompts, themes, context files, and project settings.
Thus, only built-in providers and routes from `models.json` can qualify.
The configured preferred list contains direct-provider IDs. It does not contain OpenRouter or OpenCode gateway duplicates.

The cache expires after 24 hours. The launcher also invalidates the cache when one of these inputs changes:

- The installed Pi executable revision.
- The content of `~/.pi/agent/models.json`.
- The sorted provider and credential-type set in `~/.pi/agent/auth.json`.

The cache does not contain credential values. An OAuth token refresh does not invalidate the cache.
A successful `/login` or `/logout` changes the provider set. The next eligible launch refreshes the cache.

If a refresh fails, the launcher can use a stale catalog with the same input fingerprint.
If no trusted cache exists, Pi uses its native model resolution and authentication guidance.
A changed provider fingerprint prevents stale-cache use.

An explicit `--models` value bypasses automatic scope discovery. Help, version, package, authentication, and `--list-models` commands also bypass it.
The `--list-models` command always requests the complete authenticated catalog with `--models "*"`.

The controller uses one VM for all conversation sessions in one canonical workspace. The root Pi process owns its lease and publishes the verified capability only after readiness. `/new`, `/resume`, `/fork`, and `/reload` replace the conversation extension runtime, which reconnects to the same lease and VM; they do not acquire or release a root lease. Child Pi processes inherit and connect to the capability but never adopt or release the parent lease. Final quit or a fatal routing failure releases the root lease. Lease expiry remains the process-crash and failed-replacement backstop. A different workspace gets a different controller state directory. The controller stops after the last root lease ends or expires. It is not retained to make a later launch faster. A cold controller always verifies the full image.

Startup has three distinct states: **controller starting**, **host UI ready**, and **sandbox ready**. The trusted host UI is not VM-isolated. It can show the editor, model/session controls, extensions, and status while the sandbox is starting, but native built-ins are disabled from process launch and no agent turn, model-directed tool, or user Bash command crosses the readiness gate before the verified lease exists.

### Startup benchmark

Run the native benchmark from an ordinary terminal, not from a sandboxed Pi session:

```bash
npm --prefix pi/sandbox run benchmark:startup -- --samples 10
```

It creates one disposable workspace identity, closes stdin after RPC initialization, and sends no model request or persistent session. It runs one untimed warm-up for each mode, then reports medians and ranges for cold controller launches and launches with an owned active-controller lease. Each cold sample waits for its own controller manifest and socket to disappear. The active-controller lease is released before cleanup, so unrelated controllers are never acquired, released, or stopped.

The benchmark reports cold-controller, active-controller, and forced-refresh samples. It reports medians, ranges, launch-to-host-UI and host-UI-to-sandbox-ready intervals, phase durations, and metadata and real Pi process counts.

Optional startup tracing records repository scope, controller acquisition, image verification, policy creation, VM creation and start, Docker health, model-cache work, Pi initialization, routing audit, and handshake. The benchmark alone sets `PI_TIMING=1`. Normal launches do not forward ambient Pi diagnostics.

The benchmark uses a disposable model-cache file. It never reads or writes the user's preferred-model cache.

## Host adapters

The source manifest permits these model tools on the host:

- `ketch_search`, `ketch_scrape`, `ketch_code`, `ketch_docs`, and `ketch_crawl`
- `ask_user_question`
- `subagent`
- `submit_plan`, `plan_progress`, `complete_plan`, and `complete_stage`

The manifest checks the tool name, source information, package version, and parameter schema. An unknown or changed tool stays inactive.

Ketch uses host networking. The four execution workflow tools write only the validated plan and ledger state.

Plan inspection tools and planning Bash use Gondolin. A known planning mutation stops before an execution RPC.

Staged execution uses the same controller. Every subagent and discussion child starts without native Pi built-ins.

## Filesystem settings

`settings.json` has this schema:

```json
{
  "version": 1,
  "externalMounts": [
    { "path": "~/src/shared", "access": "ro" },
    { "path": "~/.ssh/git/id_ed25519_signing.pub", "access": "ro" }
  ],
  "network": {
    "mode": "public-http",
    "allowedHosts": [],
    "allowWebSockets": false,
    "tcpMappings": []
  }
}
```

The controller mounts the canonical workspace root as read-write. A verified bare common directory is also read-write for linked worktrees.

Ordinary external mounts expose their canonical host directories directly at the same guest paths and can use `ro` or `rw` access. The signing public key at `~/.ssh/git/id_ed25519_signing.pub` is the sole file-setting exception and must be read-only. Its guest mount point is the canonical parent directory, not the `.pub` file path. When the VM starts, the controller captures the public-key content in a one-file read-only virtual directory; it contains only `id_ed25519_signing.pub`, not the private-key sibling or other host entries. Restart the VM after key rotation to capture the new public key.

The settings parser rejects these mounts:

- A relative or missing path
- `/` or the complete home directory
- An overlapping mount
- A Pi, controller, Docker, Ketch, credential, or host cache path (except the read-only signing public-key file above)
- A custom guest destination

Private workspace data uses these guest paths:

| Guest path | Purpose |
|---|---|
| `/root/.cache` | Linux tool cache |
| `/root/.npm` | npm cache |
| `/root/.cargo` | Cargo cache |
| `/var/lib/docker` | Ephemeral guest-native Docker state |

The private host root is `~/.cache/pi-gondolin/workspaces/<workspace-key>/`. Docker is deliberately not stored there or mounted from the host.

The workspace provider blocks writes to Git hooks, Git settings, shell startup files, editor settings, and agent settings. It checks lexical and resolved paths.

The provider checks both paths for rename and link operations. It also blocks writes through protected symlinks and pre-existing hard links.

Pi state, Ketch state, private credentials, and the host Docker socket are not guest mounts.

## Network settings

The `network.mode` value has three choices:

- `public-http` permits public HTTP and HTTPS destinations.
- `allowlist` permits only `allowedHosts` entries.
- `offline` disables guest networking.

Gondolin blocks loopback, private, link-local, and metadata addresses. It checks redirects and connection-time DNS results.

WebSockets are disabled by default. Set `allowWebSockets` to `true` to permit them.

A TCP mapping is an explicit exception:

```json
{
  "guestHost": "database.local",
  "guestPort": 5432,
  "connectHost": "127.0.0.1",
  "connectPort": 15432
}
```

Mapped TCP does not use HTTP request checks. Add only the minimum required target.

## Guest image and Docker

The exact Gondolin version is `0.12.0`. The image uses Alpine Linux and QEMU.

The image contains Bash, certificates, Git, OpenSSH client, ripgrep, fd, Node.js, npm, Python, UV, RTK, Docker, Compose, and BuildKit.

The image input digest covers the architecture, image settings, init script, Gondolin version, and pinned RTK assets.

Built images use this path:

```text
~/.cache/pi-gondolin/images/<input-digest>/
```

A cold controller verifies the Gondolin manifest, all asset checksums, and Pi image metadata before it publishes a healthy manifest. A launcher that joins that healthy controller validates its generation and lease instead of repeating the hash pass.

The VM starts one guest-local `dockerd`. It uses the `vfs` storage driver and `/var/lib/docker`.

### Docker storage lifecycle

Docker uses its guest-native `/var/lib/docker` data root with the `vfs` storage driver. It is not a `fuse.sandboxfs` mount, so it supports extended attributes. The representative pinned build below succeeds, including its external-stage copy and `uvx --version`:

```Dockerfile
FROM alpine:3.23
COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /uvx /bin/
RUN uvx --version
```

The tradeoff is deliberate: images, containers, volumes, and BuildKit cache exist only for the current VM. They disappear when its controller stops, the VM restarts, or Docker is reset. `vfs` remains intentional. Do not mount the host Docker socket or host Docker settings.

The host Docker socket and host Docker settings are not mounted. Privileged guest containers remain inside the VM boundary.

## `/sandbox`

Run `/sandbox` in the Pi TUI to inspect or change the sandbox.

The view shows controller health, VM ID, Docker health, roots, mounts, network settings, and generation IDs.

You can do these actions:

- Add or remove an external mount.
- Change mount access.
- Change the network mode and allowed hosts.
- Change WebSocket and TCP settings.
- Restart the VM.
- Replace the shared VM and clear its ephemeral Docker state.

Each accepted settings change replaces the Stow source atomically. Then the controller drains active work and restarts once.

Docker reset requires confirmation. It replaces the shared VM, deleting that VM's guest-native images, containers, volumes, and build cache.

The footer shows a compact VM health marker. Detailed state remains in `/sandbox`.

## `gondolinier` VM and storage management

`gondolinier` is installed through Stow with `./install.sh config`. It never starts a controller or VM.

```bash
gondolinier vm list
gondolinier storage list
gondolinier storage purge
```

`gondolinier vm list` reports connectable Gondolin VMs and identifies a Pi workspace when its validated controller manifest is available.

`gondolinier storage list` shows reclaimable Docker storage from active Pi VMs. It reports Images, Containers, Volumes, Build cache, and a decimal-gigabyte total. Active volumes are called out separately because purge preserves them.

`gondolinier storage purge` displays the same preview, then asks for explicit confirmation. A declined or empty preview changes nothing. On confirmation it runs Docker's reclaimable-only system prune: stopped containers, unused images and volumes, and build cache are removed; active containers and volumes remain.

## Installation

### macOS

Install the required software:

```bash
brew install qemu lz4 e2fsprogs
```

macOS supplies `cpio` and `tar`.

### Linux

Install Node.js 23.6 or newer. Install QEMU, `cpio`, `lz4`, `tar`, and `e2fsprogs` with the system package manager.

For Debian or Ubuntu on ARM64, run:

```bash
sudo apt install qemu-system-arm cpio lz4 tar e2fsprogs
```

Use the matching QEMU system package on x86_64. The rootless Linux bootstrap does not install these OS packages.

Run the settings installer:

```bash
./install.sh config
```

The installer uses Stow. It does not create manual target links.

The installer runs this dependency command:

```bash
npm ci --omit=dev --ignore-scripts
```

Then it builds a missing image or verifies the current image. A missing prerequisite stops the installation with an error.

macOS ARM64 has full native verification. Run the same native suite before you claim support for a Linux host.

## Image and Docker maintenance

Verify the current image:

```bash
node pi/sandbox/build-gondolin-image.mjs --verify --print-path
```

Rebuild the current image:

```bash
node pi/sandbox/build-gondolin-image.mjs --force
```

Use `/sandbox` to replace the shared VM and clear its ephemeral Docker state. Use `gondolinier storage purge` when the VM remains live and you want to reclaim only Docker objects that are safe to remove.

Do not connect the guest to the host Docker socket.

## Unsandboxed bypass

Use `--yolo` only when you explicitly need host built-ins:

```bash
pi --yolo [args...]
```

The launcher removes `--yolo` and starts the real Pi binary directly. It skips controller, image, settings, and environment checks.

The command prints a warning. Host tools and credentials are then available to model-directed operations.

## Verification

Run unit and wrapper tests:

```bash
npm --prefix pi/sandbox test
```

Run native QEMU, Docker, network, tool, child, and Ketch tests:

```bash
npm --prefix pi/sandbox run test:native
```

Measure startup separately with `npm --prefix pi/sandbox run benchmark:startup -- --samples 10`. Performance varies with QEMU and host load, so the benchmark is an acceptance observation rather than a unit-test threshold.

Run extension regressions:

```bash
PI_PACKAGE_ROOT=/path/to/pi-coding-agent npm --prefix pi/agent/extensions/plan-mode test
PI_PACKAGE_ROOT=/path/to/pi-coding-agent node --test pi/agent/extensions/subagent/test/*.test.mjs
npm --prefix pi/agent/packages/ask-user-question test
```

The native canary verifies public HTTPS and blocked internal destinations. It also verifies Docker pull, BuildKit xattrs, Compose, host isolation, and ephemeral Docker state across VM replacement.

The inventory test starts real normal and planning children. It checks replacement sources, host adapters, unknown tools, and handshake failure.

## Accepted risks

The host control plane and audited adapters are trusted. A defect in this code can affect the host.

An allowed public server can receive any guest-readable data. Ketch also has host network access by design.

QEMU escape and denial of service are accepted risks. Keep QEMU and the pinned dependencies current.
