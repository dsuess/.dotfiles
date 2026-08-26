# Consolidate Pi Planning Around One Canonical Contract

## Context

Pi planning currently accepts several historical Markdown formats. The parser, renderer, ledger, progress widget, execution handoff, tests, and README contain branches for these formats.

The active planner uses the Part-based format with `Context`, optional answered questions, `Approach`, optional parallel scheduling, optional critical files, and optional verification. However, planner and optimizer messages call this format by a numeric label. Fast approval also checks that label before it accepts a plan.

The repository documentation promises compatibility with older Step-based and stage-grouped plans. The code agrees with that promise through separate parsers, renderers, progress headings, ledger mutations, fixtures, and execution-contract branches. This conflicts with the user's decision to maintain one plan contract without an explicit numeric identity.

Remove compatibility for older plan documents and their execution instructions. Older saved plans will remain historical files, but the extension will no longer parse, render, revise, or execute them. If an older active execution cannot match the canonical in-place contract, restoration must stop safely with a clear error. This loss of active-session compatibility is an accepted result of the user's decision.

No glossary or ADR is needed. The canonical terms already exist: **plan**, **Part**, **execution stage**, and **Parallel Execution**. The README is the correct place for this reversible workflow rule.

The working tree contains unrelated and in-progress fast-optimizer changes in `index.ts`, `prompts.ts`, the README, and tests. Implementation must preserve and integrate those edits. It must not overwrite the existing plan artifacts or the unrelated `AGENTS.md` change. The installed Pi documentation path is unavailable inside the planning filesystem, so this plan uses the complete local extension README, code, tests, and introducing commits.

## Approach

Make the Part-based contract the only accepted document shape. Remove numeric plan identities and all format-selection branches. Then align ledger updates, execution handoff, documentation, fixtures, and restoration behavior with that one contract.

### Part A — Collapse document handling to one contract
- **Ledger:** {"status":"completed","note":"Collapsed plan-document.js to the canonical Context/Approach/Part parser and renderer; removed historical parsers, renderers, numeric identity, and Step progress reporting.","evidence":"node --check pi/agent/extensions/plan-mode/plan-document.js; canonical parser smoke confirms round-trip, Part Progress report, rejection of Background, and no document.version."}

Refactor `pi/agent/extensions/plan-mode/plan-document.js` around the existing Part-based parser and renderer. Remove the document format constant, the parsed `document.version` field, historical section detectors, historical parsers, historical renderers, and format-dependent validation messages.

Keep the current H1, ordered H2 sections, Part identities, answered-question table, parallel schedule, selective anchors, size limit, and managed-metadata guards. Parse the canonical structure directly. A document with `Background` and `Changes`, `Why` and `What`, or stage-grouped task headings must fail normal canonical validation. The parser must not guess or migrate it.

Use only `## Part Progress` for the managed trailing report. Remove Step progress headings, format inference, and rendering options that exist only for older documents. Preserve strict marker, placement, row, and size validation.

Acceptance requires one parser, one renderer, one managed report shape, and no numeric plan identity in the returned document model or validation text.

### Part B — Align progress and execution with canonical Parts
- **Ledger:** {"status":"completed","note":"Aligned ledger, widget, state, fast eligibility, execution contract, prompts, and restoration around Parts and the in-place contract; unsupported executing restores now fail closed.","evidence":"node --check for modified JS modules; canonical ledger/execution smoke verifies Part-only ledger persistence, Part Progress, canonical run restoration, and rejection of a historical contract; git diff --check passes."}

Simplify `ledger.js` and `progress-widget.js` to use stable Part headings and extension-owned Ledger rows only. Remove Step-heading status mutation, target/tool metadata anchors, historical task projections, and compatibility aliases. Ledger updates must continue to reject authored-content drift and regenerate one Part report atomically.

Update the planning and fast-optimization workflow to check canonical structure instead of a numeric identity. Standard execution must derive one ordered stage from each Part. Fast execution must derive its order from the validated `Parallel Execution` schedule. Remove state fields and conditionals that exist only to distinguish historical plan staging from canonical Part staging.

