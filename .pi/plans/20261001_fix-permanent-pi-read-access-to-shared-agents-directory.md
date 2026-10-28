# Allow shared agent reads in every Pi workspace

## Context

Pi discovers shared skills from `~/.agents/skills` on the host. Model-directed file and Bash tools run through the SRT controller.

The current policy denies reads under the real home directory. Its host-read manifest allows the dotfiles source, but omits `~/.agents`. The deployed Stow path therefore remains inaccessible.

The reported failure reproduces through the read tool and Bash. `lstatSync`, `realpathSync`, and `readlinkSync` also return `EPERM` for `~/.agents/skills`. Reading `agents/skills/grill-with-docs/SKILL.md` through the repository source succeeds.

This conflicts with the documented shared-skill workflow. Host-side discovery does not imply sandboxed tool access. The manifest currently promises canonical paths only, and the policy canonicalizes its roots again. Adding only the resolved Stow target will not address access to the deployed link.

The requested scope is permanent read access to the entire real-user `~/.agents` directory in every workspace. It includes the deployed skills link and its resolved target. It does not introduce a home-directory read grant, a write grant, or a sandbox bypass.

Controllers derive their policy at startup. Root clients, reloaded clients, and child clients share that controller policy. Existing controllers cannot acquire this change through `/reload`. Existing Pi processes need a restart after deployment. The existing source-digest mechanism rejects stale controller implementations on subsequent root startup.

Unrelated changes exist in `install.sh`, `pi/agent/settings.json`, and an OpenCode plugin. Preserve them. Do not change Pi's runtime system prompt.

## Approach

Add the shared-agent directory to the controller's reviewed baseline read manifest. Preserve both deployed paths and canonical targets when the policy builds read allowances. Keep the existing routing, controller lifecycle, and write boundaries.

### Part A — Establish permanent shared-agent read access
- **Ledger:** {"status":"completed","note":null,"evidence":"Added regressions before implementation; real-directory, Stow-skills, and linked-root discovery failed as expected. After fix, node --test pi/sandbox/test-host-configuration.mjs pi/sandbox/test-srt-policy.mjs passes all 13 tests. Reviewed aliases and canonical roots enter allowRead only; protected targets/ancestors rejected. Policy fixture now uses an existing file because policy construction does not require a live socket."}

Extend host-read discovery for the real-user `~/.agents` directory and its `skills` directory. Resolve paths on the host before SRT starts. Include the deployed spelling and the canonical target so Stow links remain traversable. Handle both real directories and symlinked directories.

Adjust the manifest contract and policy ingestion to retain reviewed aliases instead of discarding them through canonicalization. Limit new baseline access to the shared-agent directory and the reviewed skills target. Do not scan arbitrary symlink targets or grant the whole home directory. Reject or exclude targets that overlap protected controller or credential roots.

An absent shared-agent directory must not prevent Pi startup. A directory created after controller startup becomes available after a restart. Existing workspace write permissions remain unchanged, including writes to source files when the dotfiles repository itself is the active workspace.

Add regression cases before the fix. Cover real directories, the Stow-style skills symlink, a symlinked agent root, and a missing directory. Use a target outside the workspace and outside already allowed dotfiles roots so existing grants cannot mask the defect.

Acceptance: the resulting policy permits reads through deployed and canonical paths without adding shared-agent roots to its write allowances. Protected targets remain excluded or rejected.

### Part B — Prove access through the controller and preserve isolation
- **Ledger:** {"status":"blocked","note":"Integration test implemented, but native controller verification requires an ordinary host terminal.","evidence":"node --test --test-name-pattern='shared-agent reads' pi/sandbox/test-controller-lifecycle.mjs fails at controller startup: EPERM mkdir /tmp/pi-srt-501/c/<workspace-key>. npm --prefix pi run check:deterministic reaches 118 passing plan-mode tests then fails smoke-load because routed HOME points to generated home and launcher cannot locate .dotfiles/bin/pi. No Seatbelt access claim made."}

Extend controller integration coverage with a temporary host-home fixture and a separate workspace. Populate the shared-agent directory with an ordinary file and a linked skill containing `SKILL.md` and a companion document.

Exercise helper access, directory listing, file reads, and routed Bash against the deployed paths. Exercise multiple root clients and an inherited child client to establish that access comes from the shared controller policy, not a per-client permission prompt.

Attempt writes against fixture files outside the workspace. Confirm rejection and unchanged contents. Confirm that unrelated home files and credential files remain unreadable.

