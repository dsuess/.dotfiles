# Decouple Planning Workflow from the Mutation Guard

## Context

The plan-mode extension currently makes the planning workflow conditional on `state.mode === "planning"`: normal startup hides `show_plan`, the tool rejects calls outside that mode, pending approval is defined as a planning-only state, and `/plan` resets prior candidate and execution data. This coupling explains both reported failures: the model receives the full workflow only after explicit guard entry, and a later planning pass can lose or fail to expose the new candidate after implementation.

The canonical terms need sharpening. **Planning workflow** means model-led investigation, discussion, candidate presentation, approval, and optional execution tracking. **Planning mode** remains the user-visible mutation guard. Pi slash commands are user-input commands, so the model will not receive a synthetic or model-callable `/plan`; instead, `show_plan` will be its always-available, model-only presentation action. A successful `show_plan` call will enable the mutation guard and open the usual actions. User `/plan [goal]`, Shift+Tab, and the palette will continue to control the guard directly.

The guard is independent of workflow state, but two accepted exceptions to “guard only” remain: entering it still selects the saved planning model profile and injects the full read-only planning instructions. Outside the guard, repository-level and tool guidance will strongly encourage deliberate planning and `show_plan` for non-trivial work without making presentation mandatory or closing ordinary conversation.

Candidate lineage will follow lifecycle evidence rather than title heuristics or a model-supplied new/revise flag. Discussion and review resubmissions revise the current candidate in place. Once a candidate has been handed off, any later candidate gets a new durable plan file. Presenting one during active or paused execution supersedes that run while retaining its prior session entries and plan file. Initial progress is supplied through a validated `show_plan` parameter rather than model-authored managed Markdown; terminal statuses require evidence, and execution skips already terminal Parts. Existing unrelated changes in `codex/config.toml`, `pi/agent/settings.json`, and the untracked SRT permission-grants plan are outside scope.

## Questions & Answers

| Question | Answer |
|---|---|
| How should the model start planning itself when slash commands are user-only? | Do not add a model `plan` tool. Keep `/plan` user-only and let the model use always-available `show_plan`. |
| When the model starts a planning run, should it enable the mutation guard? | Enable the guard at successful `show_plan` presentation. |
| What should happen when `show_plan` is called while the guard is off? | Enable the guard and show the usual candidate actions. |
| May a new planning workflow replace an active or paused implementation? | Let the model decide from user intent whether it is amending prior work or starting new work; presenting the resulting candidate supersedes the old run. |
| Without a model-callable plan tool, when does autonomous exploration become guarded? | At `show_plan`; exploration before presentation can occur with normal tools unless the user entered `/plan`. |
| How should the model declare whether a candidate is new or a revision? | No declaration is needed; infer candidate-file lineage from workflow lifecycle. |
| What happens to an active or paused run when another candidate is presented? | Supersede it, while retaining its durable history and plan file. |
| What should user `/plan [goal]` do? | Enable the guard and send an optional goal as a normal planning request; `/plan off` disables the guard without resetting workflow data. |
| How should replacement-plan progress be supplied? | Add an optional validated per-Part progress field to `show_plan`; keep managed progress Markdown extension-owned. |
| How should discussion revisions and post-handoff candidates be stored? | Revise the same file during discussion or review; allocate a new file after handoff. |
| How should implementation treat Parts already marked completed? | Skip terminal Parts, retain their evidence, and start from the first nonterminal Part. |
| Should planning-mode guard toggles still switch planning and inference model profiles? | Yes. Preserve the existing model routing. |
| Should the guard still inject the full planning workflow prompt? | Yes. Preserve the full read-only workflow prompt while guarded. |

## Approach

Separate durable workflow facts from the mutation guard, then make candidate presentation available in every ordinary conversation while preserving the existing approval and execution experience.

### Part A — Separate guard from durable workflow facts
- **Ledger:** {"status":"completed","note":"Decoupled durable approval/execution from the planning guard; preserved workflow data across toggles; added v1/v2→v3 migration and explicit execution supersession.","evidence":"Changed state.js/state.ts and state tests. Parent verification: complete plan-mode unit suite passed 124/124; focused integrated suite passed 37/37; git diff --check passed."}

Evolve the persisted state contract so `mode` controls tool gating, status presentation, planning prompt injection, and model profile selection, but no longer determines whether approval or execution exists. Predicates such as `hasPendingApproval` and `isActiveExecution` will inspect their own durable records rather than require a particular mode. Guard entry and exit will preserve the current plan, approval nonce, execution contract, ledger, checkpoints, outcome, and counters; `/plan off` will restore the appropriate normal or execution tool set instead of deleting workflow state.

Migrate existing versioned state safely, including legacy phase-based records and current two-mode records. A guard toggle during active execution must temporarily expose only planning tools and then restore the same execution on exit. A successful replacement candidate must instead supersede the old execution explicitly and become the sole active workflow. Prior custom state entries and plan files remain durable evidence; no concurrent or stacked workflow is introduced.