Retain only the current in-place execution contract. Remove the fresh-child compatibility contract and all “legacy work item” or “Part-based plan” branches from execution prompts, tool descriptions, restoration, and context isolation. The retained contract and boundary metadata must identify a run by its stable run ID, plan path, plan hash, and boundary hash without a numeric plan-contract discriminator.

If restoration finds an executing workflow without a matching canonical contract and boundary, fail closed. Do not expose planning history or continue an older plan implicitly. Current execution restoration, post-compaction tail retention, staged checkpoints, fast workers, and missing-plan recovery must continue to work.

Acceptance requires all model-visible planning and execution instructions to describe one Part contract without numbered labels or historical alternatives.

### Part C — Replace compatibility coverage and document the invariant
- **Ledger:** {"status":"completed","note":"Replaced compatibility fixtures and coverage with canonical Part cases; documented the single contract and unsupported-restore behavior.","evidence":"50 focused parser/store/ledger/progress/state/execution-helper tests pass. Full plan-mode check and sandbox suite were attempted but cannot load Pi's missing Jiti runtime at the hardcoded /opt/homebrew path; install deployment was attempted and stopped because qemu-system-aarch64 is unavailable."}

Replace historical fixtures and tests with canonical Part plans. Rewrite parser, store, ledger, progress, restore, workflow-dialog, and execution-helper tests so each test exercises the single contract. Delete tests whose only purpose is compatibility with removed formats.

Add focused rejection coverage for representative older headings and task shapes. Add restoration coverage that proves an unsupported execution stops safely while a current in-place execution restores. Keep the in-progress fast-optimizer diagnostics and conservative fallback tests intact.

Rewrite the plan schema and execution sections of `pi/agent/extensions/plan-mode/README.md` in concise language. Describe the canonical contract directly. Remove numbered format labels, compatibility promises, Step reports, historical execution contracts, and conditional wording about Part-based plans. Update planner and optimizer prompts, notifications, and errors to use the same terms.

Retain the submitted `.pi/plans/...` document with the implementation commit, as required by the repository workflow. Do not rewrite historical plan files merely because they record earlier work.

Acceptance requires active code, prompts, tests, and authoritative README text to state one consistent invariant: Pi authors, validates, stores, restores, and executes one canonical Part plan contract.

## Critical Files

- `pi/agent/extensions/plan-mode/plan-document.js` — owns the canonical Markdown parser, renderer, parallel schedule, and managed report.
- `pi/agent/extensions/plan-mode/ledger.js` and `progress-widget.js` — own immutable-content checks and the Part status projection.
- `pi/agent/extensions/plan-mode/index.ts`, `execution.ts`, and `execution-helpers.js` — own submission eligibility, execution contracts, restoration, and model-visible execution instructions.
- `pi/agent/extensions/plan-mode/README.md` and `test/` — define the public workflow and its regression contract.

## Verification

**New contract checks**

- Parse and round-trip minimal, answered-question, full, and parallel canonical plans.
- Reject each removed heading family and status-bearing Step or task shape as invalid canonical Markdown.
- Make sure that parser results and managed reports contain no numeric plan identity.
- Restore a current execution by run and boundary identity. Stop an unsupported execution without exposing planning context.
- Scan active plan-mode prompts, errors, README text, and tests for numbered plan labels and historical plan instructions.

**Regression checks**

- Exercise Questions & Answers ordering, Part identities beyond `Z`, parallel ownership and dependency validation, fast source equivalence, immutable ledger updates, missing-plan recovery, and post-compaction context isolation.
- Preserve the existing uncommitted fast-revision diagnostic behavior and its retry lifecycle.
- Run `npm --prefix pi/agent/extensions/plan-mode run check`.
- Run the final Pi sandbox test suite required by `pi/AGENTS.md`.
- Review `git diff`, run `git diff --check`, and make sure that unrelated working-tree changes remain intact.
- Deploy only through `./install.sh config`. Success means future planning and execution messages describe one unnumbered Part contract, with no fallback parser or instruction path for older plans.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Collapse document handling to one contract
- ☑ Align progress and execution with canonical Parts
- ☑ Replace compatibility coverage and document the invariant
<!-- pi-plan-mode:progress:end -->
