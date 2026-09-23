# Perfect Pi Planning Mode

A global Pi extension for model-led planning, explicit approval, a mutation guard, implementation handoff, and a persistent task ledger.

The planning workflow and the mutation guard are separate. The workflow owns investigation, candidate files, approval, and optional execution tracking. Planning mode is the user-visible guard that restricts model mutation tools.

## Commands and entry points

- `show_plan` — model-only tool that presents a complete candidate from any conversation state. A successful call enables the mutation guard and opens the candidate actions.
- `/plan [goal]` — user command that enables the mutation guard and optionally starts a planning turn.
- `/plan off` — disable only the mutation guard. It preserves candidates, approvals, executions, checkpoints, outcomes, and counters.
- `--plan` — start a session with the mutation guard enabled.
- `Shift+Tab` — toggle the mutation guard.
- Command palette **Plan** row — toggle the mutation guard without enqueueing `/plan` or starting an agent turn.
- `/plan-actions` — reopen actions for the pending candidate, with or without the guard enabled.
- `/plan-stage-actions` — reopen the active staged checkpoint.
- `/plan-resume` — resume a paused implementation session.

Pi slash commands accept user input. The model does not invoke or synthesize `/plan`. Instead, `show_plan` is always available to the parent model as the presentation action.

State has exactly two guard modes: `planning` and `normal`. Candidate, approval, execution, checkpoint, and outcome records do not depend on the guard mode. Only an implementation action starts or resumes implementation. A guard toggle does not create, revise, approve, supersede, or discard a candidate.

## Model profiles

Plan mode has two independent global defaults in `~/.pi/agent/settings.json`: native `defaultProvider`/`defaultModel` for implementation, and extension-owned `defaultThinkingProvider`/`defaultThinkingModel` for planning. A new branch initializes its planning and inference profiles from those pairs. `defaultThinkingLevel` remains one shared reasoning-level default; it is not a planning-model setting.

After initialization, planning and inference profiles are branch-local. Resuming a session or navigating its tree restores the saved branch profile rather than adopting a later global edit. Handoff to implementation and `/plan off` switch to the inference profile, while a later planning entry restores the saved planning profile. An explicit CLI `--model` remains higher priority than both defaults.

A `/model` choice or Ctrl+P cycle persists only the active guard profile. Guarded changes update `defaultThinkingProvider` and `defaultThinkingModel`. Unguarded changes update `defaultProvider` and `defaultModel`. Workflow-driven Sol↔Terra switches never change either durable default. Missing models, credentials, malformed settings, or settings-write failures leave the applicable values unchanged and show a warning.

## Planning workflow and mutation guard

`show_plan` stays registered and active in normal, guarded, and executing parent conversations. The execution tools stay hidden outside an approved run. Child workers and questionnaire discussion children do not receive `show_plan`.

When the guard is enabled, Pi exposes only registered inspection, research, and question tools, plus `show_plan`. Unknown custom tools and implementation workflow tools are hidden. Pi blocks direct mutation tools again at `tool_call` as defense in depth.

Bash and user `!`/`!!` commands use a **known-mutator denylist**. The guard rejects redirects and recognized mutation commands. This includes common wrappers, chains, substitutions, and nested `sh -c` forms. Unclassified commands are deliberately allowed. This policy is fail-open and is not a security boundary.

The guarded per-turn prompt adapts `grill-with-docs` to read-only planning. Terminology and ADR/CONTEXT decisions become plan tasks, not inline writes. The prompt keeps the full canonical-format instructions. It collects blockers while useful investigation remains and asks them together in one batch. It uses one-question-at-a-time only when the user requests that format.

Outside the guard, repository and tool guidance encourages deliberate investigation and `show_plan` for non-trivial work. Candidate presentation remains optional. The model does not end useful exploration or present an unfinished candidate only because a turn is ending.

## Plan files and schema

Validated plans are saved under:

`<project>/.pi/plans/YYYYMMDD_<intent-slug>.md`