### Part B — Preserve the implementation-tool baseline
- **Ledger:** {"status":"completed","note":"Separated clean implementation-tool snapshots from presentation/execution tool composition and wired normal/execution restoration to that baseline.","evidence":"Changed planning-gate.js, execution-helpers.js, index.ts, and focused tests. Parent verification: complete plan-mode unit suite passed 124/124; focused integrated suite passed 37/37; git diff --check passed."}

Preserve the pre-guard implementation-tool baseline independently of always-available presentation tools. This baseline is required so a candidate shown from normal conversation can later hand off to implementation, and so a candidate shown during execution restores the original implementation capabilities rather than stale `plan_progress` or completion tools.

### Part C — Make `show_plan` globally usable and lifecycle-aware
- **Ledger:** {"status":"completed","note":"Made show_plan available across parent conversation states, added atomic guard activation and lifecycle-aware revision/supersession, and added validated initial Part progress with deterministic managed ledger persistence.","evidence":"Changed presentation/orchestration, store/document/ledger/state/prompt surfaces and tests. Parent verification: npm --prefix pi/agent/extensions/plan-mode test passed 131/131; git diff --check passed. Worker package check also passed with PI_BIN=/opt/homebrew/bin/pi."}

Keep `show_plan` registered and active in normal, guarded, and executing conversations while continuing to exclude it from child workers and questionnaire discussion children. Remove its planning-mode precondition and make a successful call atomically perform candidate persistence, workflow transition, guard activation, planning-profile routing, durable rendering, and pending-action creation. Validation failures must leave the prior guard and execution state intact and return the existing bounded diagnostics and retry behavior.

Infer persistence lineage from state: an unhanded-off candidate under discussion or review is revised at its validated path, while any candidate after execution handoff receives a new collision-safe plan path. A successful call during active or paused execution marks that run superseded before installing the new candidate; failures do not interrupt it. Pending approval and `/plan-actions` must work regardless of whether the user subsequently turns the guard off, and ordinary input must still consume only the pending decision so discussion can remain open.

Extend the model-only tool schema with optional per-Part progress entries containing Part ID, status, note, and evidence. Validate uniqueness, known Part IDs, legal statuses, terminal evidence, and blocker notes. Persist these values only as extension-managed Ledger rows and the generated Part Progress report; continue rejecting model-authored managed metadata in the Markdown argument. Store matching ledger evidence in state and include it in the durable candidate hash/rendering so restoration is deterministic.

### Part D — Resume execution from supplied progress
- **Ledger:** {"status":"completed","note":"Execution kickoff and staged/parallel resumption now skip terminal Parts, continue in-progress Parts without replay, advance to first nonterminal stage, preserve evidence through fast optimization, and reconcile all-terminal plans via complete_plan.","evidence":"Changed execution helpers/state flow and regression tests. Parent verification: plan-mode package tests passed 137/137; worker plan-mode check, palette integration, and TUI smoke passed."}

When a candidate is approved, select the first nonterminal derived stage rather than always selecting the first Part. Standard, staged, and parallel kickoff instructions must distinguish pending, in-progress, and terminal Parts: skip completed or blocked work, continue genuinely in-progress work without replaying its initial transition, and preserve prior evidence for dependency and completion checks. Earlier terminal Parts must satisfy ordering constraints, while future nonterminal Parts remain gated by the existing stage or wave rules.

For staged execution, checkpoints begin at the first nonterminal Part and advance past later terminal Parts. If every Part is already terminal, expose the whole-plan completion path so the implementation turn can reconcile verification and call `complete_plan` rather than re-running work. Fast-plan optimization must preserve source progress and evidence while retaining its current scope-equivalence and schedule validation.

### Part E — Preserve trusted and inherited tool boundaries
- **Ledger:** {"status":"completed","note":"Preserved parent-only workflow tool boundaries and made inherited planning require both the structural guard marker and effective planning prompt while retaining trusted show_plan provenance.","evidence":"Changed SRT child capabilities, subagent, questionnaire discussion, and boundary tests. Parent verification: subagent 31/31, SRT/Herdr focused 14/14, questionnaire typecheck passed; questionnaire assertions 593/594 with sole EPERM /tmp sandbox fixture failure."}

Change normal tool composition so `show_plan` is always visible to the model, while `plan_progress`, `complete_plan`, and `complete_stage` remain execution-only. Keep inherited-planning detection dependent on both the active guard marker and system prompt, preventing always-active `show_plan` from falsely placing subagents into planning mode. Retain SRT trusted-host provenance for `show_plan` and verify every tool-set transition through the existing routing audit.

### Part F — Align model guidance and documentation
- **Ledger:** {"status":"completed","note":"Updated model guidance, extension README, and repository correction lesson to distinguish durable workflow from the mutation guard.","evidence":"Changed AGENTS.md, pi/agent/AGENTS.md, and plan-mode/README.md. Documentation diff reviewed; full plan-mode suite passed 124/124; git diff --check passed."}

