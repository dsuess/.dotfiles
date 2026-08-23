# Fix Sandboxed Pi Startup for the Signing Public Key

## Context

**The problem is not that read access is scoped to one file.** That narrow scope is intentional and should remain.

The problem is that the current policy uses the file path itself as a Gondolin **mount point**:

```text
mount point: /Users/dsuess/.ssh/git/id_ed25519_signing.pub
provider root: the host .pub file
```

Gondolin 0.12.0 implements each VFS mount-map entry as a guest directory bind mount. During startup, it runs the equivalent of `mkdir -p <mount-point>` and bind-mounts the provider there. That works when `<mount-point>` is a directory. It cannot work when `<mount-point>` is the `.pub` file. Gondolin retries the failed bind, logs `vfs mount ...id_ed25519_signing.pub not ready`, and eventually reaches its 120-second VM startup timeout. The launcher can wait up to 150 seconds for the controller, which makes normal `bin/pi` appear to hang. `--yolo` works because it bypasses the Gondolin controller and VM entirely.

A single-file permission is still possible, but it must be represented as a directory-shaped provider:

```text
mount point: /Users/dsuess/.ssh/git/
visible entry: id_ed25519_signing.pub
hidden entries: id_ed25519_signing and every other sibling
```

The existing unit test missed this distinction. It opened `/` directly on a `RealFSProvider` rooted at the file and never exercised Gondolin’s guest bind-mount startup. The README has the same terminology conflict: it describes a direct file mount even though the runtime only supports directory mount points.

Preserve the narrow public-key exception and the user’s other dirty work. Do not expose the containing host directory, the private-key sibling, an SSH agent, or broader credentials. Keep normal startup fail-closed and leave `--yolo` unchanged. Materializing the public key in a read-only in-memory directory when the VM starts avoids mounting the credential directory; key rotation becomes visible after a VM restart.

## Approach

Keep the operator-facing setting scoped to the exact public-key file. Translate that setting into a Gondolin-compatible directory mount whose provider contains only an in-memory copy of the approved `.pub` file. This changes mount topology, not the intended permission scope.

### Part A — Build a directory-shaped single-file provider
- **Ledger:** {"status":"completed","note":"Resolved the exact signing public-key exception to its canonical parent directory and materialized only the public key into a read-only MemoryProvider-backed mount.","evidence":"npm --prefix pi/sandbox run test:controller (19 passing)"}

Adjust `resolveExternalMounts` so the approved signing-public-key exception retains the canonical public file as its source but uses the file’s parent path as the guest mount point. Keep the exception limited to the exact `~/.ssh/git/id_ed25519_signing.pub` path, a regular file, and `ro` access. Ordinary external mounts must remain existing directories subject to the current invariant and overlap checks.

Teach `createPolicyProviders` to recognize the `signing-public-key` kind. It will create a bounded `MemoryProvider`, add only `id_ed25519_signing.pub`, and make the provider read-only before Gondolin receives it. Do not use a `RealFSProvider` rooted at `~/.ssh/git`, because that would make the private key and other siblings visible even if writes were blocked.

Acceptance outcomes: the provider-map key is the guest directory, the expected `.pub` path is readable with its original content, listing that directory returns only the public file, private and unrelated siblings are absent, every write attempt fails read-only, and all other mount kinds retain their current behavior.

### Part B — Test the mount contract at both boundaries
- **Ledger:** {"status":"completed","note":"Replaced the file-root provider assertion with directory visibility and read-only checks, and added a production-policy native VM scenario that exercises Gondolin's bind-mount readiness path.","evidence":"npm --prefix pi/sandbox run test:controller (19 passing); npm --prefix pi/sandbox run test:extension (15 passing); npm --prefix pi/sandbox run test:canary (2 passing, including new native VM scenario)"}

Replace the misleading file-root unit assertion with checks for the resolved directory mount, one visible public file, hidden private sibling, and read-only behavior. Retain settings-store tests proving that only the exact public key is accepted and that the private key remains rejected.

Add a native Gondolin scenario that boots a VM with the production single-file provider and reads the public key through its full guest path. This must exercise the real bind-mount readiness loop; a provider-only test is insufficient because it was the reason the current defect passed.

Acceptance outcomes: unit tests verify the permission boundary, and a real VM verifies the directory-mount topology. A regression to a file-shaped mount must fail before release.

### Part C — Correct documentation and verify startup
- **Ledger:** {"status":"completed","note":"Documented the virtual directory topology and restart-on-rotation semantics, deployed via Stow, and verified fresh controller/routing startup plus the unchanged --yolo bypass.","evidence":"npm --prefix pi/sandbox test (all suites passing); npm --prefix pi/sandbox run test:native (all native suites passing); ./install.sh config; npm --prefix pi/sandbox run benchmark:startup -- --samples 1 (cold 3106.4 ms and active 1339.5 ms, both routing_handshake_complete); bin/pi --yolo --version (0.84.2)."}

Update `pi/sandbox/README.md` to distinguish the configured source file from the guest directory mount. State explicitly that ordinary external mounts expose directories directly, while the signing-key exception creates a one-file read-only virtual directory. Document that public-key content is captured when the VM starts and requires a VM restart after rotation.

Run focused policy and Gondolin extension/settings tests, then the complete non-native and native sandbox suites. Deploy only through `./install.sh config`. From a fresh normal launch, confirm the controller and routing handshake complete, sandbox tools can read the `.pub` file, and they cannot read the private-key sibling or modify the public key. Keep the complete plan document with the implementation commit.

Acceptance outcomes: normal `bin/pi` reaches ready state without a public-key mount timeout, controller logs contain no `vfs mount ...id_ed25519_signing.pub not ready` failure, documentation matches runtime behavior, and `bin/pi --yolo` remains unchanged.

## Critical Files

- `pi/sandbox/policy.mjs` — validates the one-file grant, translates it into directory mount topology, and constructs the isolated provider.
- `pi/sandbox/test-policy.mjs` — verifies the source/mount distinction, visibility boundary, and write rejection.
- `pi/sandbox/test-gondolin-canary.mjs` — exercises bind-mount readiness through a real Gondolin VM.
- `pi/agent/extensions/gondolin-sandbox/settings-store.ts` and its test — retain operator-side validation of the exact public-key exception.
- `pi/sandbox/README.md` — documents the difference between a configured source file and a guest mount point.

## Verification

**New-feature scenarios:** Boot a native VM with the production signing-key provider. Require successful startup, exact public-key content at the configured guest path, a directory listing containing only the `.pub` file, failed reads of the private-key sibling, and failed write, truncate, rename, and deletion attempts.

**Regression checks:** Run `npm --prefix pi/sandbox test` and `npm --prefix pi/sandbox run test:native`, then deploy with `./install.sh config`. Confirm a fresh normal `bin/pi` launch reaches TUI or RPC-ready state within the bounded startup window and completes the routing handshake. Failure signals are another file-shaped provider-map key, `vfs mount ... not ready`, a controller-acquisition timeout, any private sibling becoming visible, a successful guest write, or any change to `--yolo` bypass behavior.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Build a directory-shaped single-file provider
- ☑ Test the mount contract at both boundaries
- ☑ Correct documentation and verify startup
<!-- pi-plan-mode:progress:end -->
