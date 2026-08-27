# Support Spaced Gondolin Paths and Report Orphaned QEMUs

## Context

Pi pins `@earendil-works/gondolin` 0.12.0 and applies reviewed compatibility patches after every `npm ci`. Gondolin currently serializes `fuseMount` and every VFS bind destination into one whitespace-delimited QEMU kernel command line. Its guest init script then parses `/proc/cmdline` with shell word splitting. A workspace such as `/Users/dsuess/src/Video Upscale` is therefore truncated at the space, and VM readiness fails with `vfs mount /Users/dsuess/src/Video Upscale not ready`. This affects any workspace or configured guest mount path containing whitespace; changing only Pi’s shell quoting cannot fix it because the loss occurs inside the guest’s kernel-command-line parser.

The failed starts have also left QEMU processes whose parent is PID 1 but whose Gondolin session metadata and Pi controller manifests are gone. `gondolinier vm list` intentionally calls Gondolin’s `listSessions()` and filters for connectable session sockets, so these processes are invisible even though they still consume resources. The operator documentation currently describes `vm list` as listing only connectable VMs.

Use **orphaned QEMU** as the precise term for a process that matches Gondolin’s QEMU launch signature, has been reparented to the platform’s init process, and has no attachable Gondolin/Pi control plane. It is not a healthy VM, a stale session record, or a process that `gondolinier` can safely manage. Inventory will be informational only; this change will not kill or purge processes. Detection must be conservative so an ordinary QEMU process or a Gondolin VM still starting under a live controller is never mislabeled.

The path fix should cover all Gondolin VFS bind destinations, not only the reported repository, while preserving the existing guest-visible absolute paths and filesystem protections. A version-locked compatibility patch is lower risk than a broad Gondolin upgrade because Pi already has this audited patch mechanism and depends on additional 0.12.0 behavior. The patched guest init source must become an image-generation input so an old cached initramfs can never be paired with the new host-side encoding.

No glossary or ADR is warranted. The repository already defines Gondolin VM, controller, session, and canonical workspace, while the compatibility patch and inventory format are reversible implementation choices. The submitted plan document must remain in the implementation commit. Unrelated working-tree changes, including the existing `oh-my-zsh/.oh-my-zsh` modification, remain untouched.

## Approach

Implement a versioned, backward-compatible mount-path transport for the pinned runtime, then broaden `gondolinier`’s read-only inventory with a separate orphan-process classification.

### Part A — Encode Gondolin mount paths without changing guest paths
- **Ledger:** {"status":"completed","note":"Added version-locked v1 base64url mount-path compatibility patch, installation hook, and image-input invalidation (schema v4).","evidence":"npm --prefix pi/sandbox run test:patch (8 passing); npm --prefix pi/sandbox run test:image-builder (6 passing), including guest-init input digest mutation."}

Add a pinned Gondolin 0.12.0 compatibility patch, following the existing public-TCP patch’s exact-version, source-anchor, partial-state, and idempotence safeguards. The host-side boot configuration will encode `fuseMount` and each `fuseBinds` entry into whitespace- and delimiter-safe values before adding them to QEMU’s `-append` payload. The guest init script will decode the new versioned fields before creating bind mounts, while retaining support for Gondolin’s old unencoded fields so the patch is backward-compatible at the parser boundary. Encode entries independently so spaces, commas, percent signs, and other valid non-NUL path bytes cannot become list delimiters.

Do not alias the workspace, mount a wider parent directory, or rewrite controller paths. The workspace must remain available inside the guest at its canonical host absolute path, and existing read-only and protected-path providers must retain their current scopes.

Apply the patch immediately after the pinned package install. Include the patched guest init source in `getImageInputs()` and advance the Pi image metadata schema as needed, ensuring installation and `gondolinier image build` rebuild rather than reuse an initramfs that understands only the old boot fields. Patch tests must prove clean application, idempotence, version/source rejection, encoded round trips for whitespace and delimiter-bearing paths, and legacy parser compatibility.

Acceptance requires a real controller to start with a workspace directory containing spaces, expose the exact canonical path as its guest working directory, and complete representative file and Docker health operations without an unencoded workspace path appearing as a standalone kernel-command-line token.

### Part B — Show conservative orphaned-QEMU rows in VM inventory
- **Ledger:** {"status":"completed","note":"Added conservative macOS/Linux process inventory with strong Gondolin QEMU signature, init-parent requirement, live-session exclusion, safe CWD lookup, and explicit state column.","evidence":"npm --prefix pi/sandbox run test:gondolinier (12 passing); live `node pi/sandbox/gondolinier.mjs vm list` reports existing detached QEMUs as orphaned-qemu with discovered spaced workspaces."}

Extend `getVmInventory()` with a platform-bounded process scanner for macOS and Linux. Keep Gondolin `listSessions()` and validated Pi controller manifests authoritative for connectable rows. Separately inspect host processes using trusted absolute OS interfaces, recognize only QEMU commands with Gondolin-specific virtio, QMP, and sandboxfs launch markers, and classify a candidate as `orphaned-qemu` only when it has been reparented to init and is not represented by a live control-plane owner. Resolve the process working directory through the platform’s process filesystem or system `lsof` when available; use `-` rather than guessing when it cannot be established.

