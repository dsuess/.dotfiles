# Hosts and runtime behavior

Where the questionnaire renders, what it degrades to, and what happens when it cannot
render at all.

## Three environments

| Environment | What the model sees | What you see |
| --- | --- | --- |
| Interactive terminal | `ask_user_question` in its tool list | The full tabbed TUI overlay |
| RPC / ACP host (VS Code pendant, Zed, Paseo) | `ask_user_question` in its tool list | A sequence of the host's own native select and input dialogs |
| Non-interactive run (no UI) | Nothing — the tool is removed | Nothing |

### Non-interactive runs

A `before_agent_start` hook reconciles the active tool set against `ctx.hasUI` before every
turn. When there is no UI, `ask_user_question` is stripped from the list so the model never
sees a tool it cannot use — better than offering it and auto-declining every call. When UI
comes back, the tool is restored. The reconciler is idempotent and leaves sibling tools
untouched.

A second guard lives inside the tool handler as a one-turn backstop: if a call somehow
arrives without UI, it returns `error: "no_ui"` and the text
`Error: UI not available (running in non-interactive mode)`.

### RPC and ACP hosts

RPC hosts report `hasUI: true` because Pi's dialog sub-protocol works there, but custom
terminal UI does not render. The package detects this two ways: hosts that advertise
`ctx.mode === "rpc"` route straight to the dialog walker, skipping the TUI import
entirely, and older RPC builds are caught by a backstop when custom UI resolves without
rendering anything. Either path requires the host to expose both `select` and `input`.

The walker asks one question at a time and returns the same answer/cancel/handoff result
semantics as the TUI. Trade-offs inherent to native primitives:

- No side-by-side preview pane. Previews are folded into the dialog title instead,
  truncated at 600 characters each.
- No tab bar and no Submit review tab — one dialog per question, in order.
- Multi-select first offers the authored rows, **Discuss this**, custom input, and a
  `Select multiple…` action. The latter accepts comma-separated option numbers (`1,3`).
  Invalid index text remains a custom answer, and empty input commits an empty selection.
- **Discuss this** opens a native action loop. Users can ask repeated clarification turns,
  see the latest bounded transcript or retryable error in the next select dialog, return to
  the original choices, or continue in normal chat.
- Dismissing the outer question dialog cancels the questionnaire. Dismissing an inner
  discussion action returns to the original question instead of fabricating an answer.

If the host can render neither custom UI nor dialogs, the call returns
`error: "no_custom_ui"` with text telling the model the user never saw the questions and
that it should ask them as plain chat text instead — explicitly not a decline.

## Conditional surfaces

Some parts of the dialog exist only under the right conditions:

| Surface | Appears when |
| --- | --- |
| Tab bar and Submit tab | The call carries more than one question |
| `Next` row | The question is multi-select |
| `Discuss this` row | Always, after authored choices |
| `Type something.` row | Always, after `Discuss this` |
| Side-by-side preview | An option carries a `preview`, and terminal and pane are both ≥ 100 columns |
| Preview pane at all | Single-select questions only |
| Collapse shortcut | `collapseKey` is not `"off"` and the host exposes raw terminal input |
| Localized chrome | `@juicesharp/rpiv-i18n` is installed |

## Discussion child lifecycle

Each clarification turn launches an ephemeral child Pi process with the current model,
thinking level, effective system instructions, bounded compaction-aware conversation context,
working directory, sandbox, trust state, and active child-compatible tools in their existing
order. `ask_user_question`, subagent delegation, and parent planning/workflow completion tools
are structurally excluded; mutation-capable active tools are otherwise retained.

Prompt/system files are private (`0600`) and removed after the turn. Observable tool activity
and final text are shown, but thinking blocks are not. Parent context, transcript, stderr, and
output are bounded; truncation is marked. Nested usage and cost are attached to the parent tool
result. Esc, questionnaire close, reload, shutdown, and provider errors terminate the child and
retain the clarification draft.

A **Continue in chat** result is `outcome: "handoff"`, `cancelled: false`. The extension queues
one steering user message containing the question, choices, bounded discussion, reason, and
partial answers. It is not the decline path and avoids a duplicate automatic response.

## Loading and startup cost

The dialog's render graph costs roughly 560 ms to import, so it is loaded lazily — on the
first tool call, not when the extension registers. To keep that first call fast and safe,
the graph is also pre-warmed in the background two seconds after startup. The pre-warm
timer is unref'd, so it never holds a process open, and a failed pre-warm is swallowed:
the first real call re-imports and reports properly.

The pre-warm exists for a specific failure. Pi's module loader registers a module in its
graph cache *before* evaluating it and does not evict it if evaluation throws. If your
package manager replaces the dependency store while Pi is running, one failed import can
poison the cache for the rest of the process. Evaluating the graph early, while the paths
Pi resolved at boot still exist, keeps it in memory for the process lifetime and makes
that unreachable.

When it does happen, you get a structured envelope rather than a raw `TypeError`:

| `error` | Meaning | Fix |
| --- | --- | --- |
| `session_load_failed` | The dialog module could not be imported. | Repair the install if needed, then restart Pi. |
| `stale_module_cache` | The module cache went stale after an earlier failed import. | Restart Pi — this is unrecoverable in the running process. |

Both messages tell the model the questions were never shown and to ask them as plain chat
text instead of treating the failure as a decline.
