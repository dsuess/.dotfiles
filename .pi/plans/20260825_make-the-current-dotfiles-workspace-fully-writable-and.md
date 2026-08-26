# Configure Workspace File Access in Sandbox Settings

## Context

The Gondolin controller currently mounts each canonical workspace read-write, but `pi/sandbox/policy.mjs` wraps it in `ProtectedWriteProvider`. Hard-coded `WORKSPACE_PROTECTED_PATHS`, `BARE_PROTECTED_PATHS`, and dynamically discovered Pi control-plane paths deny writes to files such as `.git/config`, Git hooks, shell/editor/agent settings, `bin/pi`, `pi/sandbox`, and `pi/agent`. External mount access is configurable in `pi/sandbox/settings.json`, while workspace and bare-common access remain code-defined. The controller parser and the `/sandbox` settings store independently enforce the same strict version-1 schema.

For this change, **workspace** means the canonical repository root selected by trusted Git discovery, not only the process launch subdirectory. The permissive rule must match only the canonical `~/.dotfiles` workspace; all other repositories retain the current default protections. **Temporary** means a durable, checked-in settings override that remains active until manually removed or restored. It is not session-scoped and has no timer.

The requested override deliberately allows writes to every file and subtree in `~/.dotfiles`, including `.git/config`, Git hooks, Pi’s launcher, sandbox sources, and agent configuration. This weakens protection for future trusted launches from this workspace. The VM mount boundary, external-mount validation, credential exclusions, signing-public-key read-only exception, host-tool audit, and Gondolin routing remain unchanged. Other workspaces must not inherit the permissive override.

This request supersedes current statements in `pi/AGENTS.md` and `pi/sandbox/README.md` that workspace write exclusions are non-configurable invariants. Those authoritative documents must describe the new settings-owned policy and the risk of an empty write-protection list. Historical plan files remain historical and should not be rewritten. No glossary or ADR is warranted: the repository already documents this subsystem in its README, and the selected override is intentionally reversible configuration.

## Questions & Answers

| Question | Answer |
|---|---|
| Should the permissive write rule apply only to this canonical workspace (`~/.dotfiles`) or to every workspace opened through Pi? | This workspace (Recommended). |
| How should “temporarily” be represented? | Manual revert (Recommended). |

## Approach

Introduce one versioned filesystem section as the source of truth for user-visible host file access. Keep guest-private cache mounts and other runtime internals code-managed. Resolve workspace overrides by exact canonical root so launching from any nested dotfiles directory receives the same override without affecting another repository.

### Part A — Move workspace access policy into the versioned settings schema
- **Ledger:** {"status":"completed","note":"Moved workspace, bare-common, and external mount access into strict filesystem settings; added canonical exact workspace overrides and provider selection for ro/rw/protected/empty policies.","evidence":"npm --prefix pi/sandbox test passed (includes policy, controller, repository, settings-store, and extension suites)."}

Upgrade the strict sandbox schema and update both validators together. Add a `filesystem` section containing:

- default workspace `access` (`ro` or `rw`) and `writeProtectedPaths`;
- exact-path `workspaceOverrides`, each with its own access and replacement write-protection list;
- bare-common access and write-protection paths; and
- the existing external mounts and their `ro`/`rw` access.

Move the current generic workspace and bare-common protected-path lists out of module constants and into the checked-in settings. Validate bounded relative write-protection paths without absolute paths, traversal, empty entries, or duplicates. Validate workspace override roots as existing absolute or `~/` directories, compare their canonical forms, reject duplicate canonical roots, and preserve portable `~/` spelling in durable settings where possible.

Update policy construction to select the exact canonical workspace override before creating mounts. Mount access and effective write-protection paths must participate in `policyGeneration`. A read-only mount uses `ReadonlyProvider`; a read-write mount with non-empty protections uses `ProtectedWriteProvider`; and a read-write mount with an empty list uses `RealFSProvider`. The empty-list case matters because it must not retain the guarded provider’s general hard-link write denial after all workspace protections are intentionally disabled. Gondolin’s mount boundary must still reject paths and symlink targets that escape exposed roots.

Preserve existing behavior for repositories without an override, verified bare common directories, external read-only/read-write mounts, the isolated signing public key, and code-enforced exclusions that determine which external host roots may be mounted at all.

Acceptance outcome: all file-access decisions for workspace, bare-common, and external user mounts come from the strict settings document; the dotfiles override can remove workspace write protections without changing another workspace or exposing an additional host root.

