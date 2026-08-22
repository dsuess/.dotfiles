# Eliminate Sandboxed Pi Prompt Submission Delay

## Context

The delay is not model latency or a first-session rendering problem. Pi constructs the user message, then synchronously awaits every `before_agent_start` extension handler before it calls the agent and emits the user `message_start` event that the TUI renders. The global Git tree checkpoint extension uses that hook to capture repository state before every prompt, preserving the checkpoint as the parent of the user message.

Current session timestamps identify that capture as the blocked interval: the first prompt was constructed at `13:44:32.859Z` and persisted/rendered at `13:44:35.786Z`, a 2.927-second delay. A later prompt in the same session took 2.770 seconds, so the issue affects every checkpointed prompt rather than only the first prompt.

The corrected root cause is PATH reordering in `bin/pi`. The launching zsh session resolves `git` to `/opt/homebrew/bin/git`, but the sandbox wrapper constructs `inner_path` by placing Pi, Node, ripgrep, `/usr/bin`, and `/bin` ahead of the inherited PATH. Neither prefixed Cellar directory contains Git, so `/usr/bin/git` wins before the inherited `/opt/homebrew/bin` entry. On this macOS installation, `/usr/bin/git` invokes Apple's developer-tool launcher. Inside the filesystem sandbox, that launcher repeatedly fails to create its `xcrun_db-*` cache under Darwin's per-user cache directory. Each Git command still succeeds, but costs about 0.298 seconds; ten read-only `git rev-parse` calls took 2.98 seconds. The Homebrew Git selected by the launching session does not incur that penalty.

A checkpoint runs many Git processes for index validation, HEAD/ref/tree reads, alternate-index population, tree and commit creation, and ref update. The repeated Apple launcher penalty explains the prompt delay. `--yolo` executes Pi with the original session environment and PATH order, so it continues to select `/opt/homebrew/bin/git` and does not exhibit the delay.

The fix should retain synchronous pre-prompt checkpoint semantics and the existing bootstrap trust boundary. Rendering the user message early would only hide the delay and could let code mutation race ahead of the checkpoint. Granting write access to Darwin's broad cache directory or adding macOS-specific Git resolution is unnecessary when the launching session already selects the intended executable.

## Questions & Answers

| Question | Answer |
|---|---|
| Should the revised plan use inherited PATH ordering or special-case Apple's Git launcher? | Inherit the PATH setup from the session that launches Pi so sandboxed commands use the same intended `git`; the earlier contrary conclusion came from inspecting the already-reordered in-sandbox PATH. |

## Approach

Preserve the launching session's command-resolution order after filtering out entries that are unsafe during bootstrap. Keep only the minimal Pi-specific precedence needed to prevent nested Pi processes from re-entering the wrapper. This fixes Git selection generally rather than encoding a platform-specific executable path.

### Part A — Preserve the launching session’s trusted PATH order
- **Ledger:** {"status":"completed","note":"Sandbox PATH now promotes only REAL_PI_DIR, then preserves canonical safe launch-PATH order while deduplicating exact directories.","evidence":"bin/pi updated; `bash -n bin/pi` and `pi/sandbox/test-wrapper.sh` passed."}

Refactor `bin/pi` to build the sandboxed PATH from `safe_path_entries` in their original session order. These entries are already restricted to canonical absolute directories outside the candidate worktree and its Git metadata, so repository-local shims remain excluded from trusted launcher setup. Deduplicate entries without changing first-match command resolution.

Keep `REAL_PI_DIR` first. Nested Pi processes and subagents must continue to execute the installed Pi binary inside the active sandbox rather than recursively invoking `~/bin/pi`. Do not independently promote the Node, ripgrep, Git, `/usr/bin`, `/bin`, bwrap, or socat directories ahead of the inherited safe ordering; those prerequisites were already discovered from the same ordered safe path. Do not append an unfiltered PATH segment that could restore an excluded repository-local directory ahead of trusted commands.

Preserve platform and mode boundaries: Linux uses the same ordered-path rule; missing prerequisites still fail closed during bootstrap; optional Git discovery still fails narrow; sanitized environment and credential filtering remain unchanged; and `--yolo` remains a direct unfiltered bypass.

Acceptance outcome: when the host launching session's first safe `git` is `/opt/homebrew/bin/git`, sandboxed `command -v git` resolves to that same executable. The checkpoint still completes before the user message, but Git no longer invokes `/usr/bin/git` or emits denied `xcrun_db` cache errors.

