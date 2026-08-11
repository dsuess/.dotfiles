# Pi whole-process sandbox

`~/bin/pi` wraps the installed Pi binary with
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
The OS boundary applies to Pi and its entire process tree: built-in tools, `!`
commands, extension tools, MCP processes, `pi-subagents`, and native Ketch
processes. It restricts filesystem access while deliberately leaving host
network and Unix-socket access unrestricted.

The boundary is fail-closed. Missing dependencies, an invalid policy, or
sandbox initialization failure stops the launch; there is no automatic
unsandboxed fallback.

## Unsandboxed bypass

Pass `--yolo` to explicitly bypass the wrapper's sandbox:

```bash
pi --yolo [args...]
```

The wrapper consumes `--yolo` and launches the installed Pi binary directly,
without sandbox prerequisite checks, policy enforcement, or environment
filtering. The wrapper prints a warning because Pi and all model-invoked
subprocesses then have the same host filesystem access and credentials as the
calling shell.

## Installation

Run:

```bash
./install.sh config
```

This stows the wrapper to `~/bin/pi`, stows this directory to
`~/.pi/sandbox`, and runs `npm ci` for the pinned runtime.

Both platforms require Node.js 20.11 or newer and `rg`. macOS uses the system
`sandbox-exec`; Linux additionally requires `bwrap` and `socat`. The installer
also provisions a pinned Ketch binary on Linux when none is on `PATH`, but
Ketch is not a launcher prerequisite. The wrapper names any missing sandbox
prerequisite and exits. A trusted `git` outside the candidate repository is
optional: when it is unavailable, repository scope discovery fails narrow to
the physical launch directory.

## Policy

`settings.json` is the trusted base policy. For each launch, the wrapper builds
a private, ephemeral effective policy without changing the checked-in file:

- Outside a valid Git working tree, the physical launch directory reads and
  writes through to the host, preserving the original boundary.
- Inside a valid working tree, the nearest working-tree root is recursively
  readable and writable even when Pi starts in a nested directory. Pi still
  starts in the physical launch directory.
- A linked worktree whose common repository is verified as bare also receives
  recursive access to that bare common directory. This permits ordinary Git
  updates to objects, refs, logs, lockfiles, and linked-worktree administration.
- A linked worktree backed by a non-bare repository receives no external common
  directory grant. Its working-tree root is still granted normally.
- Malformed or stale metadata, failed Git verification, paths the policy cannot
  represent literally, or an unavailable trusted host Git never broaden the
  boundary; the wrapper falls back to the physical launch directory.
- Other home-directory reads and writes are denied unless explicitly listed.
- Pi's own `~/.pi/agent` state is available so auth refresh, sessions,
  packages, and trust decisions continue to work. Its Stow source,
  `~/.dotfiles/pi/agent`, is also writable so runtime settings saves that
  resolve the symlink can safely replace their target.
- Ambient environment credentials and common credential files remain hidden.
- Outbound network access is unrestricted. Pi and all descendants can reach
  public, private, loopback, and metadata services using host networking.
- macOS pseudo-terminal operations are allowed so Pi can put its interactive
  terminal into raw mode.
- macOS trust-service access is enabled so Go HTTPS clients such as Ketch can
  verify certificates.
- Apple Events remain blocked. Host Unix sockets are allowed as part of the
  unrestricted traffic policy; the Herdr status integration still uses its
  authenticated loopback broker rather than exposing its socket path.

## Unrestricted network

SRT's settings schema requires `network.allowedDomains` and has no supported
"disable network policy" setting. `unrestricted-network.mjs` therefore
validates and initializes the checked-in policy, removes that field from the
in-memory configuration, and only then asks SRT to wrap Pi. SRT consequently
retains filesystem, credential, PTY, and Apple Event controls but does not emit
its network boundary or proxy environment. `allowAllUnixSockets` is also set so
local socket traffic is unrestricted on every supported platform.

This is intentionally unrestricted host networking, not a broad HTTP
allowlist. Pi and every descendant can use arbitrary outbound protocols and can
reach public sites, localhost, private networks, cloud metadata services, and
host Unix sockets.

