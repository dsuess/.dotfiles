# Pi Workflow

This file adapts the project workflow from `claude/CLAUDE.md` for Pi.
Follow the intent of those rules, using Pi-native mechanisms where Claude-only
concepts do not exist.

## Workflow Orchestration

### 1. Think and Plan Deliberately

- For any non-trivial task, create a concise plan before editing. Prefer Pi's
  planning extension (`/plan` or `--plan`) and its persistent ledger; otherwise
  write and maintain a checkable plan in the conversation.
- Treat a task as non-trivial when it has three or more steps, touches multiple
  files, changes architecture, or has meaningful verification risk.
- For large or ambiguous work, spell out the expected behavior and state
  material assumptions explicitly. If multiple interpretations would produce
  meaningfully different results, present them instead of choosing silently.
- Resolve uncertainty from repository context when possible. If unresolved
  ambiguity would change behavior or scope, name it and ask before implementing.
- Surface tradeoffs and point out a simpler approach when one exists. Push back
  when the requested approach adds unnecessary complexity or risk.
- Translate the request into verifiable success criteria and include
  verification in the plan. For a multi-step task, make each plan step end in a
  concrete check.
- Mark plan or ledger progress as work completes, and provide concise updates
  after meaningful stages or large operations.
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

### 3. Learn From Corrections

- After a user correction, record the reusable lesson in the AGENTS.md if
  that file exists or when creating it is appropriate for the repository.
- Write lessons as concrete prevention rules, not generic reminders.
- Inspect project launchers and configured extensions before concluding that a
  requested capability is unavailable.

### 4. Verify Before Done

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

### 5. Prefer Elegant, Surgical Simplicity

- Make the smallest change that solves the real problem.
- Add no features, abstractions, configurability, or speculative error handling
  beyond what the request requires.
- Touch only lines that trace directly to the request. Do not refactor, reformat,
  or "improve" adjacent code, and match the existing style.
- Remove imports, variables, functions, and other artifacts made obsolete by
  your changes. Mention unrelated pre-existing dead code instead of removing it.
- For non-trivial changes, pause before finalizing and look for a simpler or
  more coherent solution.
- If the current fix feels like a workaround, use the full context gathered so
  far to replace it with the cleaner implementation.
- If the implementation is substantially larger than the problem warrants,
  rewrite it more simply.

### 6. Fix Bugs Autonomously

- For bug reports, reproduce or inspect the failure, identify the root cause,
  and fix it without requiring the user to provide step-by-step direction.
- Use logs, errors, failing tests, and code evidence to drive the fix, following
  the verification requirements above.

### 7. Try Before Asking

- When a command is rejected or prompted, or you are unsure it will work, retry
  a corrected safe form instead of ending the turn to ask.
- Fix the obvious cause first: use absolute paths instead of `cd ... &&` and
  split compound commands.
- Work within the OS sandbox established by `bin/pi`. Attempt a safe read-only
  retry before asking the user to change or bypass that boundary.
- Resolve routine implementation uncertainty from repository context and safe
  experiments, but state any consequential assumption.
- Stop to ask when the choice is genuinely the user's: destructive,
  irreversible, ambiguous intent, or a tradeoff that materially changes
  behavior or scope.
- Treat each candidate question as a pending blocker, not an immediate reason
  to interrupt the user. Do not stop at the first uncertainty: keep inspecting,
  reasoning, and advancing every independent branch that does not require an
  answer.
- Ask only when no further useful, safe progress is possible without user input.
  Before that point, complete all available repository inspection,
  documentation review, safe experiments, and independent reasoning.
- At that point, accumulate all currently known blockers and ask them together
  in one `ask_user_question` call (up to its four-question limit), with a
  recommended answer for each decision. If more than four are known, ask the
  highest-dependency decisions first. If the tool is unavailable, use one
  concise, numbered plain-text list instead; if no blockers remain, ask nothing.
- After receiving answers, resume investigation and work before asking again.
  Ask a later batch only when the answers reveal dependent decisions or a
  tool-limited batch leaves blockers and all newly available progress is again
  exhausted; never issue questionnaires back-to-back.
- Override this collect-then-batch cadence only when the user explicitly
  requests a one-question-at-a-time interview.

## Repository Constraint

- **Stow Discipline**: This repository is managed by GNU Stow. Never manually
  create symlinks or copy files into target directories. Add files to the right
  package and deploy with `./install.sh config`.
