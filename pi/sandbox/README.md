# Pi SRT tool routing

Pi, its UI, provider authentication, and audited non-core adapters run on the host. Core file and shell tools run in one SRT process per operation. Docker is available only through a private workspace Docker Sandboxes sidecar broker.

## Security contract

- The controller uses a private, versioned capability descriptor and mode-0600 manifest. The manifest stores only a token digest.
- Tool processes receive a generated HOME, temp directory, and cache. They do not receive controller descriptors, routing tokens, SSH/GPG agents, Docker/SBX controls, or host Docker endpoints.
- Ordinary tool environment values, including secrets, are forwarded directly. Do not mask credentials: failures and retained diagnostics must redact values instead.
- Only the configured signing-key exception may be granted from SSH storage. Hard-link handling is path-based.
- IP egress is unrestricted. Unix-socket access is limited to the exact broker socket and reviewed system exceptions.
- Workspace writes are allow-only. A workspace below the real home directory remains writable; controller and broker state are never granted.

## Docker sidecar

Controller readiness starts only the private broker. The sidecar is created on its first Docker connection, is owned by canonical workspace metadata, and survives normal Pi/controller exit. `reset` removes only a validated owned sidecar. Resources and persistent mounts apply at sidecar creation; changed settings require recreation. Ports are disabled by default and any configured ingress must be loopback-only.

## Permissions and settings

Permission prompts are serialized at the controller boundary. A once grant applies to one drained retry, a session grant stays in controller memory, and a persistent grant is atomically written to the resolved Stow source and revalidated when loaded. Missing UI, timeout, cancellation, disconnect, malformed requests, and shutdown deny access.

## Operations

Run `npm --prefix pi/sandbox test` for deterministic controller, policy, host-configuration, and sidecar checks. Run `npm --prefix pi run check:deterministic`, then `./install.sh config`, then `npm --prefix pi run check` for the full repository gate. `./install.sh config` is non-destructive: it must not create a disposable sidecar.

If routing fails, inspect the private controller manifest/socket ownership and launch with `bin/pi --help` to confirm the trusted executable resolution without starting a controller. Do not manually create links; deploy only through `./install.sh config`.
