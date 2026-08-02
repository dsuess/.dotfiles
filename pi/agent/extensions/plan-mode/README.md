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

Current Markdown is high-level and outcome-oriented:

1. One H1 title.
2. Required `## Background` explains the request, motivation, and place in the wider repository.
3. Required `## Changes` summarizes the proposal and contains globally numbered `### Step N [status] Title` work items.
4. Optional `## Breaking Changes`, `## Testing Plan`, and `## Assumptions / Decisions` sections are included only when applicable and non-empty.
5. Optional `## Stages` uses a `Stage | Description | Steps` table for larger changes, grouping every step exactly once and identifying ordering or parallel work.

Plans deliberately omit target-file and tool/API inventories. Step bodies retain enough behavioral detail, constraints, dependencies, outcomes, edge cases, and guardrails to execute without becoming implementation recipes. Small plans omit `Stages`; the runtime gives them one implicit execution group so the ledger and approval flow remain consistent. Statuses are `pending`, `in_progress`, `completed`, and `blocked`. A clearly delimited, extension-managed `Step Progress` report is generated at the end of each saved plan and regenerated from the ledger; it is not user-authored plan content. Version 1 stage-grouped and version 2 `Why`/`What` plans remain readable so active older execution sessions can finish.

## Approval actions

The complete saved plan is rendered as a durable transcript block, then the action dialog opens directly after the planning turn settles without injecting a `/plan-actions` user message. The dialog offers:

- **Implement plan** — execute all stages without ordinary stage pauses.
- **Implement in stages** — hard pause after every stage.
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

Ledger writes are serialized through Pi's file mutation queue and atomically update a Step heading, its `Ledger` line, and the trailing generated report. Any other plan-content drift stops the update. The live widget and saved report both list every Step in plan order with the same status icon and title-only label. Optional Stages remain execution-order and checkpoint groups only; they do not become progress rows. Parallel workers report to the parent implementation agent; the parent is the only ledger writer.

Staged checkpoints offer Continue, feedback/fixes, summary review, and Stop. Feedback explicitly reopens affected tasks. Stop remains resumable in the same implementation session. Worker run/session IDs are retained in state for dependent later work.

## Lifecycle and host behavior

- Reload, resume, and tree navigation restore workflow state and the execution contract matching the active run on the current branch. In-place execution remains in the same session history; older child-session executions continue in their existing session files.
- After an agent turn settles—or immediately after restoring an idle branch—any unconsumed approval or mandatory checkpoint whose persisted `presented` flag is false opens through the current TUI or RPC context, regardless of whether planning began by command, flag, shortcut, or palette.
- A decision is marked presented before the extension awaits input, preventing duplicate dialogs. Escape leaves it pending, and `/plan-actions` or `/plan-stage-actions` reopens it manually.
- TUI mode uses full renderers and structured dialogs. During planning and approval, the global rich statusbar changes only its CWD segment to Catppuccin peach and right-aligns a dark-gray `[PLANNING]` marker.
- RPC uses host select/editor primitives.
- Print/JSON validates and saves plans but cannot approve or auto-run.
- Plan writes are read-back verified. If a validated plan file disappears, approval/review restores it from the matching durable transcript entry before continuing. Resumed older executions reconstruct missing Step titles and backfill a missing generated report from the durable approved plan and ledger.
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
