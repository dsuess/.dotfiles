@/Users/dsuess/.codex/RTK.md

# Codex Workflow

This file adapts the project workflow from `claude/CLAUDE.md` for Codex.
Follow the intent of those rules. Use Codex-native mechanisms where Claude-only
concepts do not exist.

## Workflow Orchestration

### 1. Think and Plan Deliberately

- For any non-trivial task, create a concise plan before editing. Use Codex Plan
  Mode for a decision-complete design. Use `update_plan` for an implementation
  checklist in Default Mode. These mechanisms are separate.
- If a task has three or more steps, treat it as non-trivial. Also apply this
  rule to architecture changes, multi-file changes, and risky verification.
- For large or ambiguous work, spell out the expected behavior and state
  material assumptions explicitly. If multiple interpretations can produce
  meaningfully different results, present them instead of choosing silently.
- Use repository context to resolve uncertainty. If ambiguity can change
  behavior or scope, name it and ask before implementing.
- If feedback can affect the next stage, consider a checkpoint after a large
  operation. Otherwise, routine checkpoints are optional.
- If a simpler approach exists, explain it. If the requested approach adds
  unnecessary complexity or risk, push back.
- Translate the request into verifiable success criteria and include
  verification in the plan. For a multi-step task, make each plan step end in a
  concrete check.
- If evidence contradicts the plan, stop implementation briefly, revise the
  plan, and continue from the updated understanding.

### 2. Context-First Delegation and Subagents

- Use parallel tool calls for independent reads, searches, and inspections.
  Keep trivial lookups and one-tool operations in the main agent.
- Treat the main agent as the coordinator. It owns user intent, accepted
  decisions, synthesis, integration, user communication, and checklist state.
- If a bounded task can use a self-contained briefing, delegate it.
- If the main agent needs only the conclusion, delegate a bounded task.
- Protect the main context first. Treat cost and latency improvements as
  secondary benefits.
- Use read-only scouts for codebase discovery, documentation research, large
  output inspection, inventories, and alternative analysis.
- Use workers for bounded implementation or verification. Give each worker
  clear ownership and acceptance criteria.
- If work needs rapid user interaction or implicit conversation context, keep
  it in the main agent. Also keep tightly coupled edits there.
- Parallelize only independent workstreams. Give workers disjoint file ownership
  because all Codex agents share the same workspace.
- For an isolated task, use `spawn_agent` with `fork_turns: "none"`. Put all
  required context in the task prompt.
- If recent context is necessary, use the smallest sufficient positive
  `fork_turns` value. If the full conversation is necessary, use `"all"`.
- Include the objective, relevant context, accepted decisions, scope,
  exclusions, expected evidence, and completion condition in each task prompt.
- Ask each subagent for compact conclusions, file locations, source citations,
  risks, and unresolved questions. Do not request raw intermediate output.
- Keep delegation trees shallow. Give a subagent explicit authority before it
  delegates further.
- Subagents inherit applicable restrictions and use their exposed tools. They
  cannot own or update the main agent's checklist.
- The main agent must reconcile subagent reports and inspect consequential
  findings. It must integrate changes and make sure that the result works.
- If subagents are unavailable, separate investigations clearly and keep each
  line of inquiry narrow.

#### Subagent Model Routing

- Prefer the parent model for subagents. If a bounded task benefits from another
  cost or capability tier, set an explicit model.
- Use the current GPT Luna model for simple, well-defined research tasks.
- Use the current GPT Terra model for standard implementation tasks and
  difficult research.
- Keep complex planning, architecture, and cross-cutting synthesis with the
  parent. Do not replace the parent model through subagent routing.
- Full-history forks inherit the parent model. To override `model` or
  `reasoning_effort`, use `fork_turns: "none"` or a positive turn count.
- For an explicit override, use a concrete available model and
  `reasoning_effort: "high"`. Do not change the parent model.
- If the preferred model is unavailable, use an equivalent model in the same
  tier. Disclose a fallback that materially changes the result.

#### Plan Mode Model Behavior

- Codex uses one model for each conversation. Plan Mode and Default Mode do not
  store independent model selections.
- A model-picker change applies to planning and implementation in the current
  conversation.
- `plan_mode_reasoning_effort` can set a separate reasoning effort for Plan
  Mode. It does not set a separate model.
