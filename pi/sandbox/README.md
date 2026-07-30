# Pi whole-process sandbox

`~/bin/pi` wraps the installed Pi binary with
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).
The OS boundary applies to Pi itself and its entire process tree: built-in
tools, `!` commands, extension tools, MCP processes, and `pi-subagents`.

The wrapper is deliberately fail-closed. Missing dependencies, an invalid
policy, or sandbox initialization failure stops Pi; there is no unsandboxed
fallback.

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
- Apple Events and host Unix sockets, including Docker, remain blocked.

Edit the checked-in policy outside sandboxed Pi to add another directory or
domain. The wrapper, policy, and plan-mode gate are write-protected from
inside Pi, including when this dotfiles repository is the workspace.

Run `npm run test:wrapper` for launcher checks and
`npm run test:containment` from a normal terminal for native filesystem and
network enforcement checks. A containment test cannot apply another native
sandbox when invoked from an already-sandboxed agent session.

## Plan mode

The existing plan-mode extension remains a separate workflow guard. It hides
mutation tools and rejects mutating shell commands before plan approval. The
whole-process wrapper is the security boundary; the extension only adds the
temporary promise that the allowed workspace will not change during planning.

## Accepted credential risk

Pi's `auth.json` is intentionally available inside the sandbox. Model-invoked
code can therefore read those credentials, and any allowed multi-tenant
domain can be an exfiltration channel. Unrelated host credentials are not
passed through. SRT 0.0.67 filters by hostname rather than port, so an allowed
host is reachable on any port and enabling localhost also permits other local
ports. On macOS, sandboxed child processes can also interact with
permission-accessible pseudo-terminals; this is required by Pi's TUI.
