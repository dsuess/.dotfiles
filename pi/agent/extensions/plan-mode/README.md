# Perfect Pi Planning Mode

A global Pi extension for read-oriented planning, explicit approval, clean implementation handoff, and a persistent task ledger.

## Commands and entry points

- `/plan [goal]` — enter planning mode and optionally start a planning turn.
- `/plan off` — leave planning/approval and restore the exact pre-planning tool snapshot (minus tools no longer registered).
- `--plan` — start a session in planning mode.
- `Shift+Tab` — toggle planning mode.
- Command palette **Plan** row — toggle planning mode directly without enqueueing `/plan` or starting an agent turn.
- `/plan-actions` — reopen actions for the pending plan.
- `/plan-stage-actions` — reopen the active staged checkpoint.
- `/plan-resume` — resume a paused implementation session.

State transitions are persisted as non-context custom session entries:

`off → planning → approval → executing_all | executing_staged → completed | blocked`

## Planning gate

Planning and approval expose only registered inspection/research/question tools plus `submit_plan`. Unknown custom tools and implementation workflow tools are hidden. Direct mutation tools are blocked again at `tool_call` as defense in depth.

Bash and user `!`/`!!` commands use a **known-mutator denylist**. Redirects and recognized filesystem, Git, package-manager, process/service, archive, download, and editor mutations are rejected, including common wrappers, chains, substitutions, and nested `sh -c` forms. Unclassified commands are deliberately allowed. This is fail-open and is not a security boundary.

The per-turn planner prompt adapts `grill-with-docs` to read-only planning: terminology and ADR/CONTEXT decisions become plan tasks rather than inline writes. It also overrides the skill's one-question-at-a-time cadence unless explicitly requested, collecting blockers while useful investigation remains and then asking them together in one batch.

## Plan files and schema

Validated plans are saved under:

`<project>/.pi/plans/<intent-slug>.md`

The model never supplies an output path. Slugs are bounded kebab-case; unrelated collisions use `-2` through a maximum of 100 probes. Writes validate containment and symlinks, enforce a 256 KiB plan limit, use a same-directory temporary file and atomic replacement, and retain the last validated revision on failure.

Newly authored Markdown uses document version 4:

1. One concise, action-oriented H1 title.
2. Required `## Context` explains current behavior, motivation, architectural fit, relevant research, terminology conflicts, assumptions, confirmed decisions, and accepted risks when they matter.
3. Required `## Approach` explains the solution before one or more ordered `### Part A — Action-oriented title` work items. IDs continue alphabetically without gaps; headings never contain an author-written status.
4. Optional `## Critical Files` maps only important modification boundaries and read-only references, with each entry's responsibility stated.
5. Optional `## Verification` distinguishes regression checks from new-feature scenarios and records observable smoke/canary, success, and failure signals. It is required by the authoring guidance whenever the result can be meaningfully checked; explanatory or investigative plans may omit it when no meaningful verification exists.

Each Part describes one coherent behavior boundary: dependencies, scope, edge cases, guardrails, rationale, and acceptance outcomes. A Part is also one ledger item and one derived execution stage, so staged execution pauses after every Part while full execution advances through Parts in order without ordinary pauses.

Concrete anchors such as paths, symbols, flags, external interfaces, and data shapes are welcome when research established a constraint or they materially reduce ambiguity. They should be selective and rationale-driven. `Critical Files` is not an exhaustive inventory, and plans still reject mandatory target/tool metadata, exhaustive file lists, and tool-call recipes.

New Parts initialize `pending`. Runtime statuses are `pending`, `in_progress`, `completed`, and `blocked`, persisted only in extension-managed `Ledger` metadata. A delimited `Part Progress` report is generated from that metadata without changing approved Part headings or authored content. Document versions 1–3—including status-bearing Step headings, explicit stage mappings, and `Step Progress` reports—remain readable, renderable, recoverable, and executable without destructive migration.

Representative behavior-changing plan:

```markdown
# Add Reliable Cache Invalidation

## Context

Successful writes can leave stale cache entries. Research confirmed that `src/cache.ts` owns expiry keys; this anchor matters because invalidation must use the same identity.

## Approach

Make invalidation part of the existing cache lifecycle without changing the public interface.

### Part A — Define cache consistency

Establish successful-write, failed-write, expiry, and idempotency outcomes. This Part is accepted when every write outcome has one unambiguous cache result.

### Part B — Implement reliable invalidation

Invalidate after successful writes, preserve valid values after failures, and stop if expiry and invalidation cannot share key identity.

## Critical Files

- `src/cache.ts` — modification boundary that owns expiry and invalidation.
- `docs/cache-lifecycle.md` — read-only terminology reference.

## Verification

Regression checks preserve failed-write values and the public interface. New-feature scenarios cover successful writes, misses, and expiry races. Fresh data after a successful write is the smoke and success signal; any stale read or key mismatch is the assumption-failure signal.
```

