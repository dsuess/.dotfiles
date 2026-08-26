# Include stale Gondolin images in storage management

## Context

`gondolinier storage list` currently inspects only Docker-managed objects inside active Pi VMs. It discovers live controller manifests, acquires controller leases, and aggregates `docker system df --format json`; it never scans the host cache. This matches the current help and `pi/sandbox/README.md`, which define the command as “reclaimable Docker storage,” but conflicts with the broader `storage` command name and leaves the dominant Gondolin disk use invisible.

The observed `~/.cache/pi-gondolin` tree occupies approximately 54 GB: about 53 GB is in 18 checksum-addressed directories under `images/`, while workspace and host caches are comparatively small. The current image generation is `3e7b76f…` and occupies about 4.2 GB, so roughly 49 GB belongs to older generations. `ensureGondolinImage()` selects one directory from a digest of reviewed image inputs and replaces only that same digest during a forced rebuild; it intentionally cleans temporary build directories but has no garbage collection for superseded digests.

Use these precise terms in the implementation and operator documentation:

- **Docker storage**: images, containers, volumes, and build cache inside an active ephemeral VM.
- **Host VM image cache**: immutable boot assets under `<cache-root>/images/<image-generation>`.
- **Protected image generation**: the current input digest needed for the next launch, or a generation named by a validated live controller manifest.
- **Stale image generation**: a recognized cached generation that is neither current nor protected by a live controller. Only this class is reclaimable.

The change will cover cached VM image generations only. It will not expand cleanup to workspace caches, Node/Jiti caches, unrecognized directories, temporary files, or arbitrary content under `~/.cache/pi-gondolin`. Unknown or malformed image entries will be visible but preserved. The existing interactive, default-no purge contract remains the destructive-operation boundary. No glossary or ADR is warranted: the sandbox README is the existing operator contract, and this is a reversible extension of an existing CLI rather than a new architectural decision.

## Questions & Answers

| Question | Answer |
|---|---|
| How should `gondolinier storage` handle stale host VM image generations? | List and purge: show current/active/stale image-cache usage; confirmed purge removes only stale generations. |

## Approach

Extend the existing storage preview into a combined view of guest Docker reclaimable data and host VM image-cache usage. Reuse the image builder’s canonical cache-root and current-generation derivation, and reuse validated controller manifests as the authority for live image generations. Keep cache discovery read-only for `list`; make `purge` operate only on the exact stale set shown before confirmation.

### Part A — Classify host VM image generations safely
- **Ledger:** {"status":"completed","note":"Added exported host cache inventory using the image builder cache-root/current-digest invariants and validated live manifests.","evidence":"pi/sandbox/gondolinier.mjs: inspectHostImageCache recognizes only checksum-named real directories with matching non-symlink pi-image.json; lstat recursive allocated-byte accounting deduplicates inodes and never follows symlinks. Missing cache is empty."}

Add a testable image-cache inventory boundary to `pi/sandbox/gondolinier.mjs`. Resolve the cache root through the same `PI_GONDOLIN_CACHE_DIR`/default logic used by `build-gondolin-image.mjs`, derive the current generation from the reviewed image inputs, and collect active `imageGeneration` values from validated live controller manifests.

Scan only the immediate children of `<cache-root>/images`. Recognize a generation only when its directory name and `pi-image.json` identify the same checksum-addressed generation. Classify recognized generations as current, active, or stale; current and active classifications are non-reclaimable even when they overlap. Preserve symlinks, malformed metadata, non-generation names, and paths outside the canonical images directory as unrecognized rather than following or deleting them.

Measure allocated host disk usage rather than only the logical `rootfs.ext4` length so the preview corresponds to the space users can reclaim. Count directory contents without following symlinks and avoid double-counting hard-linked files. A missing cache or images directory is a valid empty inventory.

Observable outcomes: the current machine’s image inventory accounts for the approximately 53 GB image cache, identifies the current 4.2 GB generation as protected, and identifies old valid generations as stale; a live controller on an older generation protects that generation as active.

### Part B — Combine image-cache inspection with storage purge
- **Ledger:** {"status":"completed","note":"Combined Docker and host-cache previews, overall reclaimable totals, default-no confirmation, and revalidated stale-only deletion are implemented.","evidence":"pi/sandbox/gondolinier.mjs renders Docker and allocated host image-cache sections; purge snapshots stale names, re-inventories with current live manifests, and deletes only immediate still-stale recognized children. Focused gondolinier tests pass."}

