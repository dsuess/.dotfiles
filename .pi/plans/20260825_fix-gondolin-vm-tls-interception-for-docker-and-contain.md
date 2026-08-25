# Enable Direct Public TCP in the Gondolin VM

## Context

The requested firewall-rule change cannot be applied literally. Gondolin 0.12.0 does not use guest `REDIRECT` or `TPROXY` rules and does not provide ordinary host NAT. Its host-side TypeScript network stack terminates every guest TLS flow, presents a certificate signed by the Gondolin MITM CA, and then replays the HTTP request. Docker bridge traffic is normally masqueraded to the VM address before Gondolin sees it, so interface names such as `docker0` and Compose-created `br-*` devices are not available at Gondolin’s enforcement point. Gondolin’s own security documentation confirms that the host userspace stack—not guest firewall rules—is the network boundary: https://github.com/earendil-works/gondolin/security and https://earendil-works.github.io/gondolin/network/.

The selected replacement is an explicit **public TCP passthrough** mode for the complete VM. It will open raw host TCP connections for guest flows, including Docker builds, default-bridge containers, and Compose networks. Destination lookup must still reject loopback, private, carrier-grade NAT, link-local, metadata, and other internal addresses for IPv4 and IPv6. DNS remains host-controlled, and non-DNS UDP remains blocked. This is not fully unrestricted VM networking.

This changes the security contract: Gondolin can no longer inspect HTTP requests, inject HTTP secrets, enforce path/method rules, or independently disable WebSockets for passthrough flows. It also permits non-HTTP protocols over public TCP. The retained boundary is destination-level public-address enforcement plus the VM and filesystem isolation. That trade-off is accepted to ensure clients see public origin certificates and to avoid project-specific certificates, disabled validation, or Visonic image/Compose changes.

The worktree already contains uncommitted sandbox settings-schema work. Implementation must integrate with those edits rather than reset or overwrite them. The implementation and this plan document must be committed together, per repository policy.

## Questions & Answers

| Question | Answer |
|---|---|
| Gondolin has no guest REDIRECT/TPROXY rules: its host-side TypeScript stack MITMs every HTTPS flow, and Docker NAT makes container traffic indistinguishable from other guest traffic. Which boundary should the fix use? | Public TCP passthrough (Recommended) — disable HTTP/TLS interception for the whole VM while keeping private, loopback, link-local, and metadata destinations blocked. |

## Approach

Introduce a distinct, security-visible `public-tcp` network mode instead of silently changing the meaning of the existing `public-http` mode. Keep `public-http`, `allowlist`, and `offline` behavior available for callers that still require mediated HTTP. The current checked-in VM settings will select `public-tcp`.

Because the latest published Gondolin package is still 0.12.0 and exposes raw TCP only for explicit fixed host mappings, carry the smallest deterministic compatibility patch locally. The patch must remain pinned to the exact package version and expected source anchors, fail closed if upstream content changes, and be applied after every `npm ci`. This avoids an unreviewed mutable `node_modules` edit while providing an immediately deployable fix until upstream offers the capability.

### Part A — Add a pinned Gondolin public-TCP capability
- **Ledger:** {"status":"completed","note":"Added a pinned, fail-closed @earendil-works/gondolin@0.12.0 runtime/declaration patch with public raw TCP, per-host synthetic DNS, connect-time all-address guarding, cleanup/flow-control preservation, and install integration.","evidence":"`node --test pi/sandbox/test-apply-gondolin-public-tcp-patch.mjs` passed clean/idempotent/version/anchor cases; `npm --prefix pi/sandbox run test:controller` passed (24 tests)."}

Add a checked-in patch applicator for `@earendil-works/gondolin@0.12.0` that validates the package version and exact expected inputs before changing the installed runtime and declarations. Wire it into the sandbox dependency-install path immediately after `npm ci`; an unknown or partially patched package must stop installation instead of starting a VM with ambiguous policy.

Extend Gondolin’s resolved server/network options with one explicit public-TCP passthrough flag. In this mode, synthetic DNS must retain per-host attribution, each guest TCP flow must connect to the attributed hostname or literal destination through a raw socket, and the connect-time lookup must evaluate every IPv4/IPv6 result through a destination policy before any socket opens. Mapped TCP behavior remains explicit and unchanged; offline mode must never enable passthrough.

The passthrough implementation must preserve flow-control limits, cancellation, socket cleanup, and QEMU activity accounting. It must not fall back to MITM when attribution or policy checks fail. Acceptance for this part is a deterministic patch/install test plus focused network tests proving public raw TCP is enabled only when requested and internal resolutions are rejected before connection.

### Part B — Expose the mode and remove MITM trust propagation
- **Ledger:** {"status":"completed","note":"Exposed `public-tcp` in both settings implementations, selected it in checked-in settings, passed the guarded option into the controller, and removed guest/container MITM CA propagation.","evidence":"`npm --prefix pi/sandbox run test:controller`, `test:extension`, and `test:wrapper` passed; policy tests assert raw TCP omits HTTP hooks and blocks metadata; extension tests assert no CA environment override."}

Add `public-tcp` to both sandbox settings implementations: `pi/sandbox/policy.mjs` and the `/sandbox` settings store/view. Keep strict parsing, exact-key validation, atomic settings persistence, and the existing `public-http`, `allowlist`, and `offline` choices. Update `pi/sandbox/settings.json` to select `public-tcp`; the policy generation already incorporates the network object, so this change will force controller convergence.

