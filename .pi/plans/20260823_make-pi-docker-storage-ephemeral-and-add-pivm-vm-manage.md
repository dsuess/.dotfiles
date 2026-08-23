# Make Pi Docker storage ephemeral and add pivm

## Context

Pi's Gondolin controller currently mounts workspace-scoped host storage at `/var/lib/docker`. Gondolin 0.12.0 exposes that mount through `fuse.sandboxfs`, which does not support xattrs and breaks representative BuildKit cross-image copies. A direct experiment showed that the same pinned `ghcr.io/astral-sh/uv:0.9.18` build succeeds when Docker's data root is on the VM's guest-native filesystem. The accepted tradeoff is that images, containers, volumes, and build cache disappear when the VM restarts or stops.

The guest-local daemon must remain isolated: no host Docker socket or host Docker settings will be mounted. The existing `vfs` storage driver remains appropriate; moving the data root to guest-native storage supplies xattrs without weakening that boundary.

The new `pivm` host CLI will manage live Gondolin VMs and their reclaimable Docker storage. “Purge” means Docker-reclaimable objects only: stopped containers, unused images and volumes, and build cache. Running resources remain untouched. Active volumes are reported as unpurgable before confirmation.

The repository has no domain glossary or ADR covering these general infrastructure concepts, so no glossary or ADR change is warranted. The existing Pi sandbox README is the canonical operator documentation.

## Questions & Answers

| Question | Answer |
|---|---|
| What should `pivm storage purge` delete after showing the size preview? | Reclaimable only. Also warn about running unpurgable volumes. |

## Approach

The implementation will make Docker storage part of the VM lifecycle, expose read-only inventory and safe cleanup through a small host CLI, and update tests from persistence expectations to explicit ephemerality. `pivm storage list` will be added as the one complementary command needed to inspect the same purge preview without entering a destructive flow; no broader speculative VM controls will be added.

### Part A — Move Docker state to guest-native storage
- **Ledger:** {"status":"completed","note":"Docker data root now remains guest-native and docker.reset delegates to authenticated VM replacement.","evidence":"npm --prefix pi/sandbox run test:controller (19 passing). Policy no longer creates/mounts workspace docker; controller test proves reset preserves legacy host directory while replacing VM."}

Remove the host-backed `/var/lib/docker` provider from `buildSandboxPolicy` while retaining workspace caches, controller generation checks, guest-local `dockerd`, and the `vfs` storage driver. The daemon can continue using `/var/lib/docker`; without a VFS mount, that path belongs to the guest-native root filesystem and supports xattrs.

Stop creating the obsolete workspace `docker` directory. Keep it classified as an invariant boundary during migration so old private state cannot be exposed as an external mount. Existing legacy directories may remain harmlessly on disk until an explicit host-cache cleanup; normal launches must neither mount nor depend on them.

Redefine the existing authenticated `docker.reset` operation as a VM restart. Closing the old VM deletes its complete ephemeral Docker state, and starting a fresh VM restores a healthy empty daemon. Preserve the protocol method for extension compatibility, but remove assumptions that reset validates and deletes a host path.

Observable outcomes: controller status no longer advertises a Docker mount; `docker info` still reports `vfs|/var/lib/docker`; `/var/lib/docker` is not `fuse.sandboxfs`; xattr listing works; and VM restart yields an empty Docker store.

### Part B — Build the pivm live-VM inventory
- **Ledger:** {"status":"completed","note":"Added Stow-managed pivm CLI and read-only live Gondolin VM inventory with validated Pi workspace mapping.","evidence":"node --test pi/sandbox/test-pivm.mjs (2 passing): filters stale/malformed entries, maps workspace, formats inventory, and handles empty/help."}

Add a Stow-managed `pivm` executable under `bin/`, backed by a testable module in `pi/sandbox/`. `pivm vm list` will use Gondolin's public `listSessions()` registry API, filter to connectable live sessions, and print stable columns for VM ID, process ID, age, and label. Where a valid Pi controller manifest maps a VM ID to a workspace, include the workspace to make multiple Pi VMs distinguishable without changing Gondolin's registry format.

The command must not start a controller or VM. Malformed or stale registry entries and manifests are ignored as non-running; an empty inventory reports that no VMs are running. `pivm --help` and command-specific usage are part of the public interface.

Observable outcomes: all current Gondolin VMs are visible, Pi-managed VMs identify their workspace when available, and listing remains read-only with no lifecycle side effects.

### Part C — Add safe Docker storage inspection and purge
- **Ledger:** {"status":"completed","note":"Added authenticated active-controller storage inspection, preview, default-no purge, active-volume protection warning, and lease cleanup.","evidence":"node --test pi/sandbox/test-pivm.mjs (5 passing): aggregation/GB formatting, warnings, decline, confirmation, zero-data no prompt, and inspection failure before prune."}

Discover only currently running Pi controllers from their private runtime manifests. Validate each manifest with the existing `readControllerManifest` checks, acquire a temporary authenticated lease, and execute the guest's absolute `/usr/bin/docker` command through `ControllerClient`; do not connect to the host Docker socket or spawn missing controllers.

Add `pivm storage list` to aggregate `docker system df --format json` across active Pi VMs. Normalize Docker's categories to Images, Containers, Volumes, and Build cache, and display reclaimable sizes in decimal gigabytes for each category plus a total. Also display the number and non-reclaimable size of active volumes when present, with an explicit warning that purge will preserve them.

