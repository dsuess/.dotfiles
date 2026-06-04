@/Users/dsuess/.codex/RTK.md

# Codex Workflow

This file adapts the project workflow from `claude/CLAUDE.md` for Codex.
Follow the intent of those rules, using Codex-native mechanisms where Claude-only
concepts do not exist.

## Workflow Orchestration

### 1. Plan Deliberately

- For any non-trivial task, create a concise plan before editing. Use
  `update_plan` when available; otherwise write the plan in the conversation.
- Treat a task as non-trivial when it has three or more steps, touches multiple
  files, changes architecture, or has meaningful verification risk.
- If evidence contradicts the plan, stop implementation briefly, revise the
  plan, and continue from the updated understanding.
- Include verification in the plan. Planning is not only for implementation.
- For large or ambiguous work, spell out the expected behavior before changing
  files. Ask for user feedback only when the ambiguity cannot be resolved from
  repository context.

### 2. Parallel Investigation

- Use parallel tool calls for independent reads, searches, and inspections to
  keep context efficient.
- When subagent tools are available, use them for isolated research,
  exploration, or alternative approaches. Give each subagent one focused task.
- If subagents are unavailable, simulate the same discipline by separating
  investigations clearly and keeping each line of inquiry narrow.

### 3. Learn From Corrections

- After a user correction, record the reusable lesson in `tasks/lessons.md` when
  that file exists or when creating it is appropriate for the repository.
- Write lessons as concrete prevention rules, not generic reminders.
- At session start or before related work, review relevant lessons if the
  `tasks/` files exist.

### 4. Verify Before Done

- Do not call work complete until it has been checked. Run the narrowest useful
  tests, linters, builds, or command-level verification available.
- When behavior changes, compare before and after behavior when practical.
- If verification cannot run because of sandbox, missing tools, credentials, or
  time, say exactly what was not verified and why.
- Before final response, review the diff or changed files and ask whether the
  result would pass a staff-level review for correctness, maintainability, and
  scope control.

### 5. Prefer Elegant Simplicity

- Make the smallest change that solves the real problem.
- For non-trivial changes, pause before finalizing and look for a simpler or
  more coherent solution.
- If the current fix feels like a workaround, use the full context gathered so
  far to replace it with the cleaner implementation.
- Skip extra abstraction for simple, obvious fixes.

### 6. Fix Bugs Autonomously

- For bug reports, reproduce or inspect the failure, identify the root cause,
  and fix it without requiring the user to provide step-by-step direction.
- Use logs, errors, failing tests, and code evidence to drive the fix.
- Keep the user informed with concise progress updates during longer debugging.

## Task Tracking

- Use Codex's plan tool for active checklists when available.
- If the repository has `tasks/todo.md`, use it for substantial multi-stage
  efforts that need durable tracking across turns.
- Mark progress as work completes; do not wait until the end to update every
  item.
- Add a short review/results note for substantial tasks when `tasks/todo.md` is
  being used.
- Update `tasks/lessons.md` after user corrections with a prevention-oriented
  rule.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal
  code.
- **No Laziness**: Find root causes. Avoid temporary fixes unless explicitly
  requested and clearly labeled.
- **Minimal Impact**: Touch only what is necessary. Do not introduce unrelated
  refactors or metadata churn.
- **Stow Discipline**: This repository is managed by GNU Stow. Never manually
  create symlinks or copy files into target directories. Add files to the right
  package and deploy with `./install.sh config`.
