# Fix Sandboxed Pi Startup and Test the Installed Launcher

## Context

A production-shaped launch from `/Users/dsuess/src/canva` through `/Users/dsuess/bin/pi` reproduces the failure. Keeping RPC stdin open long enough for VM startup ends with `timed out waiting for the Gondolin routing extension handshake`. The controller log identifies the actual failure: the current Pi sources expect image generation `72b11a…`, but only the previous generation is cached. The generation changed because the in-progress Gondolin mount-path compatibility work correctly added the patched guest init parser to the immutable image inputs. The prior deployment attempt could not materialize that generation because the host Docker daemon was unavailable.

`canva` is not a Git worktree, but that is not the defect. `discoverRepositoryScope()` deliberately and correctly treats a non-repository launch directory as the canonical workspace. The failure occurs later, when the detached controller verifies the expected image. Normal startup must remain fail-closed and verify-only; it must not silently build an image or fall back to host tools. Image construction remains an explicit `./install.sh config`/`gondolinier image build` operation that requires host Docker only when reviewed image inputs changed.

A second issue hides this root cause. Launcher preflight returns the PID of the detached controller it started, but `acquireControllerLease()` discards that PID when it waits for the manifest. An immediately failed controller is therefore reported only as the outer handshake timeout instead of the controller log’s actionable missing-image error.

The existing canonical command, `npm --prefix pi run check`, is already required after every `pi/` change and deliberately is not an automatic Git hook. However, its native suites call `ensureGondolinImage()` before production inventory checks, so they can build the missing generation and mask the exact stale-deployment failure. The gate needs an installed-launcher canary that runs first, invokes the explicit `~/bin/pi` wrapper as requested, and proves a fresh non-Git workspace reaches routed VM execution without a model request or persistent session.

No glossary or ADR is warranted. **Canonical workspace**, **image generation**, **controller**, **routing handshake**, and **installed launcher** already have precise meanings in the Pi sandbox documentation. The current unrelated and in-progress working-tree changes, including the spaced-path work and its existing plan, must be preserved; this plan document must be committed with the implementation.

## Approach

Keep image construction explicit, restore actionable detached-controller failure propagation, then add a production launcher canary ahead of all native tests that can build or warm the expected image.

### Part A — Report detached controller startup failures immediately
- **Ledger:** {"status":"completed","note":"Retained validated cold-start PID through lease acquisition and fail immediately with bounded controller log after it exits pre-manifest.","evidence":"`npm --prefix pi/sandbox run test:controller` passed (34 tests), including warm manifest and dead detached-controller diagnostic coverage."}

Extend the controller-client startup wait so `acquireControllerLease()` observes the trusted `startupPid` from the validated startup descriptor. If that detached process exits before publishing a valid manifest, read the bounded controller log and return `controller_start_failed` immediately. Preserve the existing manifest validation, timeout, cancellation, PID-safety, and fail-closed behavior; do not increase the handshake timeout or treat a failed controller as recoverable.

Add deterministic coverage for a detached controller that exits before manifest publication. The test must prove the wait ends before the normal timeout and includes the bounded underlying diagnostic, such as a missing image, while healthy/warm manifest handling remains unchanged. The routing extension can then write its failed handshake, allowing `~/bin/pi` to surface the cause instead of only a 15-second generic timeout.

Acceptance means the currently missing generation is reported as the controller’s missing-image failure, and no host tool or native built-in becomes active.

### Part B — Add a production installed-launcher canary to the Pi gate
- **Ledger:** {"status":"completed","note":"Added host-only installed Stow-wrapper RPC canary as the first native suite and documented its complete-gate role.","evidence":"The new canary invoked `~/bin/pi` from a disposable non-Git workspace before image-building suites; against the undeployed generation it failed in ~0.8s with the bounded actionable missing-image diagnostic (`72b11a…`), not the former handshake timeout."}

Add a bounded native test that creates a disposable non-Git workspace and spawns the absolute installed wrapper at `~/bin/pi` in RPC mode with session persistence disabled. Keep stdin open, use strict LF-delimited JSONL framing, and issue an RPC `bash` probe such as `pwd`. Assert that startup completes, the command executes through the Gondolin replacement in the exact canonical workspace, no model prompt is sent, and closing stdin exits cleanly and releases the root lease.

Wire this canary as the first native suite reached by `npm --prefix pi run check`, before any suite that calls `ensureGondolinImage()`. This ordering is the regression boundary: a changed `pi/` image input without a deployed matching generation must fail the canonical gate through the same `~/bin/pi` path a user runs, rather than being repaired or hidden by a later native test. Keep it out of `check:deterministic`, because a Gondolin-routed Pi cannot validate its own host launcher or start a sibling host VM.

