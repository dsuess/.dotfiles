# Support single-file sandbox grants

## Context

Pi's trusted `/sandbox grants` commands save global defaults in the version-1 `filesystem.readOnly` and `filesystem.readWrite` path arrays. Each client activates its own snapshot through the controller; other clients retain their snapshots until an explicit refresh. The SRT policy already accepts file paths for reviewed exceptions, but `resolveFilesystemGrant()` currently rejects everything except directories.

Extend the same grant mechanism to existing regular files, including a path such as `~/.phab-helper.json`. This changes the directory-only definitions in `CONTEXT.md`, `pi/AGENTS.md`, command help, and `pi/sandbox/README.md`; those documents must be updated together. Keep directory behavior, protected roots, workspace overlap rules, Stow deployment, and client-local activation semantics intact.

Material scope and assumptions:

- Support both read-only and read-write grants for existing regular files using the existing command syntax and saved configuration schema. Do not automatically grant the example file or change `pi/sandbox/config.json`; that file already contains user changes.
- A file grant authorizes the configured file path and its validated canonical alias, not its parent directory or siblings. It is path-based authority, not an inode capability; ordinary replacement by another regular file at the same canonical path remains permitted.
- Effective snapshots must remember whether each validated target is a file or directory. A type change or symlink retarget invalidates the snapshot before further execution rather than silently widening authority.
- Read-write file grants permit writes subject to native SRT and OS restrictions. They do not promise atomic replacement, deletion, or rename across platforms: those operations may need parent-directory authority. Never grant the parent as a workaround.
- Grants still do not populate generated HOME, create Docker mounts, add PATH entries, or forward environment variables. Helpers must use the actual granted path rather than assume the generated HOME contains host configuration.
- Existing protected credential/runtime roots remain excluded. An explicitly granted ordinary configuration file can contain credentials; any sandboxed command able to read it can disclose or use them because network egress is unrestricted.
- SRT interprets `*`, `?`, `[` and `]` as pattern characters. Reject grant spellings and canonical targets containing these characters rather than accidentally treating an exact path as a glob. Do not add a new pattern-grant feature or patch the pinned runtime.
- Preserve all unrelated working-tree changes. Installation and full native acceptance must run from an ordinary host terminal, not this sandboxed harness session.

## Approach

Use the existing grant service and SRT policy composition rather than introduce a separate file-grant configuration or credential exception. Infer target type when loading saved paths, then retain that type in validated effective grants and controller messages so subsequent validation can enforce the same authority boundary.

### Part A — Extend validated grants without broadening authority
- **Ledger:** {"status":"completed","note":null,"evidence":"Validated file/directory type retained through protocol and revalidated; exact-path patterns rejected, policy alias union preserved. Focused 43 grant/configuration/client/policy tests plus 12 client tests passed, including stale file type and downgrade cases."}

Update grant resolution to accept existing directories or regular files, rejecting missing paths, sockets, FIFOs, devices, and other special targets without reading their contents. Preserve lexical/canonical safety checks, home-relative expansion, bounds, canonical duplicate handling, and non-identical parent/child overlap rejection, including a file inside an already granted directory or the workspace.

Record a file/directory discriminator in validated grant snapshots and carry it through the bounded `policy.prepare` protocol. Revalidation must compare both canonical path and target type at prepare, commit, activation, and operation capture. Do not add inode pinning or reject normal same-path regular-file replacement. Retain the version-1 saved path arrays; no configuration migration is required. Update internal directory-specific names where necessary to accurately describe canonical target identity, without unrelated refactoring.

Compose file aliases into `allowRead`, and into `allowWrite` only for read-write authority, without adding parents or `allowCompleteWorkspaceWrites` exceptions. Maintain deterministic union of duplicate canonical authority and validate every alias before deduplication. Reject SRT pattern characters in both lexical and canonical grant paths before policy composition.

Acceptance: focused validation, configuration, protocol, policy, and client-snapshot regressions pass for both files and directories. Invalid changes preserve saved bytes and effective authority, and file-to-directory replacement fails closed even when another duplicate alias remains valid.

### Part B — Expose and document file grants through existing controls
- **Ledger:** {"status":"completed","note":null,"evidence":"Updated command help/dialogs, service wording, glossary, Pi invariants and sandbox README with exact-file/security limitations. Command and policy-service tests passed (19), plus 13 command tests including file paths."}

Update `/sandbox` help, path dialogs, command descriptions, and directory-specific service errors to describe file-or-directory targets. Keep parsing, literal spaces, home-relative syntax, idle boundaries, cancellation, non-interactive restrictions, saved/effective status, and activation failure behavior unchanged.

