# Fix discussion child extension startup

## Context

Selecting **Discuss this** suspends the questionnaire and launches a persisted Pi child session. The child-only runtime registers `/resolve` and excludes questionnaire recursion, delegation, and parent workflow tools.

`registerDiscussionChildRuntime()` in `discussion/child.ts` currently invokes `stripExcluded()` during extension loading. That function calls `pi.getActiveTools()` and `pi.setActiveTools()` before Pi binds the extension runtime. Pi rejects these calls, so the entire questionnaire extension fails to load in the child, including `/resolve`.

Read-only reproduction with the installed Pi 1.4.0 extension loader confirmed the exact reported error when `PI_ASK_USER_QUESTION_DISCUSSION_CHILD=1`. The same extension loads without errors when the child marker is absent. Pi's lifecycle documentation and loader implementation require session actions to run after runtime initialization. The code already registers filtering at `session_start` and `before_agent_start`; the eager call is redundant and invalid.

The unmatched-model warnings originate from configured `enabledModels` patterns. They are independent of the reproduced extension error. This fix will preserve model settings and all unrelated existing workspace changes. It will not change the persisted-child design, sandbox authority, answer confirmation, or RPC handoff behavior.

## Approach

Remove the premature runtime action rather than suppressing the exception or disabling extensions. Use the existing lifecycle hooks and execution-time block to retain child restrictions.

### Part A — Repair child startup and prevent lifecycle regressions
- **Ledger:** {"status":"completed","note":null,"evidence":"Added lifecycle regression and observed 3 failures with the exact uninitialized getActiveTools error before the fix. Removed only the eager stripExcluded call; retained session_start, before_agent_start, and execution guards. Focused child/reconciler tests: 22/22 pass. Full package suite: 597/598 pass; remaining Herdr test fails on sandbox EPERM creating /tmp/herdr-questionnaire-*. Rerun excluding that file: 593/593 pass. Typecheck passes. Real installed Pi 1.4.0 loader: parent and child each load one extension with zero errors; /resolve absent in parent and present in child. npm --prefix pi run check attempted in current routed environment: stops at unrelated plan-mode launcher smoke failure resolving generated-HOME launcher path; ordinary-host gate and native SRT/Docker checks remain unavailable. Deployment not attempted because sandbox denies deployment targets and installer begins with broad target removal; existing Stow resolution points questionnaire entry to this source. Interactive Discuss this /resolve smoke unavailable. git diff --check passes; only three package files plus saved plan changed by this task, all pre-existing changes preserved."}

Add a focused regression test for child-runtime registration with action APIs that throw until initialization. Verify registration performs no active-tool reads or writes, registers `/resolve` only for child sessions, and attaches the expected lifecycle and execution guards. Reproduce the failure before removing the eager `stripExcluded()` call.

Retain filtering at `session_start`, after this package registers its questionnaire tool, and before each agent run. Test that filtering preserves compatible tools while removing every excluded tool. Verify the reconciler cannot restore `ask_user_question` in children and the tool-call guard still blocks excluded tools.

Document the lifecycle constraint briefly in the existing package runtime documentation or maintenance notes: registration installs handlers; active-tool filtering starts only after runtime initialization. Keep the saved plan with implementation changes if those changes are committed.

Acceptance: the real Pi loader loads the extension in both parent and child modes without runtime-initialization errors; child-only `/resolve` and restrictions remain present. No model settings or unrelated files change.

## Critical Files

- `pi/agent/packages/ask-user-question/discussion/child.ts`: child lifecycle registration, tool exclusions, and `/resolve`.
- `pi/agent/packages/ask-user-question/discussion/child.test.ts`: regression coverage for lifecycle timing and child restrictions.
- `pi/agent/packages/ask-user-question/reconcile.ts`: read-only integration reference for preventing questionnaire restoration in children.
- `pi/agent/packages/ask-user-question/docs/hosts.md`: existing runtime behavior documentation.

## Verification

- First run the new lifecycle regression against the current implementation and observe the initialization error; then verify it passes after the fix.
- Run focused child/reconciler tests, followed by the questionnaire package test suite and typecheck. Install development dependencies only if needed during approved implementation.
- Repeat the real installed Pi loader probe with and without the child marker. Require one loaded extension and no load errors in both cases.
- Run `npm --prefix pi run check` from an ordinary host terminal as required by repository policy. Report any unavailable native SRT/Docker checks rather than treating them as passed.
- Deploy only through `./install.sh config`, if deployment can proceed without overwriting unrelated changes. If the existing dirty Obsidian or configuration state blocks deployment, report the blocker rather than bypassing it.
- Terminal smoke test: open **Discuss this**, confirm the child starts and `/resolve` exists, resolve an outcome, and confirm the parent questionnaire returns with explicit answer confirmation still required. Ordinary child exit must leave the answer unchanged. If an interactive smoke test is unavailable, state that limitation.
- Review the final diff for scope control and preservation of pre-existing changes. Unmatched-model warnings may remain; they are not a failure signal for this lifecycle fix.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Repair child startup and prevent lifecycle regressions
<!-- pi-plan-mode:progress:end -->
