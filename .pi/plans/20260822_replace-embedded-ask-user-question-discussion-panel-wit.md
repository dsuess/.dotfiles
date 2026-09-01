# Replace Embedded Discussion UI with Forked Threads

## Context

The local `pi/agent/packages/ask-user-question` fork currently appends a **Discuss this** row to every question and opens an embedded discussion panel inside the questionnaire overlay. Each panel turn launches an ephemeral, one-shot JSON/print child Pi process. The panel owns its own editor, transcript, actions, activity display, cancellation flow, and RPC equivalent.

Here, **extra discussion UI** means that embedded panel and its native-dialog imitation, not the **Discuss this** row itself. The row remains the entry point. In terminal Pi, selecting it will suspend the parent TUI and open a normal interactive Pi session that is a real, persisted child fork. Resolving or leaving that child returns to the still-active questionnaire. One child session is retained per question and re-entering the row resumes that thread.

The installed Pi runtime is 0.84.2, while this package's development dependencies and compatibility text still target 0.82.1. The proposed resolver needs the current `ModelRegistry.complete` API, so the package development pins, lockfile, and compatibility statement must move to 0.84.2. This is an existing package/runtime documentation conflict that the change will resolve.

Confirmed behavior and guardrails:

- `/resolve [optional outcome]` is available only inside a questionnaire discussion child. It returns to the parent questionnaire; Ctrl+D or another ordinary child exit does not resolve and leaves the questionnaire unchanged.
- `/resolve` performs one bounded, no-workspace-tool classification call with the child's current model. The classifier produces a concise outcome and decides whether it fully answers the original question. Invalid or failed classification safely degrades to context-only. This extra usage is recorded and included in the parent tool result.
- Every resolved outcome is shown in the ordinary question dialog. If the classifier identifies a complete answer, the dialog preselects the exact authored option(s), or seeds a custom answer, but still requires normal Enter/Next confirmation. It never auto-submits, and the user can override the suggestion.
- Context-only outcomes do not alter choices, prior answers, notes, custom drafts, checkbox selections, tab position, preview focus, or collapse state.
- RPC/ACP hosts cannot host a nested terminal Pi process. Selecting **Discuss this** there directly produces the existing non-cancellation handoff to normal chat; the embedded RPC discussion loop is removed.
- The child inherits the effective parent system instructions, model, thinking level, trust state, cwd, sandbox, and active compatible tools. Questionnaire recursion, subagent delegation, and parent workflow-completion tools remain excluded.
- The fork is persisted under Pi's normal session tree with `parentSession` provenance. This makes the discussion discoverable and resumable, at the cost of retaining a separate session file.
- The public `rpiv:ask-user:blocked` state remains active for the complete questionnaire and child-thread interval. Child Herdr/broker identity variables are removed so the nested Pi process cannot overwrite the parent's authoritative blocked status.

No repository `CONTEXT.md` or ADR exists for this package. The established package documentation and `FORK.md` are the appropriate places to record this reversible local UX/runtime decision; a new ADR is not warranted.

## Questions & Answers

| Question | Answer |
|---|---|
| How should a forked discussion signal that it is resolved and return to the suspended questionnaire? | `/resolve command (Recommended)`: run `/resolve [optional outcome]`; without text, use the latest assistant response. Ctrl+D exits without resolving. |
| What should the returned discussion outcome do in the original question dialog? | `Show context only (Recommended)`, with the user note: “use that context as the answer for the question if appropriate.” |
| What should happen on RPC/ACP hosts that cannot launch a nested terminal Pi thread? | `Handoff to chat`: selecting **Discuss this** ends the questionnaire and continues clarification in the host's normal chat. |
| When should a resolved thread's outcome count as the question's answer rather than only context? | `Agent decides`. |
| If the discussion agent says its outcome fully answers a single-select question, how should the returned dialog finish that question? | `Preselect, confirm (Recommended)`: highlight the classified option or custom answer; the user presses Enter to accept or chooses something else. |

