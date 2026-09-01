# Fix zsh vi-mode dot-repeat corruption

## Context

The reported “repeat last command” behavior is vi’s dot-repeat: it replays the last line-edit operation. After a command is accepted, `zsh-vi-mode` retains the insertion as the last edit, so pressing `Esc` then `.` on a new prompt reconstructs that command line.

The failure reproduces with the pinned `zsh-vi-mode` submodule in an otherwise clean interactive zsh, without Oh My Zsh, fzf, or Powerlevel10k. `zvm_zle-line-pre-redraw` calls `zvm_update_repeat_commands` once for every inserted character and once more when Enter invokes `accept-line`. On that final callback, the plugin appends the character under the cursor again. For example, the recorded command ends with two closing quotes, so dot-repeat opens a continuation prompt and appears to garble the terminal. The same duplicate occurs with both the NEX and ZLE read-key engines.

The plugin is a clean, upstream-tracking submodule, so the fix will remain in the parent repository’s zsh configuration rather than creating an uncommitted submodule patch or replacing the plugin. No glossary or ADR update is warranted for this narrow, reversible compatibility workaround.

## Approach

The solution will wrap the plugin’s repeat-state updater after Oh My Zsh loads `zsh-vi-mode`. The wrapper will preserve the original function and delegate every normal redraw, but skip the redraw whose `LASTWIDGET` is `accept-line`. This prevents the duplicate final character while retaining the plugin’s custom repeat support for insertions, deletions, changes, replacements, counts, and same-line dot-repeat.

### Part A — Guard accepted lines from repeat-state mutation
- **Ledger:** {"status":"completed","note":"Added the documented parent-config repeat-state wrapper immediately after zsh-vi-mode loads.","evidence":"`zsh -n zsh/.zshrc`, `git diff --check`, and `git -C my-zsh/plugins/zsh-vi-mode diff --quiet` passed. A clean-startup Expect/PTTY session (history disabled) verified a closing quote is stored once, `Esc . Enter` exactly replays the quoted command without a continuation prompt, dot-repeat applies an insert at a second location, and viins Ctrl+R remains bound to fzf-history-widget."}

Add a documented compatibility shim in `zsh/.zshrc` alongside the existing `zsh-vi-mode`/fzf integration. Clone the loaded `zvm_update_repeat_commands` implementation under a private helper name, then redefine the public function to call that helper unless the preceding widget was `accept-line`.

Keep the change scoped to the tracked parent config: do not edit `my-zsh/plugins/zsh-vi-mode`, switch read-key engines, replace dot-repeat with zsh’s native widget, or disturb the existing delayed plugin initialization and fzf rebinding. The guard must be based on the accepting widget rather than a literal carriage-return byte so equivalent accept-line key bindings are covered without suppressing unrelated redraws.

Acceptance outcome: an accepted line is stored exactly once, `Esc . Enter` on the following prompt executes the reconstructed command without extra bytes or a continuation prompt, and dot-repeat still works for edits made before acceptance.

## Critical Files

- `zsh/.zshrc` — canonical Stow-managed zsh configuration and the modification boundary for the compatibility shim.
- `my-zsh/plugins/zsh-vi-mode/zsh-vi-mode.zsh` — read-only upstream submodule reference defining `zvm_update_repeat_commands`, `zvm_zle-line-pre-redraw`, and the `.` binding.

## Verification

- **Regression check:** Run zsh syntax validation on `zsh/.zshrc` and start a clean interactive zsh that loads the configuration without initialization errors.
- **Reported scenario:** In a bounded PTY/Expect session with history disabled, execute a command ending in a quote, inspect the plugin’s repeat array to confirm the quote occurs once, then press `Esc`, `.`, and Enter at the next prompt. Success is one exact replay and a normal prompt; an extra character, `quote>` continuation, or terminal-control debris is a failure.
- **Edit behavior:** Exercise dot-repeat on a second location within the current command line to confirm the wrapper did not disable ordinary vi repeat semantics.
- **Integration canary:** After lazy plugin initialization, confirm the existing fzf `Ctrl+R` insert-mode binding remains installed and no tracked submodule content changed.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Guard accepted lines from repeat-state mutation
<!-- pi-plan-mode:progress:end -->
