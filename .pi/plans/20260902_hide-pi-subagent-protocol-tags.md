# Hide Pi Subagent Protocol Tags

## Context

Parallel-plan worker prompts begin with role and worker protocol directives. Pi needs
those directives for worker-role inference, but the task summaries shown in the active
subagent row and conversation tool-call renderer should show only the human task.

## Plan

1. Strip leading canonical role and parallel-worker directives during display-summary
   normalization, without changing the raw delegated prompt or role inference.
2. Cover active-row and conversation-renderer output with the subagent TUI smoke test.
3. Document that protocol directives are omitted from visible task summaries.

## Verification

- `node pi/agent/extensions/subagent/test/tui-smoke.mjs`
- `node pi/agent/extensions/plan-mode/test/execution-helpers.test.mjs`
- `npm --prefix pi run check`