`YYYYMMDD` is the local calendar date when a new target is first allocated. Discussion and review revisions retain the current validated path. After implementation handoff, the next candidate gets a new durable path. The extension infers this lineage from workflow lifecycle state, not titles or a model-supplied flag.

The model never supplies an output path. Slugs are bounded kebab-case. Unrelated collisions use `-2` through a maximum of 100 probes. Writes validate containment and symlinks. They enforce a 256 KiB plan limit and use atomic replacement in the same directory. A failed write retains the last validated revision.

Every plan uses this canonical Markdown contract:

1. One concise, action-oriented H1 title.
2. Required `## Context` explains current behavior, motivation, architectural fit, relevant research, terminology conflicts, assumptions, confirmed decisions, and accepted risks when they matter.
3. Optional `## Questions & Answers` follows `Context` and precedes `Approach`. Include it only for user clarifications that have answers. It contains one table with this exact shape:

   ```markdown
   | Question | Answer |
   |---|---|
   | Does this change the public interface? | No. Keep the existing interface. |
   ```

   Add one non-empty row for each answered clarification. Record the question and answer so they preserve the decision. Do not add unresolved questions. Do not invent entries or add a placeholder when no questions were asked.
4. Required `## Approach` explains the solution before one or more ordered `### Part A — Action-oriented title` Parts. IDs continue alphabetically without gaps; headings never contain an author-written status.
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

Parts initialize as `pending` unless `show_plan` supplies valid initial progress. Runtime statuses are `pending`, `in_progress`, `completed`, and `blocked`. The extension persists these statuses only in managed `Ledger` metadata. Terminal initial statuses require evidence, and blocked Parts require a note.

A trailing `Part Progress` report comes from that metadata. It does not change approved Part headings or authored content. Other Markdown shapes are rejected. Saved historical plan files remain untouched but cannot be resumed or executed.

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

## Candidate lifecycle

The planner can inspect, answer, and ask questions across any number of turns. It calls `show_plan` only when every blocker is resolved and the complete candidate is ready. Ending a turn does not require candidate presentation.

A successful `show_plan` call saves and renders one candidate. It also enables the mutation guard and opens one decision dialog. A validation or persistence failure leaves the prior guard, candidate, and execution unchanged.

**Discuss** clears the pending nonce and sends open-ended feedback. The planner can answer or investigate without immediate resubmission. A later ready revision uses the same validated file. A review revision follows the same rule. Any ordinary user input while a candidate is pending has the same discussion effect.

After handoff to implementation, a later candidate gets a new durable file. If an active or paused run exists, successful presentation marks that run as superseded. The old session entries and plan file remain as durable history. A failed presentation does not supersede the run. The extension does not run concurrent or stacked workflows.

`show_plan` can include optional initial progress for each Part. The extension validates Part IDs, uniqueness, statuses, notes, and required terminal evidence. It writes progress only to managed Ledger metadata and the generated Part Progress report. Model-authored managed progress Markdown remains invalid.

Automatic threshold or overflow compaction waits while a candidate decision is pending. Manual `/compact` remains available. Pending actions remain valid if the user later disables the guard. `/plan-actions` can reopen them in either guard state.

## Approval actions

The complete saved plan is rendered as a durable transcript block, then the action dialog opens directly after the planning turn settles without injecting a `/plan-actions` user message. The dialog offers:

- **Implement plan** — execute all stages without ordinary stage pauses.
- **Implement (fast)** — create a source-equivalent parallel revision, then start it without another approval dialog.
- **Implement in stages** — hard pause after every derived stage (one Part per stage).
- **Discuss** — send exact free-form revision feedback without starting implementation or changing the current guard choice.
- **Review** — suspend Pi and open the validated plan revision as an isolated single-file tuicr review in the same terminal.

**Implement plan** remains first and is the default action. Escape leaves approval pending. Nonces reject stale queued commands and older revisions.

The fast action reads and hash-checks the approved source before it starts. It requires a canonical plan and `subagent` in the original tool snapshot. The optimizer uses the planning profile and cannot ask questions. It can inspect the repository, split a source Part, and add the schedule. It cannot change approved scope or combine source Parts.