## Approach

The implementation will retain the structured questionnaire as the parent interaction and replace only its embedded discussion mode. A persisted child Pi session becomes the discussion boundary; a child-only resolution command produces a validated, bounded handback; and the parent reducer projects that handback into the existing question controls. Host-specific behavior remains explicit: native child session in terminal mode, normal-chat handoff in RPC/ACP mode, and no tool in non-interactive mode.

### Part A — Replace one-shot panel turns with a persistent native child thread
- **Ledger:** {"status":"completed","note":"Replaced one-shot JSON/print discussion turns with persisted session forks and child-only /resolve runtime. Child threads fork before the parent tool-call, retain parentSession provenance, filter forbidden tools, restore parent system instructions through a secure file, scrub parent/Herdr identity env, and stop/restart the parent TUI around an inherited-stdio child.","evidence":"`npm --prefix pi/agent/packages/ask-user-question run typecheck`; `npm --prefix pi/agent/packages/ask-user-question test` (37 files, 590 tests). New `discussion/runtime.test.ts` verifies fork anchor/provenance, forbidden tool filtering, secure prompt cleanup, parent TUI restoration, and durable resolution usage."}

Refactor the discussion runtime into a session-fork transport. At the current `ask_user_question` tool call, locate the persisted assistant/tool-call entry and create a branched session from its parent so the child has valid conversation history without an unmatched `ask_user_question` call. Add a private metadata entry containing the original question, choices, mode, parent tool call, and fork anchor, then launch the fork in an interactive child Pi process.

Before launch, securely materialize the effective parent system prompt and bounded kickoff context. Invoke the same Pi runtime with the active model, thinking level, trust decision, cwd, and filtered active-tool order. Clear stale parent session variables and Herdr broker variables, set a dedicated discussion-child marker, and ensure the reconciler cannot re-enable `ask_user_question` inside the child. Keep mutation-capable tools only when they were already active; continue excluding questionnaire recursion, delegation, and parent planning/workflow completion capabilities.

Use Pi's documented interactive-process pattern: stop the parent TUI, give the terminal to the child with inherited stdio, and always restart and force-render the parent TUI after child success, failure, signal exit, or cancellation. Clean secure prompt files in every path. If the parent session is not persisted or a valid pre-tool fork anchor cannot be established, notify the user and leave the questionnaire state untouched rather than creating a misleading pseudo-fork.

Register `/resolve` only when the child marker is present. The command reads the question metadata and bounded observable child transcript, excluding thinking and binary/image content. It uses the current child model with a single resolution tool schema to return:

- a concise outcome;
- `context_only`, exact single-option, exact multi-option, or custom-answer classification;
- only labels/text valid for the original question shape.

Runtime validation rejects hallucinated labels, wrong single/multi shapes, and empty custom answers back to context-only. Persist the resolution, classifier usage, and transcript boundary in a child custom entry, then shut down cleanly. A parent invocation accepts only a resolution newer than the last one it consumed, so exiting or re-entering an already-resolved child cannot replay stale state. Re-entering **Discuss this** resumes the same per-question child session; Ctrl+D without a new resolution returns unchanged.

Observable acceptance outcome: selecting **Discuss this** leaves the questionnaire shell, opens a normal Pi conversation with full native chat/tool UI, and `/resolve` restores the parent questionnaire with a durable, bounded result from that exact child session.

### Part B — Return outcomes through the ordinary questionnaire state and view
- **Ledger:** {"status":"completed","note":"Removed the embedded editor/panel state and replaced it with per-question child-thread/resolution metadata. Returned outcomes now render in the ordinary question layout; validated suggestions focus/prepopulate existing controls and remain confirmation-only, while context-only/error paths retain candidate state.","evidence":"`npm --prefix pi/agent/packages/ask-user-question run typecheck`; `npm --prefix pi/agent/packages/ask-user-question test` (37 files, 590 tests). Updated domain/view tests cover launch preservation, context-only return, option/multi/custom suggestions, and no auto-submit."}

