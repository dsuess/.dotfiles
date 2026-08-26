# Pi Gondolin tool sandbox

`~/bin/pi` keeps Pi on the host. It runs model-directed tools in a Gondolin Linux VM.

The boundary has three parts:

- The host control plane runs Pi, model access, sessions, reviewed extensions, and the Gondolin controller.
- The guest tool plane runs `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `!`, and `!!`.
- Audited host adapters run Ketch, structured questions, child orchestration, and plan ledger operations.

A custom Pi extension still runs on the host. Gondolin does not isolate extension code.

## Startup

A normal launch uses this sequence:

1. The launcher finds trusted QEMU and the real Pi binary from one canonical safe PATH. Its filtered child-facing PATH puts the installed Pi directory first, so nested Pi processes do not re-enter the wrapper.
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
  "filesystem": {
    "workspace": {
      "access": "rw",
      "writeProtectedPaths": [".git/config", ".git/hooks"]
    },
    "workspaceOverrides": [
      {
        "root": "~/.dotfiles",
        "access": "rw",
        "writeProtectedPaths": []
      }
    ],
    "bareCommon": {
      "access": "rw",
      "writeProtectedPaths": ["config", "hooks"]
    },
    "externalMounts": [
      { "path": "~/src/shared", "access": "ro" },
      { "path": "~/.ssh/git/id_ed25519_signing.pub", "access": "ro" }
    ]
  },
  "network": {
    "mode": "public-tcp",
    "allowedHosts": [],
    "allowWebSockets": false,
    "tcpMappings": []
  },
  "ingress": {
    "workspaceProfiles": [
      {
        "root": "~/src/example",
        "allowWebSockets": true,
        "listeners": [
          { "name": "app", "hostPort": 3000, "guestPort": 3000 },
          { "name": "api", "hostPort": 0, "guestPort": 8080 }
        ]
      }
    ]
  }
}
```

`filesystem.workspace` is the default canonical-workspace policy. `workspaceOverrides` replace that policy only when an override root resolves to the exact canonical workspace root. An override therefore applies to nested launches and symlink aliases of the same repository, but never to another repository. Override roots must be existing absolute or `~/` directories; duplicate canonical roots are rejected. Protected paths are bounded workspace-relative paths with no traversal or duplicates.

The checked-in `~/.dotfiles` override is intentionally temporary and durable: it remains until it is manually removed or restored in `pi/sandbox/settings.json`. Its empty `writeProtectedPaths` list means the workspace provider is unguarded. Pi can then write Git configuration and hooks, `.pi`, `bin/pi`, `pi/sandbox`, and `pi/agent` in this repository. Do not use an empty list for a workspace you do not intend to trust with those control-plane files. To revert, remove this override (or restore the populated default protection list), then run `./install.sh config` and restart the controller.

The controller mounts the canonical workspace root and a verified bare common directory with the access and protection policies in `filesystem`. It also mounts the developer's `~/local_cache` at `/root/local_cache`, so guest-root Docker Compose expansion of `~/local_cache` reaches the required bind-mount source without exposing the rest of the developer home.

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
| `/root/local_cache` | Developer `~/local_cache` Docker bind-mount source |
| `/var/lib/docker` | Ephemeral guest-native Docker state |

The private host root is `~/.cache/pi-gondolin/workspaces/<workspace-key>/`. Docker is deliberately not stored there or mounted from the host.

A read-only workspace or bare-common mount rejects all writes. A read-write mount with protected paths checks lexical and resolved paths, both paths of rename and link operations, protected symlinks, and pre-existing hard links. A read-write mount with an empty protected-path list intentionally uses an unguarded real provider, so it does not retain the hard-link guard.

Pi state, Ketch state, host private-credential directories, and the host Docker socket are not guest mounts. A project-local `.gcloud/adc.json` remains available through the workspace mount after project authentication; the launcher forwards `GOOGLE_APPLICATION_CREDENTIALS` only when it names that workspace-contained file.

## Network settings

The `network.mode` value has four choices:

- `public-tcp` permits raw TCP to public destinations. It is the checked-in default.
- `public-http` permits public HTTP and HTTPS destinations through Gondolin's mediated HTTP/TLS path.
- `allowlist` permits only `allowedHosts` entries through that mediated path.
- `offline` disables guest networking.

