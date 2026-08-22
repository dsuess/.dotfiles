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

## Model profiles

Plan mode has two independent global defaults in `~/.pi/agent/settings.json`: native `defaultProvider`/`defaultModel` for implementation, and extension-owned `defaultThinkingProvider`/`defaultThinkingModel` for planning. A new branch initializes its planning and inference profiles from those pairs. `defaultThinkingLevel` remains one shared reasoning-level default; it is not a planning-model setting.

After initialization, planning and inference profiles are branch-local. Resuming a session or navigating its tree restores the saved branch profile rather than adopting a later global edit. Handoff to implementation and `/plan off` switch to the inference profile, while a later planning entry restores the saved planning profile. An explicit CLI `--model` remains higher priority than both defaults.

A `/model` choice or Ctrl+P cycle persists only the active mode's global pair and branch profile: planning/approval changes `defaultThinkingProvider`/`defaultThinkingModel`; implementation changes `defaultProvider`/`defaultModel`. Workflow-driven Sol↔Terra switches never change either durable default. Missing models, credentials, malformed settings, or settings-write failures leave the active model or durable defaults unchanged as applicable and show a warning rather than blocking the workflow.

## Planning gate

Planning and approval expose only registered inspection/research/question tools plus `submit_plan`. Unknown custom tools and implementation workflow tools are hidden. Direct mutation tools are blocked again at `tool_call` as defense in depth.

Bash and user `!`/`!!` commands use a **known-mutator denylist**. Redirects and recognized filesystem, Git, package-manager, process/service, archive, download, and editor mutations are rejected, including common wrappers, chains, substitutions, and nested `sh -c` forms. Unclassified commands are deliberately allowed. This is fail-open and is not a security boundary.

The per-turn planner prompt adapts `grill-with-docs` to read-only planning: terminology and ADR/CONTEXT decisions become plan tasks rather than inline writes. It also overrides the skill's one-question-at-a-time cadence unless explicitly requested, collecting blockers while useful investigation remains and then asking them together in one batch.

## Plan files and schema

Validated plans are saved under:

`<project>/.pi/plans/YYYYMMDD_<intent-slug>.md`

`YYYYMMDD` is the local calendar date when a new target is first allocated; revisions retain their recorded path. The model never supplies an output path. Slugs are bounded kebab-case; unrelated collisions use `-2` through a maximum of 100 probes. Writes validate containment and symlinks, enforce a 256 KiB plan limit, use a same-directory temporary file and atomic replacement, and retain the last validated revision on failure.

Newly authored Markdown uses document version 4:

1. One concise, action-oriented H1 title.
2. Required `## Context` explains current behavior, motivation, architectural fit, relevant research, terminology conflicts, assumptions, confirmed decisions, and accepted risks when they matter.
3. Optional `## Questions & Answers` follows `Context` and precedes `Approach`. Include it only for user clarifications that have answers. It contains one table with this exact shape:

   ```markdown
   | Question | Answer |
   |---|---|
   | Does this change the public interface? | No. Keep the existing interface. |
   ```

   Add one non-empty row for each answered clarification. Record the question and answer so they preserve the decision. Do not add unresolved questions. Do not invent entries or add a placeholder when no questions were asked.
4. Required `## Approach` explains the solution before one or more ordered `### Part A — Action-oriented title` work items. IDs continue alphabetically without gaps; headings never contain an author-written status.
5. Optional `## Parallel Execution` follows `Approach` and precedes `Critical Files`. Normal plans omit this section. A fast revision contains one strict table:

   ```markdown
   | Wave | Worker | Part | Source Part | Depends On | Ownership |
   |---|---|---|---|---|---|
   | 1 | worker-a | A | A | — | parser boundary |
   ```

   Each optimized Part has one row and one worker. Waves start at 1 and have no gaps. A dependency names a Part in an earlier wave. Ownership names an exclusive mutation boundary.
6. Optional `## Critical Files` maps only important modification boundaries and read-only references, with each entry's responsibility stated.
7. Optional `## Verification` distinguishes regression checks from new-feature scenarios and records observable smoke/canary, success, and failure signals. It is required by the authoring guidance whenever the result can be meaningfully checked; explanatory or investigative plans may omit it when no meaningful verification exists.

Each Part describes one coherent behavior boundary: dependencies, scope, edge cases, guardrails, rationale, and acceptance outcomes. A Part is also one ledger item and one derived execution stage, so staged execution pauses after every Part while full execution advances through Parts in order without ordinary pauses.

