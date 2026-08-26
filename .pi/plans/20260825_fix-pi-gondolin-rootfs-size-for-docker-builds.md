# Increase Pi Gondolin rootfs capacity for Docker builds

## Context

A sandboxed Pi session ran `.dev/dev-start.sh docker` in the Visonic development repository. Docker's guest-native `vfs` storage exhausted the Gondolin guest root filesystem while building the five Compose services. The controller default was 32G.

Docker must remain guest-native and ephemeral. Moving it to host storage or changing its storage driver would weaken or change the existing isolation contract. The narrow fix is a larger temporary guest disk plus a documented per-launch override for unusually large builds.

## Approach

1. Change the default guest rootfs capacity from 32G to 64G, while preserving `PI_GONDOLIN_ROOTFS_SIZE` as the explicit override through the launcher and controller-client allowlists.
2. Add unit and wrapper regressions that cover the default, a supplied override, and its handoff through the fail-closed launcher. Keep the existing controller environment-forwarding test.
3. Update the operator documentation to describe temporary host-disk consumption and the requirement to set the override before creating the workspace controller.
4. Run focused controller tests, the sandbox suite, and repeat the Visonic Docker build through a sandboxed Pi session without changing target-repository files.

## Verification

- The controller unit test verifies the default and override values.
- The existing client environment test verifies `PI_GONDOLIN_ROOTFS_SIZE` reaches the spawned controller.
- The Visonic Compose build completes inside a fresh Pi/Gondolin VM without a guest disk-full failure.
- `git diff --check` passes and the target repository has no tracked or new untracked changes.

## Result

Completed. The controller now defaults to 64G and the launcher forwards the `PI_GONDOLIN_ROOTFS_SIZE` override to its trusted controller preflight. Focused and full sandbox tests passed, as did the native QEMU/Docker suite. A fresh sandboxed Pi session reported a 63G root filesystem and completed `.dev/dev-start.sh docker` with exit status 0; a separate `PI_GONDOLIN_ROOTFS_SIZE=96G` session reported a 95G root filesystem.
