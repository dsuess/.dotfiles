# Commit the Git tree checkpoint latency fix

## Context

Commit the existing checkpoint latency changes without altering unrelated working-tree files. Include `pi/agent/.gitignore` because its `/install/` rule is required by the new checkpoint regression test. No installation or deployment is included. Repository instructions require a plan in the implementation commit.

## Approach

Verify the existing fix, then stage only the checkpoint extension, its required ignore rule, and this plan. Preserve all other working-tree changes.

### Part A — Verify the scoped changes
- **Ledger:** {"status":"completed","note":null,"evidence":"Reviewed all scoped changes; checkpoint suite passed 38/38 and git diff --check passed. Existing staged diff contains only the four scoped source/config files; plan will be added in Part B. UI suite failed its missing-runtime precondition both with default path and explicit managed 1.5.0 PI_PACKAGE_ROOT. User explicitly authorized committing with this verification limitation documented. Full host-native checks and physical terminal latency remain unverified."}

Review the checkpoint engine, regression tests, README, and managed ignore rule. Run the checkpoint tests, the UI performance suite, and whitespace checks. The checkpoint tests have already passed: 38 tests, zero failures. Full host-native verification and physical terminal latency confirmation remain outside this sandboxed commit task.

Acceptance: focused tests and whitespace checks pass; the staged diff contains only the checkpoint changes, required ignore rule, and this plan.

### Part B — Commit and confirm isolation
- **Ledger:** {"status":"in_progress","note":null,"evidence":null}

Stage `pi/agent/extensions/git-tree-checkpoints/README.md`, `pi/agent/extensions/git-tree-checkpoints/git-checkpoints.js`, `pi/agent/extensions/git-tree-checkpoints/test/git-checkpoints.test.mjs`, `pi/agent/.gitignore`, and this plan. Commit with a message describing filter-free checkpoint exclusion. Inspect the resulting commit and remaining working-tree status.

Acceptance: the commit contains only the scoped files and unrelated changes remain uncommitted.

## Verification

- `npm --prefix pi/agent/extensions/git-tree-checkpoints test`
- `npm --prefix pi run check:ui`
- `git diff --cached --check`
- Inspect the resulting commit and remaining working-tree status.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Verify the scoped changes
- ▶ Commit and confirm isolation
<!-- pi-plan-mode:progress:end -->