Before the extension writes a fast revision, it compares the title, Context, answers, Approach preamble, Critical Files, and Verification. For each source Part, mapped Part bodies must join to the same normalized text. The source Part order stays unchanged. Within those safety constraints, the optimizer minimizes critical-path waves: it places each Part in the earliest wave allowed by a concrete predecessor output and does not treat source order, shared context, eventual integration, or general caution as dependencies. Keeping a source Part verbatim preserves scope; it does not require sequential execution. The optimizer may split a broad Part only through an exact source-preserving partition that unlocks useful concurrency. A rejected fast submission returns bounded, machine-readable validator rows and model-visible stable codes with available line and message context, so the optimizer can correct the schedule or mapping on its next attempt. If the optimizer stops, fails validation three times, or reaches its retry limit, the extension restores the original unconsumed approval. It never executes the source plan on this failure path.

Review is available only in interactive TUI mode; RPC omits it, and print/JSON cannot prompt. Pi verifies tuicr's required `--file`, `--theme`, and `review` CLI interfaces, gives each round private data/cache/state storage, and copies the user's normal tuicr configuration into that isolated round. Plan review installs a Catppuccin Mocha theme and compact Markdown syntax theme in that private configuration. Because tuicr models file annotation as an all-added diff, addition backgrounds remain on the Mocha base instead of tinting the full plan green. Its dim foreground also matches the base to visually hide tuicr's unavoidable line-number digits; the empty gutter remains, and other dim text can be hidden in this disposable review session. The snapshot matches the validated revision, while the canonical `.pi/plans/...` file remains under `show_plan` ownership. Editing the snapshot with `:edit`, ambiguous persisted sessions, malformed output, process failure, cleanup failure, or missing/empty comments rejects the round without consuming approval or incrementing review counters. `/plan-actions` can retry, and **Discuss** is the supported fallback.

Saved review-, file-, line-, and range-level comments are returned as one structured planner turn with stable IDs, anchors, side, lifecycle state, content, and optional advisory types. Types do not create a directive/question protocol. The planner acknowledges and reconciles every comment against repository evidence in the supplied original order. Its visible response uses one block per comment:

```markdown
> Exact user question or comment

**Resolution:** Grounded answer, reconciliation, and plan impact.
```

Every line of a multi-line comment remains quoted, and `**Resolution:**` follows the quote directly. The quoted user text, not an anchor, stable ID, or opaque hash, is the visible label; IDs remain available only for internal coverage checks, never as an ID-only bullet or hash-led answer. The planner inventories and explicitly answers every user question—including natural-language interrogatives and requests for a choice—and states whether each resolution changes the plan. A resolution is grounded in repository evidence, a stated assumption, or a user decision; an answerable question is never silently folded into plan text. Any user-owned decision that remains open is batched through the normal clarification workflow, keeps planning active, and blocks `show_plan` until the complete discussion closes. Before submission, every supplied comment must have a final complete resolution block. Once every question has an explicit answer or agreed resolution, the planner resubmits one complete canonical revision through `show_plan` without implementing. Applicable user decisions are recorded in the plan's `Questions & Answers` section; the immutable canonical-plan boundary remains unchanged.

## Execution and ledger

Run actions continue in the current visible session. The extension persists one run-scoped in-place contract identified by its run ID, plan path, plan hash, and boundary hash, then inserts one hidden execution-boundary message with the approved plan and execution rules. The visible transcript keeps planning for reference, while model context starts at the matching boundary.

If a current execution is restored without its boundary marker, the extension reconstructs the boundary from the persisted contract without exposing planning context. After compaction it retains the execution tail after the newest summary. An executing workflow without a matching canonical in-place contract stops safely and does not continue implicitly.

To recover an affected existing session, first stop the loop. Deploy the extension, then use `/reload` or restart Pi. The extension restores the persisted workflow state and continues without editing or deleting the session JSONL file.

