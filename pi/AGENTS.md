# Pi Configuration Development

Repository-wide rules are in `../AGENTS.md`. `agent/AGENTS.md` is Pi's runtime system prompt; do not modify it unless the user requests a prompt change.

## Deployment

- `agent/` is stowed to `~/.pi/agent`, and `sandbox/` to `~/.pi/sandbox`.
- Deploy only with `./install.sh config`.
- Preserve unrelated runtime-written settings in `agent/settings.json`.

## SRT tool-routing invariants

- Pi, provider authentication, extension UI, and trusted-provenance non-core adapters stay on the host. Normal launches start sandboxed. On normal launches, the seven core tools and user Bash use per-operation SRT unless the user explicitly selects conversation-local `/sandbox off`.
- Normal startup fails closed. Missing SRT package, verified patch, controller, policy, sidecar inventory, or routing handshake must leave native core tools disabled and block model input.
- `pi --yolo` is the explicit host-native bypass: it must skip SRT preflight and routing, retain Pi's native built-ins, and warn on stderr. The launcher starts every normal Pi process with native built-ins disabled and the routing extension activates required replacements only after trusted provenance and readiness checks.
- A root Pi client owns the canonical-workspace controller lease. Reloaded and child clients attach through opaque capabilities; they cannot start or release a controller.
- While sandboxed, tool commands receive only the private Docker broker endpoint. Do not expose host Docker sockets, Docker Sandboxes control variables, SSH agents, credential stores, or controller state through grants. Explicit off mode uses ordinary host-user access, environment values, and Docker configuration. Never add a filesystem-only host Docker exception.
- Keep the controller sandbox-only. Bind effective grant snapshots to individual clients, not shared leases. A saved grant edit updates the current client and future clients. Other active clients retain their snapshots until explicit `/sandbox reload`. Do not include saved configuration bytes in controller replacement identity or use global SRT policy updates for client-local changes.
- `/sandbox` provides explicit user controls through a menu and subcommands. Show only the opposite-mode action in the menu. Keep exact syntax and behavior consistent with `sandbox/README.md`. Do not expose mode or grant changes as model tools or shell endpoints. Keep status available without dialogs. Cancellation must not change state. Reject unsupported non-interactive mutations explicitly.
- Require idle operation boundaries for mode and grant changes. Validate the effective policy and controller readiness before enabling sandboxing. If re-enabling fails, block core execution rather than continue silently on the host. If save succeeds but activation fails, report the mismatch and block sandboxed operations until successful refresh.
- Preserve off mode and the effective snapshot across Pi `/reload` in the same process and conversation. Reset sandbox mode on `/new`, `/resume`, `/fork`, and restart, except explicit `--yolo` launches. Replacement conversations load saved defaults. Child agents must not inherit off authority. Keep the planning mutation guard independent of sandbox mode.
- After `/sandbox off`, display an immediate host-access warning and one persistent red `● sandbox: off — host access` indicator in the sandbox footer segment without another confirmation dialog. Controller health updates must not erase the indicator. Re-enabling affects future operations only. It cannot undo host effects or stop escaped background processes.
- Saved filesystem grants retain the versioned `filesystem.readOnly` and `filesystem.readWrite` schema in `sandbox/config.json`. Write atomically through the resolved Stow target. Preserve deployment symlinks. Retain edits in git. Serialize edits. Reject stale revisions.
- Validate grants as safe existing directories. Bound both lexical Stow/symlink paths and canonical targets. Preserve credential/runtime exclusions, workspace overlap rules, and duplicate/overlap rules. Read-write includes read but never changes OS permissions or privileges. Removal revokes only configured access, not derived workspace or tool access.
- Grants never create Docker mounts, PATH entries, generated-HOME contents, or forwarded environment access. Do not claim automatic once/session permission prompts work without a production broker lifecycle. Use `pi-sbx` for persistent Docker management, not `/sandbox`.
- Pi SRT routing must not add proxy-side credential masking or token substitution. Forward tool-environment secrets directly. Keep sandboxed credential files and control sockets denied, apart from reviewed policy exceptions.
- Keep Ketch on its trusted canonical host-side path. Do not add a Ketch broker.
- Keep routed MCP admission separate from host adapters. Admit only the reviewed canonical Visonic dev Serena profile through controller-owned stdio. Bind each definition to canonical routing provenance and a live, current-policy session. Project trust and tool names alone grant no authority.
- Recheck reviewed MCP inputs on reconnect. Retire process groups before policy activation and on session replacement. Reject stale authority and never replay an ambiguous edit. Keep Serena under SRT after `/sandbox off`. Preserve upstream MCP behavior for `--yolo` and shell CLI dispatch.
- Compose dynamic MCP declarations with the independent planning guard. Permit only the four reviewed inspection offerings during planning. Block all structural edits regardless of server hints. Do not restore unrelated tools during late registration or planning exit.
- Use generated runtime paths for Serena and language-server writes, including npm cache. Do not broaden grants or change host installation permissions to satisfy startup prerequisites.
- For launcher or routed-command changes, test the exact documented argument order and the real user-Bash path; model prose is never evidence that a shell command executed.

## Verification

- Run the narrowest relevant package checks during development.
- Before completing Pi changes, run `npm --prefix pi run check` from an ordinary host terminal. The full gate includes deterministic routing tests and native SRT/Docker checks.
