# Highlight Plan Revisions and Review Changes in Tuicr

## Context

The planning extension saves successive candidate revisions to the same `.pi/plans/` file before implementation handoff. Each successful presentation also stores the complete candidate in a durable `plan-mode-plan-display` session entry.

`plan-renderer.ts` currently repeats the entire plan without a change summary or change markers. Its heading says “Approved plan candidate” before approval occurs. Replace that misleading label with “Plan candidate”.

The existing tuicr reviewer uses `--file` for an isolated snapshot. This interface treats the whole document as added. Its custom theme therefore suppresses green addition backgrounds and hides line-number digits. This deliberate full-document styling cannot represent a revision diff.

The solution separates two reading tasks. Pi provides an editorial overview and the complete current candidate. Tuicr provides exact revision comparison and structured annotations. Approval remains a separate action.

Definitions for this feature:

- **Candidate revision:** one successfully saved and presented plan in a plan lineage.
- **Comparison baseline:** the immediately preceding candidate revision on the active conversation branch, within that lineage.
- **Authored plan:** canonical Markdown without extension-managed Ledger rows and the generated Part Progress report.
- **Change map:** a deterministic overview of changed sections and Parts, not a model-generated explanation of intent.

The root `CONTEXT.md` describes sandbox authority, not planning review. Keep these feature definitions in the planning extension documentation instead of expanding the sandbox glossary.

The installed tuicr is 0.27.0. Its documented CLI supports local working-tree diffs, persisted comment retrieval, and custom themes. It does not expose a documented arbitrary-patch input. A disposable Git repository provides a real old/new diff without touching project Git state.

Relevant references:

