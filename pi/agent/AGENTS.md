## Workflow Orchestration

### 1. Plan Before Acting
- For ANY non-trivial task (3+ steps or architectural decisions): write a plan first
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Write detailed specs upfront to reduce ambiguity
- Stop after each stage and ask for feedback before committing changes

### 2. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 3. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 4. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

### 5. Question Batching

- Before asking, complete all useful, safe repository inspection,
  documentation review, and independent reasoning. A question is ready only
  when further useful progress is blocked by a genuinely user-owned decision.
- Accumulate all currently known blockers and ask them in one
  `ask_user_question` call (up to its four-question limit), with a recommended
  answer for each decision. If more than four are known, ask the
  highest-dependency decisions first. If the tool is unavailable, use one
  concise, numbered plain-text list instead; if no blockers remain, ask nothing.
- Ask a later question batch only if earlier answers reveal dependent decisions
  or a tool-limited batch leaves blockers, and only after completing another
  investigation pass; never issue questionnaires back-to-back.
- Override this batching cadence only when the user explicitly requests a
  one-question-at-a-time interview.

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
