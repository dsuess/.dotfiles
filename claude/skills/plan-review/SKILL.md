---
name: plan-review-annotations
description: >-
  Process inline `!`/`?` annotations a user left in a Claude Code plan file. Use when the user returns from
  editing a plan and points you at their annotations, comments, feedback, or `!`/`?` markers — e.g. "address
  my plan comments", "I left notes in the plan", "process my ! and ? lines".
---

# Plan Review Annotations

When reviewing a plan, the user marks up the plan file (typically opened with Ctrl+G) with two kinds of
inline annotation. This skill defines exactly how to interpret them. The whole point is that the user's
feedback lives as plain text inside the plan, and the two markers tell you *how* to act on each line.

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

### Step 1 — Find the annotations

Scan the plan for annotation lines: a line is an annotation if its first non-whitespace character is `!`
or `?`. Collect them in order, keeping track of which plan section/step each one sits under (that context
usually tells you what the annotation refers to).

Be careful about false positives:
- Ignore `!` or `?` that appear **inside fenced code blocks** (between ``` fences) or inline code spans —
  those are almost always real content (shell history-expansion, a CLI flag, a ternary), not feedback.
- If a marker line is ambiguous (could be genuine plan content rather than a note), don't assume — ask
  the user whether it was meant as an annotation.
- An annotation may span multiple lines: treat continuation lines (indented or clearly part of the same
  thought) as belonging to the marker above them.

### Step 2 — Acknowledge what you parsed (do not revise yet)

Briefly reflect back what you found so the user can confirm you read their marks correctly:
- the list of `!` directives you will apply, and
- the list of `?` questions you need to work through first.

Do **not** output the revised plan at this stage, even if the directives alone would be enough to revise.
If there are open questions, the revision waits.

### Step 3 — Resolve every `?` question interactively

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

Then hold for approval as normal. **Stay in plan mode** — do not begin implementing. The output of this
skill is a revised plan for the user to review, not executed changes.

## Edge cases

- **Only `!` lines, no `?` lines:** no discussion is needed. Acknowledge the directives and go straight to
  the revised plan (Step 4).
- **Only `?` lines, no `!` lines:** discuss all questions, then produce the revised plan reflecting the
  decisions reached.
- **No annotations found:** tell the user you didn't find any `!` or `?` lines, and ask whether they saved
  the file or used a different marker — a common cause is feedback left in the plan-review comment UI,
  which does not reach the model; only edits to the plan text itself do.
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
