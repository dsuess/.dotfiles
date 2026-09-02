# Pi Subagent Extension

`subagent` runs one delegated task in an isolated child Pi process and returns the child’s final report.

## Usage

Inherit the parent model and thinking level:

```json
{
  "prompt": "Inspect the authentication code and report likely failure modes."
}
```

Override either setting independently:

```json
{
  "prompt": "Review the proposed API change.",
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high"
}
```

The public input contains only required `prompt`, optional `model`, and optional `thinkingLevel`. A child receives the prompt as its sole user message. Supported thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; child Pi validates the model and clamps unsupported levels.

## Runtime contract

Each invocation starts an ephemeral `pi --mode json --print --no-session` run. It does not copy parent conversation messages, create a resumable route, or persist a child session. The child inherits the parent’s:

- effective system instructions and planning restrictions;
- working directory and current process sandbox/environment;
- model and thinking level, unless explicitly overridden; and
- active tool allowlist, in its existing order.

The inherited tools exclude `subagent` and parent-session workflow tools (`show_plan`, plan progress/completion tools, and stage completion). The caller cannot supply or broaden tools. Extension discovery remains enabled so inherited discoverable custom tools can load; unavailable dynamic or SDK-only tools fail rather than causing Pi to enable defaults.

The inherited system prompt is transferred through a mode-`0600` temporary file, and the delegated task is written only to child stdin. Parent session environment identifiers are removed. Prompt state is deleted after success, failure, or cancellation.

Sibling tool calls may run concurrently. Each tool call owns one child and one active row; finishing a child removes only that row. Child processes are aborted on parent cancellation or session shutdown. A child cannot invoke `subagent`, even if the tool becomes unexpectedly visible.

Successful empty answers return `(no output)`. Model-visible output is bounded by lines and UTF-8 bytes. When truncated, the complete answer is saved to a mode-`0600` temporary file and the result reports its path and omitted byte count. Errors and stderr diagnostics are bounded as well.

Adjacent live activities with the same kind and action are coalesced before progress updates and result history. A repeated activity after a meaningful transition remains visible, as do same-kind activities with different actions.

## Visual roles

The below-editor row first accepts a leading, standalone directive of the form `[PI SUBAGENT ROLE: worker]`, where the role is one of `reviewer`, `planner`, `worker`, `scout`, or `general`. Malformed, unknown, inline, and non-leading directives are ignored. Without a valid directive, it infers one fixed presentation role from the delegated prompt with this precedence:

1. `🧪 reviewer` — review, audit, critique, assess, verify, validate
2. `🗺️ planner` — plan, design, architect, roadmap, strategy
3. `🔨 worker` — implement, fix, build, edit, write, refactor, change, create
4. `🔎 scout` — inspect, investigate, explore, search, find, research, analyze, locate
5. `🤖 general` — no matching word

Directive and fallback matching are case-insensitive; fallback keyword matching is word-oriented. Role inference is presentation-only: it does not change the prompt, tools, permissions, or model and makes no extra model call. The active row and conversation tool-call summary omit leading role and parallel-worker protocol directives, then display role, ordinal, and the provider-qualified selected model before the whitespace-normalized task; terminal-width truncation shortens the task first. Live child activity never changes the role or task summary; activity remains available in the normal tool result.

Role icons appear only in the below-editor active-run row. Conversation tool-call and activity lines are plain text, while running, completed, failed, and cancelled result headers retain their status icons.
