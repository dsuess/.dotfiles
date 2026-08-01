# Perfect Pi Planning Mode

A global Pi extension for read-oriented planning, explicit approval, clean implementation handoff, and a persistent task ledger.

## Commands and entry points

- `/plan [goal]` — enter planning mode and optionally start a planning turn.
- `/plan off` — leave planning/approval and restore the exact pre-planning tool snapshot (minus tools no longer registered).
- `--plan` — start a session in planning mode.
- `Ctrl+Alt+P` — toggle planning mode.
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

Required Markdown is organized around intent and work, not execution phases:

1. One H1 title.
2. `## Why` for the problem, evidence, motivation, and outcome.
3. `## What` for the solution summary and globally numbered `### Step N [status] Title` entries.
4. Each step has `Targets` and `Tools / APIs` metadata plus its concrete changes, dependencies, verification, edge cases, and guardrails.
5. A final `## Stages` table with `Stage | Description | Steps`, mapping every step to exactly one stage.

There are no per-stage detail sections or other H2 sections. Statuses are `pending`, `in_progress`, `completed`, and `blocked`. Legacy stage-grouped plans remain readable so active older execution sessions can finish.

## Approval actions

The complete saved plan is rendered as a durable transcript block, then the action dialog opens directly after the planning turn settles without injecting a `/plan-actions` user message. The dialog offers:

- **Implement plan** — execute all stages without ordinary stage pauses.
- **Implement in stages** — hard pause after every stage.
- **Change** — send exact free-form revision feedback while remaining gated.
- **Review** — edit the actual plan in the configured external editor (or Pi editor fallback).

Escape leaves approval pending. Nonces reject stale queued commands and older revisions.

Review annotations use a leading `!` for directives and `?` for blocking questions. Fenced-code and inline-code examples are ignored. The planner must acknowledge parsed feedback, resolve every question, reconcile conflicts, strip markers, and only then resubmit. External-editor failures restore the last validated plan.

## Execution and ledger

Run actions create a fresh child session. No planning user/assistant messages are copied. The new session receives normal project instructions, a non-context execution contract, the complete approved plan, and one kickoff user message.

The original active tools are restored by registered-name intersection, with execution-only tools added:

- `plan_progress` — legal one-task status transitions with notes/evidence.
- `complete_plan` — terminal whole-plan validation.
- `complete_stage` — current-stage validation and mandatory checkpoint.

Ledger writes are serialized through Pi's file mutation queue and atomically update only a step status plus its `Ledger` line. Any other plan-content drift stops the update. The progress widget groups those steps into described stage rows and uses emoji status indicators. Parallel workers report to the parent implementation agent; the parent is the only ledger writer.

Staged checkpoints offer Continue, feedback/fixes, summary review, and Stop. Feedback explicitly reopens affected tasks. Stop remains resumable in the same implementation session. Worker run/session IDs are retained in state for dependent later work.

## Lifecycle and host behavior

- Reload, resume, and tree navigation restore state from the latest custom entry on the active branch.
- Pending dialogs are queued at most once; cancelled dialogs remain manually reopenable.
- TUI mode uses full renderers and structured dialogs.
- RPC uses host select/editor primitives.
- Print/JSON validates and saves plans but cannot approve or auto-run.
- Plan writes are read-back verified. If a validated plan file disappears, approval/review restores it from the matching durable transcript entry before continuing.
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
