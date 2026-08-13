---
name: plan-review
description: >-
  Process inline `!`/`?` annotations a user left in a Claude Code plan file. Use when the user returns from
  editing a plan and points you at their annotations, comments, feedback, or `!`/`?` markers — e.g. "address
  my plan comments", "I left notes in the plan", "process my ! and ? lines".
---

# Plan Review Annotations

When reviewing a plan, the user marks up the plan text with two kinds of inline annotation. This skill
defines exactly how to interpret them. The whole point is that the user's feedback lives as plain text
inside the plan, and the two markers tell you *how* to act on each line.

## Where the plan lives

Every plan you present via ExitPlanMode is persisted by Claude Code to a flat folder:

```
~/.claude/plans/<slug>.md
```

The slug derives from the session's first prompt plus a random suffix; the **most recently modified**
`.md` in that folder is the current plan. When the user presses **Ctrl+G** at the approval dialog, their
editor opens *this file*, and the edits they save land back on disk here. That is how inline annotations
reach you — not through the approval dialog (whose options are fixed and only ever offer "implement"
paths), but as saved edits to the plan file.

### Pi plan-mode host branch

Pi's `plan-mode` extension stores the active plan at the exact project-local path recorded in extension
state:

```
<project>/.pi/plans/YYYYMMDD_<intent-slug>.md
```

Do not search by modification time in Pi. The extension's **Review** action opens an isolated snapshot of
that exact validated revision in tuicr and supplies the saved comments as structured feedback containing
stable IDs, review/file/line/range anchors, side, lifecycle state, optional advisory type, and content. The
canonical plan itself is not edited. Pi comments are ordinary natural-language feedback: do not reinterpret
them as Claude's marker protocol below.

## Telling the user how to invoke this (do this whenever you present a plan)

Because the approval dialog cannot show a "review my annotations" option, the user has to reach this skill
deliberately. Whenever you present a plan, end the plan with a one-line reminder of the path back:

> To give inline feedback: press **Ctrl+G**, mark lines with `!` (directive) or `?` (question), save,
> then choose **Keep planning with feedback** and say "process my plan annotations".

The critical mechanic: the user must pick **Keep planning with feedback**, *not* any approve option —
approving starts implementation and these annotations are never seen.

In Pi plan mode, the interactive approval dialog already has a **Review** option. Tell the user to choose
**Review**, add anchored comments in the same-terminal tuicr session, and quit tuicr. Pi remains gated on
missing, empty, malformed, or failed review rounds; **Change** is the fallback outside interactive TUI mode.
No second submit keystroke or "process my annotations" message is needed.

## The two markers

- **`!` line — a directive.** A line whose first non-whitespace character is `!` is an instruction to
  change the plan. You will incorporate it into the revised plan.
- **`?` line — a question.** A line whose first non-whitespace character is `?` is a question or point of
  discussion. You must **not** silently guess an answer and revise. These are resolved interactively with
  the user *first*.

**The core rule:** never output a revised plan while any `?` question is still unresolved. Directives can
be applied freely, but questions gate the revision. Only once every `?` has been answered do you produce
one revised plan that folds in both the `!` directives and the decisions reached from the `?` discussion.

## Workflow

### Step 1 — Locate the plan file, then find the annotations

In Pi plan mode, do not search for or parse an edited file. Use the exact `.pi/plans/...` path and complete
structured tuicr comment set supplied by the extension, then skip the Claude-specific search below.

First find the file the user annotated. The current plan is the most recently modified plan file:

```
ls -t ~/.claude/plans/*.md | head -5
```

The newest entry is almost always the one — confirm it by checking its content matches the plan you just
presented (you have that plan in context). Ignore `*-agent-*.md` files: those are subagent plans, not the
user's. If the newest file does not match what you proposed, say so and ask the user which file they
edited rather than guessing.

Read that file, then scan it for annotation lines: a line is an annotation if its first non-whitespace
character is `!` or `?`. Collect them in order, keeping track of which plan section/step each one sits
under (that context usually tells you what the annotation refers to).

