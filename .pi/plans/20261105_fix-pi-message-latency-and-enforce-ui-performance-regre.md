# Fix Pi message latency and enforce performance checks

## Context

Pi loads global extensions from the Stow-managed `pi/agent/extensions/` tree. Extension hooks run in sequence before a prompt reaches the agent. Footer rendering runs on the terminal interaction path.

Inspection and read-only experiments found two concrete costs:

- `git-tree-checkpoints/index.ts` awaits `captureCheckpoint()` in `before_agent_start`. A delayed capture prevented submission from completing throughout a 251ms controlled probe.
- `git-checkpoints.js` enumerates repository files, checks attributes, reads text candidates sequentially, and runs approximately 22 Git commands per capture. A read-only probe took 159ms with every Git write stubbed. This is a lower bound, not a measurement of the reported total delay.
- `statusbar.ts` calls `ctx.getContextUsage()` and scans `getBranch()` during every render. The installed Pi implementation rebuilds its session projection inside `getContextUsage()`. A footer probe performed 1,000 history scans for 1,000 redraws.

These findings reproduce unnecessary local work, but do not establish that all reported delay comes from these extensions. Provider response latency, startup readiness, and automatic compaction remain separate. The implementation must compare the local stages before and after the fix.

The user requires exact pre-prompt checkpoint semantics. Capture must finish before the model can change code. Background capture, deferred first-write capture, and removal of automatic snapshots are excluded. This retains unavoidable disk and Git latency for changed or large workspaces.

The existing Pi test gate has no automatic saved-edit or commit enforcement. The repository has no configured `core.hooksPath` and no active pre-commit hook. “Every change” means automatic debounced checks after repository saves during root interactive Pi development, plus a blocking check on every repository commit. Commit checks apply regardless of the changed paths. Git's explicit hook bypass remains possible and must not be described as absolute enforcement.

The checkpoint README says unreadable or uncertain files are excluded. The implementation currently throws on read errors other than missing files. Resolve this documentation/code conflict within classification tests, without broadening captured paths.

Preserve all unrelated working-tree changes. Do not change the runtime system prompt, provider defaults, sandbox authority, MCP approval rules, or installed Homebrew package files.

## Questions & Answers

| Question | Answer |
|---|---|
| How should Git checkpoints work without delaying each message? | Optimize pre-prompt capture. Keep exact before-prompt snapshots and reduce redundant file reads and Git work. Submission still waits for disk and Git. |
| What automatic enforcement do you want for the UI regression test? | Watch edits + block commits. Run a lightweight regression suite automatically after saved edits during Pi development, install a repository-local pre-commit gate, and include the suite in both existing Pi check commands. |

## Approach

Keep the current checkpoint lifecycle and restore contract. Reduce capture work rather than moving it past the prompt boundary. Move expensive footer calculations out of repeated rendering. Add one bounded performance suite with automatic saved-edit and commit entry points.

### Part A — Reproduce and reduce pre-prompt checkpoint cost
- **Ledger:** {"status":"completed","note":null,"evidence":"Added failing operation-count and full-file invalid UTF-8 regressions before optimization. All 36 checkpoint tests passed (restore, staging, modes, symlinks, attributes, unsupported indexes, cleanup). Isolated baseline cold/repeat/edit/mixed: 257/272/291/300ms, 19 operations; optimized: 208/226/219/233ms, 16 operations text-only. Smoke launcher failed on nonexistent generated sandbox launcher path; retained for Part E reporting."}

Establish stage timings and operation counts for actual capture in disposable Git repositories. Cover the first capture, unchanged repeated prompts, a changed worktree, and a larger mixed text/binary workspace. Keep model-network time out of these measurements.

Optimize the existing engine with bounded parallel text classification, shared file enumeration, set-based membership, and fewer redundant Git operations. Preserve attribute precedence, complete UTF-8 validation, NUL rejection, modes, symlinks, staging, and non-ignored untracked text. Do not replace full validation with a prefix sample.

Reuse unchanged classification only when its identity checks preserve correctness. Account for attribute changes, replacement files, mode changes, deletion, and text/binary transitions. A timestamp-only cache is not sufficient. Prefer a simpler uncached improvement over an unsafe or elaborate cache.

Retain serialized captures, alternate indexes, atomic checkpoint-ref advancement, and cleanup after errors or cancellation. Keep snapshots before prompt persistence and model execution. Capture failures must warn without publishing false metadata. Safety capture and restoration during `/tree` retain their existing behavior.

Add correctness and operation-count regressions before optimization. Resolve unreadable-file behavior to match conservative exclusion in the documented text-selection contract. Preserve errors that invalidate repository or checkpoint safety.

Acceptance: changed files and staging round-trip through existing restore tests. Repeated captures perform measurably less redundant work. Benchmark results show the improvement and identify any remaining dominant stage.