Validate that `~/bin/pi` resolves to the repository’s Stow-managed `bin/pi`; fail with an actionable deployment message if the wrapper, current image generation, routing handshake, or guest probe is unavailable. Update the Pi verification documentation to state that the complete gate includes this installed non-repository launcher canary. Do not add a Git hook, file watcher, or test invocation to `./install.sh config`; the existing repository rule remains that the complete gate is run once after every Pi change.

### Part C — Materialize the current image and prove the reported scenario
- **Ledger:** {"status":"completed","note":"Started Docker Desktop, deployed only through `./install.sh config`, verified image `72b11a…`, and repaired the existing spaced-path readiness check exposed by native verification.","evidence":"Installed-launcher canary and Canva RPC `pwd` both exited cleanly; `gondolinier vm list` reported no managed/orphaned QEMU. `PI_BIN=$HOME/bin/pi npm --prefix pi run check` passed fully, including all deterministic and native suites."}

With the host Docker daemon available, run `./install.sh config` so Stow remains the only deployment mechanism, the reviewed Gondolin compatibility patches are reapplied, and the current image generation is built and verified. Do not manually copy files, create links, relabel the old image, or weaken the image-input checksum.

Run the new installed-launcher canary before later native suites can build another image. Then repeat the production-shaped RPC startup from `/Users/dsuess/src/canva` with `/Users/dsuess/bin/pi`, execute a routed `pwd` probe, and close cleanly. This exact check distinguishes caller environment, non-Git workspace fallback, installed wrapper selection, controller/image readiness, and guest tool routing.

Finally run the complete Pi gate and review the full diff, including the already-present spaced-path changes, without overwriting unrelated modifications. Acceptance requires the current image to verify, Canva startup to reach healthy sandbox routing, final lease release to leave no managed or orphaned QEMU, and every maintained deterministic and native suite to pass.

## Critical Files

- `pi/sandbox/client.mjs` — validates startup descriptors and waits for detached controller manifest publication; it must retain the startup PID diagnostic boundary.
- `pi/sandbox/test-controller.mjs` (or a narrowly scoped client test) — proves immediate, bounded propagation of detached startup failure logs.
- `pi/sandbox/test-installed-launcher.mjs` — production canary for the Stow-installed `~/bin/pi` wrapper in a disposable non-Git workspace.
- `pi/sandbox/package.json` and `pi/test-gate.mjs` — place the installed-launcher canary before native suites that can build or warm images.
- `pi/AGENTS.md` and `pi/sandbox/README.md` — define the every-Pi-change complete gate and its host-only installed-launcher coverage.

## Verification

**Regression checks**

- Run the focused controller-client test. Success means a dead detached startup PID produces `controller_start_failed` with the bounded controller-log cause before the configured timeout; valid manifests still connect normally.
- Run the deterministic sandbox suite and `npm --prefix pi run check:deterministic`. Success means repository-scope fallback, wrapper filtering, image verification, extensions, and all maintained package tests remain green.
- Deliberately point the installed-launcher canary at a fixture with no matching image generation. Success for this negative scenario means it fails before later image-building suites and includes an actionable missing-generation/deployment diagnostic.

**Installed-launcher and reported scenarios**

- After `./install.sh config` builds the current generation, run the canary with the absolute `~/bin/pi` path. Success means its RPC `bash` response reports the disposable canonical workspace, exits zero without a model call or saved session, and releases the VM lease.
- Run the same bounded RPC probe from `/Users/dsuess/src/canva` through `/Users/dsuess/bin/pi`. Success means the non-Git workspace reaches a healthy VM and guest `pwd` is exactly `/Users/dsuess/src/canva`; a handshake timeout, host execution, or stale managed/orphaned QEMU is a failure.
- From an ordinary terminal or `pi --yolo` session, run `npm --prefix pi run check`. Success requires the installed-launcher canary to run before all image-building native suites and every deterministic, QEMU, Docker, routing, production-inventory, Ketch, and live-network check to pass.
- Run `git diff --check`, review all changed files, preserve unrelated working-tree changes, and include this plan document in the implementation commit.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Report detached controller startup failures immediately
- ☑ Add a production installed-launcher canary to the Pi gate
- ☑ Materialize the current image and prove the reported scenario
<!-- pi-plan-mode:progress:end -->
