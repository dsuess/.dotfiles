# Pi Configuration Development

Repository-wide rules are in `../AGENTS.md`. `agent/AGENTS.md` is Pi's runtime system prompt; do not modify it unless the user requests a prompt change.

## Deployment

- `agent/` is stowed to `~/.pi/agent`, and `sandbox/` to `~/.pi/sandbox`.
- Deploy only with `./install.sh config`.
- Preserve unrelated runtime-written settings in `agent/settings.json`.

## SRT tool-routing invariants

- Pi, provider authentication, extension UI, and audited non-core adapters stay on the host. Every model-directed core file and shell operation runs through the per-operation SRT controller.
- Normal startup fails closed. Missing SRT package, verified patch, controller, policy, sidecar inventory, or routing handshake must leave native core tools disabled and block model input.
- There is no host-built-in bypass. The launcher starts Pi with native built-ins disabled and the routing extension activates exact audited replacements only after readiness.
- A root Pi client owns the canonical-workspace controller lease. Reloaded and child clients attach through opaque capabilities; they cannot start or release a controller.
- The private Docker broker is the only Docker endpoint given to tool commands. Never expose host Docker, Docker Sandboxes control variables, SSH agents, credential stores, or controller state.
- Permission grants are canonicalized and scoped once, session, or persistent. Persistent settings use the resolved Stow source and a locked atomic write.
- Pi SRT routing must not add proxy-side credential masking or token substitution. Tool-environment secrets are forwarded directly while credential files and control sockets remain denied unless explicitly approved.
- Keep Ketch on its audited host-side path. Do not add a Ketch broker.

## Verification

- Run the narrowest relevant package checks during development.
- Before completing Pi changes, run `npm --prefix pi run check` from an ordinary host terminal. The full gate includes deterministic routing tests and native SRT/Docker checks.
