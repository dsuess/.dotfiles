# Compose overlapping grants with workspace access

## Context

Launching Pi in `~/src/polez` fails because `pi/sandbox/config.json` contains a saved read-write grant for `~/src`. The controller's `controller-error.log` confirms that `assertSafe()` rejects the parent/workspace overlap during configuration validation before publishing readiness. The launcher subsequently reports only `controller did not publish ready state`.

The user explicitly rejected deleting the saved grant: the sandbox must compose configured authority with independently derived workspace authority. Current code and documentation require identical workspace matches and reject all other workspace overlaps; that rule must change. Preserve the user's saved configuration and the ongoing single-file implementation.

Authority is additive: a saved read-only parent stays read-only outside the workspace, while the workspace remains read-write. A saved read-write parent retains its explicitly authorized access, without receiving complete-workspace-write exceptions. Safe files and directories inside the workspace may also be saved; they cannot reduce independently derived workspace access, including through validated aliases. Their saved access level must remain intact when used from another workspace. Continue rejecting protected home, credential and runtime roots, unsafe aliases, stale target types, pattern characters, and non-identical overlaps between saved grants. This is workspace composition, not a general nested-grant feature.

The sandboxed harness cannot perform deployment or the full host/native acceptance gate. Do not remove grants, weaken protected-path checks, or bypass sandboxing to satisfy startup.

## Approach

Remove workspace-overlap rejection from shared grant safety validation, while retaining all independent safety checks. Compose alias authority based on canonical containment in the derived workspace, not just canonical equality. Keep saved bytes, client snapshots and saved grant identity independent of derived authority.

### Part A — Compose workspace and saved authority safely
- **Ledger:** {"status":"completed","note":null,"evidence":"Reproduced four failures against original validation with synthetic ~/src/polez; after changes, node --test pi/sandbox/test-workspace-grant-composition.mjs pi/sandbox/test-filesystem-grant-validation.mjs passes 14 tests, including authority composition, safety and client snapshots."}

Reproduce the failure with a synthetic HOME containing a saved `~/src` grant and a `~/src/polez` workspace. Cover read-only and read-write parents, child directories and regular files, lexical/canonical aliases, and launching from a different workspace.

Allow safe workspace ancestor and descendant grants in `filesystem-grants.mjs`. Preserve controller and credential/runtime exclusions for every spelling and canonical target. Keep overlap rejection between non-identical saved grants unchanged.

In `srt-policy.mjs`, ensure validated aliases of targets inside the workspace receive the workspace's derived read-write authority even when their saved grant is read-only. Do not elevate a workspace ancestor's read-only grant to write access, and do not extend `allowCompleteWorkspaceWrites` to saved parents or children. Preserve canonical duplicate union and snapshot revalidation.

Verify configuration edits, removals, startup composition, and client refresh do not delete or rewrite saved grants, and that removing a child grant cannot revoke ordinary workspace writes. Existing client snapshot isolation remains unchanged. Acceptance: the synthetic reported scenario validates and composes successfully, parent read-only authority remains narrow, and protected alias cases still fail closed.

### Part B — Align documentation and verify the regression
- **Ledger:** {"status":"completed","note":null,"evidence":"Updated pi/AGENTS.md and pi/sandbox/README.md; scoped diff and git diff --check reviewed, saved config untouched. Focused tests pass 63/63. npm --prefix pi/sandbox test attempted: 224 passed, 5 skipped, 22 failed due to sandbox EPERM on controller directories/Unix sockets and missing ask-user-question package dependency. Host-only check, Stow deployment, and real workspace launch remain unverified."}

Update `pi/AGENTS.md` and `pi/sandbox/README.md` to distinguish allowed workspace overlaps from still-rejected overlaps between saved grants. Record the correction as a concrete prevention rule in the existing repository instructions: resolve saved grants and workspace authority additively rather than requesting removal of valid shared defaults. Keep domain definitions free of implementation recipes, and modify `CONTEXT.md` only if needed to clarify that a grant cannot reduce derived access. Do not change Pi's runtime system prompt or saved configuration.

Run focused grant, configuration, client-policy, policy and command tests, then attempt the sandbox test suite where permitted. Review the scoped diff and preserve unrelated changes. Full `npm --prefix pi run check`, deployment with `./install.sh config`, and a fresh real Pi launch in `~/src/polez` must occur in an ordinary host terminal; report unavailable verification explicitly. Do not add unrelated startup diagnostic infrastructure in this fix.

Acceptance: documentation describes the new composition rule, deterministic regression checks pass, saved `~/src` remains untouched, and any native/deployed acceptance limitations are recorded honestly.

## Verification

- New regression: synthetic `~/src` saved grant with `~/src/polez` workspace succeeds for both access levels; the workspace is writable and parent write authority matches only the saved grant.
- Safe child file/directory grants and aliases compose with workspace writes; using the same saved read-only grant from an unrelated workspace does not grant writes.
- Protected roots and protected lexical aliases remain rejected even when they contain, equal, or are inside the workspace. Type changes and symlink retargets remain fail-closed.
- Nested saved grants remain rejected; workspace overlap support does not introduce deny-style read-only carve-outs or configuration normalization.
- Existing Stow-safe configuration changes, grant removal, duplicate handling, client isolation and command tests continue to pass.
- Review `git diff --check` and the scoped diff. Run focused tests and attempt `npm --prefix pi/sandbox test`; distinguish harness/dependency failures from behavioral regressions.
- Required host acceptance: deploy from an ordinary host terminal, restart Pi, verify startup in `~/src/polez` with the saved `~/src` grant unchanged, and run `npm --prefix pi run check`. Native checks must not be claimed successful without evidence.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Compose workspace and saved authority safely
- ☑ Align documentation and verify the regression
<!-- pi-plan-mode:progress:end -->
