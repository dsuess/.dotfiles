# Pi SRT tool routing

Pi, its UI, provider authentication, and audited non-core adapters run on the host. Core file and shell tools run in one SRT process per operation. Docker is available only through a private workspace Docker Sandboxes sidecar broker.

## Security contract

- The controller uses a private, versioned capability descriptor and mode-0600 manifest. The manifest stores only a token digest.
- Tool processes receive a generated HOME, temp directory, cache, and empty immutable `DOCKER_CONFIG`. They do not receive controller descriptors, routing tokens, SSH/GPG agents, host Docker contexts, credentials, control sockets, or SBX controls.
- Routed `PATH` is the controller startup `PATH`, with the generated private Docker client directory prepended. PATH is not a security boundary: SRT filesystem permissions decide whether a discovered program can read, execute, or mutate its target. A command may set its own PATH, but cannot bypass those permissions.
- The generated Docker client directory exposes the reviewed Docker CLI and only Buildx and Compose. Other Docker Desktop plugins are not available. Buildx configuration, state, and logs use a separate writable generated `BUILDX_CONFIG` directory.
- Ordinary tool environment values, including secrets, are forwarded directly. Do not mask credentials: failures and retained diagnostics must redact values instead.
- Only the configured signing-key exception may be granted from SSH storage. Hard-link handling is path-based.
- IP egress is unrestricted. Unix-socket access is limited to the exact private Docker broker socket and reviewed system exceptions.
- Workspace writes are allow-only. A workspace below the real home directory remains writable; controller and broker state are never granted. Installed tool roots, including `/opt/homebrew`, `/usr/local`, `~/.local/bin`, `~/.local/share/uv/tools`, and `~/.local/share/uv/python`, are read-only. The uv credentials directory remains denied.

## Docker sidecar

Controller readiness starts only the private broker. The sidecar is created on its first Docker connection, is owned by canonical workspace metadata, and survives normal Pi/controller exit. It has its own Docker daemon, filesystem, and network; it cannot see host Docker containers. Build mounts may use paths in the sidecar, including the same-path workspace mount. Published ports are rejected.

A print-mode whole prompt beginning with `!` or `!!` executes Bash through the same SRT controller without calling a model:

```sh
pi -p --no-session "!docker ps"
pi -p --no-session "!!docker compose ps"
```

Normal prompts and interactive Bash retain their normal Pi behavior. Inline exclamation marks, JSON/RPC input, and print prompts without a leading bang do not use this path.

Docker access has no host credentials. Use public registries or authenticate inside the private sidecar; never expect host `~/.docker` credentials or contexts to be inherited.

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

`reset` and `prune` require an interactive confirmation or `--force`. The command accepts a validated sidecar name for status, stop, and reset. It refuses missing, foreign, ambiguous, or capability-drifted sidecars. The `/sandbox` UI reports routing settings only; use `pi-sbx` for Docker disk management.

## Permissions and settings

Permission prompts are serialized at the controller boundary. A once grant applies to one drained retry, a session grant stays in controller memory, and a persistent grant is atomically written to the resolved Stow source and revalidated when loaded. Missing UI, timeout, cancellation, disconnect, malformed requests, and shutdown deny access.

## Operations and troubleshooting

The detached routing controller owns the workspace socket, policy, leases, Docker broker, and lazy sidecar. Each routed file, shell, or Docker request starts its own short-lived SRT operation; there is no long-running per-session SRT process to restart.

A root Pi runtime refreshes its opaque controller lease while it runs. After a long host pause, such as machine sleep or synchronous plan review, its next routed request transparently proves the original private startup capability to the same controller, reactivates the same lease token, and retries that rejected request once. This does not restart the controller, recreate the policy, or replace the sidecar. Inherited child runtimes have only the opaque lease and cannot renew it. If the root cannot prove that original authority, routing fails closed: Pi disables routed tools and shuts down rather than falling back to host tools.

Run `npm --prefix pi/sandbox test` for deterministic controller, policy, host-configuration, and sidecar checks. Run `npm --prefix pi run check:deterministic`, then `./install.sh config`, then `npm --prefix pi run check` for the full repository gate. `./install.sh config` is non-destructive: it must not create a disposable sidecar.

If Docker creation fails, verify the exact reviewed `sbx` version, authenticate only with `sbx --app-name pi-srt login`, and check that the reviewed shell template digest remains available. Template or capability drift is intentionally rejected; reset the validated sidecar only after reviewing the change. Never use `chown` or `chmod` on Homebrew or user tool installations as a sandbox workaround. Do not manually create links; deploy only through `./install.sh config`.