`pivm storage purge` first prints that same preview and warning, then asks for a default-no confirmation. On confirmation, run `docker system prune --all --volumes --force` in each connected VM. This removes only Docker-reclaimable objects; active containers, their images, and active volumes remain. Declining performs no prune. Hold and heartbeat temporary leases through the prompt and always release them afterward. If any active controller cannot be inspected, abort before deleting anything rather than perform a silent partial purge.

Do not add a confirmation bypass in this first version: the requested safety property is an interactive preview and confirmation. If no reclaimable data exists, report that result and skip the prompt.

Observable outcomes: storage can be previewed independently, purge always shows category sizes before asking, active-volume warnings are prominent, a declined prompt is a no-op, and confirmed cleanup is limited to reclaimable data.

### Part D — Align the sandbox UI and documentation
- **Ledger:** {"status":"completed","note":"Updated /sandbox wording and canonical operator README for guest-native ephemeral Docker storage and pivm operations.","evidence":"npm --prefix pi/sandbox run test:extension (15 passing); README search confirms obsolete persistence/xattr-limitation claims are gone."}

Update `/sandbox` terminology so Docker reset clearly means replacing the shared VM and deleting that VM's ephemeral Docker state. Remove claims that Docker data persists by workspace or survives VM restart. Document the xattr-compatible guest-native data root, lifecycle tradeoff, `pivm vm list`, `pivm storage list`, and `pivm storage purge` behavior in `pi/sandbox/README.md`.

Preserve the repository's Stow workflow: `./install.sh config` deploys `bin/pivm` and the sandbox module; no manual target symlink is created. Keep unrelated startup-benchmark and launcher edits already present in the working tree untouched.

Observable outcomes: operator text consistently calls the storage ephemeral and does not promise persistence or imply that safe purge removes active volumes.

### Part E — Convert regression coverage from persistence to ephemerality
- **Ledger:** {"status":"completed","note":"Converted policy, controller, pivm, integration, and native canary coverage to guest-native Docker xattrs and VM ephemerality.","evidence":"npm --prefix pi/sandbox test (all suites passing); npm --prefix pi/sandbox run test:native (canary, controller-native, tools, inventory, Ketch live all passing); git diff --check passed."}

Use vertical test-driven slices. First update policy and controller tests to expect no Docker mount and a reset implemented by VM replacement. Then add public CLI tests for empty and populated VM lists, workspace mapping, storage aggregation and GB formatting, active-volume warnings, default-no/declined confirmation, confirmed prune, no-data behavior, and inspection failure before deletion.

Change the native Gondolin canary to omit the `/var/lib/docker` VFS provider, require the pinned uv external-stage `COPY` and `uvx --version` to succeed, retain Docker pull/run/Compose/network/host-isolation checks, and prove that images, containers, and volumes created in the first VM are absent in a fresh second VM. The canary must still verify that the host Docker socket and configuration are unavailable.

Observable outcomes: tests fail if Docker returns to FUSE-backed storage, if state accidentally persists, if `pivm` can purge without confirmation, or if active resources are represented as reclaimable.

## Critical Files

- `pi/sandbox/policy.mjs` — decides which host paths enter the VM; it must stop mounting Docker state.
- `pi/sandbox/controller.mjs` and `pi/sandbox/client.mjs` — own VM restart/reset behavior and authenticated management access.
- `pi/sandbox/pivm.mjs` and `bin/pivm` — new host-side management interface and Stow-managed launcher.
- `pi/sandbox/test-gondolin-canary.mjs` — native proof of xattr-compatible builds, isolation, and ephemeral lifecycle.
- `pi/agent/extensions/gondolin-sandbox/settings-view.ts` — `/sandbox` reset confirmation and terminology.
- `pi/sandbox/README.md` — canonical operator contract for storage and `pivm`.

## Verification

- **Policy regression:** focused policy tests show cache mounts remain while `/var/lib/docker` is absent from VFS providers and no new workspace Docker directory is created.
- **Controller regression:** reset closes the old VM, starts a different healthy VM, preserves generation/lease behavior, and performs no host-directory deletion.
- **CLI scenarios:** invoke the public `pivm` command/module against controlled session and controller fixtures. Verify live-only listing, exact storage category totals, active-volume warnings, default-no confirmation, confirmed prune calls, no prompt when reclaimable size is zero, and all-or-nothing inspection failure.
- **Native feature scenario:** build and run the pinned uv multi-stage Dockerfile inside Gondolin. Success requires working xattrs, guest-local `vfs` Docker at `/var/lib/docker`, and no `fuse.sandboxfs` mount at that path.
- **Native lifecycle scenario:** create representative image/container/volume state, replace the VM, then verify each object is absent while Docker returns healthy.
- **Isolation regression:** retain tests proving a privileged guest container cannot read unmounted host paths or host Docker settings/socket.
- **Full checks:** run the focused `pivm`, policy, controller, extension, and native canary tests, followed by `npm --prefix pi/sandbox test` and the complete native sandbox suite where host prerequisites are available. Finish with `git diff --check`, review only intended files, and deploy through `./install.sh config` if installation-side verification is requested.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Move Docker state to guest-native storage
- ☑ Build the pivm live-VM inventory
- ☑ Add safe Docker storage inspection and purge
- ☑ Align the sandbox UI and documentation
- ☑ Convert regression coverage from persistence to ephemerality
<!-- pi-plan-mode:progress:end -->
