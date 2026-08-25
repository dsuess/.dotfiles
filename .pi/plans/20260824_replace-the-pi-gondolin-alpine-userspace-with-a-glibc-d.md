# Build a glibc Pi development VM

## Context

The current Pi tool-plane image uses Alpine 3.23 and musl. Its package list provides the core shell, language, and nested-Docker tools, but it does not provide a Playwright-capable browser stack, Serena build headers, `gcloud`, or `direnv`.

“Change the base image” means replacing the guest **root filesystem/userspace**, not the complete Gondolin boot pipeline. Gondolin 0.12.0 only implements its Alpine kernel/initramfs builder, but it can import an OCI root filesystem such as Debian while retaining those Alpine boot artifacts. The implementation must therefore keep `distro: "alpine"` for Gondolin’s builder and set a glibc OCI rootfs source; describing the resulting guest as Alpine would be incorrect. This is the supported Gondolin model: https://earendil-works.github.io/gondolin/custom-images/

Use a digest-pinned Node 24 Debian Trixie slim image as the rootfs foundation. Trixie supplies glibc 2.41, which is new enough for the existing RTK 0.44.0 ARM64 GNU binary’s glibc 2.39 floor; Bookworm’s older glibc would not be sufficient. The obsolete Alpine `gcompat`/`LD_PRELOAD` RTK compatibility layer can then be removed. Debian also packages system Chromium with the GLib, NSS, accessibility, audio, X11/XCB, DRM/GBM, Pango/Cairo, fontconfig, and related runtime dependencies requested here: https://packages.debian.org/trixie/chromium

System Chromium is a baseline and canary, not a replacement for project-managed Playwright browsers. Playwright binds each release to specific browser revisions, so repositories may still run `playwright install chromium`; the glibc libraries and persistent tool cache will make those matching downloads usable: https://playwright.dev/docs/browsers

The TLS failure is a separate clock defect, not an Alpine defect. A live production VM probe after host sleep showed host time near 08:58, guest system time near 08:22, and the emulated hardware clock near 08:57. QEMU’s guest clock had paused while the Mac slept, so newly generated proxy certificates were not yet valid according to the guest. A glibc rootfs alone would leave this failure intact. The runtime must resynchronize from QEMU’s correct RTC at boot and before controller executions, with lightweight background correction for already-running guest processes.

On a glibc distribution, the requested equivalent of Alpine’s `musl-dev` is `libc6-dev`; `python3-dev`, `build-essential`/GCC, and `linux-libc-dev` provide the remaining Serena build surface. `gcloud` means the CLI executable only: the existing policy must continue to withhold host `~/.config/gcloud` and credentials. `direnv` means the binary only; the image must not auto-allow repository `.envrc` files or alter protected shell startup files.

The accepted delivery tradeoff is a local Docker build. A running host Docker daemon is required only when a missing or forced image build needs the OCI rootfs; the Docker socket remains a host build-time dependency and is never mounted into the guest. The larger browser/development image and slower first build are accepted costs. The built Gondolin assets remain checksum-verified and digest-addressed. No domain glossary or ADR is warranted; `pi/sandbox/README.md` is the existing canonical operator document for this infrastructure.

## Questions & Answers

| Question | Answer |
|---|---|
| How should the custom glibc rootfs be built and supplied? | Build it locally with Docker. |
| Which browser baseline should the shared VM provide? | Bake in system Chromium, while allowing repositories to cache their Playwright-version-matched browser. |
| What should `gondolinier image build` own? | Build the local Docker rootfs, import it into Gondolin, verify the final image, and clean the temporary Docker tag; `install.sh config` uses the same reusable path. |

## Approach

Build a reviewed Debian OCI userspace first, then have one reusable host workflow assemble and verify the complete Gondolin image. Preserve all existing VM isolation and nested-Docker behavior, repair the independent post-sleep clock defect at the runtime boundary, and prove the result with focused orchestration tests plus native browser/toolchain scenarios.

### Part A — Build the glibc development rootfs
- **Ledger:** {"status":"completed","note":"Added digest-pinned Node 24/Trixie OCI rootfs with Chromium, Debian development/Docker stack, and checksum-verified UV, gcloud, direnv, and RTK. Removed musl RTK compatibility artifacts.","evidence":"Built pi-gondolin-rootfs:smoke locally and verified Debian 13/Trixie, glibc 2.41, direct RTK, gcloud 580.0.0, direnv 2.37.1, Chromium, Docker/Buildx/Compose, and Python/Linux header compilation."}

Add a reviewed, multi-architecture rootfs Dockerfile under `pi/sandbox/image/`, based on a digest-pinned Node 24 Trixie slim image. Install the existing guest capabilities plus system Chromium and fonts; GNU build tools, Python development headers, glibc development headers, and Linux userspace headers; `gcloud`; and `direnv`. Preserve Bash, certificates, Git/SSH, ripgrep, `fd`, Node/npm, Python, UV, RTK, Docker Engine, Buildx, Compose, iptables, and e2fsprogs so the base-image change does not regress the established tool plane.