### Part B — Make footer redraws independent of conversation length
- **Ledger:** {"status":"completed","note":null,"evidence":"Actual footer tests: 200 redraws against 20,000 entries in 5.5ms with zero scans/projections. Tested finalized turn/run boundaries, compaction unknown values, tree branch cost reconstruction, model selection, reload/new/resume/fork startup, and narrow sandbox-off warning. Installed runtime confirms message_end precedes persistence; refresh uses subsequent finalized boundaries."}

Cache the current context display and cumulative branch cost outside `render()`. Refresh them at supported lifecycle boundaries that change finalized conversation state, compaction, branch selection, or model limits. Reconstruct state on session startup and replacement.

Preserve compaction-aware unknown context values and the current branch's cost. Do not count abandoned branches or double-count message completion. Keep model/thinking display, planning markers, and sandbox-off warnings current. Rendering must use cached values, even during rapid streaming updates, editor input, and resize events.

Use the existing `selectContextDisplay()` helper. Do not patch Pi's installed runtime or approximate its compaction rules with a separate estimator.

Acceptance: repeated redraws make no history scans or context-projection calls. Lifecycle tests prove that new messages, compaction, navigation, reload, and model changes update the displayed values correctly. Narrow-width rendering retains the sandbox authority warning.

### Part C — Add a bounded performance regression suite
- **Ledger:** {"status":"completed","note":null,"evidence":"check:ui passes five behavioral checks in 3.6s with fixed inputs: 20k-history/200 redraws (5ms, zero projections), seven-file workspace/three consecutive captures (801ms <1s, 48 operations), text/binary/attribute transitions, cancellation cleanup. Installed AgentSession runs actual checkpoint hook before agent_start with fake transport (208ms preparation, 122ms provider). Disposable expensive footer fails explanatory structural assertion. Both gates start check:ui; suite has external 30s process-group kill deadline."}

Create a dedicated suite outside extension auto-discovery. Expose it through `npm --prefix pi run check:ui` and include it at the start of both existing Pi gates.

Exercise actual extension handlers and footer rendering, not source-text patterns. Use isolated temporary repositories and a fake local model transport or equivalent installed-runtime boundary. No live credentials, paid requests, Docker startup, or network availability may determine performance results.

Use deterministic work-count assertions as the primary protection. Add generous elapsed-time deadlines to detect stalls. The initial budgets are 100ms for cached footer redraw batches and 1s for repeated small-workspace pre-prompt capture. Report cold capture separately. Establish fixture sizes and repetitions before implementation tuning, and retain those inputs in the suite. Do not relax budgets merely to make the optimized implementation pass.

Include large-history redraws, first and repeated prompts, text edits, binary transitions, attribute edits, cancellation, and rapid consecutive submissions. Add a composed input-to-agent-start smoke scenario that distinguishes local preparation from provider latency.

Demonstrate sensitivity by injecting a delayed capture or restoring the expensive redraw path in a disposable test fixture. The regression suite must fail with an explanatory message. Keep a process-level timeout so a synchronous stall cannot hang the watcher or commit indefinitely.

Acceptance: the suite fails against reproduced expensive behavior through structural assertions, passes after the fixes, and prints useful timing evidence. Existing correctness suites remain independent.

### Part D — Run the suite after saves and before every commit
- **Ledger:** {"status":"completed","note":null,"evidence":"Six automatic-enforcement tests pass: atomic saves/new directories/bursts, serialized rerun/stale-success suppression, failures/timeouts/shutdown with ESRCH child reaping, real save invoking check:ui, disposable passing/failing commits and hook ownership preservation, actual root-TUI extension startup/shutdown. fs.watch returns EMFILE in this execution environment; implemented and exercised excluded one-second metadata polling fallback. Tracked pre-commit hook activation added to install.sh config, local-only. Docs and developer prevention rules added; bash -n and diff --check pass."}

Add a small watcher for this canonical repository. Start it only in a root interactive Pi session for the dotfiles workspace, never in child agents, RPC sessions, or unrelated projects. Start and stop it through session lifecycle hooks, not the extension factory or prompt hooks.

Watch repository source saves and newly created directories. Exclude `.git`, dependency trees, generated test output, and runtime-only data. Debounce save bursts, serialize test processes, and schedule one final rerun when edits arrive during a check. Suppress stale success results. Publish a concise latest result without sending messages to the model. Failures must remain visible.

Install a tracked pre-commit hook through a repository-local `core.hooksPath` setting during `./install.sh config`. Do not change global Git configuration or create manual deployment symlinks. Respect an existing unrelated hook configuration instead of silently replacing it. Treat missing Node/Pi test prerequisites and nonzero regression results as commit failures.

The hook runs for every commit, including non-Pi changes. The watcher does not execute the full native SRT gate after every save. It runs only the lightweight regression suite. The full Pi gate remains required before completion.

