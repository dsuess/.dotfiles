# Diagnose the sandboxed Docker copy failure

## Context

A normal `pi` launch does not use the host Docker daemon. It runs commands in a Gondolin Linux VM and starts a workspace-local Docker daemon there. The local configuration deliberately mounts persistent Docker state at `/var/lib/docker` through Gondolin's host-mediated `fuse.sandboxfs`; Docker then uses its `vfs` storage driver on that mount (`pi/sandbox/policy.mjs`, `pi/sandbox/controller.mjs`, and `pi/sandbox/image/docker-init-extra.sh`). Live inspection confirms both `fuse.sandboxfs` at `/var/lib/docker` and Docker's `vfs` driver.

The failure is a filesystem-feature mismatch, not a sandbox policy rejecting `/uvx`. Gondolin 0.12.0's guest filesystem explicitly returns `EOPNOTSUPP` for extended-attribute operations (`SETXATTR`, `GETXATTR`, `LISTXATTR`, and `REMOVEXATTR`) in `pi/sandbox/node_modules/@earendil-works/gondolin/dist/guest/src/sandboxfs/main.zig`. Docker/BuildKit copies image-layer metadata as well as file bytes; current Docker versions can treat an unsupported xattr operation as fatal while materializing or copying a layer on a filesystem without xattr support. Moby reports the same incompatibility for the `vfs` driver on non-xattr filesystems: https://github.com/moby/moby/issues/45417. Related BuildKit failures are tracked at https://github.com/docker/buildx/issues/584.

`ghcr.io/astral-sh/uv:latest` is a valid distroless image containing `/uv` and `/uvx`, and Astral documents the failing `COPY --from=... /uv /uvx /bin/` pattern: https://docs.astral.sh/uv/guides/integration/docker/. Its image source is a `scratch` stage containing those two files: https://raw.githubusercontent.com/astral-sh/uv/main/Dockerfile. The image reference exposed the sandbox limitation; it is not evidence that `uvx` itself is invalid.

The existing native canary proves only a simple Alpine BuildKit build. It does not cover a multi-stage copy from the uv distroless image or xattr-bearing layer metadata, so its success does not contradict this failure.

## Approach

The immediate explanation is the causal chain: normal Pi launch → Gondolin guest Docker → persistent `/var/lib/docker` on `fuse.sandboxfs` → Docker `vfs` layer copy → unsupported xattr operation → `EOPNOTSUPP` (“operation not supported”).

### Part A — Confirm the exact failing operation
- **Ledger:** {"status":"completed","note":"Reproduced the pinned uv multi-stage build in a guest VM and captured BuildKit plus dockerd diagnostics.","evidence":"Guest baseline: vfs|/var/lib/docker and fuse.sandboxfs mounted there. Python os.listxattr('/var/lib/docker') returned OSError errno 95 (EOPNOTSUPP). `COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /uvx /bin/` failed at /uvx with `failed to create hash ... operation not supported`; dockerd logged the identical BuildKit Solve failure. Gondolin 0.12.0 sandboxfs main.zig dispatches all xattr FUSE opcodes to EOPNOTSUPP."}

Capture the complete Docker/BuildKit error from the affected workspace and correlate it with the guest Docker daemon log. Confirm whether the rejected syscall is an xattr read/write, rather than a less likely unsupported filesystem operation. Acceptance outcome: the full error names the metadata operation or daemon tracing/logging identifies the corresponding `EOPNOTSUPP` path.

### Part B — Choose the appropriate response
- **Ledger:** {"status":"completed","note":"Selected the documented `pi --yolo` host-tool bypass for trusted one-off builds; the current pinned Gondolin dependency has no available upstream xattr-capable release, so the general sandbox capability remains an explicit accepted limitation rather than a Dockerfile-specific fix.","evidence":"Host control used Docker Desktop overlay2 and built/runs the exact pinned `ghcr.io/astral-sh/uv:0.9.18` COPY pattern successfully (`uvx 0.9.18`). This isolates the failure to sandboxfs-backed guest Docker, not the image or Dockerfile."}

