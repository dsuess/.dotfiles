# Pi Gondolin tool sandbox

`~/bin/pi` keeps Pi on the host. It runs model-directed tools in a Gondolin Linux VM.

The boundary has three parts:

- The host control plane runs Pi, model access, sessions, reviewed extensions, the Herdr broker, and the Gondolin controller.
- The guest tool plane runs `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `!`, and `!!`.
- Audited host adapters run Ketch, structured questions, child orchestration, and plan ledger operations.

A custom Pi extension still runs on the host. Gondolin does not isolate extension code.

## Startup

A normal launch uses this sequence:

1. The launcher finds trusted Node.js, QEMU, Git, and the real Pi binary.
2. The launcher verifies the pinned image and the versioned settings.
3. The launcher acquires one workspace controller lease.
4. The launcher disables all native Pi built-ins.
5. The launcher passes private tool requests to the routing extension.
6. The extension connects to the controller and checks each tool source.
7. The launcher waits for the extension handshake.

The launch stops if any step fails. The launcher never retries with host built-ins.

The controller uses one VM for all root sessions in one canonical workspace. Child Pi processes use the same lease and VM.

A different workspace gets a different controller state directory. The controller stops after the last root lease ends or expires.

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
    { "path": "~/src/shared", "access": "ro" }
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

External mount destinations equal their canonical host paths. An external mount can use `ro` or `rw` access.

The settings parser rejects these mounts:

- A relative or missing path
- `/` or the complete home directory
- An overlapping mount
- A Pi, controller, Docker, Ketch, credential, or host cache path
- A custom guest destination

Private workspace data uses these guest paths:

| Guest path | Purpose |
|---|---|
| `/root/.cache` | Linux tool cache |
| `/root/.npm` | npm cache |
| `/root/.cargo` | Cargo cache |
| `/var/lib/docker` | Guest Docker state |

The private host root is `~/.cache/pi-gondolin/workspaces/<workspace-key>/`.

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

The launcher verifies the Gondolin manifest, all asset checksums, and Pi image metadata.

The VM starts one guest-local `dockerd`. It uses the `vfs` storage driver and `/var/lib/docker`.

The host Docker socket and host Docker settings are not mounted. Privileged guest containers remain inside the VM boundary.

One workspace controller prevents two Docker daemons from using the same data directory. Images, containers, and volumes remain after VM restart.

## `/sandbox`

Run `/sandbox` in the Pi TUI to inspect or change the sandbox.

The view shows controller health, VM ID, Docker health, roots, mounts, network settings, and generation IDs.

You can do these actions:

- Add or remove an external mount.
- Change mount access.
- Change the network mode and allowed hosts.
- Change WebSocket and TCP settings.
- Restart the VM.
- Reset Docker state for the current workspace.

Each accepted settings change replaces the Stow source atomically. Then the controller drains active work and restarts once.

Docker reset requires confirmation. It removes only the current workspace Docker directory.

The footer shows a compact VM health marker. Detailed state remains in `/sandbox`.

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

Use `/sandbox` to reset only the current workspace Docker state.

You can also stop Pi and remove this directory:

```text
~/.cache/pi-gondolin/workspaces/<workspace-key>/docker
```

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

Run extension regressions:

```bash
PI_PACKAGE_ROOT=/path/to/pi-coding-agent npm --prefix pi/agent/extensions/plan-mode test
PI_PACKAGE_ROOT=/path/to/pi-coding-agent node --test pi/agent/extensions/subagent/test/*.test.mjs
npm --prefix pi/agent/packages/ask-user-question test
```

The native canary verifies public HTTPS and blocked internal destinations. It also verifies Docker pull, BuildKit, Compose, and persistent state.

The inventory test starts real normal and planning children. It checks replacement sources, host adapters, unknown tools, and handshake failure.

## Accepted risks

The host control plane and audited adapters are trusted. A defect in this code can affect the host.

An allowed public server can receive any guest-readable data. Ketch also has host network access by design.

QEMU escape and denial of service are accepted risks. Keep QEMU and the pinned dependencies current.