Add watcher tests for atomic-save replacement, new directories, edit bursts, edits during a running suite, test failures, timeouts, shutdown, and child-session exclusion. Add disposable-repository integration tests proving that a failing check blocks a commit and a passing check permits it. Prove that save events actually invoke the same suite, rather than only testing its standalone command.

Document the automatic checks and manual commands in Pi development documentation. Add a prevention rule to `pi/AGENTS.md` for expensive prompt hooks and render callbacks. Update the checkpoint README with the optimized behavior and measured limits. Do not add an ADR or generic glossary entries for ordinary performance concepts.

Acceptance: a saved edit triggers the suite without delaying message submission. Every normal repository commit invokes the suite and stops on failure. Watcher teardown leaves no orphan process.

### Part E — Verify and deploy the latency fix
- **Ledger:** {"status":"blocked","note":"Host-only full verification and deployment/live interactive smoke cannot complete inside current SRT tool environment. No authority bypass attempted.","evidence":"Focused checks pass: check:ui (5), automatic enforcement (6), checkpoint correctness (36) plus smoke with explicit installed PI_BIN, hook invocation, bash -n, diff --check. Full npm --prefix pi run check starts UI suites successfully but launcher smoke fails because generated HOME lacks bin/pi; safe installed-binary retry passes planning/checkpoint stages then stops at pre-existing RTK package missing in generated HOME. Native SRT/Docker stages therefore did not run. ./install.sh config activated local core.hooksPath=.githooks and attempted Stow, then failed at Herdr socket path exceeding sockaddr_un capacity due to generated HOME. Real host Stow aliases are sandbox-denied; refreshed interactive session unavailable. Unrelated Obsidian edits preserved (installer never reached Obsidian drift check). Local probes show repeat ~226ms vs baseline 272ms, 16 vs 19 Git operations, footer ~5ms/200 redraws with no scans; not evidence that entire reported live latency is resolved. Final diff reviewed; no commit made."}

Run focused correctness and performance checks first. Then run `npm --prefix pi run check` from an ordinary host terminal, as repository instructions require. Report environmental or pre-existing failures separately from regressions introduced here.

Deploy only through `./install.sh config`. Existing unrelated Obsidian changes can block this installer. Do not discard or commit those changes merely to deploy Pi. Report that blocker if it remains.

After deployment, verify the Stow-managed sources, installed repository hook, and automatic watcher. Use a refreshed Pi session to compare repeated prompt submission and typing/redraw responsiveness. Record local preparation timings separately from model response times.

Review the final diff for scope, cleanup, correctness, and maintained checkpoint safety. Include the canonical saved plan with implementation changes if a commit is made.

Acceptance: all affected regressions pass, automatic execution has observed evidence, and the deployed smoke test shows reduced local latency. Do not claim the UI is fixed if only unit tests ran or if the reported delay remains unexplained.

## Critical Files

- `pi/agent/extensions/git-tree-checkpoints/git-checkpoints.js`: text selection and safe Git snapshot capture.
- `pi/agent/extensions/git-tree-checkpoints/index.ts`: pre-prompt ordering and `/tree` recovery semantics.
- `pi/agent/extensions/statusbar.ts`: render path and lifecycle-driven display data.
- `pi/test-gate.mjs` and `pi/package.json`: required performance-suite entry points.
- `install.sh`: repository-local hook activation and Stow-only deployment.
- `pi/AGENTS.md`: developer verification requirements, not the runtime system prompt.
- Installed Pi extension, SDK, and TUI documentation: read-only lifecycle and rendering references.

## Verification

Regression checks cover text/binary selection, staging, untracked paths, symlinks, modes, attribute precedence, unsupported indexes, cleanup, checkpoint persistence, and `/tree` recovery.

Performance checks combine bounded timings with deterministic operation counts. Footer redraws must not call `getBranch()` or `getContextUsage()`. Capture checks must prove reduced redundant work while retaining exact pre-prompt ordering.

Automatic-execution checks cover saved-edit dispatch, process serialization, timeout cleanup, visible failure state, and passing/failing commits in disposable repositories. Missing prerequisites must fail explicitly, not skip checks.

Integration checks retain sandbox readiness, planning guard composition, MCP authority, and existing extension behavior. No latency improvement may come from removing a security gate.

The final host check is `npm --prefix pi run check`. A deployed interactive smoke test must show prompt preparation and footer responsiveness separately from provider response delay. Any deployment, native-test, or live-reproduction gap must appear in the final report.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Reproduce and reduce pre-prompt checkpoint cost
- ☑ Make footer redraws independent of conversation length
- ☑ Add a bounded performance regression suite
- ☑ Run the suite after saves and before every commit
- ⛔ Verify and deploy the latency fix
<!-- pi-plan-mode:progress:end -->