Extend `gondolinier storage list` output to show both existing Docker categories and a distinct host VM image-cache section with generation counts and allocated sizes for protected, stale/reclaimable, and unrecognized content. Keep decimal-gigabyte formatting consistent with the existing CLI, but label host allocation separately from Docker’s reported sizes. The overall reclaimable total must include Docker-reclaimable bytes plus stale image-generation bytes, so stale cache remains visible even when no Pi VM is active.

Extend `gondolinier storage purge` to preview that same classified snapshot and retain the existing default-no confirmation. After confirmation, run the existing Docker reclaimable-only prune for inspected active controllers and remove only the stale image directories from the previewed snapshot. Revalidate each deletion target immediately before removal: it must remain an immediate recognized child of the canonical images directory and must not have become current or active. If discovery or inspection fails before confirmation, delete nothing; if a target no longer qualifies, preserve it and report the skipped target rather than broadening cleanup.

Do not add automatic garbage collection to image builds, a force flag, or non-interactive confirmation bypass. Do not delete the current image, images referenced by live Pi controllers, malformed entries, or unrelated workspace/runtime caches. Retain controller lease release and the existing warning that active Docker volumes survive Docker prune.

Observable outcomes: `storage list` reports the large stale host cache without starting a VM; a declined purge changes nothing; a confirmed purge can reclaim stale generations while preserving the next-launch image, live-controller images, active Docker resources, and unknown cache content.

### Part C — Lock the expanded contract into tests and documentation
- **Ledger:** {"status":"completed","note":"Added focused host-cache safety fixtures and updated the operator contract/help; completed required smoke and suite checks.","evidence":"npm --prefix pi/sandbox run test:gondolinier (10/10); npm --prefix pi/sandbox test (all suites pass); real `node pi/sandbox/gondolinier.mjs storage list` reported 1 protected 4.49 GB generation, matching read-only `du -sk ~/.cache/pi-gondolin/images` = 4,382,096 KiB and one immediate checksum directory; git diff --check passed."}

Extend `pi/sandbox/test-gondolinier.mjs` with temporary-cache fixtures covering current, live older, stale, malformed, symlink, hard-link, missing-cache, and cache-root-override scenarios. Verify combined totals, no-active-VM behavior, default-no behavior, exact stale deletion after confirmation, target revalidation, preservation of protected/unrecognized entries, and cleanup after controller-inspection failures. Keep the existing Docker category, active-volume, lease-release, and prune assertions as regressions.

Update CLI help and `pi/sandbox/README.md` so `storage list` and `storage purge` explicitly distinguish ephemeral guest Docker storage from persistent host VM image generations. Document that old input digests accumulate until an explicit confirmed purge, and that current/live generations and unrecognized cache entries are preserved. Keep the saved plan document with the implementation commit as required by the repository workflow.

Observable outcomes: help and README no longer claim that storage management covers only active-VM Docker data, and tests fail if host cache becomes invisible or cleanup crosses a protected boundary.

## Critical Files

- `pi/sandbox/gondolinier.mjs` — combined storage inventory, formatting, confirmation, and guarded stale-generation deletion.
- `pi/sandbox/build-gondolin-image.mjs` — canonical cache-root and current image-generation derivation; primarily a source of reused invariants rather than a new cleanup location.
- `pi/sandbox/client.mjs` — validated live-controller manifest contract whose `imageGeneration` protects in-use cache entries.
- `pi/sandbox/test-gondolinier.mjs` — focused behavioral and deletion-safety coverage.
- `pi/sandbox/README.md` — canonical operator definition of Docker storage versus host VM image-cache storage.

## Verification

- **Host-cache feature scenarios:** focused tests construct multiple image generations and verify allocated-byte accounting, current/live protection, stale classification, unknown-entry preservation, hard-link accounting, and empty/missing cache behavior.
- **Purge safety scenarios:** tests prove decline is a no-op, confirmation removes only the previewed stale generations, reclassification before deletion prevents races, symlinks cannot escape the images directory, and an inspection failure causes no deletion.
- **Docker regressions:** retain exact category aggregation, active-volume warnings, no-data handling, controller release, and `docker system prune --all --volumes --force` confirmation behavior.
- **Public smoke check:** run `gondolinier storage list` against the real cache and compare its host-image allocation and generation count with a read-only `du`/directory inventory. Do not purge the real cache as part of automated verification.
- **Focused and full checks:** run `npm --prefix pi/sandbox run test:gondolinier`, then `npm --prefix pi/sandbox test`, followed by `git diff --check` and a final diff review for scope and deletion safety.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Classify host VM image generations safely
- ☑ Combine image-cache inspection with storage purge
- ☑ Lock the expanded contract into tests and documentation
<!-- pi-plan-mode:progress:end -->