Use existing controller test infrastructure and cleanup. Do not add a new permission UI, persistent grant configuration, or controller hot-reload mechanism.

Acceptance: all clients read the shared files through both helper and Bash operations. Outside-workspace writes fail, and unrelated protected reads still fail.

### Part C — Deploy the fix and document the restart boundary
- **Ledger:** {"status":"blocked","note":"Documentation and prevention rule complete; deployment and host-only checks blocked by current SRT sandbox.","evidence":"HOME=/Users/dsuess ./install.sh config stopped immediately on EPERM removing .zshrc/.zsh_profile/.bashrc/.bash_profile; no bypass used. npm --prefix pi run check fails at plan-mode smoke-load due generated HOME, before native gate. Launcher smoke attempts for SKILL.md and CONTEXT-FORMAT.md in two separate temporary workspaces fail closed: cannot resolve installed Pi binary. Focused 13 tests pass, integration file syntax and git diff --check pass. Diff reviewed; runtime prompt untouched and existing install.sh/settings/OpenCode changes preserved. Approved plan retained."}

Update `pi/sandbox/README.md` with the permanent shared-agent allowance, Stow alias behavior, and restart requirement. Record a prevention rule in repository development instructions: baseline sandbox reads for Stow-managed resources must cover deployed aliases and canonical targets.

Deploy only with `./install.sh config`. Preserve unrelated changes and stop if the installer reports Obsidian drift or another deployment conflict. Do not copy files, create manual links, change filesystem ownership, or use `--yolo` as the fix.

Run the required full gate from an ordinary host terminal. Run a real launcher smoke check that reads `/Users/dsuess/.agents/skills/grill-with-docs/SKILL.md` from a workspace other than dotfiles. Also confirm a companion skill document is readable. Repeat with another workspace to establish workspace-independent access.

Explain that already-running Pi instances must restart. Do not terminate other user sessions automatically. Do not claim that `/reload` refreshes their controller policy.

Keep the approved `.pi/plans` document with the implementation in any eventual commit, as repository instructions require. Do not include unrelated user changes.

Acceptance: deployment succeeds, fresh normal launches read the reported path without permission prompts, and the documentation states the precise lifecycle boundary.

## Critical Files

- `pi/sandbox/host-configuration.mjs`: discovers reviewed host read paths before sandbox initialization.
- `pi/sandbox/srt-policy.mjs`: translates the manifest into immutable read and write allowances.
- `pi/sandbox/test-host-configuration.mjs`, `pi/sandbox/test-srt-policy.mjs`, and `pi/sandbox/test-controller-lifecycle.mjs`: cover discovery, alias retention, and actual SRT behavior.
- `pi/sandbox/client.mjs` and `bin/pi`: read-only references for source-digest invalidation, startup, and launcher smoke checks.
- `pi/sandbox/README.md` and `pi/AGENTS.md`: document the access contract and the regression-prevention rule.

## Verification

New regression scenarios:

- Reproduce the missing allowance before changing the policy.
- Read ordinary agent files and linked skill documents through deployed and canonical paths.
- Cover real directories, Stow links, a linked agent root, and missing directories.
- Use an unrelated workspace and a target that existing read roots do not already allow.
- Exercise helper operations, routed Bash, multiple roots, and an inherited child.
- Reject protected symlink targets without granting their contents.

Isolation checks:

- Outside-workspace shared-agent writes fail and fixture contents remain unchanged.
- Unrelated home files, credential files, and controller state remain denied.
- Existing workspace write permissions and fail-closed tool routing remain intact.

Repository and deployment checks:

- Run the focused host-configuration, policy, and controller tests.
- Run `npm --prefix pi run check:deterministic`.
- Deploy with `./install.sh config`.
- Run `npm --prefix pi run check` from an ordinary host terminal.
- Run `pi -p --no-session "!cat /Users/dsuess/.agents/skills/grill-with-docs/SKILL.md"` through the normal launcher in two unrelated workspaces.
- Review the diff for unintended grants, manual deployment, runtime-prompt changes, and unrelated user changes.

If native checks or deployment cannot run inside the current sandbox, report the exact blocked checks. Do not treat policy-array assertions alone as proof that Seatbelt permits the deployed path.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Establish permanent shared-agent read access
- ⛔ Prove access through the controller and preserve isolation
- ⛔ Deploy the fix and document the restart boundary
<!-- pi-plan-mode:progress:end -->
