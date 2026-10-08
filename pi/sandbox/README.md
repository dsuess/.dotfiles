# Pi SRT tool routing

Pi, its UI, provider authentication, and trusted-provenance non-core adapters run on the host. Normal launches start with sandboxing on. The seven core file and shell tools and user Bash use one SRT process per operation.

`/sandbox off` selects host execution for core tools and user Bash in the current conversation. Reviewed Serena tools remain under SRT. `pi --yolo` remains the explicit host-native launch path. Normal launches never silently fall back to host execution.

## Security contract

Sandbox filesystem, environment, and Docker restrictions apply while sandboxing is on. Tool provenance and integrity checks remain mandatory in both modes. The trusted controller remains sandbox-only, even when one client selects host execution.

- Tool authority comes from provenance, not compatibility fingerprints. Every routed built-in slot must come from the canonical user-scoped SRT routing extension. Each allowlisted host adapter must match its canonical user-scoped source path, origin, and base directory. Routed MCP tools also require a reviewed profile and a live, policy-bound sandbox transport. They are not host adapters. Unknown, missing, or source-spoofed tools remain denied.
- Tool parameter schemas and host-adapter package versions can change without an admission-list update. The `sbx` release number and commit can also change. Runtime behavior establishes compatibility. The canary verifies routing ownership, daemon health, authentication, diagnostics, SSH-agent settings, policy, MCP, templates, sidecar fields, and the Docker Engine dial. Incompatible Docker behavior blocks sidecar use. Core SRT file and shell routing remains active.
- Artifact and integrity pins remain. The Docker shell template digest identifies the reviewed sidecar image. Capability protocol versions and controller source digests protect host/guest coherence. The SRT lockfile and verified patch preimages and postimages protect dependency and patch integrity.
- The controller uses a private, versioned capability descriptor and mode-0600 manifest. The manifest stores only a token digest.
- Tool processes receive a generated HOME, temp directory, cache, and empty immutable `DOCKER_CONFIG`. npm-backed tools use the launcher-provided `NPM_CONFIG_CACHE`, which defaults to `/Users/dsuess/.npm`; callers can override it per Pi launch or Bash request. They do not receive controller descriptors, routing tokens, SSH/GPG agents, host Docker contexts, credentials, control sockets, or SBX controls.
- Routed `PATH` starts with the generated Docker client directory, then the read-only `mktemp` compatibility directory, then the controller startup `PATH`. PATH is not a security boundary: SRT filesystem permissions decide whether a discovered program can read, execute, or mutate its target. A command may set its own PATH, but cannot bypass those permissions.
- Routed adapters invoke optional host-installed tools by validated bare executable name through that inherited PATH (for example, `rg` and `fd`). They must use direct argument vectors and must not hard-code an installation prefix, inspect the filesystem, resolve through a shell, or reconstruct PATH. Fixed controller or platform dependencies may retain reviewed absolute paths when their identity is part of the controller protocol. In both cases, SRT filesystem policy remains the authority boundary.
- The generated Docker client directory exposes the reviewed Docker CLI and only Buildx and Compose. Other Docker Desktop plugins are not available. Buildx configuration, state, and logs use a separate writable generated `BUILDX_CONFIG` directory.
- Ordinary tool environment values, including secrets, are forwarded directly. Do not mask credentials: failures and retained diagnostics must redact values instead.
- Only the configured signing-key exception may be granted from SSH storage. Hard-link handling is path-based.
- IP egress is unrestricted. Unix-socket access is limited to the exact private Docker broker socket and reviewed system exceptions.
- Workspace writes are allow-only. A workspace below the real home directory remains writable; controller and broker state are never granted. Installed tool roots, including `/opt/homebrew`, `/usr/local`, `~/.local/bin`, `~/.local/share/uv/tools`, and `~/.local/share/uv/python`, are read-only. The uv credentials directory remains denied.
- `config.json` stores versioned saved grants for explicitly shared tool-plane directories. Its initial grant is read-only `~/.agents`. `readWrite` is empty. Each client has its own effective policy snapshot. Saved grants do not replace derived workspace or tool access. Grants never create Docker sidecar mounts, PATH entries, generated-HOME files, or environment forwarding.

## Agent MCP configuration inventory

The agent uses `mcp_list` to inspect MCP configuration. This no-argument tool runs through a canonical, read-only host adapter.
It does not copy trust records or grant filesystem access to routed Bash. It does not start servers, connect to URLs, or evaluate configuration commands.