A documentation-only or investigative plan uses the same `Context` and `Approach` shape but may omit both optional sections when no file map or meaningful verification applies.

## Approval actions

The complete saved plan is rendered as a durable transcript block, then the action dialog opens directly after the planning turn settles without injecting a `/plan-actions` user message. The dialog offers:

- **Implement plan** — execute all stages without ordinary stage pauses.
- **Implement in stages** — hard pause after every derived stage (one Part per stage for version 4).
- **Change** — send exact free-form revision feedback while remaining gated.
- **Review** — edit the actual plan in the configured external editor (or Pi editor fallback).

Escape leaves approval pending. Nonces reject stale queued commands and older revisions.

Review annotations use a leading `!` for directives and `?` for blocking questions. Fenced-code and inline-code examples are ignored. The planner must acknowledge parsed feedback, resolve every question, reconcile conflicts, strip markers, and only then resubmit. External-editor failures restore the last validated plan.

## Execution and ledger

Run actions continue in the current visible session; they do not create a child session or parent-session link. The extension persists a versioned, run-scoped execution contract and inserts one hidden execution-boundary message containing the complete approved plan and execution rules. The visible transcript keeps the planning discussion for reference, while model context starts at the matching boundary, so implementation receives normal project instructions plus only the approved contract and messages sent afterward.

If an in-place execution state is restored without its matching boundary marker, context fails closed to a boundary reconstructed from the persisted approved contract rather than exposing the planning conversation. Run IDs distinguish the active execution from older contracts on the same session branch. Version 1 contracts from already-running fresh child sessions remain readable and retain their original context behavior.

The original active tools are restored by registered-name intersection, with execution-only tools added:

- `plan_progress` — legal one-task status transitions with notes/evidence.
- `complete_plan` — terminal whole-plan validation.
- `complete_stage` — current-stage validation and mandatory checkpoint.

Ledger writes are serialized through Pi's file mutation queue. For version 4 they atomically update only a Part's managed `Ledger` line and the trailing generated report; the approved Part heading and authored body remain immutable. Legacy plans retain their status-bearing heading behavior. Any other plan-content drift stops the update. The live widget and saved report list every plan item in document order with the same status icon and title-only label. Derived stages govern order and checkpoints but do not add duplicate progress rows. Parallel workers report to the parent implementation agent; the parent is the only ledger writer.

Staged checkpoints offer Continue, feedback/fixes, summary review, and Stop. Feedback explicitly reopens affected plan items. Stop remains resumable in the same implementation session. Worker run/session IDs are retained in state for dependent later work.

## Lifecycle and host behavior

- Reload, resume, and tree navigation restore workflow state and the execution contract matching the active run on the current branch. In-place execution remains in the same session history; older child-session executions continue in their existing session files.
- After an agent turn settles—or immediately after restoring an idle branch—any unconsumed approval or mandatory checkpoint whose persisted `presented` flag is false opens through the current TUI or RPC context, regardless of whether planning began by command, flag, shortcut, or palette.
- A decision is marked presented before the extension awaits input, preventing duplicate dialogs. Escape leaves it pending, and `/plan-actions` or `/plan-stage-actions` reopens it manually.
- TUI mode uses full renderers and structured dialogs. During planning and approval, the global rich statusbar changes only its CWD segment to Catppuccin peach and right-aligns a dark-gray `[PLANNING]` marker.
- RPC uses host select/editor primitives.
- Print/JSON validates and saves plans but cannot approve or auto-run.
- Plan writes are read-back verified. If a validated plan file disappears, approval/review restores it from the matching durable transcript entry before continuing. Resumed executions reconstruct missing plan-item titles and backfill the version-appropriate Part or Step report from the durable approved plan and ledger.
- Plan files are durable and are never deleted on shutdown.
- `.pi/plans/` is not automatically ignored or committed; each project owns that policy.

## Security boundary

There are three distinct layers:

1. **Workflow gate:** hides model mutation tools and rejects known shell mutations during planning.
2. **Trusted writes:** this extension and the user's editor may write the active plan/ledger only.
3. **Whole-process sandbox:** the separate Pi sandbox policy constrains Pi and descendants at the OS level.

Because unknown Bash commands are allowed, planning mode cannot promise that the workspace is absolutely read-only. Treat the extension as workflow enforcement; treat the OS sandbox as the security boundary.

## Development

```bash
cd pi/agent/extensions/plan-mode
npm run check
```

Deployment must use GNU Stow through `./install.sh config`; do not create manual symlinks.
