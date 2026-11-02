# Fix Plan Recovery After Tree Navigation

## Context

Plan mode stores workflow state in branch-local `plan-mode-state` entries. Validated candidate Markdown lives in `plan-mode-plan-display` entries and a mutable `.pi/plans/` file.

Pi restores the parent of a selected user message and returns its text to the editor. Plan mode clears approval during `input`, before Pi saves that user message. Returning to edit that message therefore restores discussion state without a pending approval. `/plan-actions` rejects that state even though its validated candidate remains available.

Successive revisions replace the same plan file. Returning to an earlier branch can restore an older expected hash while the file retains a newer revision. `show_plan` always attempts to replace that candidate file, so `revision_drift` prevents both revision and recovery. Changing the title or intent cannot select another file.

Git checkpoints include tracked and non-ignored untracked text plan files. Their optional restoration runs during `session_before_tree`, before plan mode restores workflow state. However, Keep current code is the default. Checkpoints also operate at prompt boundaries and cannot restore a missing approval token. Plan recovery must work with checkpoint restoration, conversation-only navigation, ignored plans, and non-Git workspaces.

The mutation guard remains independent of candidate approval and execution. Recovery must not enable execution, adopt changed disk content, or pull candidate state from abandoned branches. Ordinary discussion still clears approval and does not open automatic dialogs.

The accepted recovery behavior preserves changed files. Explicit `/plan-actions` restores the active branch's exact validated candidate to a fresh file when necessary. A complete revised `show_plan` submission can also allocate a fresh file when its previous target has changed. Matching files retain the existing path. A fresh path starts a new file lineage at revision 1, consistent with the current state model.

The existing state, store, and workflow-dialog checks pass: 79 tests. Current tree tests mostly emit `session_tree` without changing the active branch, so they miss the reported scenarios. Existing unrelated worktree changes remain outside this task.

## Questions & Answers

| Question | Answer |
|---|---|
| After /tree restores an older candidate whose file contains newer content, what should /plan-actions do? | Restore branch candidate: save the exact validated candidate from that branch to a new file, preserve the newer file, and reopen actions. The user also asked whether Git checkpoints already store repository state. They capture non-ignored text plans and optionally restore them before workflow restoration, but they do not guarantee matching plan content or restore approval tokens. |
| Should /plan-actions also reopen an unchanged candidate after discussion has cleared its pending approval? | Allow explicit reopening: revalidate the saved candidate and issue a fresh approval token when the user explicitly runs /plan-actions. Discussion must not trigger execution or automatic dialogs. |

## Approach

Keep the existing branch-local workflow and file-lineage model. Add explicit candidate reopening and safe target allocation instead of weakening hash checks or introducing a reset command. Use incremental red-green tests for each behavior, including installed Pi tree navigation without live provider calls.

### Part A — Reopen validated branch candidates through explicit actions
- **Ledger:** {"status":"completed","note":null,"evidence":"Reproduced missing approval in installed Pi navigateTree regression and guard-off dialog test; both now pass. State, workflow-dialog, and installed-tree suites pass (66 tests), including stale token, no prior candidate, cancellation, and no execution."}

Add a regression that selects a revision-feedback user message through actual tree navigation, then opens `/plan-actions` without resubmitting the message. Reproduce the missing-approval warning before changing behavior.

Allow an explicit no-token `/plan-actions` command to create a fresh approval for an existing, valid, unexecuted candidate after discussion or review. Reopening preserves the guard choice, candidate contents, ledger, and review counters. It does not advance the candidate revision when its file remains unchanged. Mark the decision presented before awaiting UI input so cancellation leaves one reusable approval rather than causing duplicate automatic dialogs.

Keep supplied stale tokens rejected. Do not resurrect approvals for executing, completed, blocked, or optimizing workflows. A branch before candidate presentation remains without a candidate. Do not search descendants or unrelated branches to invent one.

Extend tests to cover ordinary discussion, guard-off reopening, cancellation, stale tokens, and navigation between distinct candidate histories. Use actual session entry parent relationships rather than a flat array that treats all entries as the active branch. Acceptance requires `/plan-actions` to open the correct branch candidate while execution remains absent until an explicit implementation choice.

### Part B — Recover candidate files without overwriting changed content
- **Ledger:** {"status":"completed","note":null,"evidence":"Installed tree regressions reproduced revision_drift and failed explicit recovery before fixes; now pass with preserved bytes and fresh revision-1 paths. Store, dialog, and tree suites pass (58 tests), including collision, missing targets, symlink and path rejection, fast optimization."}

Add a red-green regression that presents two revisions on one file, restores the earlier conversation branch while retaining current code, and submits a complete revised plan. The submission must succeed on a fresh collision-safe path and leave the changed prior file byte-for-byte intact.

Retain strict containment, regular-file, symlink, canonical-schema, hash, atomic-write, and read-back checks in the store. Give the candidate workflow a narrow safe-allocation recovery path for a changed revision target. Unsafe paths, symlinks, validation errors, and unrelated I/O failures must not become allocation fallbacks. Missing revision files must also permit complete resubmission without leaving the workflow trapped.