Be careful about false positives:
- Ignore `!` or `?` that appear **inside fenced code blocks** (between ``` fences) or inline code spans —
  those are almost always real content (shell history-expansion, a CLI flag, a ternary), not feedback.
- If a marker line is ambiguous (could be genuine plan content rather than a note), don't assume — ask
  the user whether it was meant as an annotation.
- An annotation may span multiple lines: treat continuation lines (indented or clearly part of the same
  thought) as belonging to the marker above them.

### Step 2 — Acknowledge what you parsed (do not revise yet)

In Pi, acknowledge every structured comment by its anchor or ID and explain how you will reconcile it
against repository evidence; comment types are advisory context only. Use the normal collect-then-batch
clarification workflow and ask only when the comment and repository evidence do not settle a decision.

Briefly reflect back what you found so the user can confirm you read their marks correctly:
- the list of `!` directives you will apply, and
- the list of `?` questions you need to work through first.

Do **not** output the revised plan at this stage, even if the directives alone would be enough to revise.
If there are open questions, the revision waits.

### Step 3 — Resolve every `?` question interactively

In Pi, present only the genuinely unresolved decisions identified from the structured comments and
reconcile conflicting comments explicitly. This is not a marker-driven question gate.

Present the `?` questions and discuss them with the user. Default to surfacing all of them together (so
the user sees the full set and can answer in one pass), but stay genuinely interactive — if an answer
raises a follow-up, pursue it; if the user wants to go one at a time, follow their lead.

While resolving:
- Offer your own analysis or a recommendation for each question rather than just asking it back blankly —
  you read the codebase during planning, so contribute. But let the user make the call.
- If a `?` answer conflicts with a `!` directive (e.g. a directive says "use a generic wrapper" but a
  question's resolution argues against it), flag the conflict explicitly and reconcile it before moving
  on. Do not quietly pick one.
- Keep going until **no `?` question remains open.** If something is still unclear, ask again rather than
  assuming.

### Step 4 — Produce one revised plan

Once — and only once — every `?` is resolved:
1. Produce a single revised plan that incorporates the `!` directives **and** the decisions from the `?`
   discussion.
2. Strip the annotation lines (`!` and `?`) out of the revised plan — they were feedback, not plan
   content, and should not survive into the plan the user approves.
3. Optionally, note briefly where notable changes came from (which directive or which resolved question)
   so the user can verify their feedback landed.

Present the revised plan through ExitPlanMode as normal — that re-persists a fresh `~/.claude/plans/`
file, so the user can annotate the new version the same way and the loop repeats until they approve. End
it with the same Ctrl+G reminder from above. **Stay in plan mode** — do not begin implementing. The output
of this skill is a revised plan for the user to review, not executed changes. Do not hand-write into
`~/.claude/plans/` yourself; let ExitPlanMode own that file.

In Pi plan mode, once all supplied comments are reconciled and any genuine user decisions are resolved,
submit the single complete canonical revision through `submit_plan` instead. No marker conversion or
annotation stripping applies. The trusted extension owns
`.pi/plans/` persistence and reopens its four-action interactive approval dialog. Never use ordinary
mutation tools to rewrite the Pi plan file.

## Edge cases

- **Only `!` lines, no `?` lines:** no discussion is needed. Acknowledge the directives and go straight to
  the revised plan (Step 4).
- **Only `?` lines, no `!` lines:** discuss all questions, then produce the revised plan reflecting the
  decisions reached.
- **No annotations found:** tell the user you didn't find any `!` or `?` lines in the current plan file,
  and ask whether they saved the Ctrl+G edit (an unsaved buffer never reaches disk) or annotated a
  different file. A common cause is feedback left in the plan-review comment UI, which does not reach the
  model; only saved edits to the plan text itself do.
- **A line is both a statement and a question:** treat the leading marker as authoritative. `! also,
  should we cache?` is a directive (the user is telling you to add caching); `? should we cache?` is a
  question to discuss.

## Example

Suppose the plan file comes back looking like this:

```
## Step 2: Add the rate limiter
Add a middleware that limits public API requests to 100/min.
! use the existing rate-limit pattern in admin/, don't add a new library
? should the limit be per-IP or per-API-key? the admin one is per-key

## Step 4: Storage
Store counters in a new in-memory map.
? is in-memory fine, or do we need this to survive restarts across the cluster?
```

Correct behavior:
1. Parse: two `!`/`?` blocks — one directive (`! use the existing rate-limit pattern...`) and two
   questions (per-IP vs per-key; in-memory vs persistent).
2. Acknowledge: "Got it — I'll reuse the admin rate-limit pattern instead of a new library. Two things to
   settle first: ..." (no revised plan yet).
3. Discuss both questions, offering a recommendation on each, until the user decides.
4. Only then output the revised plan: rate limiter reusing the admin pattern, keying as decided, storage
   backend as decided, with the `!`/`?` lines removed.

What would be wrong: applying the directive and immediately printing a revised plan that quietly assumes
per-IP and in-memory storage. The `?` lines exist precisely to prevent that.