### Part B — Activate and document the dotfiles-only permissive override
- **Ledger:** {"status":"completed","note":"Activated the durable dotfiles-only empty-protection override, updated /sandbox preservation/display behavior and docs, and retained the approved plan file.","evidence":"npm --prefix pi/sandbox test passed; npm --prefix pi/sandbox run test:native passed; ./install.sh config passed; deployed ~/.pi/sandbox/settings.json resolves to the repository source and contains the ~/ .dotfiles override (verified with Node realpath). git diff --check passed."}

Update `pi/sandbox/settings.json` with an exact `~/.dotfiles` workspace override using `access: "rw"` and an empty `writeProtectedPaths` list. Keep the default workspace protection list populated so unrelated repositories retain current behavior, and keep the existing bare-common protections and signing-public-key mount.

Adapt `SandboxSettingsStore` canonicalization, atomic Stow-source replacement, and tests to the nested filesystem schema. Update `/sandbox` to read and preserve the new workspace, bare-common, and external-mount fields when it edits settings; show effective workspace/bare mount access where useful, while retaining the existing external-mount actions and coordinated policy reload. Do not add an automatic reversion mechanism or a global permissive default.

Revise `pi/sandbox/README.md` with the new schema, exact-match override semantics, manual-revert procedure, and warning that an empty list permits writes to Git and Pi control-plane files. Revise `pi/AGENTS.md` so it no longer claims these exclusions are immutable, while retaining fail-closed routing, Stow persistence, credential, Docker, host-adapter, and controller invariants. Keep the generated plan document in the implementation commit as required by the repository workflow.

Acceptance outcome: nested launches anywhere under `~/.dotfiles` receive a fully writable canonical workspace until the checked-in override is manually restored, `/sandbox` cannot erase the new fields during a save, and documentation accurately describes the temporary risk and scope.

## Critical Files

- `pi/sandbox/settings.json` — canonical versioned filesystem/network policy and the temporary dotfiles-only override.
- `pi/sandbox/policy.mjs` — strict controller-side parsing, canonical override selection, mount generation, and provider composition.
- `pi/agent/extensions/gondolin-sandbox/settings-store.ts` — matching host-side validation and atomic Stow-source persistence.
- `pi/agent/extensions/gondolin-sandbox/settings-view.ts` — `/sandbox` display/edit flow that must preserve and apply the new schema.
- `pi/sandbox/README.md` and `pi/AGENTS.md` — authoritative behavior, terminology, risk, and maintenance guidance.

## Verification

**New file-access scenarios**

- Prove strict parsing rejects malformed access modes, absolute or escaping protected paths, duplicate protected paths, missing override roots, and canonical duplicate overrides.
- Build policies for `~/.dotfiles`, a nested launch within it, a symlink alias to it, and an unrelated repository. Require only the canonical dotfiles workspace to resolve to read-write with no protected paths; require the unrelated repository to retain the previous default denials.
- In fixture providers, write, rename, delete, link, and truncate paths representing `.git/config`, `.git/hooks`, `.pi`, `bin/pi`, `pi/sandbox`, and `pi/agent` under the permissive override. Include a hard-linked file to prove the empty list does not leave the old generic hard-link guard active.
- Prove default protected paths still reject lexical, resolved-symlink, hard-link, rename, and structural writes. Prove a read-only workspace rejects all writes and bare-common/external mount access still follows settings.
- Prove policy generations change when access, protected paths, or a matching override changes, while equivalent canonical configuration remains stable.
- Prove `/sandbox` atomic saves preserve the Stow symlink, source mode, portable override, nested filesystem fields, and complete-write serialization; invalid settings must leave source bytes unchanged.

**Regression checks**

- Run the focused policy, repository-scope, Gondolin extension, settings-store, controller, and wrapper tests during development.
- Run `npm --prefix pi/sandbox test` as the complete non-native sandbox regression suite.
- Run `npm --prefix pi/sandbox run test:native`, including a real tool-plane write to a normally protected fixture path under an exact permissive override. Success requires the write to reach the host fixture while an unrelated protected workspace and the read-only signing-key mount still reject writes.
- Run `./install.sh config` through Stow and confirm the deployed `~/.pi/sandbox/settings.json` resolves to the repository source with the intended schema and override. Review the final diff and `git diff --check`; no unrelated runtime settings or historical plans should change.

Failure signals include a permissive policy in an unrelated workspace, continued denial inside the exact dotfiles override, loss of default protections, exposure of an unmounted host path, `/sandbox` dropping filesystem fields, policy-generation mismatch after save, or any fallback to host built-ins.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Move workspace access policy into the versioned settings schema
- ☑ Activate and document the dotfiles-only permissive override
<!-- pi-plan-mode:progress:end -->