For explicit `/plan-actions`, resolve the candidate from the matching validated display entry on the active branch. Check its hash, title, schema, Part identities, and ledger before recovery. If the file matches, reuse it. If it is missing, use the existing exact-copy restoration behavior. If it contains different content, preserve it and save the exact branch candidate to a fresh managed file. Never approve disk edits implicitly. If an exact durable copy is unavailable, report the reason and keep complete `show_plan` resubmission available.

Persist the recovered file reference and matching display record together with a fresh approval. A new file starts at revision 1. Preserve candidate progress and evidence through recovery. Later revisions use that recovered path and regain normal revision comparison behavior. The UI must identify the recovered path so the user can distinguish it from the preserved file.

Keep fast optimization's approved-source checks and execution-ledger drift protections intact. Failed recovery must retain the previous candidate and guard. Serialize trusted candidate file operations through Pi's file mutation queue where they share an existing target. Acceptance requires both explicit action reopening and revised submission to recover without a manual reset or changes to the newer file.

### Part C — Verify checkpoint integration and document recovery
- **Ledger:** {"status":"blocked","note":"The required full Pi gate must run in an ordinary host terminal; this session is confined by SRT and cannot complete host-native checks.","evidence":"Installed Pi navigateTree tests pass for Git keep/restore and non-Git; plan-mode check passes all 171 tests plus smoke/RPC/palette/TUI using installed PI_BIN. Gate progressed through preceding suites, then questionnaire test failed EPERM creating /tmp/herdr-questionnaire-*; native archive test failed EPERM listening on its Unix socket; native SRT/Docker canary failed EPERM creating /tmp/sboxd symlink. Run npm --prefix pi run check on host. README and approved plan retained; git diff --check passed."}

Add installed-Pi integration coverage for `navigateTree` with both conversation-only navigation and Git checkpoint restoration. Use temporary repositories and isolated model-default storage. No live model credentials or changes to real runtime settings are required.

Exercise selecting a feedback user message, returning to an older candidate after a newer revision, and navigating back to the abandoned branch. With Keep current code, recovery creates a fresh candidate file only when content differs. With Restore checkpointed code, an exact matching file keeps its existing path. Include non-Git recovery and the case where no candidate exists at the destination.

Update the plan-mode README's candidate lifecycle, file-lineage, command, and restoration descriptions. State that explicit reopening issues a fresh token and that drift recovery preserves changed content. Explain the Git checkpoint boundary without changing checkpoint behavior. Retain this approved plan document with the implementing changes, as required by repository policy. Do not modify the runtime system prompt or unrelated in-progress work.

Run the focused regressions, the complete plan-mode package check, and the repository-required Pi gate. Review the final diff for scope, stale-token safety, and unintended settings writes. Acceptance requires all available checks to pass, with any native environment limitation reported explicitly rather than counted as a pass.

## Critical Files

- `pi/agent/extensions/plan-mode/index.ts` — command reopening, candidate submission, active-branch restoration, and durable display integration.
- `pi/agent/extensions/plan-mode/state.js` and `state.ts` — guard-independent approval transitions and candidate lifecycle constraints.
- `pi/agent/extensions/plan-mode/plan-store.js` — safe path allocation, exact-copy recovery, and strict write validation.
- `pi/agent/extensions/plan-mode/test/` — workflow, store, and installed-runtime branch-navigation regressions.
- `pi/agent/extensions/git-tree-checkpoints/index.ts` and `git-checkpoints.js` — read-only integration references for optional restoration and checkpoint scope.

## Verification

Regression checks must fail on current behavior before their corresponding fixes. Cover the missing pending approval after selecting a feedback message and `revision_drift` after restoring an older candidate.

Recovery checks must prove that the active branch's validated Markdown is the only source of reopened approval. Preserve newer or manually edited files byte-for-byte. Check matching-file reuse, missing-file recovery, collision-safe allocation, canonical progress evidence, and failure without partial workflow replacement.

Safety regressions must retain stale-token rejection, no approval before first presentation, guard independence, no automatic reopening during discussion, no duplicate dialogs after cancellation, and strict unsafe-path and symlink rejection. Existing fast optimization and execution-ledger drift checks must continue to pass.

Installed-runtime scenarios must navigate real entry IDs and confirm the resulting active branch. Run both checkpoint restoration and Keep current code. No implementation boundary can appear until the user selects an implementation action.

Run the complete plan-mode package check. Before completion, run `npm --prefix pi run check` from an ordinary host terminal, including deterministic checks and native SRT/Docker checks. Report any unavailable native check and its exact cause. The smoke success signal is immediate `/plan-actions` access after tree navigation, followed by successful revised submission without a reset or overwrite.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Reopen validated branch candidates through explicit actions
- ☑ Recover candidate files without overwriting changed content
- ⛔ Verify checkpoint integration and document recovery
<!-- pi-plan-mode:progress:end -->