Use architecture-aware, reviewed versions and checksums for externally downloaded standalone tools such as UV, RTK, `gcloud`, and `direnv`, and pin the root image by digest. Let Debian security repositories resolve browser/runtime/build package updates when an explicit rebuild occurs; do not claim byte-for-byte reproducibility across rebuild dates. Remove apt indexes and other installation residue from the final rootfs.

Replace Alpine package population in `image/docker.json` with Gondolin’s OCI-rootfs configuration while retaining the Alpine kernel/initramfs settings required by Gondolin 0.12.0. Update the image input digest and metadata schema to include the Dockerfile and all new reviewed build inputs. Remove `gcompat`, the RTK preload wrapper, compatibility source, and precompiled compatibility objects once native glibc execution is proven; copy RTK directly and retain the architecture-specific upstream asset selection that works on glibc.

Guardrails: support both `aarch64` and `x86_64`; keep the root filesystem in memory mode; do not bake credentials, project files, Playwright npm packages, Serena itself, or an auto-approved `direnv` environment into the shared image. The observable result is a Debian GNU/Linux userspace reporting glibc, with every requested executable and development/runtime library present.

### Part B — Expose one complete image-build workflow
- **Ledger:** {"status":"completed","note":"Image assembly now builds a uniquely tagged local OCI rootfs, imports it with pullPolicy never, verifies/publishes atomically, and always removes the temporary tag. Added gondolinier image build and cache-aware installer reuse.","evidence":"Ran `node pi/sandbox/gondolinier.mjs image build`; it built and verified /Users/dsuess/.cache/pi-gondolin/images/d5ee336eb4ec764ffde8635d51878156d429de95ddb7f8e42398aed2039147cc and removed its temporary Docker tag. Image-builder and gondolinier unit tests pass."}

Refactor `build-gondolin-image.mjs` so one reusable operation builds a uniquely tagged local OCI rootfs for the host architecture, imports it through Gondolin with `pullPolicy: "never"`, writes and verifies the final digest-addressed Gondolin image, and removes the temporary Docker tag in success and failure paths. Preserve cache hits: if the current verified Gondolin image already exists, normal installation must not require a running Docker daemon. A missing Docker client/daemon or failed rootfs build must stop with a specific error and the recovery command.

Add `gondolinier image build` to the public host CLI. It must perform the full forced rootfs-plus-Gondolin build and verification, print the resulting image path/identity, and never start a controller or VM. Extend command-specific help and unit-testable dependency injection rather than shelling through the Stow launcher in tests. Keep the existing `vm` and `storage` contracts unchanged.

Make `./install.sh config` call the same reusable image-build path for a missing/current image instead of maintaining separate Docker logic. The first build therefore requires the user-selected running host Docker daemon; later unchanged installs use the verified cache. Record the operator-facing image-build command as a Pi repository invariant in `pi/AGENTS.md`, and document that all deployment still occurs through Stow rather than manual links or copies.

Acceptance outcomes: `gondolinier image build` rebuilds and verifies both layers; a bad Docker preflight fails before publishing a Gondolin image; interrupted builds leave no final partial directory or temporary tag; and a cache-hit install succeeds while Docker is stopped.

### Part C — Preserve runtime isolation and repair wall-clock drift
- **Ledger:** {"status":"completed","note":"Added RTC synchronization at guest boot, periodic guest correction, and fail-closed pre-execution controller synchronization while preserving active-cancellation restart behavior. Adapted Debian Docker startup with vfs and guest-only host networking.","evidence":"`npm --prefix pi/sandbox run test:controller` passed (including ordering/failure/cancellation tests); `npm --prefix pi/sandbox run test:controller-native` passed with guest Docker vfs health after the Debian migration."}

Adapt `docker-init-extra.sh` to the Debian rootfs without weakening the existing guest-local Docker boundary: keep cgroup v2 setup, the CA wrapper, `vfs` storage at guest-native `/var/lib/docker`, BuildKit/Compose support, and the prohibition on host Docker socket/settings mounts. Use distro-independent command discovery where paths differ from Alpine.

At guest boot, set system time from QEMU’s RTC before starting network-sensitive services. Add a small background RTC correction for processes that remain alive across host sleep. At the production controller boundary, synchronize the RTC before each requested guest execution so the first command after wake cannot observe a certificate-invalid stale clock. Clock synchronization failure must fail the requested execution with a clear sandbox error rather than silently reintroducing TLS failures; it must not change policy, lease, generation, cancellation, or VM-restart semantics.

Keep CA composition and all network allowlist/internal-address protections intact. Do not add NTP egress or a new network exception: the emulated RTC is already accurate and avoids introducing another trusted endpoint.

Acceptance outcomes: nested Docker remains healthy and isolated on Debian; a deliberately stale guest clock is corrected before the next controller command; public HTTPS, apt repository access, and headless browser HTTPS work immediately afterward; and a long-lived guest process is corrected shortly after a host resume.

