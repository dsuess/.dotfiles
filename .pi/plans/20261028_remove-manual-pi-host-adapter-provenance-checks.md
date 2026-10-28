# Commit existing Pi canonical filesystem grant changes

## Context

The user requested logical commits for all existing changes under `pi/`. The host-adapter fix is already committed separately.

The remaining sandbox implementation permits saved grants for identical canonical directories, including the active workspace. It preserves every saved alias for safety checks. Explicit edits replace or remove all canonical matches. Policy composition combines access without rewriting saved configuration.

## Approach

Commit the existing grant behavior, related regression tests, and documentation together. Keep saved access configuration and runtime preferences in separate commits. Include the existing shared-agent access plan as a historical record, without claiming its implementation is present or complete.

### Part A — Verify and commit grant behavior
- **Ledger:** {"status":"completed","note":null,"evidence":"Reviewed grant validation, explicit canonical-match edits, lossless alias snapshots, and policy composition. All 35 focused tests passed with node --test across test-client-policy, test-filesystem-configuration, test-filesystem-grant-validation, test-filesystem-grants, and test-srt-policy. npm --prefix pi run check reproduced the eight known MCP fixture, missing Visonic checkout, and controller-readiness failures (SRT routing: 199 passed, 8 failed); dedicated native gate did not run. Staged whitespace check passed. Created be05feb, fix(pi): compose filesystem grants by canonical directory; inspected its 13-file list and remaining working tree. Commit includes only Pi implementation/tests/docs and .pi planning records; excludes runtime preferences, saved access configuration, runtime prompt, and unrelated files. Historical shared-agent plan is included without asserting its absent manifest implementation is present or verified."}

Review the grant validation, configuration editing, and policy composition changes. Run their focused tests. Stage the implementation, tests, relevant development instructions, sandbox documentation, and planning documents. Run the staged whitespace check and commit.

Acceptance: the focused tests pass and the commit contains no runtime preferences, saved access configuration, or non-Pi changes.

## Verification

- All 35 focused tests passed across client policy, configuration editing, grant validation, saved grants, and SRT policy.
- The existing full Pi gate was attempted during this session. It failed on eight MCP fixture, missing Visonic checkout, and controller-readiness cases. Native verification did not run.
- The existing shared-agent access plan reports blocked checks. Its described host-read manifest implementation is absent from the current diff and remains unverified.
- Inspect the commit file list and remaining working-tree changes after committing.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Verify and commit grant behavior
<!-- pi-plan-mode:progress:end -->