The extension preserves the implementation-tool baseline independently of the always-available `show_plan` tool. It restores that baseline by registered-name intersection, with execution-only tools added:

- `plan_progress` — legal one-task status transitions with notes/evidence.
- `complete_plan` — terminal whole-plan validation.
- `complete_stage` — current-stage validation and mandatory checkpoint.

Ledger writes are serialized through Pi's file mutation queue. They atomically update only a Part's managed `Ledger` line and the trailing generated report. The approved Part heading and authored body remain immutable. Any other plan-content drift stops the update. The live widget and saved report list Parts in document order with the same status icon and title-only label.

Execution starts at the first nonterminal Part. It skips completed and blocked Parts and retains their evidence. It continues an in-progress Part without replaying its initial transition. If all Parts are terminal, execution reconciles the whole-plan result through `complete_plan` without re-running work. Derived stages govern order and checkpoints but do not add duplicate progress rows. Parallel workers report to the parent implementation agent. The parent is the only ledger writer.

A fast run stays in `executing_all`. Its schedule controls the derived stages. The parent starts every ready Part in a wave. Then it sends one sibling `subagent` call for each Part. Each worker receives its Part, ownership boundary, approved context, acceptance outcomes, and predecessor evidence. Workers use the persisted inference model at high thinking. The parent waits for every worker, records terminal evidence, checks integration, and then starts the next wave. A later wave cannot start before every earlier-wave Part and declared dependency is terminal.

Staged checkpoints offer Continue, feedback/fixes, summary review, and Stop. Feedback explicitly reopens affected plan items. Stop remains resumable in the same implementation session. Worker run/session IDs are retained in state for dependent later work.

## Lifecycle and host behavior

- Reload, resume, and tree navigation restore workflow state and the execution contract matching the active run on the current branch. In-place execution remains in the same session history; unsupported execution records stop safely. Every refresh emits `plan-mode:workflow-state` with the persisted mode and `feedbackPending`, including restored completed sessions and the `complete_plan` transition.
- After an agent turn settles—or immediately after restoring an idle branch—any unconsumed approval or mandatory checkpoint whose persisted `presented` flag is false opens through the current TUI or RPC context, regardless of whether planning began by command, flag, shortcut, or palette.
- A decision is marked presented before the extension awaits input, preventing duplicate dialogs. Escape leaves it pending, and `/plan-actions` or `/plan-stage-actions` reopens it manually.
- TUI mode uses full renderers and structured dialogs. While the guard is enabled, the rich status bar uses a Catppuccin peach CWD segment and shows a dark-gray `[PLANNING]` marker.
- RPC uses host select/editor primitives and omits the TUI-only tuicr Review action.
- Print/JSON validates and saves plans but cannot approve or auto-run.
- Plan writes are read-back verified. If a validated plan file disappears, approval/review restores it from the matching durable transcript entry before continuing. Resumed executions reconstruct missing plan-item titles and backfill the Part report from the durable approved plan and ledger.
- Plan files are durable and are never deleted on shutdown.
- `.pi/plans/` is not automatically ignored or committed; each project owns that policy.

## Security boundary

There are three distinct layers:

1. **Mutation guard:** hides model mutation tools and rejects known shell mutations while the guard is enabled.
2. **Trusted writes:** this extension writes the active plan/ledger; tuicr receives only a disposable isolated snapshot.
3. **SRT tool routing tool boundary:** the trusted host control plane runs Pi, reviewed extensions, model access, sessions, and the controller. The guest tool plane runs routed built-in file and Bash operations. Trusted-provenance host adapters remain on the host.

Because unknown Bash commands are allowed, planning mode cannot promise that the workspace is absolutely read-only. Treat the extension as workflow enforcement and the SRT tool routing guest tool plane as the boundary for routed model tools. The host control plane and provenance-verified adapters are trusted; this is not a whole-process OS sandbox for Pi or extension code.

## Development

```bash
cd pi/agent/extensions/plan-mode
npm run check
```

Deployment must use GNU Stow through `./install.sh config`; do not create manual symlinks.