### Part D — Prove the development loop and update its contract
- **Ledger:** {"status":"completed","note":"Expanded the native contract to Debian/glibc, direct RTK, Chromium/fonts, pinned Playwright Chromium, Python/Linux headers, gcloud/direnv, RTC recovery, Docker isolation, BuildKit, and Compose. Updated operator documentation and deployed through Stow.","evidence":"`npm --prefix pi/sandbox test` passed; `npm --prefix pi/sandbox run test:native` passed end-to-end; `./install.sh config` completed successfully; `git diff --check --no-ext-diff --text` passed."}

Extend focused tests before completing each behavior slice. CLI tests must cover `gondolinier image build` help, successful orchestration, cache/force behavior, Docker failure propagation, verification failure, and cleanup. Controller tests must cover synchronization ordering and failure behavior without changing existing cancellation/restart guarantees.

Expand the native canary from a generic Alpine tool list into an explicit glibc development-image contract. Prove GNU libc and Debian identity; direct RTK execution without preload; system Chromium headless startup with fonts and public HTTPS; a pinned Playwright download and headless launch; a representative Python C-extension/header compilation for Serena’s build dependencies; and successful `gcloud` and `direnv` version commands. Deliberately move the guest clock behind, then prove that the next controller execution restores current time and can reach HTTPS package endpoints. Retain all current filesystem, network, Docker xattr/BuildKit/Compose, ephemerality, and host-isolation scenarios, changing only Alpine-specific assertions about the guest OS.

Update `pi/sandbox/README.md` to describe the Debian/glibc OCI rootfs over Gondolin’s Alpine boot pipeline, exact tool categories, system-versus-Playwright Chromium behavior, the build-time host Docker requirement, `gondolinier image build`, clock recovery, and the unchanged credential/isolation boundaries. Remove obsolete statements that the guest userspace and toolchain are Alpine. Keep the existing Alpine nested-container example where it still tests Docker behavior; distinguish that container image from the Debian VM userspace.

The final change must include this approved plan document in the same commit, remove obsolete compatibility artifacts, and avoid unrelated launcher, policy, or extension refactors.

## Critical Files

- `pi/sandbox/image/rootfs.Dockerfile` and `pi/sandbox/image/docker.json` — define the glibc userspace and Gondolin OCI import boundary.
- `pi/sandbox/build-gondolin-image.mjs` — owns input hashing, transient local OCI construction, Gondolin assembly, verification, and cleanup.
- `pi/sandbox/gondolinier.mjs` and `bin/gondolinier` — expose the full operator-facing image build without bypassing Stow.
- `pi/sandbox/image/docker-init-extra.sh` and `pi/sandbox/controller.mjs` — preserve guest Docker startup and recover wall-clock correctness after host sleep.
- `pi/sandbox/test-gondolin-canary.mjs` — native proof of browser, compiler, CLI, clock, Docker, network, and isolation behavior.
- `pi/sandbox/README.md` — canonical installation and runtime contract.

## Verification

- **Focused regressions:** run the gondolinier, image-builder, controller, and protocol tests. Success means command dispatch and help are stable, mocked Docker/Gondolin phases occur in order, temporary resources are always cleaned, and clock-sync failures fail closed.
- **Image build scenario:** with the host Docker daemon running, run `gondolinier image build`. Success means the local OCI rootfs builds for the host architecture, the final image verifies, its metadata includes the new inputs, and no temporary tagged rootfs remains. Stop Docker afterward and confirm an unchanged `./install.sh config` uses the verified cache.
- **Guest toolchain scenario:** boot the rebuilt image and require Debian/Trixie identity, GNU libc at or above the RTK requirement, direct RTK execution, Node/npm/Python/UV, GCC plus Python and Linux header compilation, `gcloud version`, and `direnv version`.
- **Browser scenarios:** launch system Chromium headlessly against a local page and public HTTPS, verify rendered output/font availability, then install a pinned Playwright Chromium revision and launch it through Playwright. Missing shared libraries, sandbox/process crashes, TLS errors, or absent browser output are failures.
- **Clock/TLS scenario:** use the native controller test to set guest system time behind the RTC, then issue a fresh command. Success means time is restored within a tight host tolerance before HTTPS and apt metadata access; the control test must show that clock-sync failure prevents the requested workload.
- **Docker and isolation regressions:** retain Docker pull/run, BuildKit external-stage copy, Compose, xattr-compatible `vfs`, VM ephemerality, blocked internal destinations, protected host paths, and absence of host Docker settings/socket.
- **Full checks:** run `npm --prefix pi/sandbox test`, then `npm --prefix pi/sandbox run test:native` from an ordinary terminal or `--yolo` session with the required host services. Finish with `git diff --check`, inspect the complete diff and deleted compatibility files, and deploy only through `./install.sh config`.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Build the glibc development rootfs
- ☑ Expose one complete image-build workflow
- ☑ Preserve runtime isolation and repair wall-clock drift
- ☑ Prove the development loop and update its contract
<!-- pi-plan-mode:progress:end -->
