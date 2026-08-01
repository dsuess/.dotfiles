# Pi whole-process sandbox

`~/bin/pi` wraps the installed Pi binary with
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
The OS boundary applies to Pi itself and its entire process tree: built-in
tools, `!` commands, extension tools, MCP processes, and `pi-subagents`.

The wrapper is deliberately fail-closed. Missing dependencies, an invalid
policy, or sandbox initialization failure stops Pi; there is no automatic
unsandboxed fallback.

## Unsandboxed bypass

Pass `--yolo` to explicitly bypass the wrapper's sandbox:

```bash
pi --yolo [args...]
```

The wrapper consumes `--yolo` and launches the installed Pi binary directly,
without sandbox prerequisite checks, policy enforcement, or environment
filtering. It prints a warning because Pi and all model-invoked subprocesses
then have the same host access and credentials as the calling shell.

## Installation

Run:

```bash
./install.sh config
```

This stows the wrapper to `~/bin/pi`, stows this directory to
`~/.pi/sandbox`, and runs `npm ci` for the pinned runtime.

Both platforms require Node.js 20.11 or newer and `rg`. macOS uses the system
`sandbox-exec`; Linux additionally requires `bwrap` and `socat`. The wrapper
names any missing prerequisite and exits.

## Policy

`settings.json` is the trusted policy:

- The current working directory writes through to the host.
- Other home-directory reads and writes are denied unless explicitly listed.
- Pi's own `~/.pi/agent` state is available so auth refresh, sessions,
  packages, and trust decisions continue to work.
- Ambient environment credentials and common credential files remain hidden.
- Network access is restricted to the checked-in provider and development
  hosts, plus localhost for vLLM-MLX.
- macOS pseudo-terminal operations are allowed so Pi can put its interactive
  terminal into raw mode.
- Apple Events and host Unix sockets remain blocked. The wrapper exposes only a
  loopback Herdr status broker to the official Pi integration.

Edit the checked-in policy outside sandboxed Pi to add another directory or
domain. The wrapper, policy, and plan-mode gate are write-protected from
inside Pi, including when this dotfiles repository is the workspace.

Run `npm run test:broker` for the Herdr broker API checks,
`npm run test:wrapper` for launcher checks, and `npm run test:containment` from
an unsandboxed terminal for native filesystem and network enforcement checks.
A containment test cannot apply another native sandbox when invoked from an
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
and the native Herdr Unix socket remains blocked on both macOS and Linux.

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
code can therefore read those credentials, and any allowed multi-tenant
domain can be an exfiltration channel. Unrelated host credentials are not
passed through. SRT 0.0.67 filters by hostname rather than port, so an allowed
host is reachable on any port and enabling localhost also permits other local
ports. On macOS, sandboxed child processes can also interact with
permission-accessible pseudo-terminals; this is required by Pi's TUI.
