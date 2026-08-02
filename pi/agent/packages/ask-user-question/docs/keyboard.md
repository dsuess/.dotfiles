# Keyboard and dialog layout

Every key the questionnaire dialog reacts to, the rows it appends for you, and how it
adapts to the size of your terminal.

## Keys

| Key | What it does | Where it applies |
| --- | --- | --- |
| `↑` / `↓` | Move between rows. Wraps at both ends. | Option list, Submit picker |
| `Enter` | Confirm the focused option, open discussion, commit typed text, close notes, or activate the focused action. | Everywhere |
| `Shift+Enter` | Insert a newline. | `Type something.` input, notes editor |
| `Esc` | Cancel the questionnaire; in discussion it cancels a running turn or returns to the question. | Context dependent |
| `Tab` / `Shift+Tab` | Next / previous question tab; inside discussion, move between input and actions. | Context dependent |
| `Space` | Toggle the focused checkbox. | Multi-select questions |
| `n` | Open the notes editor for the current question. | Every question tab |
| `Ctrl+G` | Open Pi's configured external editor with the current draft. | Custom-answer and discussion inputs |
| `Ctrl+U` | Clear the current custom-answer draft. | `Type something.` input |
| `Ctrl+]` | Collapse or expand the dialog. Configurable via `collapseKey`. | Everywhere, including while collapsed |

In a multi-select question, `Enter` on a regular row toggles its checkbox exactly like
`Space` — it does not submit. Committing the question means focusing the `Next` row and
pressing `Enter`. That is deliberate: it makes `Enter` a zero-cost way to flip boxes
without leaving the home row.

`Space` is suppressed on three rows: `Discuss this` and `Next` are actions, not
checkboxes, while `Type something.` is an inline input whose spaces belong to the answer.

## The rows the dialog adds

| Row | Label | Appended to |
| --- | --- | --- |
| Clarification | `Discuss this` | Every question, immediately after authored choices |
| Custom answer | `Type something.` | Every question, immediately after `Discuss this` |
| Commit | `Next` | Multi-select questions only |

Focusing `Type something.` switches the row into an inline multiline editor. In preview
mode it expands to the full pane width while you type, so a long custom answer is not
squeezed into the narrow options column. `Shift+Enter` inserts a line break; vertical
arrows move between lines and return to row navigation at the draft's top and bottom.
The draft replaces the static row label while you browse other options and is isolated
per question. `Ctrl+G` round-trips it through Pi's configured external editor; `Ctrl+U`
clears it, while `Esc` remains the explicit way to cancel the questionnaire. Confirming
it produces an answer of `kind: "custom"`.

`Discuss this`, `Type something.`, and `Next` are reserved — the model cannot author an
option that collides with them. They localize with the rest of the UI chrome; validation
always compares against canonical English strings (and also reserves `Other`).

## Discussion panel

Selecting `Discuss this` opens a question-local panel without changing the structured
question or any answer, checkbox, note, custom draft, preview focus, tab, or collapse state.
The original question and choices stay visible above a bounded multi-turn transcript and
multiline clarification editor.

`Enter` sends from the editor; `Shift+Enter` adds a line; `Ctrl+G` opens the external
editor. `Tab` moves to the actions, `↑`/`↓` selects **Send**, **Back to question**, or
**Continue in chat**, and `Enter` activates it. While a child turn runs, duplicate sends
and navigation actions are unavailable; `Esc` aborts the child while preserving the draft.
Errors are retryable. Outside a running turn, `Esc` from the editor is Back; from actions it
returns focus to the editor.

Back restores the exact row and choices. Question tabs cannot switch until Back is used,
but a question's transcript remains available when discussion is re-entered later.
Continue closes the whole questionnaire and hands bounded context plus partial answers to
normal chat as a non-cancellation outcome.

The panel propagates IME focus to Pi's `Editor`, clips every rendered line to width, limits
itself to terminal height, and keeps existing collapse/reopen behavior.

## Notes

`n` opens a notes editor on any question tab, whether the question is single- or
multi-select and whether or not its options carry previews. Notes are stored in a
side-band keyed by tab index, not inside the answer, so writing a note does not mark a
question as answered — the Submit tab still lists it as outstanding. The note merges into
the answer when you confirm it, and reaches the model as `user notes: <text>`.

Inside the editor, `Shift+Enter` inserts a newline, while `Esc` and `Enter` close it; other
keystrokes edit the buffer, so `n` types an `n`. Pasted line breaks are preserved.

## Collapse mode

`Ctrl+]` gets the dialog out of the way: the overlay is marked hidden in Pi's overlay
stack and shrinks to a single dim hint row, so the transcript it was covering becomes
readable and chat scrolling resumes. Press the same key to bring the questionnaire back
with your answers intact. The first time you collapse, Pi notifies you with the key to
press — that message names your configured key.

Because Pi routes no input to a hidden overlay, the collapse key is additionally captured
at the raw terminal level. It only acts when the questionnaire is hidden or focused, so a
different overlay on top of it (for example `/btw`) keeps its keystrokes.

While collapsed, every keystroke other than cancel is ignored, so you cannot mutate
answers you cannot see.

The default `ctrl+]` is free in Terminal.app, iTerm2, Warp, tmux, zellij and screen. On
keyboard layouts where `]` sits on the shifted layer — Latin American `es-AR` / `es-MX`,
among others — set a different `collapseKey`, or `"off"` to disable the shortcut.

## Layout

Options render in a vertical list. When any option in a single-select question carries a
`preview`, the dialog splits into a side-by-side layout with the option list on the left
and a bordered monospace preview box on the right — but only when both the terminal and
the dialog pane are at least 100 columns wide. Below that, the preview stacks underneath
the options instead.

When the dialog is taller than the terminal, the body scrolls between a sticky heading and
a sticky footer, and an overflow indicator shows which direction is clipped: `↑` for
content above, `↓` for content below, `↕` for both.

The footer hint line adapts to context — it drops the notes hint and appends the
`Shift+Enter` newline hint whenever a text editor has the keyboard, with `Ctrl+U` still at
the far right for custom answers. It adds the tab hint only in multi-question dialogs.
`Ctrl+G` remains Pi's global external-editor shortcut and is not repeated there. On narrow
terminals the right edge clips with `…` so the core hints survive.