Each call reads the user `mcp.json` from Pi's public agent directory. It reads project `.pi/mcp.json` only when the current session trusts the project.
Session-only trust applies. Missing or unavailable trust skips project configuration without reading it. Each child uses its own session trust.
The inventory also includes extension-registered servers. File entries override registrations; project entries override same-name user entries. Disabled entries remain visible.

The result contains:

- `inventoryOnly: true` and an explicit statement that metadata does not establish upstream validity, connectivity, or callable capabilities.
- `projectConfiguration`: `included` or `skipped-untrusted`. `included` means trust permitted the read, not that the file exists.
- `servers`: sorted entries with `name`, `source.scope` (`user`, `project`, or `extension`), `source.path`, `enabled`, and `transport` (`stdio` or `http`).
- `diagnostics`: categorical `scope` and `code` fields, without raw errors or configuration excerpts.

The reader accepts only the metadata needed for these fields. Unsupported metadata and ambiguous transports produce diagnostics, not upstream validation results.
The limits are 128 KiB per file, 32 entries per source and total, 128 characters per name, and 512 characters per source path.
Serialized output stays within 32 KiB. A limit diagnostic means the inventory can be incomplete.
Missing files are normal. Diagnostics identify malformed JSON, oversized or unreadable files, unsupported shapes or metadata, ambiguous names, unavailable registrations, and exceeded limits.
Commands, arguments, URLs, descriptions, headers, environment values, working directories, and OAuth configuration never appear in the result.

Interactive `/mcp` inspects connections in the current Pi session. Nested `pi mcp list` starts separate connection attempts with the sandbox's generated HOME.
Neither connection workflow is equivalent to `mcp_list`. The inventory does not test Serena or make Serena tools callable.
Arbitrary MCP tools remain unadmitted. The reviewed Serena profile below is the only routed MCP exception.

## Reviewed Serena profile

Normal SRT sessions replace Pi's built-in MCP session integration with the exported `createMcpExtension` and a controller-owned transport. No host transport is available through this replacement. Shell-level MCP commands and `--yolo` retain upstream behavior.

The profile in `agent/extensions/srt-tool-routing/serena-profile.mjs` admits only the canonical `/Users/dsuess/src/visonic/dev` worktree. Current session trust permits the configuration read. Trust does not grant tool authority. User configuration and extension registrations cannot supply an admitted server.

The profile binds the configuration source, server name, stdio command, arguments, literal environment, and working directory. It also records SHA-256 fingerprints for:

- `.pi/mcp.json`
- `.dev/run-serena-mcp.sh`
- `.dev/install-serena.sh`
- `.pi/serena-context.yml`

Configuration commands, environment expansion, HTTP transports, extra arguments, changed fingerprints, and changed canonical file identities fail closed. `/mcp` retains status and reconnect controls. Its configuration controls cannot extend admission or write the reviewed configuration.

The server must actually offer each tool, and the project configuration must expose it directly. The reviewed inspection tools are `search_for_pattern`, `get_symbols_overview`, `find_symbol`, and `find_referencing_symbols`. Planning permits only these four verified offerings.

