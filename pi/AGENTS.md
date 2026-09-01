# Pi Configuration Development

Repository-wide rules are in `../AGENTS.md`. `agent/AGENTS.md` is Pi's runtime system prompt; do not modify it unless the user requests a prompt change.

## Deployment

- `agent/` is stowed to `~/.pi/agent`, and `sandbox/` to `~/.pi/sandbox`.
- Deploy only with `./install.sh config`.
- Preserve unrelated runtime-written settings in `agent/settings.json`.

## SRT tool-routing invariants

- Pi, provider authentication, extension UI, and audited non-core adapters stay on the host. Except for explicit `--yolo` launches, every model-directed core file and shell operation runs through the per-operation SRT controller.
- Normal startup fails closed. Missing SRT package, verified patch, controller, policy, sidecar inventory, or routing handshake must leave native core tools disabled and block model input.
- `pi --yolo` is the explicit host-native bypass: it must skip SRT preflight and routing, retain Pi's native built-ins, and warn on stderr. The launcher starts every normal Pi process with native built-ins disabled and the routing extension activates exact audited replacements only after readiness.
- A root Pi client owns the canonical-workspace controller lease. Reloaded and child clients attach through opaque capabilities; they cannot start or release a controller.
- The private Docker broker is the only Docker endpoint given to tool commands. Never expose host Docker, Docker Sandboxes control variables, SSH agents, credential stores, or controller state.
- `/sandbox` is a read-only live status surface. Controller policy is derived by the controller, not a settings file; it must not advertise or apply editable grants, mounts, ingress, reloads, or sidecar lifecycle actions. Use `pi-sbx` for persistent Docker management.
- Permission grants are scoped once or for the current controller session. Do not claim that persistent settings are applied.
- Pi SRT routing must not add proxy-side credential masking or token substitution. Tool-environment secrets are forwarded directly while credential files and control sockets remain denied unless explicitly approved.
- Keep Ketch on its audited host-side path. Do not add a Ketch broker.
- For launcher or routed-command changes, test the exact documented argument order and the real user-Bash path; model prose is never evidence that a shell command executed.

## Verification

- Run the narrowest relevant package checks during development.
- Before completing Pi changes, run `npm --prefix pi run check` from an ordinary host terminal. The full gate includes deterministic routing tests and native SRT/Docker checks.