- [tuicr 0.27.0 CLI](https://raw.githubusercontent.com/agavra/tuicr/v0.27.0/docs/CLI.md) — local-diff entry points and scope constraints.
- [tuicr 0.27.0 configuration](https://raw.githubusercontent.com/agavra/tuicr/v0.27.0/docs/CONFIG.md) — unified layout, wrapping, whitespace comparison, and theme controls.
- [tuicr review CLI](https://raw.githubusercontent.com/agavra/tuicr/v0.27.0/docs/REVIEW_CLI.md) — structured comments with old/new sides and line ranges.
- [tuicr diff styling](https://raw.githubusercontent.com/agavra/tuicr/v0.27.0/src/ui/styles.rs) — separate ordinary and syntax-highlighted addition/deletion backgrounds.

Exact authored Markdown edits remain visible, including formatting changes. Managed progress does not count as an authored change. Custom word-level emphasis inside tuicr is not a requirement because support remains unverified. No competing Pi diff inspector will be built.

Existing unrelated workspace changes, including `pi/agent/AGENTS.md` and settings files, remain untouched. The runtime system prompt is outside this feature's scope.

## Questions & Answers

| Question | Answer |
|---|---|
| When a revised plan appears, which reading experience do you want? | Editorial + inspector: a compact change map above the complete plan, subtle change markers, and an exact comparison inspector. The user also asked whether tuicr can provide that review with proper diff colors. |
| What should “changed” mean after several feedback rounds: compared with which revision? | Compare with the immediately preceding successfully presented candidate in the same plan lineage. |
| Should the change view emphasize exact text edits or suppress cosmetic rewrite noise? | Readable + exact: compare authored Markdown precisely, exclude managed progress, and group changes by section. Do not silently suppress formatting edits. |
| Should tuicr replace the proposed custom Changes inspector, or sit alongside it? | Tuicr replaces the custom inspector. Keep the change map and marked full plan in Pi. Offer Review changes and Review full plan. |
| If you open the revision diff and quit without adding comments, what should Pi do? | Return to approval actions. Keep approval pending and do not start a model turn. Comments use the existing revision workflow. |
| What default layout should the tuicr revision review use for long plan prose? | Wrapped unified. The user explicitly requires visible diff colors, unlike the current reviewer. |

## Approach

Extend the existing presentation entries with optional comparison metadata. Derive comparisons from validated snapshots, never from the overwritten plan file or model-authored change claims. Keep the canonical plan format and `show_plan` parameters unchanged.

Use one deterministic comparison model for the change map and transcript markers. Tuicr reviews exact authored snapshots through an isolated local Git diff. Reuse the existing terminal handoff, comment parsing, and cleanup boundary.

### Part A — Preserve trustworthy revision comparisons
- **Ledger:** {"status":"completed","note":null,"evidence":"stripLedgerMutationsWithMap preserves line-to-line mappings for authored Markdown; baseline capture stores preceding candidate revision, hashes, and markdown in PlanDisplayEntry; deterministic Myers diff, fence-aware section parser, block parser, and revision comparison model implemented in plan-comparison.ts and verified by test/plan-comparison.test.mjs across first-candidate, identical, progress-only, missing baseline, and multi-section changes."}

Capture the preceding validated candidate before a successful same-lineage revision replaces it. Store bounded, unstyled baseline data with the new durable display entry, including its revision and hashes. Existing entries remain readable without schema migration.

Use `stripLedgerMutations()` as the authored-content boundary. Preserve source-line mappings when removing managed rows so review comments can retain accurate revision-specific anchors.

Resolve lineage through the existing candidate lifecycle. Discussion, ordinary feedback, and tuicr feedback retain the baseline relationship. A new candidate after implementation handoff starts without a comparison to the old plan. Fast optimizer revisions can show their actual structural changes but retain their existing automatic execution behavior.

Use the active session branch only. Reload, resume, and tree navigation must restore the same baseline. Legacy pending candidates can recover the preceding revision from matching branch display entries when available. Never select a sibling branch, an unrelated path, or a revision based only on its title.

Invalid submissions never advance the baseline. Missing or invalid historical evidence produces “Comparison unavailable”, not a guessed comparison. Identical authored content produces “No authored changes since revision N”. Progress-only differences receive the same result.

Build a bounded exact comparison grouped by canonical sections and Parts. Keep headings inside fenced code from becoming section boundaries. Report insertions, deletions, and changed regions honestly. Part renumbering and moves can appear as textual changes rather than inferred semantic moves.

Acceptance requires stable comparisons across repeated feedback, failed submissions, branch restoration, no-op presentations, and new-plan allocation. Diff computation must remain bounded at the existing 256 KiB plan limit.

### Part B — Make revised candidates readable in Pi
- **Ledger:** {"status":"completed","note":null,"evidence":"Replaced Approved plan candidate with Plan candidate across all states; implemented compact change map showing affected sections and Parts in document order with +X lines and -Y lines counts; implemented MarkedPlanComponent rendering gutter markers (+ for added in green, ~ for modified in amber, quiet spaces for unchanged) while preserving Markdown formatting, wrapping, Unicode, and width bounds (verified for 24, 35, 60, 100 widths in test/plan-renderer.test.mjs); verified cache invalidation on resize/theme."}

Replace “Approved plan candidate” with “Plan candidate”. Show the current revision and its explicit comparison baseline.

Add a compact change map before the complete current plan. List affected sections and Parts in document order. Use short labels and counts with defined units, such as added and removed source lines. Do not claim to explain why the model changed the plan.

Keep unchanged content visually quiet and readable. Use a green addition marker and an amber edit marker in a restrained gutter beside affected current blocks. Preserve Markdown formatting. Wrapped continuation lines must retain their marker without changing authored text.

Keep deleted content out of the current plan body. Surface deletion locations in the change map so deletion-only revisions remain obvious. Exact removed text stays available through Review changes.

Use active Pi theme colors rather than saved ANSI strings. Pair colors with textual markers so color is not the only signal. Preserve readable code blocks, tables, lists, Unicode, and narrow-width rendering. Cache comparison and layout work outside repeated paint operations.

First candidates show the complete plan without fabricated change statistics. Historical display entries without comparison metadata keep a plain full-plan rendering. Unavailable comparisons remain explicit.

Acceptance requires an immediately visible change overview and accurate current-block markers without losing any current candidate text. Narrow terminals and theme changes must not cause overflow or stale colors.

### Part C — Review real revision diffs in tuicr
- **Ledger:** {"status":"completed","note":null,"evidence":"Extended tuicr-plan-review.ts to support revision diff review target using disposable isolated Git repository with baseline committed and current authored in working tree; created tuicr-plan-diff-theme.toml with green addition/soft green background and red deletion/soft red background, readable line numbers, and distinct hunk headers; configured isolated tuicr for wrapped unified layout (diff_view = unified, wrap = true, ignore_whitespace = false); verified Git isolation, drift detection, and old/new comment normalization with source context in test/tuicr-plan-review.test.mjs."}

Extend the existing isolated reviewer to support a full-plan target and a revision-diff target. Keep its private HOME, configuration, data, cache, and state directories.

For revision review, create a disposable Git repository containing one Markdown file. Record the baseline as a local commit and write the current authored snapshot as its working-tree revision. Run tuicr on that local diff. No project commits, index changes, hooks, remotes, or worktrees are permitted.

Isolate Git setup from inherited repository selectors, signing, hooks, external diff commands, and global whitespace rules. Use explicit local identity and deterministic diff settings. Strip launcher-chain state from independent child commands. Require both snapshots to match their recorded identity before review starts.

Configure the disposable review for wrapped unified layout and exact whitespace comparison. Preserve personal keybindings and comment categories where compatible. Override presentation settings only in the disposable configuration, never in the user's permanent tuicr configuration.

Use a dedicated revision theme with green addition foregrounds and soft green backgrounds, red deletion foregrounds and soft red backgrounds, neutral context, readable line numbers, and distinct hunk headers. Set both ordinary diff backgrounds and syntax diff backgrounds so Markdown highlighting cannot erase diff meaning. Keep the full-plan theme neutral because its file-annotation mode still treats every line as added.

Preserve the existing terminal stop/start lifecycle and restart Pi even after process failures. Check the canonical plan, both review snapshots, and the baseline repository state for drift before accepting comments. Reject edits through `:edit` without consuming approval. Clean up the entire temporary review root on every exit path.

Continue compatibility checks, adding the interfaces required for local revision review. Missing Git, incompatible tuicr, preparation failures, and cleanup failures leave approval pending with a clear diagnostic. Full-plan review and Discuss remain available.

Acceptance requires a genuine modified-file diff with both old and new sides. Addition and deletion colors must remain visible with Markdown syntax highlighting. No operation can change the real project's Git state or the canonical plan.

### Part D — Integrate review actions and revision-aware feedback
- **Ledger:** {"status":"completed","note":null,"evidence":"Integrated Review changes and Review full plan in action-dialog.ts and index.ts; Review changes appears only when exact nonempty comparison is available; quitting without comments returns cleanly to approval dialog without consuming nonce or enqueuing turns; comments on deleted lines labeled [historical] with baseline canonical anchors and source context; verified in test/workflow-dialogs.test.mjs and test/tui-smoke.mjs; updated extension README with terminology, color semantics, and review lifecycle."}

Keep Implement plan first and preserve the existing implementation, fast, staged, and Discuss behavior. In TUI mode, label the existing annotation action Review full plan. Add Review changes when an exact nonempty comparison is available.

Review changes returns to approval actions after inspection without comments. This is a successful inspection, not an error or a revision request. It does not consume the nonce, increment review counters, start implementation, or enqueue a model turn.

When either review contains comments, use the existing structured feedback workflow. Retain comment order, exact content, IDs, advisory types, lifecycle state, line ranges, and old/new side. Attach baseline and current revision identity to revision feedback.

Map new-side anchors to the current canonical snapshot. Map old-side anchors to the baseline snapshot and label them as historical. Include anchored source context so deleted-line comments cannot be mistaken for comments on current text. Do not silently reinterpret an old line number as a current line number.

Retain the existing per-comment quotation and Resolution contract. The planner must reconcile every comment and resolve user-owned decisions before another `show_plan` call.

Recheck the active candidate and approval nonce after terminal handoff. Cancelled review, stale actions, malformed comments, drift, and cleanup failures never approve or execute a candidate. Existing full-plan empty-comment behavior remains unchanged unless shared result handling requires an equivalent neutral return.

RPC continues to omit terminal-only review actions. Print and JSON remain save-only. Compact plain-text comparison metadata can accompany the tool result, but no unsupported host dialog is introduced.

Update the extension README with the terminology, comparison baseline, two review actions, color semantics, empty-comment behavior, and recovery cases. Preserve existing guard/workflow independence. Include the extension-managed plan document with the implementation commit, as repository policy requires.

Acceptance requires correct action availability, unchanged approval defaults, neutral inspection returns, revision-aware old/new comment handling, and no model turn without comments.

## Critical Files

- `pi/agent/extensions/plan-mode/index.ts` — candidate presentation, branch restoration, approval actions, and structured review feedback.
- `pi/agent/extensions/plan-mode/plan-renderer.ts` — durable display shape, change map, and marked Markdown presentation.
- `pi/agent/extensions/plan-mode/action-dialog.ts` — review action labels and conditional availability.
- `pi/agent/extensions/plan-mode/tuicr-plan-review.ts` and its theme assets — isolated review targets, terminal lifecycle, comments, and diff colors.
- `pi/agent/extensions/plan-mode/ledger.js` and `plan-document.js` — read-only reference boundaries for authored content and canonical structure.
- `pi/agent/extensions/plan-mode/README.md` — user-facing lifecycle and review documentation.

## Verification

Regression checks preserve successful plan storage, atomic replacement, nonce protection, full-plan review isolation, feedback ordering, fast optimization, execution handoff, and guard independence.

New comparison scenarios cover the first candidate, several feedback rounds, rejected submissions between valid revisions, unchanged authored content, progress-only differences, missing baselines, restored legacy entries, branch forks, new paths after execution, and optimizer revisions.

Renderer checks cover insertion-only, deletion-only, mixed edits, renamed headings, Part renumbering, tables, lists, fenced code, Unicode, long paths, narrow widths, resize, and theme changes. Every rendered line must fit its available width. The current candidate remains complete.

Tuicr checks cover isolated Git preparation, inherited Git settings, exact whitespace comparison, real old/new sides, range comments on deleted text, mapped current anchors, empty inspection returns, stale approval, snapshot edits, canonical drift, malformed sessions, missing dependencies, process failure, and cleanup failure.

Run the extension's complete package check. Then run `npm --prefix pi run check` from an ordinary host terminal, as `pi/AGENTS.md` requires. Deploy only through `./install.sh config`, preserving unrelated changes.

Perform a real interactive canary with one added paragraph, one edited paragraph, and one deleted paragraph. The transcript must identify all three. Review changes must show green additions and red deletions with readable neutral context. Quit without comments and confirm that approval actions return. Add one old-side comment and confirm that the planner receives its baseline anchor and source text.

Record project Git status and canonical plan hashes before and after the canary. Unexpected project Git changes, hidden deletion-only edits, wrong-side anchors, invisible diff colors, or automatic execution are failure signals. Deterministic tests alone do not establish visual quality. If a real terminal canary cannot run, report that limitation explicitly.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Preserve trustworthy revision comparisons
- ☑ Make revised candidates readable in Pi
- ☑ Review real revision diffs in tuicr
- ☑ Integrate review actions and revision-aware feedback
<!-- pi-plan-mode:progress:end -->