The reviewed edit tools are `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `rename_symbol`, and `safe_delete_symbol`. The planning guard blocks all five, regardless of server hints. Planning exit restores approved edits that arrived while the guard was active. Missing offerings remain unavailable. Resources, discovery, memories, onboarding, and basic file or shell tools receive no admission.

Serena uses the generated HOME, uv runtime paths, and existing filesystem policy. Its npm-backed language servers use the generated `cache/npm` directory, not host `~/.npm`. This cache mapping applies only to controller-owned stdio sessions. Core Bash retains its existing npm-cache behavior. Language-server subprocesses inherit SRT restrictions. IP egress remains unrestricted.

The private channel binds each process to its client connection and effective policy generation. Lease siblings cannot write to or close that process. Limits include two live processes, 64 KiB channel chunks, and 1 MiB input/output buffers. MCP messages have a 1 MiB limit, and retained stderr has a 64 KiB limit. Startup and cleanup have deadlines. Idle servers do not occupy core operation slots.

Policy activation retires old-policy processes before the new policy becomes effective. The next prompt reconnects lazily with the current client policy and repeats profile checks. `/reload`, `/new`, `/resume`, `/fork`, and quit retire server authority and process groups. Transport loss never replays a tool request. Failed cleanup blocks further execution.

`/sandbox off` does not move Serena onto the host. Serena still requires a healthy controller. `--yolo` skips routed admission and retains upstream host-native MCP behavior. `mcp_list` remains metadata-only and grants no connection or tool authority.

### Profile maintenance

1. If a reviewed input changes, examine its launch behavior and filesystem requirements.
2. Update the profile identity and fingerprints only after review.
3. Run the profile, transport, routing, and planning tests.
4. Deploy through `./install.sh config`.
5. Run `node pi/sandbox/verify-serena.mjs` from an ordinary host terminal.

The acceptance script uses bounded normal Pi launches with prompts that begin `test serena`. It checks real symbol results and independent fixture bytes. It removes only its own fixtures and compares Visonic status and tracked diffs after cleanup. The native adversarial MCP test separately checks OS-level read/write denial for the server and its subprocesses.

A zero Pi exit status does not prove tool success. Inspect tool events and result content. Serena can report error text with `isError: false`. The acceptance script requires real symbols rather than a success flag alone. Failed language-server startup can leave partial generated resources. Host installation changes, permission changes, and broader grants are not valid workarounds.

## MCP CLI commands

The launcher forwards a leading `mcp` command to installed Pi before session controller checks. It does not add `--no-builtin-tools`. Upstream MCP CLI commands do not load extensions. Ordinary session startup still requires the controller and fails closed.

This dispatch preserves the caller's HOME, working directory, arguments, and exit status. It does not remove existing OS sandbox restrictions or grant host access. Explicit `--yolo` behavior remains unchanged.

Inside routed Bash, `pi mcp` retains the generated HOME. It does not receive host credentials, trust records, or controller capabilities. User configuration comes from that HOME, not the host's `~/.pi/agent/mcp.json`. Upstream can skip project `.pi/mcp.json` because the generated HOME lacks project trust. A skipped configuration does not prove a server connection.

Interactive `/mcp` inspects connections in the existing host Pi session. A new `pi mcp list` process inside routed Bash does not inspect those connections. `pi mcp list` connects to enabled servers and can start subprocesses. It is not a side-effect-free inspection command.

Run these commands through routed Bash to inspect CLI dispatch:

```sh
pi mcp --help
pi mcp list --json
```

## Temporary files

The controller supplies a private `TMPDIR` for each workspace/controller generation. Operations within that generation share temporary files. Temporary files are not durable storage. Controller exit does not delete this directory. A controller restart can reuse the directory for the same workspace and generation.

On macOS, native `mktemp` can ignore `TMPDIR` and select the shared user temp directory. Ordinary PATH-resolved `mktemp` uses a read-only compatibility command. Default files, directories (`-d`), and prefixes (`-t`) use the private directory. The system `mktemp` creates the random names. Explicit templates and directory arguments (`-p`) retain native behavior and require filesystem permission. Quiet (`-q`) and dry-run (`-u`) options retain native behavior.

Node and other TMPDIR-aware runtimes use the same private directory. Controller and request environment overrides cannot change that default directory. The policy does not grant the shared macOS temp directory or all of `/tmp`.

Absolute `/usr/bin/mktemp` calls, commands that replace PATH, and APIs that ignore TMPDIR can still fail. Host execution remains unchanged.

Run this smoke command from an ordinary host terminal:

```sh
pi -p --no-session '!set -e; f=$(mktemp); d=$(mktemp -d); printf "%s\n%s\n%s\n" "$TMPDIR" "$f" "$d"; rm "$f"; rmdir "$d"'
```

## Docker sidecar

While sandboxing is on, commands use only the private workspace Docker broker. While sandboxing is off, commands use ordinary host Docker configuration and contexts. There is no separate host-socket grant while sandboxing is on.

Controller readiness starts only the private broker. The sidecar is created on its first Docker connection, is owned by canonical workspace metadata, and survives normal Pi/controller exit. It has its own Docker daemon, filesystem, and network; it cannot see host Docker containers. Build mounts may use paths in the sidecar, including the same-path workspace mount. Published ports are rejected.

A print-mode whole prompt beginning with `!` or `!!` executes Bash through the same SRT controller without calling a model:

```sh
pi -p --no-session "!docker ps"
pi -p --no-session "!!docker compose ps"
```

Normal prompts and interactive Bash retain their normal Pi behavior. Inline exclamation marks, JSON/RPC input, and print prompts without a leading bang do not use this path.

The private sidecar has no host credentials. Use public registries or authenticate inside the private sidecar. Sandboxed commands do not inherit host `~/.docker` credentials or contexts.

## Persistent-sidecar management

Use `pi-sbx`, never model tools, to inspect persistent disk state:

```sh
pi-sbx list
pi-sbx status                 # current repository/worktree
pi-sbx status /path/to/repo
pi-sbx stop --force           # preserves images, containers, volumes, and cache
pi-sbx reset --force          # deletes this workspace's sidecar and Docker state
pi-sbx prune --force          # removes validated stopped Pi sidecars only
```

`reset` and `prune` require an interactive confirmation or `--force`. The command accepts a validated sidecar name for status, stop, and reset. It refuses missing, foreign, ambiguous, or capability-drifted sidecars. `/sandbox` reports Docker health but does not manage sidecar lifecycle, mounts, or published ports. Use `pi-sbx` for Docker disk management.

## Sandbox controls

`/sandbox` opens a status-and-actions menu with built-in selection and path-input dialogs. The menu and subcommands use the same trusted services. The menu offers only the opposite-mode action: `Turn sandbox off — host access` when on, or `Turn sandbox on` when off.

| Command | Effect |
| --- | --- |
| `/sandbox status` | Display mode, workspace, configuration location, grants, revisions, refresh state, and controller/Docker health. |
| `/sandbox on` | Restore sandboxed execution after controller and effective-policy readiness checks. |
| `/sandbox off` | Select host execution immediately for this conversation, without a confirmation dialog. |
| `/sandbox grants list` | Display saved and effective grants, separate from derived access. |
| `/sandbox grants add ro <path>` | Save a read-only directory grant and apply the result to this client. |
| `/sandbox grants add rw <path>` | Save a read-write directory grant and apply the result to this client. |
| `/sandbox grants remove <path>` | Remove a saved grant and apply the result to this client. |
| `/sandbox reload` | Reload saved grants into this client's effective policy snapshot. |
| `/sandbox help` | Display command syntax. |

Paths must be absolute or home-relative, such as `/path/to/shared` or `~/shared`. The remainder of a path-bearing command is the literal path, including spaces. Do not add shell quotes:

```text
/sandbox grants add ro ~/Reference Documents
/sandbox grants add rw /path/to/shared work
/sandbox grants remove /path/to/shared work
```

Mode and grant changes require an idle operation boundary. An active tool batch or user Bash blocks a change with a retry-after-idle message. Cancellation does not change state. Unknown syntax and invalid input produce errors rather than implicit status requests.

Without UI, `/sandbox` displays status. Only status, grants list, and help are available without interactive or RPC UI. Unsupported non-interactive mutations fail explicitly. RPC clients can use the supported built-in dialogs. The controls are explicit user commands, not model-callable tools or shell endpoints.

## Saved grants and effective policy

The saved configuration is `~/.pi/sandbox/config.json`, deployed through Stow from this repository's `pi/sandbox/config.json`. The schema retains `version`, `filesystem.readOnly`, and `filesystem.readWrite`. Command edits write atomically through the resolved Stow target without replacing the symlink. The edits remain visible in git. Concurrent edits use a configuration lock and revision checks.

Each new client loads the current saved grants, even if it shares an existing controller. Each active client retains its own effective policy snapshot. A successful grant edit updates the saved configuration and the current client's snapshot. Repeating `grants add` for a saved path changes its access mode. Other active clients retain their snapshots until `/sandbox reload`. A saved grant edit does not restart the shared controller.

`/sandbox reload` refreshes only this client's saved grants. It is not Pi's `/reload`, a controller restart, or a Docker reset. Pi's `/reload` preserves the current effective snapshot. A new, resumed, or forked conversation loads current saved defaults, as does a process restart.

Status distinguishes the saved revision from the effective revision and reports whether a refresh is needed. Operations use the snapshot selected before they start. An operation already in progress retains its original policy.

Grant limits:

- Targets must be safe existing directories. Grants do not create directories or change OS file permissions.
- Read-write access includes read access. Grants do not elevate OS privileges.
- Validation bounds both the configured lexical path and its canonical target, including Stow and other symlink aliases.
- Protected credential and runtime roots remain ungrantable. Workspace overlap, duplicates, and overlapping grants follow the same validation rules.
- Removing a grant removes only configured access. It does not revoke independently derived workspace or tool access.
- Grants do not expose host Docker sockets, credential stores, SSH agents, controller state, or additional environment values.

Invalid grants and conflicting edits leave saved and effective grants unchanged. If disk save succeeds but activation fails, the command reports the saved/effective mismatch. Further sandboxed operations remain blocked for that client until a successful refresh. A failed revocation must not appear as effective.

Denied filesystem access does not trigger automatic once/session permission prompts. The current controls provide explicit saved grants and conversation-local host execution only.

## Conversation-local host execution

CAUTION: If you do not accept host-user access, keep sandboxing on. Core tools and user Bash can access host files, credentials, environment values, and Docker while sandboxing is off. Off mode grants no additional OS privileges.

The explicit command authorizes the switch without another dialog. Pi displays an immediate warning and one persistent red `● sandbox: off — host access` indicator in the sandbox footer segment. At narrow widths, the footer preserves the off state before decorative content and the independent `[PLANNING]` marker.

Controller health remains separate from execution mode. Healthy or failed controller polling must not replace the red off indicator. When on, the indicator is green `● sandbox: on` only if the controller is healthy and execution is not blocked. Blocked or failed states show red `◌ sandbox: on — blocked` or `◌ sandbox: on — failed`. Starting, restarting, and stopped states use warning colors. Sidecar identifiers and detailed diagnostics remain in `/sandbox status`.

Only this client bypasses SRT. Other clients remain sandboxed, and child agents start sandboxed by default. Pi does not save off authority in conversation history, persistent configuration, inherited environment, or controller leases.

| Boundary | Execution mode |
| --- | --- |
| Pi `/reload` in the same process and conversation | Preserve the current mode. |
| `/new`, `/resume`, or `/fork` | Reset to sandbox on. |
| Process restart | Start sandbox on, except an explicit `pi --yolo` launch. |
| `/sandbox on` | Enable sandboxing only after readiness checks succeed. |

If re-enabling fails, Pi blocks core execution rather than continuing silently on the host. The planning mutation guard remains independent of sandbox mode. Off mode does not authorize mutations that the guard blocks.

CAUTION: Re-enabling sandboxing affects future operations only. It cannot undo host changes or stop background processes that escaped the sandbox.

## Operations and troubleshooting

The detached routing controller owns the workspace socket, base policy, client snapshots, leases, Docker broker, and lazy sidecar. Each routed core file, shell, or Docker request starts its own short-lived SRT operation. Reviewed Serena uses a separate persistent SRT stdio process for the session.

A root Pi runtime refreshes its opaque controller lease while it runs. After a long host pause, such as machine sleep or synchronous plan review, its next routed request transparently proves the original private startup capability to the same controller, reactivates the same lease token, and retries that rejected request once. This does not restart the controller, recreate the policy, or replace the sidecar. Inherited child runtimes have only the opaque lease and cannot renew it. If the root cannot prove that original authority, routing fails closed: Pi disables routed tools and shuts down rather than falling back to host tools.

A parallel tool batch completes only after every sibling settles. One disconnected or unresponsive routed request could therefore previously leave completed siblings visible while the turn remained `Working...`. Controller socket close, socket write failure, invalid response frame, and response deadline now reject every pending routed request, disable routed tools, publish `sandbox:failed`, notify the UI, and request graceful shutdown. The in-flight tool reports `controller transport unavailable: <reason>`; this redacted reason distinguishes peer close, socket error, protocol failure, and response timeout without exposing request data or capabilities. Intentional session replacement retires its old connection without failing the replacement runtime.

Run `npm --prefix pi/sandbox test` for deterministic controller, policy, host-configuration, and sidecar checks. Run `npm --prefix pi run check:deterministic`, then `./install.sh config`, then `npm --prefix pi run check` for the full repository gate. `./install.sh config` is non-destructive: it must not create a disposable sidecar.

To verify npm-backed hooks in a routed workspace, run this without manually setting `NPM_CONFIG_CACHE`:

```sh
cd /Users/dsuess/src/polez/data-scout
prek run pyright --files digitization/datascout/datascout/strategies/base.py
```

Pyright should pass without an npm-cache permission or `/root/.npm` error. This grants no host Docker credentials or other host credentials.

If Docker creation fails, inspect the required capabilities instead of matching an `sbx` release number:

```sh
sbx --app-name pi-srt daemon status
sbx --app-name pi-srt diagnose --json
sbx --app-name pi-srt policy ls --json
sbx --app-name pi-srt mcp ls --json
sbx --app-name pi-srt template ls --json
```

Authenticate only with `sbx --app-name pi-srt login`. If `sbx` reports a credential-refresh cooldown, wait for the cooldown to expire. Then run the dedicated-app login again. Do not use an unscoped `sbx login`. Make sure that the dedicated app has an allow-all policy and an empty MCP registry. Make sure that the reviewed shell template digest is available. The native canary verifies SSH-agent forwarding, sidecar fields, and the private Docker dial. If template or capability data changes, review the change before you reset the sidecar. Never use `chown` or `chmod` on Homebrew or user tool installations as a sandbox workaround. Do not manually create links. Deploy only through `./install.sh config`.