`public-tcp` retains synthetic DNS hostname attribution. Immediately before a host socket opens, it resolves the attributed hostname and rejects the complete result set if any IPv4 or IPv6 answer is loopback, private, carrier-grade NAT, link-local, metadata, or otherwise internal. It therefore blocks direct internal IPs, mixed DNS answers, and DNS rebinding. DNS remains host-controlled and non-DNS UDP remains blocked. Explicit TCP mappings retain their existing narrow behavior.

Public TCP is not an unrestricted network mode. It deliberately does not MITM TLS, inject HTTP secrets, inspect HTTP methods or paths, or selectively block WebSocket upgrades. `allowWebSockets` governs the mediated `public-http` and `allowlist` modes only. In exchange, guest tools, Docker builds, and normal Docker/Compose bridge containers validate public origin certificates using their normal distribution or image CA stores. Gondolin's MITM CA is not mounted into the guest or containers, and no Gondolin CA environment override is set.

WebSockets are disabled by default. Set `allowWebSockets` to `true` only for a mediated mode.

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

## HTTP ingress workspace profiles

`ingress.workspaceProfiles` exposes declared **guest-loopback HTTP services** to the host. It is independent of `network`: an explicit host listener can work while guest egress is `offline`.

A profile applies only when its existing absolute or `~/` `root` resolves to the controller's exact canonical workspace root. Symlink aliases resolve to the same root and duplicate roots are rejected. The profile's configured portable root is retained when `/sandbox` saves the Stow source. At most 32 profiles and 16 listeners per profile are accepted. Listener names and nonzero preferred host ports must be unique within a profile.

Each host listener binds only `127.0.0.1`. `hostPort: 0` directly requests an ephemeral port. A nonzero `hostPort` is preferred; if and only if it is already in use, the controller selects an ephemeral port and marks the reported listener as a fallback. Permission errors and every other bind error fail startup. A fallback can break application code that hard-codes the preferred URL; the sandbox reports it but does not rewrite application configuration.

The controller creates one private Gondolin HTTP/1.1 gateway per VM, with unguessable internal path routes to the declared guest ports, then creates the localhost host listeners. Adapters accept only bounded HTTP/1.1 origin-form request lines, preserve the original method, path, query, Host header, request/response streaming, SSE, status, and upgrade bytes, and reject absolute-form, malformed, and raw-protocol input. `allowWebSockets` controls WebSocket upgrades for the whole profile.

A host listener is not a `network.tcpMappings` egress mapping, a Docker port publication, or a general TCP tunnel. It cannot expose debugpy, databases, SSH, or another raw debugger/database protocol. Docker may publish a container port *inside the guest*; a declared HTTP host listener can then reach that guest port through the supported gateway.

Listeners are VM lifecycle state. They are created after each VM start and closed before VM replacement, reset, reload, or final lease release. A listener being bound means ingress infrastructure is healthy, not that its backend application is ready: a service that has not started can correctly return `502`.

The checked-in Visonic profile declares Manager (`28080`), UI (`25173`), Storybook (`26006`), Conductor (`28083`), ProcessorCPU (`28081`), and optional ProcessorGPU (`28082`), with WebSockets enabled. It deliberately excludes raw debugger ports.

## Guest image and Docker

The exact Gondolin version is `0.12.0`. The rootfs Dockerfile installs the architecture-matched Debian Trixie kernel metapackage (`linux-image-arm64` or `linux-image-amd64`) into the digest-pinned Node 24 Debian OCI image. Image assembly extracts that kernel only after it finds one `/boot/vmlinuz-*` and its matching `/lib/modules/<release>` tree, then replaces Gondolin's temporary Alpine `linux-virt` kernel asset before publication. Alpine remains only the Gondolin initramfs/bootstrap layer; QEMU and the running tool plane use the matching Debian kernel, modules, and glibc userspace.

The image contains Bash, certificates, Git/OpenSSH, ripgrep/fd, Node/npm, Python, UV, direct RTK, GCC plus glibc/Python/Linux development headers, Docker/Buildx/Compose, iptables, e2fsprogs, `gcloud`, and `direnv`. It also contains system Chromium and DejaVu/Liberation fonts. System Chromium is a baseline; repositories can still install their Playwright release's matching Chromium into the persistent guest cache.