- If planning and implementation require different models, use separate or
  forked conversations. Select the required model in each conversation.

### 3. Learn From Corrections

- If the repository uses `tasks/lessons.md`, record reusable lessons there after
  user corrections.
- If the repository has no lesson file, add a narrow prevention rule to the
  applicable `AGENTS.md` file.
- Write lessons as concrete prevention rules, not generic reminders.
- If the `tasks/` files exist, review relevant lessons at session start or
  before related work.
- Inspect Codex configuration, feature flags, tools, plugins, skills, and
  project launchers. Do this before you conclude that a capability is
  unavailable.

### 4. Verify Before Done

- Translate the request into concrete, verifiable success criteria before
  editing.
- Do not call work complete before you check it. Run the narrowest useful
  tests, linters, builds, log inspections, or command-level verification.
- When practical, reproduce the current behavior before a behavior change.
  Write a failing test for a bug or invalid input. Then make it pass.
- For refactors, run the relevant checks before and after the change.
- Loop until the success criteria pass. Never mark a task complete without
  evidence that it works.
- If verification cannot run because of sandbox restrictions, missing tools,
  credentials, or time, say exactly what remains unverified and why.
- Before the final response, review the diff or changed files. Make sure that
  the result can pass a staff-level review.

### 5. Prefer Elegant, Surgical Simplicity

- Make the smallest change that solves the real problem.
- Add no features, abstractions, configurability, or speculative error handling
  beyond what the request requires.
- Touch only lines that trace directly to the request. Do not refactor,
  reformat, or "improve" adjacent code. Match the existing style.
- Remove imports, variables, functions, and other artifacts made obsolete by
  your changes. Mention unrelated pre-existing dead code instead of removing it.
- For non-trivial changes, pause before finalizing and look for a simpler or
  more coherent solution.
- If the current fix feels like a workaround, review all gathered context. Then
  replace the workaround with the cleaner implementation.
- If the implementation is substantially larger than the problem warrants,
  rewrite it more simply.

### 6. Fix Bugs Autonomously

- For bug reports, reproduce or inspect the failure. Identify the root cause and
  fix it without step-by-step direction from the user.
- When practical, write a test that reproduces the bug before fixing it and
  verify that the test passes afterward.
- Use logs, errors, failing tests, and code evidence to drive the fix.
- Keep the user informed with concise progress updates during longer debugging.

### 7. Try Before Asking

- If a command is rejected or prompts for access, retry a corrected safe form.
  If you are unsure that the command will work, also retry a safe form.
- Fix the obvious cause first. Use absolute paths instead of `cd ... &&`, and
  split compound commands. If possible, run the command in the sandbox.
- A sandboxed read-only retry is cheap and safe. Attempt it before asking for
  permission.
- Resolve routine implementation uncertainty from repository context and safe
  experiments, but state any consequential assumption.
- If the choice belongs to the user, stop and ask. This includes destructive or
  irreversible actions and material changes to behavior or scope.
- Treat each candidate question as a pending blocker. Continue every independent
  branch that does not require an answer.
- If no further safe and useful progress is possible, ask for user input.
- If multiple blockers remain and `request_user_input` is available, use it.
  Ask at most three questions. Recommend an answer for each decision.
- If the blockers exceed the limit, ask the highest-dependency decisions first.
- If `request_user_input` is unavailable, ask one concise plain-text question.
  Do not write a textual multiple-choice questionnaire.
- After the user answers, resume investigation and work before asking again.
  Do not issue question batches back-to-back.
- If the user explicitly requests that format, ask one question at a time.

## Task Tracking

- Prefer `update_plan` for active checklists in Default Mode. Do not use
  `update_plan` in Plan Mode.
- For non-trivial tasks, record checkable steps and explicit verification
  criteria before editing.
- Mark progress as work completes. Do not wait until the end to update every
  item.
- Provide concise progress updates after meaningful stages or large operations.
- Record lessons from user corrections as Section 3 requires.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Minimize code
  impact.
- **No Laziness**: Find root causes. If the user requests a temporary fix, label
  it clearly.
- **Minimal Impact**: Touch only what is necessary. Do not introduce unrelated
  refactors or metadata churn.
- **Stow Discipline**: This repository is managed by GNU Stow. Never manually
  create symlinks or copy files into target directories. Add files to the right
  package and deploy with `./install.sh config`.