Update `pi/agent/AGENTS.md` to strongly encourage the model to investigate and use `show_plan` for non-trivial work from any conversation state, while stating that it is optional, model-only, and never a reason to end exploration prematurely. Keep the full `grill-with-docs`, blocker batching, canonical-format, and read-only instructions in the guard prompt. Update the extension README to document the workflow/guard distinction, automatic guard activation on presentation, lifecycle-based revision storage, supersession, initial progress, and guard-only `/plan off` behavior. Revise the repository correction lesson because the previous “persistent tool-gated mode” rule is now too coupled: candidate workflow state must remain orthogonal to the mutation guard.

### Part G — Align status and host integrations
- **Ledger:** {"status":"completed","note":"Aligned guard-only status, durable feedback blocking, RPC/palette/restoration dialogs, child integrations, and model routing with guard-independent workflow state.","evidence":"Changed statusbar and integration tests across plan-mode, Herdr, subagent, SRT, and questionnaire. Parent verification: plan-mode 137/137, subagent 31/31, SRT/Herdr focused 14/14, questionnaire typecheck passed; worker focused status/RPC/palette/feedback tests passed."}

Update status, palette, RPC, Herdr feedback, subagent, questionnaire-discussion, and model-routing integration assumptions only where the new independence affects them. The `[PLANNING]` marker continues to represent the active guard; feedback blocking continues to represent an unconsumed approval or staged checkpoint, regardless of guard state.

## Parallel Execution

| Wave | Worker | Part | Source Part | Depends On | Ownership |
|---|---|---|---|---|---|
| 1 | worker-state | A | A | — | guard-state migration and durable workflow predicates |
| 1 | worker-tools | B | A | — | active-tool baseline helpers and restoration wiring |
| 1 | worker-guidance | F | D | — | planner prompt and planning documentation surfaces |
| 2 | worker-presentation | C | B | A, B | candidate submission, persistence, and approval orchestration |
| 3 | worker-execution | D | C | A, C | execution kickoff, stage selection, and progress resumption |
| 3 | worker-boundaries | E | D | B, C | trusted host and child capability boundaries |
| 3 | worker-integrations | G | D | A, C | status, palette, RPC, feedback, and routing integration surfaces |

## Critical Files

- `pi/agent/extensions/plan-mode/state.{js,ts}` — versioned guard-independent approval/execution invariants, supersession, initial ledger evidence, and first-nonterminal stage selection.
- `pi/agent/extensions/plan-mode/index.ts`, `planning-gate.js`, and `prompts.ts` — always-active `show_plan`, successful-call guard activation, `/plan` semantics, tool baselines, model routing, and planner guidance.
- `pi/agent/extensions/plan-mode/plan-store.js`, `plan-document.js`, `ledger.js`, and execution helpers — trusted initial-progress rendering, candidate hashing, lifecycle-aware revisions, and terminal-Part skipping.
- `pi/agent/extensions/plan-mode/README.md`, `pi/agent/AGENTS.md`, and `AGENTS.md` — user contract, runtime model guidance, and the reusable correction rule.
- Plan-mode and affected SRT/subagent/questionnaire/status integration tests — regression boundary for trusted tool availability and cross-extension behavior.

## Verification

Regression checks will retain canonical Markdown validation, atomic containment-safe persistence, stale nonce/hash rejection, approval dialogs, open-ended Discuss/Review, fast optimization, staged checkpoints, execution context isolation, model-profile routing, SRT provenance, and child workflow-tool exclusion. Run the plan-mode package check first, then the affected statusbar, Herdr feedback, SRT routing, subagent, and ask-user-question suites, followed by the repository-required `npm --prefix pi run check` from an ordinary host terminal.

New scenarios must demonstrate these observable outcomes:

- A normal session exposes `show_plan` but hides execution-only workflow tools; its ordinary model and mutation tools remain unchanged.
- The model can successfully call `show_plan` without prior `/plan`; the candidate is durably rendered once, the mutation guard and planning profile activate, and the usual action dialog opens once.
- `/plan [goal]` gates mutations and submits the goal, while `/plan off` preserves pending approval or active execution and restores the correct tools/model.
- A pending candidate remains actionable with the guard off; `/plan-actions`, ordinary discussion input, review, revision, and later implementation all work.
- Discussion and review resubmissions keep one validated path and increment its revision; post-handoff planning allocates a new path.
- A candidate shown during active or paused execution supersedes that run only after successful validation, and failed validation leaves the old run executable.
- Supplied progress produces matching managed boxes and ledger evidence; malformed, duplicate, unknown, or unsupported progress is rejected without replacing the prior plan.
- Standard, staged, and parallel execution skip terminal Parts, resume in-progress Parts, honor remaining dependencies, and can reconcile an all-terminal candidate through `complete_plan`.
- Always-active `show_plan` alone does not mark subagents or discussion children as inherited planning; the guard marker still does.
- Reload, resume, and tree navigation restore the guard, candidate decision, superseded state, execution contract, progress evidence, and feedback signal without duplicate dialogs or boundaries.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Separate guard from durable workflow facts
- ☑ Preserve the implementation-tool baseline
- ☑ Make `show_plan` globally usable and lifecycle-aware
- ☑ Resume execution from supplied progress
- ☑ Preserve trusted and inherited tool boundaries
- ☑ Align model guidance and documentation
- ☑ Align status and host integrations
<!-- pi-plan-mode:progress:end -->
