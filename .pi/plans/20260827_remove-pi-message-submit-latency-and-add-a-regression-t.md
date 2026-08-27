# Remove Pi Message Submission Delay

## Context

Pi’s user message is not rendered until its pre-agent extension lifecycle finishes. The configured run is slow, while `pi --yolo --no-extensions --no-skills --no-prompt-templates` is responsive; the delay therefore belongs to the configured extension stack rather than Pi’s editor, terminal input parser, sandbox controller, or provider request.

The current session also rules out the previously fixed Git/PATH regression as the main cause: the synchronous Git checkpoint reached its capture point about 155 ms after this prompt’s timestamp, and the host resolves Homebrew Git without the old Apple `xcrun` penalty. Keep checkpoint capture synchronous so code state still represents the conversation leaf before the prompt.

The remaining seconds-scale submission blocker is `pi-rtk-optimizer` 0.9.0. With `guardWhenRtkMissing: true`, its `before_agent_start` handler refreshes stale RTK availability before every prompt submitted more than 30 seconds after the prior check. That refresh can synchronously await executable resolution for up to one second and `rtk --version` for up to five seconds. This hook runs in normal and `--yolo` sessions and explains why disabling all extensions removes the lag. The repository’s installer already provisions `rtk` as a pinned required tool, so the runtime-missing guard duplicates a stronger deployment invariant.

Set the optimizer’s managed configuration to trust that required-tool invariant instead of probing RTK on the user-message render path. Preserve the optimizer, command rewriting, output compaction, and its startup status refresh. The accepted risk is that manually deleting or breaking `rtk` after startup will no longer make the optimizer bypass rewriting via its periodic guard; normal installation and the complete Pi checks continue to detect a missing executable.

No domain glossary or ADR is warranted. This is a reversible runtime configuration and regression-test change. The implementation must include this plan document in its commit and leave the existing unrelated sandbox, install, submodule, README, and plan changes untouched.

## Questions & Answers

| Question | Answer |
|---|---|
| Which scenario matches the lag? | All Pi sessions: fresh and long sessions, including sandboxed and `--yolo`, show similar lag. |
| Is the delay at startup or message submission? | Message submission: Pi is already open, and the user message takes seconds to appear after Return. |
| Does Pi still lag with extensions disabled? | No. `pi --yolo --no-extensions --no-skills --no-prompt-templates` is responsive; configured extensions cause the delay. |

## Approach

Disable only the optimizer’s periodic missing-RTK guard, then test the production-shaped extension lifecycle so a future configuration change cannot put process probes back on prompt submission.

### Part A — Remove RTK availability probes from prompt submission
- **Ledger:** {"status":"completed","note":"Disabled only the optimizer's stale missing-RTK guard.","evidence":"pi/agent/extensions/pi-rtk-optimizer/config.json now has guardWhenRtkMissing: false; Node JSON validation passed and the diff is a single-line change preserving rewrite and compaction settings."}

Change the committed `pi-rtk-optimizer` configuration to set `guardWhenRtkMissing` to `false`. Keep rewrite mode and all output-compaction choices unchanged.

This uses the repository’s existing guarantee that `install.sh` provisions the pinned `rtk` executable. It must not remove `pi-rtk-optimizer`, disable rewriting, weaken Git checkpoint ordering, alter Gondolin readiness, or patch generated/npm-installed package files. The optimizer may still check RTK during `session_start` and explicit verification flows; only stale per-prompt availability refreshes must disappear.

Observable outcome: after Pi has been idle for more than the optimizer’s 30-second freshness window, Return proceeds to the user message without waiting for `which` or `rtk --version`. RTK-backed Bash rewriting and output compaction remain active.

### Part B — Add a production-shaped stale-status regression test
- **Ledger:** {"status":"completed","note":"Added and wired the production-shaped stale-status lifecycle regression test.","evidence":"Focused test passed. With PI_BIN=$HOME/bin/pi, npm --prefix pi run check:deterministic and npm --prefix pi run check both completed successfully; the test loads the installed TS extension through createPiJiti, verifies session_start probes RTK, then advances 30,001 ms and proves before_agent_start settles with zero pi.exec calls."}

Add a maintained test around the installed `pi-rtk-optimizer` package and the committed configuration. Load the real extension through the same TypeScript/Jiti boundary used by the Pi test harness, register its lifecycle handlers against a controlled fake `ExtensionAPI`, and complete the normal `session_start` status probe with deterministic RTK responses.

Advance the test clock beyond 30 seconds, make every subsequent `pi.exec` call observable and fail immediately, then invoke the real `before_agent_start` handler. Assert that the handler settles without any executable-resolution or version process call. This tests the user-visible boundary directly rather than merely checking a JSON value. Keep a sensitivity assertion for the package guard predicate so the test demonstrates that enabling the guard would reactivate the stale probe path.

Wire the focused test into `pi/test-gate.mjs` so both deterministic and complete Pi checks enforce it. The test must not rewrite user configuration, depend on network access, sleep for wall-clock time, or modify the installed npm package.

## Critical Files

- `pi/agent/extensions/pi-rtk-optimizer/config.json` — managed optimizer behavior; the missing-runtime guard is the submission-path switch.
- `pi/agent/npm/node_modules/pi-rtk-optimizer/src/index.ts` and `src/runtime-guard.ts` — read-only installed-package references defining the 30-second stale check and `before_agent_start` probe.
- `pi/test-gate.mjs` — maintained deterministic/full Pi verification entrypoint.
- `install.sh` — read-only deployment invariant proving `rtk` is a pinned required executable.

## Verification

**Regression checks**

- Run the new focused lifecycle test. Success means startup still performs its expected RTK status check, but a stale `before_agent_start` performs zero `pi.exec` calls and resolves immediately. Any `which`, `where`, `rtk --version`, timeout, or pending promise during prompt submission is a failure.
- Run `npm --prefix pi run check:deterministic`. All maintained extension/package and deterministic sandbox suites must pass.
- From an ordinary terminal or `pi --yolo` session, run `npm --prefix pi run check`. Native Gondolin, Docker, routing, Ketch, and network canaries remain required by the Pi repository contract.

**Behavior scenarios**

- Start configured Pi normally, wait more than 30 seconds after startup or the previous prompt, and submit a short message. The user message must render without the former multi-second pause; a recurring delay near the optimizer’s one-plus-five-second probe bounds is a failure.
- Repeat in `pi --yolo` to confirm the extension-level fix applies independently of Gondolin.
- Exercise a Bash command that RTK can rewrite and inspect `/rtk show` or `/rtk verify`. Rewriting, output compaction, and the startup-resolved RTK path must remain functional.
- Confirm the Git checkpoint custom entry still precedes the persisted user message, preserving conversation/code restoration semantics.
- Review `git diff`, run `git diff --check`, verify unrelated working-tree changes were not overwritten, and include the generated `.pi/plans/...` document in the implementation commit.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Remove RTK availability probes from prompt submission
- ☑ Add a production-shaped stale-status regression test
<!-- pi-plan-mode:progress:end -->
