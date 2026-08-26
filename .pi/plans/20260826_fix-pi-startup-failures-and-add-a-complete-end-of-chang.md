# Fix Pi Startup and Add a Complete Test Gate

## Context

Two regressions from the recent canonical-plan consolidation prevent Pi from starting correctly.

The normal Gondolin launch is failing closed as designed, but for the wrong inventory result. `plan_progress` changed its public schema description from the historical mixed-ID wording to canonical Part IDs. Its actual schema hash is now `608694d7534b76fed9fe8b50a527e9ac3d1dff7009b8aab0af769ff727955c76`, while `pi/agent/extensions/gondolin-sandbox/host-adapters.ts` still audits the previous `f8a173…` hash. Gondolin therefore rejects the requested host adapter before activating tools. The fail-closed routing behavior must remain intact; only the reviewed manifest and its regression coverage should change.

The `--yolo` warning is expected because that flag deliberately disables Gondolin. The subsequent plan-mode failure is not expected: `restoreForContext()` assigns and reads `rejectedExecutionRestore`, but the extension closure never declares it. Every `session_start` or `session_tree` restoration can therefore throw `ReferenceError`, including a normal off-state startup. The flag is intended to suppress context only when restoration detects an executing workflow without a matching canonical execution contract.

Current focused testing confirms both root causes. With `PI_PACKAGE_ROOT` pointed at installed Pi 0.84.2, plan-mode tests reach 113 cases but 28 restoration/dialog cases fail from the undeclared variable. Registering the current execution tools produces the new `plan_progress` hash above, while the other execution-tool hashes still match the audited manifest. Several plan-mode and subagent tests also default to a removed Pi 0.82.1 Cellar path, so their ordinary package checks can fail before testing the code. This weakens the repository’s existing instruction to run a final Pi-wide test pass.

The repository needs one canonical end-of-change command for `pi/`. It should run all local extension and package checks, deterministic Gondolin unit/wrapper tests, and the native QEMU/Docker/live-network canaries. Native checks still require an ordinary terminal or a `pi --yolo` session; a Gondolin-routed Bash process cannot validate the host sandbox from inside itself. Test setup must resolve the current installed Pi package rather than embedding a versioned Homebrew Cellar path, and it must install the ask-user-question development dependencies from its lockfile before invoking Vitest and TypeScript.

No glossary or ADR is warranted. **Host adapter**, **tool inventory**, **execution contract**, and **native sandbox check** already have precise meanings in the Pi documentation, and the test-gate choice is reversible workflow configuration. The implementation must preserve unrelated working-tree changes and retain this plan document with the implementation commit, as required by the repository workflow.

## Questions & Answers

| Question | Answer |
|---|---|
| What should the single end-of-change Pi check include? | All, including native: extension and package tests, sandbox unit and wrapper tests, and QEMU, Docker, and live-network canaries. |

## Approach

Restore startup with two surgical fixes, add focused cross-extension coverage for the failure boundaries, and then make the complete Pi verification contract executable through one top-level command.

### Part A — Restore plan-mode and Gondolin startup
- **Ledger:** {"status":"completed","note":"Declared restoration rejection state, refreshed only the plan_progress audit digest, and added restoration/schema-drift coverage.","evidence":"PI_PACKAGE_ROOT=/opt/homebrew/Cellar/pi-coding-agent/0.84.2/... npm --prefix pi/agent/extensions/plan-mode test (116 passing); node --test gondolin tools + plan-workflow-schema (6 passing)."}

Declare `rejectedExecutionRestore` in the plan-mode extension’s session-scoped closure with a safe initial value. `restoreForContext()` must recompute it on every branch restoration, leave ordinary off/planning/approval/current-execution sessions unaffected, and retain the existing fail-closed behavior for an executing state without a matching canonical in-place execution contract. Do not weaken context isolation or silently accept historical execution records.

Update only the audited `plan_progress` schema digest in `pi/agent/extensions/gondolin-sandbox/host-adapters.ts` to match the reviewed canonical-Part schema. Keep source path, package version, provenance, requested-adapter enforcement, and all other adapter hashes unchanged. The visible `--yolo` warning remains unchanged because it correctly reports an explicit sandbox bypass.

Add focused restoration coverage that starts the real plan-mode extension in an ordinary non-executing state without throwing and proves both supported current execution restoration and unsupported execution rejection. Add a cheap composed schema test that registers the actual plan-mode tools and compares each plan workflow tool’s parameter schema with the Gondolin adapter manifest. This test must fail whenever a future plan tool schema changes without a deliberate audit-manifest update, rather than relying only on the expensive production inventory canary.

Acceptance requires normal Gondolin inventory audit to accept `plan_progress`, `pi --yolo` startup to load plan mode without `ReferenceError`, and unsupported execution restoration to remain blocked without exposing planning context.

### Part B — Make Pi tests independent of installed version paths
- **Ledger:** {"status":"completed","note":"Added one validated installed-Pi/Jiti helper and migrated all active version-pinned Pi test loaders.","evidence":"No active Pi test code contains a Cellar/version path (grep clean); helper resolves /opt/homebrew/opt/pi-coding-agent/...; focused plan-mode suite passes 116 tests without PI_PACKAGE_ROOT."}