Concrete anchors such as paths, symbols, flags, external interfaces, and data shapes are welcome when research established a constraint or they materially reduce ambiguity. They should be selective and rationale-driven. `Critical Files` is not an exhaustive inventory, and plans still reject mandatory target/tool metadata, exhaustive file lists, and tool-call recipes.

New Parts initialize `pending`. Runtime statuses are `pending`, `in_progress`, `completed`, and `blocked`, persisted only in extension-managed `Ledger` metadata. A delimited `Part Progress` report is generated from that metadata without changing approved Part headings or authored content. Document versions 1–3—including status-bearing Step headings, explicit stage mappings, and `Step Progress` reports—remain readable, renderable, recoverable, and executable without destructive migration.

Representative behavior-changing plan:

```markdown
# Add Reliable Cache Invalidation

## Context

Successful writes can leave stale cache entries. Research confirmed that `src/cache.ts` owns expiry keys; this anchor matters because invalidation must use the same identity.

## Questions & Answers

| Question | Answer |
|---|---|
| Must the public cache interface change? | No. Preserve compatibility. |

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
- **Implement (fast)** — create a source-equivalent parallel revision, then start it without another approval dialog.
- **Implement in stages** — hard pause after every derived stage (one Part per stage for version 4).
- **Change** — send exact free-form revision feedback while remaining gated.
- **Review** — suspend Pi and open the validated plan revision as an isolated single-file tuicr review in the same terminal.

**Implement plan** remains first and is the default action. Escape leaves approval pending. Nonces reject stale queued commands and older revisions.

The fast action reads and hash-checks the approved source before it starts. It requires a version-4 Part plan and `subagent` in the original tool snapshot. The optimizer uses the planning profile and cannot ask questions. It can inspect the repository, split a source Part, and add the schedule. It cannot change approved scope or combine source Parts.

Before the extension writes a fast revision, it compares the title, Context, answers, Approach preamble, Critical Files, and Verification. For each source Part, mapped Part bodies must join to the same normalized text. The source Part order stays unchanged. If the optimizer stops, fails validation, or reaches its retry limit, the extension restores the original unconsumed approval. It never executes the source plan on this failure path.

Review is available only in interactive TUI mode; RPC omits it, and print/JSON cannot prompt. Pi verifies tuicr's required `--file`, `--theme`, and `review` CLI interfaces, gives each round private data/cache/state storage, and copies the user's normal tuicr configuration into that isolated round. Plan review installs a Catppuccin Mocha theme and compact Markdown syntax theme in that private configuration. Because tuicr models file annotation as an all-added diff, addition backgrounds remain on the Mocha base instead of tinting the full plan green. Its dim foreground also matches the base to visually hide tuicr's unavoidable line-number digits; the empty gutter remains, and other dim text can be hidden in this disposable review session. The snapshot matches the validated revision, while the canonical `.pi/plans/...` file remains under `submit_plan` ownership. Editing the snapshot with `:edit`, ambiguous persisted sessions, malformed output, process failure, cleanup failure, or missing/empty comments rejects the round without consuming approval or incrementing review counters. `/plan-actions` can retry, and **Change** is the supported fallback.

Saved review-, file-, line-, and range-level comments are returned as one structured planner turn with stable IDs, anchors, side, lifecycle state, content, and optional advisory types. Types do not create a directive/question protocol. The planner acknowledges and reconciles every comment against repository evidence, inventories and explicitly answers every user question—including natural-language interrogatives and requests for a choice—by anchor or ID, and states whether each answer changes the plan. An answer is grounded in repository evidence, a stated assumption, or a user decision; an answerable question is never silently folded into plan text. Any user-owned decision that remains open is batched through the normal clarification workflow, keeps planning active, and blocks `submit_plan` until the complete discussion closes. Once every question has an explicit answer or agreed resolution, the planner resubmits one complete canonical revision through `submit_plan` without implementing. Applicable user decisions are recorded in the plan's `Questions & Answers` section; the immutable canonical-plan boundary remains unchanged.

## Execution and ledger

Run actions continue in the current visible session; they do not create a child session or parent-session link. The extension persists a versioned, run-scoped execution contract and inserts one hidden execution-boundary message containing the complete approved plan and execution rules. The visible transcript keeps the planning discussion for reference, while model context starts at the matching boundary, so implementation receives normal project instructions plus only the approved contract and messages sent afterward.

If an in-place execution state is restored without its matching boundary marker, context fails closed to a boundary reconstructed from the persisted approved contract rather than exposing the planning conversation. After compaction, the extension excludes the mixed compaction summary and retains every message after the newest summary, so the reconstructed boundary is followed by the retained execution tail. Without a matching boundary or compaction summary, it keeps only the reconstructed boundary. Run IDs distinguish the active execution from older contracts on the same session branch. Version 1 contracts from already-running fresh child sessions remain readable and retain their original context behavior.

To recover an affected existing session, first stop the loop. Deploy the extension, then use `/reload` or restart Pi. The extension restores the persisted workflow state and continues without editing or deleting the session JSONL file.

The original active tools are restored by registered-name intersection, with execution-only tools added:

- `plan_progress` — legal one-task status transitions with notes/evidence.
- `complete_plan` — terminal whole-plan validation.
- `complete_stage` — current-stage validation and mandatory checkpoint.

Ledger writes are serialized through Pi's file mutation queue. For version 4 they atomically update only a Part's managed `Ledger` line and the trailing generated report. The approved Part heading and authored body remain immutable. Legacy plans retain their status-bearing heading behavior. Any other plan-content drift stops the update. The live widget and saved report list every plan item in document order with the same status icon and title-only label. Derived stages govern order and checkpoints but do not add duplicate progress rows. Parallel workers report to the parent implementation agent. The parent is the only ledger writer.

A fast run stays in `executing_all`. Its schedule controls the derived stages. The parent starts every ready Part in a wave. Then it sends one sibling `subagent` call for each Part. Each worker receives its Part, ownership boundary, approved context, acceptance outcomes, and predecessor evidence. Workers use the persisted inference model at high thinking. The parent waits for every worker, records terminal evidence, checks integration, and then starts the next wave. A later wave cannot start before every earlier-wave Part and declared dependency is terminal.

Staged checkpoints offer Continue, feedback/fixes, summary review, and Stop. Feedback explicitly reopens affected plan items. Stop remains resumable in the same implementation session. Worker run/session IDs are retained in state for dependent later work.

## Lifecycle and host behavior

- Reload, resume, and tree navigation restore workflow state and the execution contract matching the active run on the current branch. In-place execution remains in the same session history; older child-session executions continue in their existing session files. Every refresh emits `plan-mode:workflow-state` with the persisted mode and `feedbackPending`, including restored completed sessions and the `complete_plan` transition.
- Herdr normally reports green from Pi's settled lifecycle. A persisted `mode: "completed"` is the only semantic green override: it reports idle without waiting for `agent_settled`. The next agent run clears that override and reports working. An active feedback wait remains blocked until it clears; blocked and paused workflow modes are not green overrides.
- After an agent turn settles—or immediately after restoring an idle branch—any unconsumed approval or mandatory checkpoint whose persisted `presented` flag is false opens through the current TUI or RPC context, regardless of whether planning began by command, flag, shortcut, or palette.
- A decision is marked presented before the extension awaits input, preventing duplicate dialogs. Escape leaves it pending, and `/plan-actions` or `/plan-stage-actions` reopens it manually.
- TUI mode uses full renderers and structured dialogs. During planning and approval, the global rich statusbar changes only its CWD segment to Catppuccin peach and right-aligns a dark-gray `[PLANNING]` marker.
- RPC uses host select/editor primitives and omits the TUI-only tuicr Review action.
- Print/JSON validates and saves plans but cannot approve or auto-run.
- Plan writes are read-back verified. If a validated plan file disappears, approval/review restores it from the matching durable transcript entry before continuing. Resumed executions reconstruct missing plan-item titles and backfill the version-appropriate Part or Step report from the durable approved plan and ledger.
- Plan files are durable and are never deleted on shutdown.
- `.pi/plans/` is not automatically ignored or committed; each project owns that policy.

## Security boundary

There are three distinct layers:

1. **Workflow gate:** hides model mutation tools and rejects known shell mutations during planning.
2. **Trusted writes:** this extension writes the active plan/ledger; tuicr receives only a disposable isolated snapshot.
3. **Whole-process sandbox:** the separate Pi sandbox policy constrains Pi and descendants at the OS level.

Because unknown Bash commands are allowed, planning mode cannot promise that the workspace is absolutely read-only. Treat the extension as workflow enforcement; treat the OS sandbox as the security boundary.

## Development

```bash
cd pi/agent/extensions/plan-mode
npm run check
```

Deployment must use GNU Stow through `./install.sh config`; do not create manual symlinks.