The upstream `pi-ketch` package launches Ketch directly without a shell; Ketch
and any configured browser inherit the same filesystem sandbox and unrestricted
network.

`enableWeakerNetworkIsolation` remains enabled on macOS so Go HTTPS clients can
use `com.apple.trustd.agent` for certificate verification. Credential filtering
and the Apple Events deny remain unchanged.

Filesystem grants remain subject to higher-priority write denies. At a
working-tree root, Git hooks and configuration plus the runtime's protected
shell, agent, and editor execution configuration remain non-writable. In a bare
common directory, root-level `hooks/` and `config` remain non-writable while Git
data and worktree administration stay writable.

Repository discovery first excludes the untrusted candidate worktree and its
candidate metadata from bootstrap executable lookup. It then uses a host Git
outside those paths with ambient Git configuration and repository-selection
environment variables removed. Only canonical, Git-verified paths are added to
the effective policy. The temporary policy protects itself from writes and is
removed when the wrapper exits.

Edit the checked-in policy outside sandboxed Pi to add another filesystem path.
The wrapper, policy, and plan-mode gate are write-protected from inside Pi,
including when this dotfiles repository is the workspace.

Run `npm run test:broker` for the Herdr broker API checks,
`npm run test:wrapper` for launcher compatibility,
`npm run test:repository` for repository scope and policy composition, and
`npm run test:ketch-config` for cross-platform deployment. Run
`npm run test:containment` from an unsandboxed terminal for native filesystem,
unrestricted-network, normal-repository, and bare-worktree enforcement.
`npm run test:ketch-live` verifies direct Ketch access to an arbitrary host.
Native sandbox tests cannot apply another boundary when invoked from an
already-sandboxed agent session.

## Plan mode

The plan-mode extension is a separate model-facing workflow guard. During
planning it hides mutation and unknown custom tools, and it rejects shell
commands that match a known-mutator denylist. The detector is intentionally
**fail-open**: unclassified commands are allowed, so plan mode cannot promise
that the workspace is absolutely read-only.

Trusted extension code may atomically write the active plan/ledger under the
project's `.pi/plans/`, and the user's configured editor may edit that plan for
review. These trusted plan writes are distinct from model-facing mutation tools.

The whole-process wrapper is the OS security boundary. It confines Pi and its
process tree to policy-approved locations, but the current workspace is one of
those writable locations. Therefore the sandbox does not turn arbitrary
planning-mode shell programs into read-only operations; the denylist remains a
workflow convenience rather than a complete mutation boundary.

## Herdr status broker

When Pi starts inside Herdr, the wrapper launches a small unsandboxed broker on
a random loopback port. Pi receives that port and a per-process token instead
of `HERDR_SOCKET_PATH`. The broker accepts only `pane.report_agent`,
`pane.report_agent_session`, and `pane.release_agent`; it fixes the pane,
source, agent, and sequence values before forwarding to Herdr. All other Herdr
methods are rejected, agent-session paths are confined to Pi's session tree,
and the native Herdr Unix socket path is not passed into Pi's environment.

The broker transport is a local adaptation in the generated
`herdr-agent-state.ts`. Reinstalling Herdr's Pi integration may overwrite that
file; preserve or restore the tracked broker transport. The wrapper never falls
back to exposing the real Herdr socket.

Model-invoked code can still spoof Pi's own reported state because it shares the
broker capability with the extension. That narrow status mutation is inherent
in making status reporting available inside the sandbox; it does not provide
pane control, process launch, terminal input, or any other Herdr operation.
`--yolo` bypasses this design together with the rest of the sandbox and retains
Herdr's normal direct integration.

## Accepted credential risk

Pi's `auth.json` is intentionally available inside the sandbox. Model-invoked
code can therefore read those credentials, and unrestricted network access is
an exfiltration channel to any reachable destination. Ketch runs in the same
process-tree boundary and can read every filesystem path granted to Pi,
including the workspace, Pi auth, and managed Ketch configuration and cache.
Fetched text remains untrusted source material and must not be treated as agent
instructions.

On macOS, sandboxed child processes can also interact with
permission-accessible pseudo-terminals; this is required by Pi's TUI.