Introduce a small shared test helper under `pi/` that resolves the Pi coding-agent package from an explicit `PI_PACKAGE_ROOT` first and then from a stable supported local installation path, with a clear failure telling non-Homebrew environments to set the environment variable. Use that helper in the plan-mode, subagent, Gondolin, command-palette, fzf, and native-tool tests that currently embed versioned Cellar locations. Preserve Jiti aliases and test semantics; this is test infrastructure, not runtime package discovery.

The helper must validate that the resolved directory contains the expected Pi runtime and Jiti entry before a suite starts. This prevents stale paths from masking product regressions as unrelated module-resolution failures and allows package-level checks to work across Pi upgrades without editing every fixture.

Acceptance requires the focused plan-mode suite and all migrated extension tests to run against the currently installed package with no 0.82.1 or version-specific Cellar references left in active Pi test code.

### Part C — Add one complete end-of-change Pi gate
- **Ledger:** {"status":"blocked","note":"Implemented and documented the sequential complete gate; deterministic phase passes. Native canaries require a host terminal or pi --yolo session and cannot be verified from this Gondolin-routed session.","evidence":"npm --prefix pi run check:deterministic passed all extension/package and sandbox deterministic suites; pi --yolo --help loaded plan-mode's --plan flag with no ReferenceError. Native phase remains npm --prefix pi/sandbox run test:native via npm --prefix pi run check on the host."}

Add a private top-level `pi/package.json` and a lightweight Node runner so `npm --prefix pi run check` is the canonical final command. The deterministic phase should run each maintained extension’s existing `check` or test entry point, direct Node tests for subagent, statusbar context, usage, Herdr feedback composition, the ask-user-question Vitest suite and typecheck, and `npm --prefix pi/sandbox test`. Reuse package-owned scripts instead of duplicating their internal test file lists where a package already owns a check.

Before the ask-user-question checks, install its development dependencies deterministically from `package-lock.json` with lifecycle scripts disabled; normal Stow deployment can continue installing production dependencies only. The runner should execute suites sequentially, stream their output, stop at the first failure with the failed suite identified, and propagate `PI_PACKAGE_ROOT` to child processes.

The final `check` phase must then invoke `npm --prefix pi/sandbox run test:native`, covering QEMU, Docker, routed tools, production child inventory, Ketch, and live network behavior. Keep a deterministic-only script available for development, but do not present it as sufficient final verification. Update `pi/AGENTS.md` and the relevant Pi verification documentation to replace the current vague final-review sentence with the exact canonical command, its all-inclusive scope, and the requirement to run it from an ordinary terminal or `pi --yolo` session. Do not add an automatic Git hook or run this expensive gate during `./install.sh config`.

Acceptance requires one documented command to cover every maintained Pi test boundary and to return nonzero for either of the reported regressions, a schema/audit drift, a deterministic sandbox failure, or a native containment/canary failure.

## Critical Files

- `pi/agent/extensions/plan-mode/index.ts` — owns session restoration state and the rejected-execution context boundary.
- `pi/agent/extensions/gondolin-sandbox/host-adapters.ts` — owns audited host-adapter schema identities and provenance checks.
- `pi/agent/extensions/plan-mode/test/` and `pi/agent/extensions/gondolin-sandbox/*.test.mjs` — cover restoration and the production-shaped plan/Gondolin composition.
- `pi/package.json` and the new `pi/` test runner/helper — define the canonical cross-package verification entry point and installed-Pi resolution.
- `pi/AGENTS.md` and `pi/sandbox/README.md` — state the end-of-change verification rule and native execution boundary.

## Verification

**Regression checks**

- Run the focused plan-mode restoration and workflow-dialog tests against the current installed Pi. Success means ordinary startup, current execution restoration, and approval restoration do not throw; unsupported execution still enters the blocked state and filters context.
- Run the composed plan/Gondolin schema test. Success means all four plan workflow tools match their audited manifest entries; changing any registered schema alone is a deliberate failing signal.
- Exercise a `pi --yolo` extension-load/startup smoke case. The sandbox-disabled warning is allowed; any plan-mode extension error or `ReferenceError` is a failure.
- Run deterministic extension, package, wrapper, and sandbox tests through the new top-level test phase. Success means every child suite exits zero and identifies the current Pi package without versioned Cellar paths.

**Full end-of-change gate**

- From an ordinary terminal or a `pi --yolo` session, run `npm --prefix pi run check` once after all edits.
- Success requires the deterministic phase and every `test:native` QEMU, Docker, network, tool-routing, production inventory, and Ketch canary to pass.
- If the implementation session remains inside Gondolin, run the deterministic phase there, explicitly report native checks as unverified, and require the host-side full command before declaring the change complete.
- Review `git diff`, run `git diff --check`, verify no unrelated working-tree changes were overwritten, and retain the submitted `.pi/plans/...` file with the implementation commit.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Restore plan-mode and Gondolin startup
- ☑ Make Pi tests independent of installed version paths
- ⛔ Add one complete end-of-change Pi gate
<!-- pi-plan-mode:progress:end -->
