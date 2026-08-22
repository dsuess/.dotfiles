# Keyboard and dialog layout

## Structured questionnaire

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move between rows and the Submit picker. |
| `Enter` | Confirm an option, open **Discuss this**, commit custom text, close notes, or commit a multi-select at **Next**. |
| `Shift+Enter` | Insert a newline in custom text or notes. |
| `Esc` | Cancel the questionnaire. |
| `Tab` / `Shift+Tab` | Switch question tabs. |
| `Space` | Toggle the focused multi-select option. |
| `n` | Open notes for the current question. |
| `Ctrl+G` | Open Pi's external editor for custom text. |
| `Ctrl+U` | Clear the custom answer draft. |
| `Ctrl+]` | Collapse or expand the dialog, when enabled. |

The extension adds these rows after authored choices:

| Row | Where |
| --- | --- |
| **Discuss this** | Every question |
| **Type something.** | Every question, after **Discuss this** |
| **Next** | Multi-select questions only |

All three labels are reserved. The model cannot author an option with them.

## Discussion thread

In a terminal, press Enter on **Discuss this**. The questionnaire stops rendering and a normal interactive Pi child session takes the terminal. Use native Pi chat and tools in that child.

Run `/resolve [optional outcome]` to return to the questionnaire. With no text, the resolver uses the latest observable assistant response. Ctrl+D or another ordinary child exit returns without changing the question. Re-enter **Discuss this** to resume the same saved child.

The restored ordinary dialog shows the outcome. A context-only result returns focus to **Discuss this**. A complete classified answer focuses the authored option, seeds **Type something.**, or checks the classified multi-options and focuses **Next**. Nothing auto-submits: use Enter or Next to accept, or choose another answer.

## Notes and collapse

Notes remain side-band text keyed by question. Writing a note does not mark a question answered. `Ctrl+]` hides the overlay and leaves a one-line restore hint; the raw terminal listener captures the configured collapse key while hidden. All other hidden-overlay input is ignored except cancel.

## Layout

Single-select options with previews render side-by-side when the terminal is wide enough and stack otherwise. Multi-select uses checkbox rows. When the dialog exceeds the terminal height, the body scrolls between a sticky heading and footer with `↑`, `↓`, or `↕` overflow markers.