The image input digest covers the architecture, Gondolin settings and init script, the reviewed rootfs Dockerfile (including its base-image digest and standalone-tool checksums), and Gondolin version.

Built images use this path:

```text
~/.cache/pi-gondolin/images/<input-digest>/
```

This persistent **host VM image cache** contains immutable boot assets. A changed reviewed input creates a new digest; old generations accumulate until an explicit confirmed `gondolinier storage purge` removes stale ones.

A cold controller verifies the Gondolin manifest, all asset checksums, and Pi image metadata before it publishes a healthy manifest. The metadata records and verifies the Debian package, architecture, release, and kernel checksum; the manifest build ID is recomputed from the replaced asset checksums. A launcher that joins that healthy controller validates its generation and lease instead of repeating the hash pass.

The VM starts one guest-local `dockerd`. It uses the `vfs` storage driver and `/var/lib/docker`, with Docker's normal bridge, iptables/nftables, IP-forwarding, and masquerading defaults. A supported VM kernel must provide the default `bridge` network and user-defined bridge networks for Docker builds, Compose, DNS, and outbound HTTPS. This remains inside the VM and its network policy; it never exposes the host network namespace, Docker socket, or Docker settings.

At boot the guest reads QEMU's RTC, then rechecks it every 30 seconds. Before every controller execution, the controller synchronizes the RTC again and fails the requested workload closed if synchronization fails. This repairs post-sleep certificate-validity drift without NTP egress.

### Docker storage lifecycle

Docker uses its guest-native `/var/lib/docker` data root with the `vfs` storage driver. The temporary writable VM disk defaults to 64G and can consume host disk as Docker writes. Set `PI_GONDOLIN_ROOTFS_SIZE` before the first Pi launch for a workspace to change its capacity, for example `PI_GONDOLIN_ROOTFS_SIZE=96G pi`; an existing controller keeps its current disk size. It is not a `fuse.sandboxfs` mount, so it supports extended attributes. The representative pinned build below succeeds, including its external-stage copy and `uvx --version`:

```Dockerfile
FROM alpine:3.23
COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /uvx /bin/
RUN uvx --version
```

The tradeoff is deliberate: images, containers, volumes, and BuildKit cache exist only for the current VM. They disappear when its controller stops, the VM restarts, or Docker is reset. `vfs` remains intentional. Do not mount the host Docker socket or host Docker settings.

The host Docker socket and host Docker settings are not mounted. Privileged guest containers remain inside the VM boundary.

## `/sandbox`

Run `/sandbox` in the Pi TUI to inspect or change the sandbox.

The view shows controller health, VM ID, Docker health, canonical workspace and bare-common mount access, external mounts, egress network settings, the active ingress workspace profile, every named host listener URL, and generation IDs.

You can do these actions:

- Add or remove an external mount.
- Change mount access.
- Change the network mode and allowed hosts.
- Change egress WebSocket and TCP settings.
- Edit listeners for the current workspace only with `name:hostPort=guestPort` (for example, `api:3000=8080`); toggle its ingress WebSocket setting.
- Restart the VM.
- Replace the shared VM and clear its ephemeral Docker state.

Each accepted settings change preserves all sibling ingress profiles and the complete `filesystem` policy, replaces the Stow source atomically, then drains active work and restarts once. `/sandbox` edits only the active workspace's ingress profile; it does not create or remove profiles for another workspace or workspace overrides. Fixed listeners appear in `/sandbox`; a fallback URL is also announced at session start and after VM restart because its preferred URL is invalid.

Docker reset requires confirmation. It replaces the shared VM, deleting that VM's guest-native images, containers, volumes, and build cache.

The footer shows a compact VM health marker. Detailed state remains in `/sandbox`.

## `gondolinier` VM and storage management

`gondolinier` is installed through Stow with `./install.sh config`. It never starts a controller or VM.

```bash
gondolinier image build
gondolinier vm list
gondolinier storage list
gondolinier storage purge
```

`gondolinier image build` force-builds the local Docker OCI rootfs, imports it into Gondolin, verifies the checksum-addressed result, and removes the temporary Docker tag. It never starts a controller or VM.

