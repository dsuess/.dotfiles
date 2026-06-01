# Plan Mode Extension

A phased planning workflow for [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent).

## Phases

| Phase     | Description                                                | Mutation Gate |
|-----------|------------------------------------------------------------|---------------|
| `off`     | Normal pi behavior                                         | Off           |
| `explore` | Gather info — read files, search codebase, research online | **On**        |
| `draft`   | Produce a structured plan and submit it                    | **On**        |
| `review`  | Open plan in `$EDITOR`, collect comments, iterate          | **On**        |
| `approved`| Release gate, write final plan, dispatch implementation    | Off           |

## Installation

The extension lives at `~/.pi/agent/extensions/plan-mode/`. Pi auto-discovers
directory-form extensions in that path. No additional install step needed.

### Prerequisites

- **Search skills**: Install `brave-search` and `browser-tools` from
  `badlogic/pi-skills` for web research during explore phase:
  ```
  pi install brave-search browser-tools
  ```

## Commands & Shortcuts

| Command          | Description                                    |
|------------------|------------------------------------------------|
| `/plan`          | Cycle phases: off → explore → draft → review → approved → off |
| `/plan explore`  | Jump directly to explore phase                 |
| `/plan review`   | Jump directly to review phase                  |
| `/plan-review`   | Open plan file in `$EDITOR` for review         |
| `/plan-approve`  | Approve the plan and dispatch implementation   |
| `/plan-reject`   | Reject the plan and return to explore          |

| Shortcut         | Description                                    |
|------------------|------------------------------------------------|
| `Ctrl+Alt+P`     | Toggle plan mode (off ↔ explore)              |

| Flag             | Description                                    |
|------------------|------------------------------------------------|
| `--plan`         | Start session in explore phase                 |

## How It Works

1. **Explore**: The agent reads files, searches the codebase, and optionally
   researches online. All mutations are blocked. When ready, the agent calls
   `submit_plan` with a structured markdown plan.

2. **Draft**: The agent can continue gathering information and refining the
   plan. Call `submit_plan` when the plan is complete.

3. **Review**: The plan is opened in your `$EDITOR` (falls back to `vi`,
   then to pi's built-in editor in no-TTY mode). Add `<!-- comments -->`
   or inline prose as feedback. When you close the editor, the extension
   detects changes and injects feedback as a follow-up for the agent to
   address. The loop continues until you approve or reject.

4. **Approved**: The extension writes the final plan to your chosen path
   (default `./PLAN.md`), releases the mutation gate, and dispatches
   implementation. You can choose:
   - **Parallel**: One worker subagent per plan section (with git worktree isolation)
   - **Sequential**: Single worker for the entire plan
   - **Manual**: Just save the plan; you implement yourself

## Visual Mode Indicator

When a plan phase is active, two visual cues appear:

1. **Editor Border Badge** — A colored phase badge in the top-left corner of the
   input editor border (like vim's modeline). Colors match the phase:

   | Phase     | Badge              | Color    |
   |-----------|--------------------|----------|
   | explore   | 🔍 EXPLORE         | accent   |
   | draft     | 📝 DRAFT           | warning  |
   | review    | 👁 REVIEW           | accent   |
   | approved  | ✅ APPROVED         | success  |

   When off, the border is clean — no badge.

2. **Terminal Title** — The terminal/tab title is prefixed with the current phase
   (e.g., `🔍 explore | π - my-project`), so you can see the mode even when pi
   is in a background tab.

## Mutation Gate

During explore/draft/review phases:
- **Allowed tools**: `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, `subagent`, `submit_plan`
- **Blocked tools**: `write`, `edit`
- **Bash**: Restricted to an allowlist of read-only commands (cat, ls, grep, git status, curl, etc.)
- **submit_plan**: The ONLY way to write the plan file — keeps the gate absolute

## State Persistence

Phase and plan state persist via `appendEntry`. They survive:
- `/reload`
- Session resume
- Process restart (via session file)

## Security Note

Extensions run with full system permissions. The mutation gate restricts the
*agent's* tool access, but the extension itself can write files (it writes
the plan on `submit_plan` and on approval). This is by design — the extension
is the trusted boundary between the read-only agent and the filesystem.