Update `CONTEXT.md`'s Saved grant and Effective grant definitions and the repository-specific grant invariants in `pi/AGENTS.md`. Update the sandbox README with read-only and read-write single-file examples, target-type and symlink revalidation, special-file rejection, exact-path restrictions, credential disclosure risk, generated-HOME behavior, and the parent-directory limitation for atomic writes. Do not modify `pi/agent/AGENTS.md` or add an ADR for this reversible extension.

Acceptance: command/menu tests accept file paths using the existing syntax, cancellation and invalid-input cases remain no-ops, documentation no longer claims all grants require directories, and no default access is added to the example credential file.

### Part C — Verify native isolation and finish the change narrowly
- **Ledger:** {"status":"blocked","note":"Native and real-launcher acceptance requires an ordinary host terminal; harness blocks SRT socket creation and controller runtime writes. Linux was not exercised.","evidence":"Added native-file-grants.test.mjs to test:native with exact-byte, sibling, parent, child, write and rename probes. 66 focused tests pass; git diff --check passes. npm --prefix pi/sandbox test fails on missing Pi package dependency and sandbox EPERM for controller/native sockets; the new native test separately fails at SRT initialization with listen EPERM, before probe execution. Host npm --prefix pi run check and deployed real-launcher canary remain unrun."}

Add native single-file grant coverage to the existing native verification gate, using synthetic HOME and fixture files outside the workspace and derived read roots. Exercise read-only and read-write files, an allowed symlink alias, adjacent denied files, parent-directory denial, and child-process inheritance. Assert actual result bytes and unchanged denied fixtures rather than merely inspecting policy arrays or process exit codes.

Check in-place writes for a read-write file without requiring parent authority. Probe temporary-file-and-rename behavior separately and establish that sibling creation is denied; document platform-specific replacement limitations rather than widening grants. Verify downgrade/removal through client snapshots and existing refresh mechanisms. Include stale alias/type rejection before subsequent operations.

Review the final diff for scope and security boundaries, preserving all existing user changes. Keep the extension-managed plan document with the implementation in any eventual commit; do not commit unrelated changes. Deployment remains a user-run `./install.sh config` from an ordinary host terminal, followed by a new Pi launch for controller source changes.

Acceptance: focused and full deterministic checks pass where runnable; native and real-launcher checks supply evidence of exact-file access and denied sibling access. Any unavailable native/platform checks are reported explicitly rather than marked successful.

## Critical Files

- `pi/sandbox/filesystem-grants.mjs` and `filesystem-configuration.mjs` — shared validation, snapshot identity, and atomic Stow-target edits.
- `pi/sandbox/protocol.mjs`, `client-policy.mjs`, and `srt-policy.mjs` — validated grant transport, per-client revalidation, and native filesystem authority composition.
- `pi/agent/extensions/srt-tool-routing/command-ui.ts` — trusted user command help and path dialogs; no new model tool or shell endpoint.
- `CONTEXT.md`, `pi/AGENTS.md`, and `pi/sandbox/README.md` — glossary, development invariants, and user-facing grant contract.
- `pi/sandbox/package.json` and the existing grant/configuration/client/native tests — regression boundaries and native gate integration.

## Verification

Regression checks:

- Retain existing directory grants, workspace-derived writes, canonical duplicate union, Stow symlinks and saved spelling, serialized revision checks, client isolation, reload retention, and saved/active mismatch blocking.
- Preserve all protected-root exclusions through both lexical aliases and canonical targets, including file paths inside protected directories.
- Run focused grant/configuration/client/policy and command UI tests, followed by `npm --prefix pi/sandbox test` where permitted.

New-feature checks:

- Add, upgrade, downgrade, list, reload, and remove file grants using absolute, home-relative, and spaced paths, preserving the version-1 saved schema and file permissions.
- Cover canonical duplicate file aliases, symlink retargeting, type changes, regular-file replacement, file/directory overlaps, missing targets, real sockets/FIFOs where supported, special targets, and literal/pattern-character rejection.
- Use synthetic native fixtures to prove exact read access, read-only write denial, read-write in-place mutation, denied sibling reads/writes, no parent grant, and inherited restrictions in descendants. Do not read real credentials during tests.
- From an ordinary host terminal after deployment, canary the real `/sandbox grants add ro <fixture-file>` path and routed Bash with an absolute fixture path, then remove the grant and verify the read is denied when no derived access exists. A successful command status without fixture bytes is insufficient evidence.
- Run `npm --prefix pi run check` from an ordinary host terminal, including the added native test. Verify macOS and Linux behavior when available; explicitly identify any platform not exercised. Never run installation from the harness or change OS permissions to make verification pass.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Extend validated grants without broadening authority
- ☑ Expose and document file grants through existing controls
- ⛔ Verify native isolation and finish the change narrowly
<!-- pi-plan-mode:progress:end -->