Remove the discussion editor, panel renderer, panel focus/actions, activity list, and panel-specific reducer branches from `QuestionnaireSession`. Keep the **Discuss this** sentinel and route Enter on it to one asynchronous fork effect. While the parent TUI is active, prevent duplicate launches; while the child owns the terminal, the parent questionnaire remains in memory and the blocked lifecycle stays asserted.

Replace panel state with per-question thread metadata: child session identity/path, last consumed resolution, bounded transcript/outcome, aggregate post-fork usage, optional validated answer suggestion, and retryable launch/resolve error. Preserve the existing answer, note, custom-draft, checkbox, preview, tab, and collapse state on launch, context-only resolution, unresolved exit, and failure.

Render the resolved outcome as a bounded informational block in the normal question layout rather than a separate mode. A context-only resolution returns focus to **Discuss this** and changes no candidate answer. A complete classified answer returns with normal confirmation semantics:

- exact single option: focus that authored option and require Enter;
- custom single answer: seed/focus **Type something.** and require Enter;
- multi option set: preselect the classified checkboxes, focus the normal commit row, and require Enter/Next;
- custom multi answer: seed/focus **Type something.** and require Enter.

The suggestion is not submitted until the user confirms it, and any normal user choice overrides it. The final tool envelope carries the confirmed answer plus bounded discussion outcome/context and aggregated child/classifier usage, preserving Pi session accounting without copying an unbounded fork transcript.

Remove terminal-only **Back to question**, **Continue in chat**, multiline discussion input, panel cancellation, and panel activity semantics. Keep ordinary questionnaire cancellation and collapse behavior unchanged.

Observable acceptance outcome: after `/resolve`, the user sees the same question dialog, an outcome summary, and either an explicit preselection awaiting confirmation or unchanged choices when the result is context-only.

### Part C — Align non-terminal hosts, contracts, and maintained-fork documentation
- **Ledger:** {"status":"completed","note":"Simplified RPC/ACP Discuss this to the existing direct normal-chat handoff; updated result metadata, outcome rendering/locales, documentation, package version, and Pi development pins. Removed all package references to the former panel/action flow.","evidence":"`npm --prefix pi/agent/packages/ask-user-question run typecheck`; complete package Vitest suite (38 files, 593 tests); `herdr-feedback-composed.test.mjs` (4 tests); `npm pack --dry-run` confirms `discussion/child.ts` ships; `pi list` resolves only `packages/ask-user-question` for this package; `pi --mode json --no-session --list-models ask-user-question` loads the configured runtime without extension error. Package/lock Pi pins verified at 0.84.2."}

Simplify `rpc-fallback.ts`: keep structured options, previews, custom input, and multi-select behavior, but make **Discuss this** immediately return the existing `outcome: "handoff"` result with the current question, choices, reason, and partial answers. `finalizeQuestionnaire` continues to queue exactly one contextual normal-chat steering message and returns `terminate: true`, so RPC discussion is neither cancellation nor a duplicate assistant continuation.

Update result/domain types and response formatting to represent forked thread identity, bounded outcome/transcript, classifier decision, answer suggestion, truncation, and usage. Preserve existing answer and handoff shapes where possible; keep **Discuss this** reserved and model guidance explicit about terminal fork behavior versus RPC handoff. Remove obsolete panel/action locale keys and tests, and add only the compact outcome/error strings still rendered by the ordinary dialog.

Update `README.md`, `FORK.md`, host/keyboard/tool-schema/localization documentation, changelog, package version, compatibility statement, development dependency pins, and lockfile. Documentation must explain saved child sessions, `/resolve`, unresolved exits, classifier fallback, answer confirmation, usage accounting, sandbox/tool inheritance, RPC handoff, and the absence of the old embedded panel.