### Part B — Lock in PATH semantics and record the diagnostic lesson
- **Ledger:** {"status":"completed","note":"Added safe-PATH precedence, deduplication, candidate-worktree, relative-entry, and nested-Pi regressions; documented PATH contract and launcher-diagnostic rule.","evidence":"Checkpoint suite: 33/33 plus smoke passed. Sandbox wrapper and repository-scope suites passed. bash -n and git diff --check passed. Login-shell and current sandbox both resolve /opt/homebrew/bin/git; 10 rev-parse calls took 0.044s with zero xcrun_db errors. Native containment was attempted: direct containment passed, while repository containment could not nest inside the active sandbox; fresh-session interactive timing likewise requires relaunch."}

Extend wrapper tests with competing safe command directories to prove the sandbox preserves first-match resolution from the launch PATH after `REAL_PI_DIR`. Extend repository-scope cases to prove candidate-worktree directories and relative entries cannot influence bootstrap or sandboxed trusted command selection. Retain coverage for missing/failing tools, Linux prerequisites, nested Pi behavior, environment sanitization, and `--yolo`.

Update `pi/sandbox/README.md` to define the intended PATH contract: sandboxed Pi inherits the launching session's safe absolute PATH order, removes untrusted repository candidates, and only prioritizes the installed Pi directory to avoid recursive wrapping. Explain that this preserves the user's package-manager choices without broadening filesystem access.

Because the diagnosis was initially based on an already-sanitized child environment, add a concrete prevention rule to `AGENTS.md`: when investigating launcher environment behavior, distinguish the invoking shell environment from the environment observed inside the wrapper, and reconstruct or inspect the login-shell setup before concluding what the host selected. This is a reusable workflow correction, not a domain glossary term or an ADR-worthy architecture decision.

Acceptance outcome: tests fail if a future launcher change again promotes system tools over the launching session's safe PATH, allows a repository shim into trusted resolution, or permits nested Pi to re-enter the sandbox wrapper.

## Critical Files

- `bin/pi` — trusted PATH filtering, prerequisite discovery, environment sanitization, and sandboxed PATH assembly.
- `pi/sandbox/test-wrapper.sh` and `pi/sandbox/test-repository-scope.sh` — command-order, recursive-launch, and untrusted-repository boundaries.
- `pi/agent/extensions/git-tree-checkpoints/index.ts` and `git-checkpoints.js` — read-only semantic reference showing why capture must finish before user-message emission.
- `pi/sandbox/README.md` — sandbox PATH and security contract.
- `AGENTS.md` — reusable rule for diagnosing wrapper-versus-host environment differences.

## Verification

- **Regression checks:** Run the Git checkpoint extension tests, sandbox wrapper tests, and repository-scope tests. Confirm checkpoint ordering and restore semantics, missing/failing prerequisite behavior, repository-local shim rejection, nested Pi execution, Linux handling, and `--yolo` remain unchanged.
- **PATH scenarios:** Launch the wrapper with two safe directories that provide the same fixture command and verify the earlier launch-PATH entry wins inside the sandbox. Repeat with the earlier directory inside the candidate repository and verify it is excluded. Verify `REAL_PI_DIR` alone remains intentionally promoted.
- **Native containment checks:** From an unsandboxed terminal, run the existing native containment suite because an already-sandboxed Pi cannot establish a second native boundary. Confirm preserving PATH order does not expand filesystem grants or credential visibility.
- **Performance scenario:** Record `command -v git` in the launching zsh session and inside sandboxed Pi. Both should select `/opt/homebrew/bin/git` on this machine. Repeated `git rev-parse --is-inside-work-tree` calls should produce no `xcrun_db` errors and no roughly 0.3-second cost per process.
- **End-to-end scenario:** Start a fresh sandboxed session in a Git worktree and submit a prompt. Confirm a `git-tree-checkpoint` entry is persisted immediately before the user message, the prompt renders without the previous multi-second pause, and the model request starts only after checkpoint completion. A recurring multi-second inner-message-to-session-entry delta is the failure signal.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Preserve the launching session’s trusted PATH order
- ☑ Lock in PATH semantics and record the diagnostic lesson
<!-- pi-plan-mode:progress:end -->
