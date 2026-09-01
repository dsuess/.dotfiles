# Restore reliable zsh Esc-. last-argument insertion

## Context

The requested behavior is zsh’s `insert-last-word` history action: Esc followed by `.` must insert the previous command’s last argument, and repeated uses must walk backward through older history entries. It is not vi dot-repeat and it is not full-command recall.

The current `zsh-vi-mode` configuration instead interprets a standalone Esc as entry into vi normal mode and binds normal-mode `.` to `zvm_repeat_change`. The existing `zvm_update_repeat_commands` wrapper in `zsh/.zshrc` was added to repair that vi repeat state, so it addresses the wrong behavior and can still produce corrupted command lines for this shortcut.

The plugin’s NEX read-key engine waits only 0.03 seconds to decide whether Esc is standalone or the prefix of a Meta sequence. Therefore, Alt-. and a quickly typed Esc-. can arrive as one insert-mode sequence, while a separately pressed Esc then `.` reaches the normal-mode binding. Reliability requires both paths to invoke the same history widget rather than increasing the timeout and delaying ordinary vi mode changes.

`zsh-vi-mode` initializes lazily and installs its normal-mode bindings only when normal mode is first entered. The fix must use the plugin’s post-initialization and post-lazy-binding hooks so later plugin setup cannot overwrite the shortcut. The accepted trade-off is that normal-mode `.` will perform last-argument insertion instead of vi dot-repeat. Plain `.` in insert mode remains a literal period. No plugin submodule, glossary, or ADR change is warranted for this narrow and reversible keybinding choice.

## Questions & Answers

| Question | Answer |
|---|---|
| What should Esc followed by `.` produce at a fresh prompt? | Insert the prior command’s last argument; repeated uses walk backward through history. |
| Which input gesture must work reliably? | Both a separately pressed Esc then `.`, and the Alt-. chord. |
| What should plain `.` do when already in vi normal mode? | Use the shell last-argument behavior instead of vi dot-repeat. |

## Approach

Replace the obsolete vi-repeat workaround with one ZLE widget that normalizes both key paths before delegating argument selection to zsh’s native `.insert-last-word` widget. Integrate it through the existing `zsh-vi-mode` lifecycle hooks so the behavior survives lazy initialization without changing the plugin or its timing configuration.

### Part A — Bind both Esc-. paths to native last-argument insertion
- **Ledger:** {"status":"blocked","note":"Sandbox denies all writes to files named .zshrc, including the canonical Stow source, while allowing writes elsewhere in zsh/. Implementation cannot be applied in this session without changing the sandbox permission/profile.","evidence":"functions.edit on zsh/.zshrc returned EPERM; `touch zsh/.zshrc` and Python append returned Operation not permitted; creating a test .zshrc in zsh/pi-test was also denied, while creating/removing zsh/pi-write-test succeeded. No project files were changed."}

In `zsh/.zshrc`, remove the `zvm_update_repeat_commands` compatibility wrapper because custom vi dot-repeat is no longer the desired behavior.

Add a private ZLE widget that delegates history parsing, quoting, and repeated-history traversal to zsh’s built-in `.insert-last-word`. When invoked from vi normal mode, first re-enter insert mode with append semantics so insertion occurs after the normal-mode cursor—the same location where the user was typing before Esc—and subsequent typing continues naturally.

Bind the complete Esc-. sequence in `viins` from the existing `zvm_after_init` hook, after the fzf bindings are restored. This covers Alt-. and fast escape-prefixed input. Add a `zvm_after_lazy_keybindings` hook that replaces normal-mode `.` only after the plugin has installed its delayed bindings. This covers a separately pressed Esc then `.` regardless of the NEX escape timeout and implements the accepted replacement of vi dot-repeat.

Keep the change confined to the canonical Stow-managed config. Do not increase `ZVM_ESCAPE_KEYTIMEOUT`, switch read-key engines, modify the `zsh-vi-mode` submodule, alter insert-mode literal `.`, or disturb the existing fzf `Ctrl+R` setup.

Acceptance outcome: fast and delayed Esc-. input both insert exactly one correctly quoted last argument at an empty prompt or after a typed command prefix; repeating the full gesture replaces it with arguments from older history entries; normal-mode `.` has the same shell-history behavior; no continuation prompt, duplicate character, or malformed buffer appears.

## Critical Files

- `zsh/.zshrc` — canonical configuration and sole modification boundary; owns the custom widget and plugin lifecycle hooks.
- `my-zsh/plugins/zsh-vi-mode/zsh-vi-mode.zsh` — read-only reference for NEX escape handling, lazy `vicmd` bindings, and hook ordering.

## Verification

- **Regression checks:** Validate `zsh/.zshrc` syntax, inspect the final diff, and start a clean interactive zsh with the pinned plugin without initialization errors. Confirm the plugin submodule remains unchanged.
- **Fast-sequence scenario:** In a PTY session, send Esc and `.` together after a history entry. Confirm the exact last argument is inserted and can be executed as part of a typed command prefix.
- **Delayed-sequence scenario:** Repeat with a delay longer than `ZVM_ESCAPE_KEYTIMEOUT` between Esc and `.`. The resulting buffer and command output must match the fast case.
- **History traversal:** Seed newer and older history entries, invoke the full shortcut repeatedly, and confirm the inserted argument is replaced with the older value rather than appended or garbled.
- **Quoting edge case:** Recall an argument containing spaces and quotes. Confirm zsh preserves valid shell quoting and the executed command receives one exact argument.
- **Binding canaries:** After lazy normal-mode initialization, confirm `viins` Esc-. and `vicmd` `.` resolve to the new widget, insert-mode plain `.` remains literal, and insert-mode `Ctrl+R` remains bound to the fzf history widget.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ⛔ Bind both Esc-. paths to native last-argument insertion
<!-- pi-plan-mode:progress:end -->