Add an explicit state column so `connectable` and `orphaned-qemu` are not conflated. Orphan rows will contain the QEMU PID, elapsed age, and discovered workspace, but no invented VM ID or session label. Preserve deterministic ordering and ensure a starting or healthy Gondolin QEMU, an unrelated QEMU invocation, malformed process output, or a process that disappears during inspection is omitted rather than misclassified.

Keep the command read-only. Do not add attach, kill, reset, or purge behavior for orphan rows, because no authenticated controller exists and PID reuse makes management a separate safety decision.

Acceptance requires fixture coverage for mixed connectable/orphan inventories, the empty case, false-positive rejection, workspace paths containing spaces, and process races. On the affected machine, `gondolinier vm list` should visibly report the detached QEMU PIDs as `orphaned-qemu` while continuing to map healthy Pi VM IDs to validated controller workspaces.

### Part C — Document and verify both lifecycle boundaries
- **Ledger:** {"status":"blocked","note":"Documentation and spaced-workspace integration assertion are implemented, but required native/deployment verification cannot build the new image because the host Docker daemon is unavailable.","evidence":"npm --prefix pi/sandbox test passed all deterministic sandbox suites. `./install.sh config` reapplied both patches but failed at image build: /var/run/docker.sock missing. `npm --prefix pi/sandbox run test:controller-native` failed for the same Docker-daemon prerequisite. `npm --prefix pi run check:deterministic` also stopped in pre-existing plan-mode RPC integration (`Unknown option: --yolo`)."}

Update the sandbox operator documentation to explain the encoded-path support and the expanded `vm list` contract: connectable entries come from Gondolin sessions, orphaned QEMU entries are conservative process observations, and orphan rows are informational rather than manageable. Keep the existing statement that one controller and VM serve each canonical workspace; orphan rows are failures outside that managed lifecycle, not additional shared VMs.

Add the new patch checks to the maintained deterministic sandbox suite. Strengthen the native controller integration scenario by using a workspace name containing spaces and asserting exact-path file access, Docker readiness, normal shared-lease behavior, and complete teardown. Retain the plan document with the implementation commit and deploy only through `./install.sh config`, which will reapply patches and build or verify the new image generation.

## Critical Files

- `pi/sandbox/node_modules/@earendil-works/gondolin/dist/src/sandbox/server-boot-config.js` and `dist/src/alpine/init-scripts.js` — read-only pinned upstream anchors that define host encoding and guest parsing; changes are produced by the committed compatibility patch, not committed directly in `node_modules`.
- `pi/sandbox/build-gondolin-image.mjs` — binds the patched guest parser to the immutable image generation.
- `pi/sandbox/gondolinier.mjs` — owns connectable-session and new orphan-process inventory semantics.
- `pi/sandbox/test-gondolinier.mjs` and `pi/sandbox/test-controller-integration.mjs` — cover classification safety and real spaced-workspace startup.
- `install.sh`, `pi/sandbox/package.json`, and `pi/sandbox/README.md` — deploy, verify, and document the compatibility boundary and operator-visible behavior.

## Verification

**Regression and deterministic checks**

- Run the compatibility-patch tests against a clean pinned-package fixture. Success means the patch is deterministic and idempotent, round-trips paths containing spaces and delimiters, accepts legacy fields, and rejects version, source, and partial-patch drift.
- Run the image-builder tests. Success means changing the patched guest parser changes the expected image generation and an old cached image cannot verify as current.
- Run the focused `gondolinier` tests. Success means healthy sessions retain their workspace mapping; only strongly identified, init-reparented Gondolin QEMUs receive `orphaned-qemu`; unrelated/owned/racing processes are omitted; and formatting remains stable for mixed and empty inventories.
- Run `npm --prefix pi run check:deterministic`. Any patch-install drift, inventory regression, wrapper failure, or sandbox unit failure is a blocking signal.

**Native feature scenarios**

- Run the real controller integration with a canonical workspace containing spaces. Success means startup reaches healthy VM and Docker state, guest `pwd` and file operations use the exact path, two clients still share one VM, and final lease release removes the managed VM and controller artifacts.
- After deployment, run `gondolinier vm list` on the affected host. Success means the existing detached QEMU PIDs appear as `orphaned-qemu` with their spaced workspace when discoverable, while any active managed VM appears as `connectable`. Listing no orphan or labeling an ordinary/active QEMU as orphan is a failure.
- From an ordinary terminal or `pi --yolo` session, run `npm --prefix pi run check`. Success requires every deterministic suite and native QEMU, Docker, routed-tool, inventory, Ketch, and live-network canary to pass.
- Review `git diff`, run `git diff --check`, confirm no unrelated changes were overwritten, and include the generated `.pi/plans/...` document in the implementation commit.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Encode Gondolin mount paths without changing guest paths
- ☑ Show conservative orphaned-QEMU rows in VM inventory
- ⛔ Document and verify both lifecycle boundaries
<!-- pi-plan-mode:progress:end -->
