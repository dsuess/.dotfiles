## Workflow Orchestration

### 1. Think and Plan Deliberately
- For any non-trivial task, create a concise plan before editing. Use the
  environment's integrated planning tool when available; otherwise write the
  plan in the conversation.
- Treat a task as non-trivial when it has three or more steps, touches multiple
  files, changes architecture, or has meaningful verification risk.
- For large or ambiguous work, spell out the expected behavior and state
  material assumptions explicitly. If multiple interpretations would produce
  meaningfully different results, present them instead of choosing silently.
- Resolve uncertainty from repository context when possible. If unresolved
  ambiguity would change behavior or scope, name it and ask before implementing.
  Otherwise, routine checkpoints are optional; consider one after a large
  operation when feedback could materially affect the next stage.
- Surface tradeoffs and point out a simpler approach when one exists. Push back
  when the requested approach adds unnecessary complexity or risk.
- Translate the request into verifiable success criteria and include
  verification in the plan. For a multi-step task, make each plan step end in a
  concrete check.
- If evidence contradicts the plan, stop implementation briefly, revise the
  plan, and continue from the updated understanding.

### 2. Parallel Investigation and Subagents
- Use parallel tool calls for independent reads, searches, and inspections to
  keep context efficient.
- Use subagents liberally for isolated research, exploration, parallel analysis,
  or alternative approaches that keep the main context focused.
- Give each subagent one focused task. For complex problems, use several when
  the workstreams are independent.
- If subagents are unavailable, simulate the same discipline by separating
  investigations clearly and keeping each line of inquiry narrow.

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verify Before Done
- Translate the request into concrete, verifiable success criteria before
  editing.
- Do not call work complete until it has been checked. Run the narrowest useful
  tests, linters, builds, log inspections, or command-level verification.
- For behavior changes, reproduce the current behavior first when practical:
  write a failing test for a bug or invalid input, then make it pass.
- For refactors, run the relevant checks before and after the change.
- Loop until the success criteria pass; never mark a task complete without
  evidence that it works.
- If verification cannot run because of sandbox restrictions, missing tools,
  credentials, or time, say exactly what remains unverified and why.
- Before the final response, review the diff or changed files and ask whether
  the result would pass a staff-level review for correctness, maintainability,
  and scope control.

### 5. Demand Elegance (Balanced)
- Write the minimum code that solves the requested problem; add nothing speculative
- Do not add unrequested features, configurability, or abstractions for single-use code
- Do not add error handling for scenarios that cannot occur
- For non-trivial changes, ask whether a senior engineer would find the solution overcomplicated; if a much smaller or more elegant implementation exists, rewrite it
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- For simple, obvious fixes, keep the change direct instead of introducing abstractions

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

### 7. Try Before Asking

- When a command is rejected or prompted, or you are unsure it will work, retry
  a corrected safe form instead of ending the turn to ask.
- Fix the obvious cause first: use absolute paths instead of `cd ... &&`, split
  compound commands, and run sandboxed when possible.
- A sandboxed read-only retry is cheap and safe; attempt it before asking for
  permission.
- Resolve routine implementation uncertainty from repository context and safe
  experiments, but state any consequential assumption.
- Stop to ask when the choice is genuinely the user's: destructive,
  irreversible, ambiguous intent, or a tradeoff that materially changes
  behavior or scope.

## Task Management

- Prefer the environment's integrated planning tool for active checklists.
- For non-trivial tasks, record checkable steps and explicit verification
  criteria before editing.
- Mark progress as work completes; do not wait until the end to update every
  item.
- Provide concise progress updates after meaningful stages or large operations.
- Update `tasks/lessons.md` after user corrections with a prevention-oriented
  rule.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Use the minimum code that solves the requested problem.
- **No Laziness**: Find root causes. Allow temporary fixes only when explicitly
  requested and clearly labeled.
- **Surgical Changes**: Every changed line should trace directly to the request.
  - Touch only what is necessary; do not improve adjacent code, comments, or formatting
  - Do not refactor working code or remove pre-existing dead code unless asked; mention unrelated issues instead
  - Match the existing style, even when you would choose differently
  - Remove imports, variables, and functions only when your changes made them unused

## System Config

All my system config lives in `~/.dotfiles` (a git repo). Files under `~/.claude`, `~/.gitconfig`, etc.
are symlinks into it. When editing config, resolve the symlink and edit the real target under
`~/.dotfiles`, then remember it's an uncommitted change in that repo to sync.

@RTK.md
