# Replace Obsidian copy synchronization with Stow

## Context

`install.sh` currently calls `sync_obsidian()` for macOS iCloud vaults. That function requires clean managed settings, imports configuration from the canonical `notes` vault, checks for drift, and copies configuration into every existing vault. These checks cause the unwanted commit-or-stash workflow.

The requested replacement is ordinary Stow deployment. Keep the existing `obsidian/` package layout and target each existing vault's `.obsidian` directory under `OBSIDIAN_DOCS`. Remove the canonical-vault concept rather than retain a second deployment path.

This deliberately reverses the copy-only exception in `AGENTS.md`. Symlinked configuration will not propagate through iCloud to iOS/iPadOS. Document this consequence without adding another synchronization mechanism.

Plugin installation and updates remain Obsidian's responsibility. Only the currently selected plugin `data.json` settings belong to this deployment. Stow does not read Git ignore rules, and ignored plugin binaries already exist locally inside the package. Explicit Stow exclusions and disabled directory folding are therefore necessary to preserve this boundary.

The working tree already contains changes to `obsidian/app.json`, `obsidian/community-plugins.json`, `AGENTS.md`, and unrelated files. Preserve those changes. Do not reset configuration, import vault contents, or install anything in the live home directory from this harness.

## Questions & Answers

| Question | Answer |
|---|---|
| How should the switch handle existing vault configuration files that conflict with Stow? | Manual cleanup (Recommended): keep the installer as plain Stow. Document a one-time host-terminal backup and removal of only conflicting configuration files; preserve plugin code. Stow warns until cleanup is done. |

## Approach

Use the existing installer and `stow_or_warn` behavior. Replace synchronization with a small vault loop that deploys the Obsidian package through Stow. No Git status checks, copying, adoption, automated backups, or destructive migration logic remain.

### Part A — Replace synchronization and verify direct links
- **Ledger:** {"status":"completed","note":null,"evidence":"Replaced copy/drift sync with per-vault Stow --no-folding and package exclusions; documented migration and iCloud limitation. Real GNU Stow Node tests pass (2 tests), bash -n install.sh and git diff --check pass. Reviewed diff and preserved existing Obsidian and AGENTS.md edits. Live host deployment intentionally not run."}

Replace `sync_obsidian()` with a small Stow deployment helper called from the existing macOS branch of `cmd_config()`. Preserve the `OBSIDIAN_DOCS` location and current scope: only vaults with an existing `.obsidian` directory receive configuration. Remove `OBSIDIAN_VAULT` and all canonical-vault, drift-check, temporary-copy, and copy-deployment code.

Deploy with `--no-folding` so plugin and snippet directories remain real directories. Add package-local Stow exclusions that allow only the three selected plugin settings paths and exclude plugin binaries, other plugin settings, and ignore-file metadata. Keep the existing Git ignore rules. This must work even when ignored plugin installations exist locally in the package.

Use `stow_or_warn` for conflict behavior consistent with other packages. Existing unmanaged target files remain untouched, produce Stow diagnostics, and prevent that vault's deployment until manual cleanup. Continue to other vaults. Do not use `--adopt`, manually create symlinks, or remove target files in the installer.

Replace the copy/drift regression test with real-Stow tests in disposable package and vault directories. Exercise deployment without running the full installer. Retain the existing test filename to avoid unrelated documentation changes. Cover linked settings, multiple vaults, paths with spaces, dirty package settings, repeated deployment, missing vault configuration, target conflicts, and plugin exclusions.

Update `AGENTS.md` to remove the copy-only exception and round-trip instructions. Describe direct Stow deployment, the iCloud limitation, and safe one-time manual cleanup. Require a backup outside `.obsidian` before removing conflicting managed files. Preserve plugin directories, plugin binaries, and unselected files. Add a concrete correction lesson: Obsidian configuration uses Stow without Git cleanliness or drift gates; plugin code remains unmanaged. Preserve unrelated existing edits to this file.

Acceptance: eligible vaults receive file-level links to repository configuration without any Git cleanliness requirement. Writes through a linked setting reach the repository file. Plugin binaries and unselected settings remain local and unchanged. Existing conflicts require manual cleanup rather than automatic data replacement.

## Critical Files

- `install.sh`: deployment entry point, vault discovery, and shared `stow_or_warn` behavior.
- `obsidian/`: existing configuration package and new package-local Stow exclusions; configuration contents remain unchanged.
- `tests/obsidian-sync.test.mjs`: replace copy synchronization assertions with direct-link regression coverage.
- `AGENTS.md`: remove obsolete deployment instructions and document the replacement and its limits.

## Verification

New behavior checks use actual GNU Stow in temporary directories, not mocked symlink creation. Test a path with spaces, multiple eligible vaults, and a vault without `.obsidian`. Confirm that linked settings resolve to the fixture package, directories remain real, and writes through links change their source files.

Regression checks confirm that plugin binaries in both the source package and target vaults remain unmanaged. Unselected plugin settings and ignore metadata must not appear as deployed links. Repeat deployment must succeed without changing existing links or plugin code.

Conflict checks confirm that existing regular configuration files remain byte-for-byte unchanged and produce a warning. Other eligible vaults must still deploy. Dirty package configuration must deploy without any commit-or-stash requirement. No canonical-vault import or drift check remains.

Run the focused Node test, `bash -n install.sh`, and `git diff --check`. Review the final diff for unrelated changes and preservation of pre-existing edits. Keep this saved plan with the implementation changes when committed.

Do not run `./install.sh config` inside the sandbox. Live deployment and the one-time cleanup remain host-terminal actions. After cleanup, the host smoke check is successful when configuration files are Stow links and Obsidian can read them without plugin damage. Actual host deployment remains unverified until that check occurs.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Replace synchronization and verify direct links
<!-- pi-plan-mode:progress:end -->
