# Enable Docker bridge networking with a Debian kernel

## Context

The Pi sandbox already uses a Debian Trixie OCI root filesystem, but Gondolin 0.12.0 still supplies an Alpine `linux-virt` kernel and Alpine initramfs. This distinction matters: Gondolin documents OCI support as replacing the userspace root filesystem while retaining its Alpine boot layer and kernel packaging ([custom-image documentation](https://earendil-works.github.io/gondolin/custom-images/)). “Use Debian” therefore means replacing the runtime QEMU kernel and matching `/lib/modules` tree with Debian artifacts while retaining Gondolin’s Alpine initramfs and reviewed sandbox helpers.

The current worktree removes Docker’s `--bridge=none`, `--iptables=false`, `--ip-forward=false`, and `--ip-masq=false` options and stops forcing `docker run` onto host networking. A rebuilt native VM then proves the deeper blocker: Alpine `linux-virt` 6.18.44 reports the required bridge/netfilter features as modules, but every module load returns `ENOSYS`. Docker cannot initialize its network controller and exits before creating the predefined `bridge` network. Reverting to host networking would violate the Visonic VM contract and conceal the missing capability.

Debian Trixie provides architecture-specific kernel metapackages, `linux-image-arm64` and `linux-image-amd64`, which install the current supported kernel and matching modules ([ARM64 package](https://packages.debian.org/trixie/linux-image-arm64), [AMD64 package](https://packages.debian.org/trixie/linux-image-amd64)). The image build already accepts Debian package/security updates when an explicit rebuild occurs, so the kernel can follow the same policy rather than introducing an independently downloaded binary.

The bridge change must preserve the established boundary: Docker remains guest-local with `vfs` storage and no host Docker socket/settings; container traffic must still cross Gondolin’s mediated virtual NIC; the canonical workspace remains read-write; only `~/local_cache` is exposed from the developer home; and a project-local `.gcloud/adc.json` remains available only through the workspace mount. The existing uncommitted Debian-userspace migration and its plan are in scope and must not be overwritten or split into contradictory behavior.

No domain glossary or ADR is warranted. These are general infrastructure terms, and `pi/sandbox/README.md` plus the committed plan document are the repository’s canonical operator and decision records.

## Questions & Answers

| Question | Answer |
|---|---|
| How should the bridge-capable VM kernel be provided after the current Alpine kernel rejected module loading? | Use Debian. |

## Approach

Use the Debian OCI build as the single source of the runtime kernel and modules, then make the Pi image assembler publish a checksum-consistent Gondolin image whose declared kernel is the Debian artifact. Keep Gondolin’s Alpine initramfs only as the bootstrap/control layer. Fail image publication and VM startup unless the resulting kernel, module tree, Docker bridge, and mediated networking are all coherent.

### Part A — Add the matching Debian kernel to the OCI image
- **Ledger:** {"status":"completed","note":"Added architecture-matched Debian kernel metapackage selection and OCI kernel extraction with release/module and architecture validation.","evidence":"`npm --prefix pi/sandbox run test:image-builder` passes (5/5), covering ARM64/AMD64 package/platform selection, extraction validation, and cleanup."}

Extend `pi/sandbox/image/rootfs.Dockerfile` to install the architecture-appropriate Trixie kernel metapackage: `linux-image-arm64` for `TARGETARCH=arm64` and `linux-image-amd64` for `TARGETARCH=amd64`. Keep the existing digest-pinned Node/Trixie base and explicit architecture rejection. Debian’s package manager must install the kernel modules into the same OCI root filesystem that becomes `rootfs.ext4`; do not copy modules from the host or mix Alpine modules with the Debian kernel.

During the Docker rootfs phase, identify the exact installed kernel release and its `/boot/vmlinuz-*` artifact from the temporary OCI image. Require one unambiguous kernel candidate and a matching `/lib/modules/<release>` directory. Extract the kernel through a disposable container, with deterministic cleanup on success and every failure path. A missing kernel, missing modules, architecture mismatch, or ambiguous package result must stop before Gondolin image publication with an actionable build error.

Keep Alpine `linux-virt` only as the temporary Gondolin builder input needed to generate its supported initramfs. It must no longer be described as the runtime kernel. Preserve support for both repository architectures even though macOS ARM64 receives the full native acceptance run.

### Part B — Publish a coherent checksum-addressed image
- **Ledger:** {"status":"completed","note":"Replaced the assembled Alpine kernel asset with the verified Debian artifact, rewrote manifest checksums/build ID, and added cold verification of kernel provenance.","evidence":"`npm --prefix pi/sandbox run test:image-builder` passes (5/5), including manifest/build-ID rewriting, cache invalidation inputs, provenance, and temporary tag/container cleanup."}

After Gondolin assembles the OCI rootfs and Alpine initramfs, replace the QEMU kernel asset in the temporary output with the extracted Debian kernel before final verification. Update the manifest’s kernel checksum and deterministic content-derived build ID so the manifest identifies the assets that will actually boot. Do not retain a stale Alpine-kernel checksum or a build ID derived from the replaced artifact.

Advance the Pi image metadata schema and record enough Debian kernel provenance to verify the package, architecture, release, and kernel checksum on every cold-controller image verification. Keep the complete input digest sensitive to the reviewed Dockerfile, image config, init script, architecture, and Gondolin version; an old cached Alpine-kernel image must not satisfy the new specification. Preserve atomic publication: a previous valid image remains usable until the Debian-kernel replacement verifies, while temporary Docker containers, tags, build directories, and partial image directories are always removed.

Extend image-builder unit coverage for ARM64/AMD64 package selection, kernel discovery, matching-module validation, manifest/checksum/build-ID rewriting, cache invalidation, and cleanup after extraction or verification failures. Avoid importing undocumented Gondolin package subpaths at runtime; if its content-derived build-ID algorithm must be reproduced because it is not publicly exported, isolate it and verify it against known Gondolin manifest vectors.

### Part C — Require normal Docker bridge behavior
- **Ledger:** {"status":"completed","note":"Docker retains normal bridge defaults and controller startup fails closed unless Docker reports vfs and its predefined bridge network.","evidence":"`npm --prefix pi/sandbox run test:controller` passes (23/23); extension suite passes (22/22); wrapper suite passes, including project-local ADC filtering."}

Keep `dockerd` guest-local with `/var/lib/docker`, `vfs`, and the Unix socket inside the VM, but start it with Docker’s normal bridge, firewall, forwarding, and masquerading defaults. Keep `--userland-proxy=false` only because it does not disable bridge networking. The Docker CLI wrapper may continue injecting the composed Gondolin CA bundle for `docker run`, but it must not add `--network host` or override an explicit caller network.

Strengthen controller readiness beyond `docker info`: require the `vfs` data-root invariant and successful inspection of Docker’s predefined `bridge` network. A daemon that starts without bridge capability must leave the sandbox unhealthy and fail closed before agent work is admitted. Preserve Docker Engine, Buildx, Compose v2, iptables/nftables userspace, cgroup setup, RTC synchronization, and ephemeral Docker lifecycle.

Retain the Visonic development surfaces already introduced in the worktree: mount only host `~/local_cache` at `/root/local_cache`, which is the guest-root expansion of Compose’s `~/local_cache`; keep the checked-out project and `.gcloud/adc.json` available through the canonical workspace mount; and forward `GOOGLE_APPLICATION_CREDENTIALS` only when it resolves to a file inside that workspace. Do not expose the complete home, `~/.config/gcloud`, unrelated credentials, or the host Docker socket. Add focused policy, launcher, and environment tests for the allowed path and rejection boundaries.

### Part D — Prove mediated build and runtime networking
- **Ledger:** {"status":"blocked","note":"Native canary remains incomplete: after the Debian-kernel boot and signing-key subtest passed, the final full canary exceeded the 480-second runner bound during its nested Docker acceptance phase.","evidence":"Earlier canary runs verified Debian kernel boot, matching modules, Docker bridge creation, and isolated signing-key boot; the BuildKit TLS probe was corrected to install the composed CA before Alpine package HTTPS. The last run logged the signing-key subtest passing, then the outer runner timed out."}

Expand the native canary to prove the actual Debian runtime kernel with `uname`, a matching `/lib/modules/$(uname -r)`, and successful loading or built-in availability of bridge, veth, and netfilter functionality. Then run the exact Docker acceptance shape: `docker info`, inspect the predefined `bridge`, create and remove a user-defined bridge, and run an Alpine 3.20 container that resolves `registry.npmjs.org` and completes outbound HTTPS.

Run BuildKit without `--network host` and Compose without `network_mode: host`. Add a build step that performs real outbound package-manager HTTPS, not only a local file operation, so certificate/DNS/NAT defects are observable before Visonic’s Storybook `RUN npm install`. Verify that runtime and build containers can reach permitted public HTTPS while loopback, RFC1918, link-local, and metadata destinations remain blocked through Gondolin after Docker NAT. A passing bridge must not become a policy bypass.

Update `pi/sandbox/README.md` and the task’s committed plan document to use precise terms: Debian userspace and runtime kernel, Alpine initramfs/bootstrap, normal guest Docker bridge networking, and unchanged host isolation. Remove obsolete statements that the QEMU kernel cannot support bridge/netfilter or that containers require host networking.

## Critical Files

- `pi/sandbox/image/rootfs.Dockerfile` — installs the architecture-matched Debian kernel and module tree alongside the existing development userspace.
- `pi/sandbox/build-gondolin-image.mjs` — extracts the Debian kernel, rewrites verified asset identity, publishes atomically, and cleans temporary Docker resources.
- `pi/sandbox/image/docker-init-extra.sh` — starts guest-local Docker with normal bridge defaults while preserving CA and storage behavior.
- `pi/sandbox/controller.mjs` — treats the predefined Docker bridge as a sandbox-readiness invariant.
- `pi/sandbox/test-gondolin-canary.mjs` — native proof of kernel/module compatibility, bridge networking, mediated egress, BuildKit, Compose, mounts, and isolation.
- `pi/sandbox/policy.mjs`, `bin/pi`, and `pi/agent/extensions/gondolin-sandbox/tools.ts` — narrow Visonic cache and workspace-contained ADC exposure boundaries.
- `pi/sandbox/README.md` — canonical operator contract for the mixed bootstrap/runtime architecture.

## Verification

- **Image-builder regressions:** run the image-builder, Gondolinier, controller/policy, routing-extension, and launcher suites. Success means both architectures select the correct Debian package, image identity changes with the kernel, all temporary resources are cleaned, bridge readiness fails closed, and credential filtering remains narrow.
- **Fresh image build:** run `gondolinier image build`. Success means the final manifest verifies against a Debian kernel checksum, the rootfs contains matching modules, the temporary OCI tag/container is absent, and the image is published only after complete verification.
- **Kernel and Docker canary:** boot a fresh QEMU VM and require a Debian kernel/module match, usable bridge/veth/netfilter support, `docker info`, `docker network inspect bridge`, user-defined bridge creation/removal, and DNS plus HTTPS from `alpine:3.20`, all with exit code `0`.
- **Security regressions:** prove normal guest and nested-container public HTTPS while loopback, private, link-local, and metadata destinations remain blocked. Confirm the host Docker socket/settings and host credential directories are absent, while `/root/local_cache` maps only to `~/local_cache` and project ADC remains workspace-contained.
- **Build and Compose scenarios:** run BuildKit without host networking using a real HTTPS package installation, then run Compose on its generated default bridge. Missing DNS, TLS trust, NAT, firewall rules, or network namespace/device support is a failure.
- **Visonic acceptance:** from `/Users/dsuess/src/visonic/dev`, run the exact Docker bridge probe in `instructions.md`, then `.dev/install-serena.sh`, `direnv allow`, `.dev/dev-auth.sh dev` when authentication is needed, `.dev/dev-preflight.sh docker`, `.dev/dev-start.sh docker`, and `.dev/dev-verify.sh docker`. Do not report startup success unless verification succeeds; stop and diagnose the first failing stage without changing Visonic Compose files.
- **Full regression and deployment:** run `npm --prefix pi/sandbox test`, then `npm --prefix pi/sandbox run test:native` from an ordinary terminal or `--yolo` session. Finish with `git diff --check`, inspect the complete mixed worktree diff, include the plan document in the implementation commit, and deploy only through `./install.sh config` so a new controller uses the rebuilt image.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Add the matching Debian kernel to the OCI image
- ☑ Publish a coherent checksum-addressed image
- ☑ Require normal Docker bridge behavior
- ⛔ Prove mediated build and runtime networking
<!-- pi-plan-mode:progress:end -->