For a one-off trusted build, run Pi with the documented explicit bypass, `pi --yolo`, so the build uses host tools rather than the Gondolin guest. Treat Dockerfile alternatives such as installing uv with Astral's installer as narrow workarounds, not fixes for the sandbox's general Docker/xattr incompatibility.

For a durable sandbox fix, preserve the invariant that the host Docker socket is never mounted. Add the minimum xattr semantics needed by Docker to Gondolin's sandbox filesystem and host VFS provider, or move Docker state to a guest-native filesystem while explicitly accepting the persistence/resource tradeoff. Do not switch to `overlay2` on the current FUSE backing store: that does not supply the missing xattr behavior and conflicts with the repository's intentional `vfs` design.

Acceptance outcome: the chosen response is explicit about whether it is a temporary bypass, a Dockerfile-specific workaround, or a general sandbox capability fix.

### Part C — Prevent regression if the sandbox is fixed
- **Ledger:** {"status":"completed","note":"Added the pinned uv external-stage COPY to the native canary as a documented expected xattr failure, retained guest Docker/isolation/persistence checks, and documented the limitation plus the safe bypass.","evidence":"`npm --prefix /Users/dsuess/.dotfiles/pi/sandbox run test:canary` passed (1/1, 45.9 s). The canary asserts vfs, /var/lib/docker, fuse.sandboxfs, the expected `failed to create hash for /uvx: operation not supported` result for uv 0.9.18, guest-local Docker isolation, and persistence."}

Extend the native Docker canary with the exact multi-stage uv copy pattern, using a pinned uv tag or digest rather than `latest`. Keep the existing checks for guest-local Docker, `vfs`, persistent state, and host-socket isolation. Update `pi/sandbox/README.md` to state the xattr limitation if it remains accepted, or document the newly supported metadata semantics if it is fixed.

Acceptance outcome: future image or Gondolin upgrades cannot claim nested Docker support while this representative multi-stage copy is broken.

## Critical Files

- `pi/sandbox/policy.mjs` — maps persistent workspace Docker state to guest `/var/lib/docker` through a host-backed provider.
- `pi/sandbox/image/docker-init-extra.sh` — starts guest-local Docker with the `vfs` storage driver.
- `pi/sandbox/node_modules/@earendil-works/gondolin/dist/guest/src/sandboxfs/main.zig` — current filesystem boundary that returns `EOPNOTSUPP` for xattrs.
- `pi/sandbox/test-gondolin-canary.mjs` — native Docker coverage that currently tests only a simple Alpine build.
- `pi/sandbox/README.md` — operator-facing sandbox and nested-Docker contract.

## Verification

- **Regression baseline:** Confirm `docker info` reports `vfs` and `/var/lib/docker`, while `mount` reports `fuse.sandboxfs` for that path.
- **Failure scenario:** In an ordinary sandboxed Pi session, build a minimal pinned Dockerfile containing `COPY --from=ghcr.io/astral-sh/uv:<version> /uv /uvx /bin/`; retain plain BuildKit output and the matching daemon error.
- **Control scenario:** Run the same minimal build against a normal host Docker filesystem, including through the explicit `pi --yolo` path when acceptable. Success there isolates the failure from the uv image and Dockerfile syntax.
- **Durable-fix scenario:** If xattr support is added, run the exact uv copy canary plus the complete native sandbox suite. Success requires the image to build and execute while Docker state remains workspace-local and the host Docker socket remains unavailable.
- **Failure signals:** Any remaining `EOPNOTSUPP`, lost required file capabilities, Docker state outside the workspace controller directory, or exposure of host Docker configuration/socket means the fix is incomplete.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Confirm the exact failing operation
- ☑ Choose the appropriate response
- ☑ Prevent regression if the sandbox is fixed
<!-- pi-plan-mode:progress:end -->