Observable acceptance outcome: package guidance, runtime behavior, locale inventory, public result docs, and the installed Pi 0.84.2 API surface agree, with no references to the removed embedded discussion UI.

## Critical Files

- `pi/agent/packages/ask-user-question/ask-user-question.ts` — tool execution, TUI/RPC routing, blocked lifecycle, child launch integration, and final response accounting.
- `pi/agent/packages/ask-user-question/discussion/` — fork creation/launch, child-only `/resolve`, classification validation, transcript bounds, session metadata, and usage aggregation.
- `pi/agent/packages/ask-user-question/state/questionnaire-session.ts` and `state/state-reducer.ts` — asynchronous discussion action, preserved questionnaire state, returned outcome, and preselection/confirmation semantics.
- `pi/agent/packages/ask-user-question/view/tab-content-strategy.ts` — compact outcome rendering inside the existing question layout without a second UI mode.
- `pi/agent/packages/ask-user-question/rpc-fallback.ts` — direct RPC/ACP handoff when a terminal child thread is unavailable.
- `pi/agent/packages/ask-user-question/tool/types.ts` and `tool/response-envelope.ts` — persisted/result contract and model-facing outcome context.
- `pi/agent/packages/ask-user-question/index.ts` and `reconcile.ts` — child-only command registration and recursion-proof tool activation.

## Verification

Regression checks:

- Run the package's complete Vitest suite and TypeScript check after updating the Pi 0.84.2 development pins.
- Confirm ordinary single-select, multi-select, custom answers, previews, notes, tabs, submit review, collapse/reopen, cancellation, validation, result envelopes, event emission, non-interactive tool removal, and extension reconciliation still pass.
- Confirm reserved-label order and upstream fork shipping/manifest tests remain stable except for intentional discussion contract changes.

New fork-thread scenarios:

- A production-shaped persisted parent creates a child session with `parentSession` provenance from the entry before the current questionnaire tool call; no orphan tool call appears in child context.
- The interactive child receives the active model/thinking/system/trust/cwd/tool order, cannot call `ask_user_question` or excluded workflow/delegation tools, inherits the existing sandbox, and cannot publish Herdr status for the parent pane.
- Parent TUI stop/start and secure-file cleanup occur on resolution, Ctrl+D, child non-zero exit, classifier failure, and spawn failure; the questionnaire remains usable afterward.
- `/resolve` accepts optional user outcome text, otherwise uses the latest observable assistant response, records one new resolution, and exits. Ordinary exit records none.
- Re-entering a question resumes its saved child thread; no-new-resolution exits do not replay the previous outcome.
- Resolution classification covers exact single option, custom answer, multi-option set, custom multi answer, context-only, malformed tool output, unknown labels, and provider failure. Invalid classifications degrade to context-only.
- Returned suggestions focus/populate the correct ordinary control and require Enter/Next; no path auto-submits, and a user override wins.
- Context-only, cancellation, and error paths preserve answers, checkboxes, notes, custom drafts, preview/tab focus, and collapse state.
- Bounded transcript/outcome and post-anchor assistant/tool/classifier usage appear once in the parent result with truncation markers where required.

Host and integration checks:

- RPC/ACP **Discuss this** produces one non-cancelled handoff, one steering message, and `terminate: true`, without opening the removed select/input discussion loop.
- The composed Herdr test remains blocked for the full unresolved questionnaire/child interval and clears only when the questionnaire itself settles.
- Deploy through `./install.sh config`, verify `pi list` loads only `packages/ask-user-question`, and smoke-test one live terminal fork/resolve/confirm cycle.
- Run the repository-required sandbox checks at the end. Native containment checks must be run from an unsandboxed terminal; if the implementation session remains sandboxed, report those exact checks as externally pending rather than claiming they passed.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Replace one-shot panel turns with a persistent native child thread
- ☑ Return outcomes through the ordinary questionnaire state and view
- ☑ Align non-terminal hosts, contracts, and maintained-fork documentation
<!-- pi-plan-mode:progress:end -->