`gondolinier vm list` reports connectable Gondolin VMs and identifies a Pi workspace when its validated controller manifest is available.

`gondolinier storage list` shows two storage classes without starting a controller or VM:

- **Docker storage** is reclaimable Images, Containers, Volumes, and Build cache inside active ephemeral VMs. It reports a decimal-gigabyte total. Active volumes are called out separately because purge preserves them.
- **Host VM image cache** is allocated host disk space in immutable boot assets under `<cache-root>/images/<image-generation>`. It reports current and live-controller **protected image generations**, **stale image generations** that are reclaimable, and unrecognized entries that remain preserved.

The current input digest needed for the next launch and every generation named by a validated live controller manifest are protected. A recognized cached generation that is neither is stale. Malformed metadata, symlinks, non-generation names, and other unrecognized entries remain visible but are never reclaimed.

`gondolinier storage purge` displays the same combined preview, then asks for explicit confirmation. A declined or empty preview changes nothing. On confirmation it runs Docker's reclaimable-only system prune: stopped containers, unused images and volumes, and build cache are removed; active containers and volumes remain. It also removes only the stale host VM image generations shown in the preview, after revalidating each target immediately before deletion.

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

A running host Docker daemon is required only when the rootfs/image cache is missing or its reviewed inputs changed. A verified unchanged cache does not require Docker. The Docker socket is a host build-time dependency only and is never mounted into the guest.

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

Force-rebuild the current image:

```bash
gondolinier image build
```

The lower-level command remains useful for cache-aware installation and verification:

```bash
node pi/sandbox/build-gondolin-image.mjs --force
```

Use `/sandbox` to replace the shared VM and clear its ephemeral Docker state. Use `gondolinier storage purge` to reclaim safe Docker objects from live VMs and stale persistent host VM image generations; it preserves current, live-controller, and unrecognized image-cache entries.

Do not connect the guest to the host Docker socket.

## Unsandboxed bypass

Use `--yolo` only when you explicitly need host built-ins:

```bash
pi --yolo [args...]
```

The launcher removes `--yolo` and starts the real Pi binary directly. It skips controller, image, settings, and environment checks.

Yolo preserves the unfiltered host environment and every host PATH entry, but prepends the installed Pi directory to PATH. A child Pi process, including a subagent that launches the command name `pi`, therefore reaches the installed binary directly instead of re-entering the sandbox wrapper.

The command prints a warning. Host tools and credentials are then available to model-directed operations.

## Verification

For every Pi change, run the complete gate from an ordinary terminal or a `pi --yolo` session:

```bash
npm --prefix pi run check
```

It runs maintained extension and package checks, deterministic Gondolin unit/wrapper tests, then native QEMU, Docker, routed-tool, production-inventory, Ketch, and live-network canaries. It stops at the first failed suite. It resolves the installed Pi package through `PI_PACKAGE_ROOT` or Homebrew's stable `opt` path; non-Homebrew environments must set `PI_PACKAGE_ROOT`.

Use the deterministic-only phase during development:

```bash
npm --prefix pi run check:deterministic
```

A Gondolin-routed Bash process cannot validate the host sandbox from inside itself. In that session, run only the deterministic phase and report native checks as unverified; run the full command on the host before completion.

Measure startup separately with `npm --prefix pi/sandbox run benchmark:startup -- --samples 10`. Performance varies with QEMU and host load, so the benchmark is an acceptance observation rather than a unit-test threshold.

The native canary verifies Debian/glibc identity, direct RTK, system and Playwright Chromium, fonts, Python/Linux header compilation, `gcloud`, `direnv`, RTC recovery and HTTPS, public HTTPS and blocked internal destinations. It also verifies Docker's default bridge and a user-defined bridge network, DNS/HTTPS from a default-network container, normal-network BuildKit and Compose, host isolation, and ephemeral Docker state across VM replacement.

The inventory test starts real normal and planning children. It checks replacement sources, host adapters, unknown tools, and handshake failure.

## Accepted risks

The host control plane and audited adapters are trusted. A defect in this code can affect the host.

An allowed public server can receive any guest-readable data. Ketch also has host network access by design.

QEMU escape and denial of service are accepted risks. Keep QEMU and the pinned dependencies current.