Have `createNetworkOptions()` construct the public-address guard and enable the patched Gondolin option only for `public-tcp`. Preserve synthetic DNS and its hostname attribution. Continue to reject private/internal destinations after host resolution, including mixed IPv4/IPv6 answer sets and DNS rebinding attempts. Do not broaden explicit host TCP mappings or expose host/LAN services.

Prevent Gondolin from installing its MITM CA into the guest trust store by supplying an empty read-only `/etc/gondolin/mitm` mount while retaining Gondolin’s separate `/etc/gondolin` control mount. Remove the controller’s Gondolin-specific CA environment variables and remove the Docker wrapper that mounts `/run/gondolin/ca-certificates.crt` into every `docker run`. Docker remains guest-local with normal bridge, forwarding, masquerading, `vfs` storage, and no host socket/settings. Standard distro and image CA stores become the only trust source.

Acceptance for this part is that normal guest tools and unmodified containers reach public HTTPS, no container receives a Gondolin CA mount or CA environment override, and all existing internal-destination probes remain blocked.

### Part C — Prove the certificate and Docker contract
- **Ledger:** {"status":"completed","note":"Native canary now verifies direct public certificate validation, absence of Gondolin CA mounts/overrides, the supplied git command, BuildKit, Compose default-network egress, raw TCP, and retained blocked destinations; documentation and invariants now state the contract.","evidence":"`./install.sh config` passed and applied the pinned patch; `npm --prefix pi/sandbox run test:canary` passed after image rebuild; `npm --prefix pi/sandbox run test:native` passed (including the supplied python/git command, certificate probe, Docker/Compose and destination probes); final `npm --prefix pi/sandbox test` and `git diff --check` passed."}

Update the native canary to exercise the exact supplied `python:3.12-slim` `git ls-remote` command. Add an independent TLS peer-certificate probe inside a normal bridge-network container that fails if the issuer or certificate chain references Gondolin and confirms the certificate is valid under the image’s public CA store. Cover a normal BuildKit build and Compose default network without copying a Gondolin CA into the build context or changing project files.

Retain regression coverage for Docker’s default and Compose-created bridges, DNS, public HTTPS, ephemeral guest-native Docker state, host Docker isolation, and blocked loopback/private/link-local/metadata destinations. Include a direct non-HTTP public TCP smoke case so the selected mode’s scope is tested rather than inferred from HTTPS alone.

Update `pi/sandbox/README.md` and the Pi sandbox development invariants to describe the new mode, the removed MITM trust propagation, the retained destination blocks, and the accepted loss of content-aware HTTP policy. Do not add Visonic-specific instructions or configuration. Record that `allowWebSockets` governs mediated modes only; public TCP passthrough cannot inspect or selectively block WebSocket upgrades.

## Critical Files

- `pi/sandbox/policy.mjs` — canonical runtime parsing and translation from network settings to Gondolin options and destination guards.
- `pi/agent/extensions/gondolin-sandbox/settings-store.ts` and `settings-view.ts` — `/sandbox` persistence and presentation of the security-visible mode.
- `pi/sandbox/controller.mjs` and `pi/sandbox/image/docker-init-extra.sh` — guest environment, trust injection, and guest-local Docker startup boundary.
- `pi/sandbox/test-gondolin-canary.mjs` — native proof of direct certificates, Docker/BuildKit/Compose networking, and retained internal blocking.
- `install.sh` and the new pinned patch applicator — reproducible installation of the exact Gondolin compatibility change.
- `pi/sandbox/README.md` — operator-facing network and accepted-risk contract.

## Verification

- **Patch/install regression:** Run the patch applicator tests against clean, already-patched, version-mismatched, and anchor-mismatched fixtures. Run `./install.sh config` and confirm the pinned dependency is installed, patched, and verified without manual `node_modules` edits.
- **Focused regressions:** Run `npm --prefix pi/sandbox run test:controller`, `npm --prefix pi/sandbox run test:extension`, `npm --prefix pi/sandbox run test:wrapper`, and the relevant settings-store tests. Existing mediated, allowlist, offline, explicit TCP-mapping, filesystem, controller-generation, and Docker-isolation scenarios must remain green.
- **Native feature gate:** Rebuild the image because the Docker init script is an image input, replace the shared VM, then run `npm --prefix pi/sandbox run test:canary`. Success requires direct public certificates from the guest and containers, ordinary BuildKit and Compose networking, and failure for every retained internal-destination probe.
- **Required acceptance command:** Run the supplied command unchanged in the rebuilt VM and require exit code 0:

  ```bash
  docker run --rm python:3.12-slim sh -ec '
    apt-get update -qq
    apt-get install -y -qq ca-certificates git
    git ls-remote --exit-code https://github.com/ytdl-org/youtube-dl.git HEAD
  '
  ```

- **Certificate signal:** In a normal bridge-network container, complete a verified TLS handshake to `github.com`, inspect the peer/chain issuer, and require that no subject or issuer contains `gondolin` or `gondolin-mitm-ca`. A successful Git command alone is insufficient because it could still succeed through a trusted MITM.
- **Final regression:** Run `npm --prefix pi/sandbox test`, `npm --prefix pi/sandbox run test:native`, `git diff --check`, and inspect the final diff without discarding the pre-existing settings-schema work.
- **Failure signals:** Any Gondolin-issued peer certificate, `/run/gondolin/ca-certificates.crt` mount or CA override inside a new container, successful access to an internal/metadata address, unpatched-package startup, loss of Docker bridge/Compose networking, or host Docker exposure means the change is incomplete.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Add a pinned Gondolin public-TCP capability
- ☑ Expose the mode and remove MITM trust propagation
- ☑ Prove the certificate and Docker contract
<!-- pi-plan-mode:progress:end -->
