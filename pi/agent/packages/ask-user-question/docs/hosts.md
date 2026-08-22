# Hosts and runtime behavior

## Three environments

| Environment | Model tool list | User experience |
| --- | --- | --- |
| Interactive terminal | `ask_user_question` is active | Tabbed questionnaire and persisted child discussions |
| RPC / ACP | `ask_user_question` is active | Native select/input questionnaire dialogs; direct normal-chat handoff for **Discuss this** |
| Non-interactive | Tool is removed | No questionnaire UI |

## Terminal TUI

The questionnaire remains in memory while **Discuss this** opens a normal interactive Pi child session. The parent TUI stops before the child takes inherited stdio and is restarted and force-rendered after every child exit, spawn failure, signal, or `/resolve` return.

A child is created from the session entry before the assistant message that contains the current tool call. Its session header records `parentSession`; its context therefore has valid conversation history without an orphaned `ask_user_question` call. One child is stored per question and later selections resume it.

The child gets the current model, thinking level, effective system prompt, trust decision, cwd, whole-process sandbox, and compatible active tools in their active order. It retains active mutation tools when present. It excludes `ask_user_question`, subagent delegation, and parent workflow-completion tools. Parent `PI_SESSION_*` and Herdr/broker identity variables are cleared before launch.

`/resolve [optional outcome]` is child-only. It saves a bounded observable transcript/outcome and calls the current child model once with a single classification tool. The classifier can return context-only, an exact single option, exact multi-options, or a custom answer. Invalid labels, invalid question shape, blank custom text, malformed tool output, or provider failure become context-only. Ctrl+D and other ordinary exits save no resolution.

The parent consumes only a resolution newer than the one it already consumed. Returned outcomes are shown inside the normal question dialog. Valid suggestions require the normal confirmation action. Child and classifier usage is attached once to the final parent tool result.

## RPC and ACP

Custom terminal UI cannot render in RPC/ACP hosts, and a nested terminal Pi process cannot safely own those hosts. The package uses Pi's `select`/`input` dialogs for ordinary structured choices, previews, custom answers, and multi-select parsing.

Selecting **Discuss this** immediately returns `outcome: "handoff"`, `cancelled: false`, with the current question, authored choices, and partial answers. `finalizeQuestionnaire` queues exactly one normal-chat steering message and returns `terminate: true`. It is not cancellation and it does not run the removed native-dialog discussion loop.

## Non-interactive runs

`before_agent_start` reconciles the active tool list with `ctx.hasUI`. When no UI exists, it removes `ask_user_question` so the model never sees a tool that cannot render. The handler retains a one-turn `no_ui` backstop.

## Fallback and load errors

An RPC host without both `select` and `input` receives `no_custom_ui`, which explicitly says that the user never saw the questions. A failed lazy questionnaire import returns either `session_load_failed` or `stale_module_cache`; both ask the model to use normal chat instead of interpreting the failure as a decline.
