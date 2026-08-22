# Add Ctrl+T fzf file selection for Pi file references

## Context

Pi already treats `@...` as a file reference and provides an inline fuzzy autocomplete list. In the current Pi 0.84.2 runtime, `Ctrl+T` normally toggles thinking blocks, and that action is protected from extension shortcut overrides. The requested “@ block” will therefore be defined precisely as the **active @ file-reference token** immediately before the editor cursor: either an unquoted token such as `@src/par` or an unclosed quoted token such as `@"docs/my f`.

The implementation should be a global Pi extension under `pi/agent/extensions/`, not a Pi core fork. It must compose with the installed `pi-vim` custom editor. Because `pi-vim` only supports wrappers loaded after it, the extension must also be listed immediately after `npm:pi-vim` in `pi/agent/settings.json`; auto-discovery will deduplicate the same extension path. `Ctrl+T` outside an active file-reference token must continue to perform its existing thinking-block action, so `pi/agent/keybindings.json` should remain unchanged.

The picker will use the repository-managed `fd` and `fzf` executables. Candidate behavior will align with Pi’s built-in file autocomplete: search from `ctx.cwd`, respect ignore files, include hidden files, follow links, and exclude `.git`. The selection is singular. A partial `@` query seeds fzf, and paths containing spaces are inserted with Pi-compatible quoting.

No glossary or ADR change is warranted: this is a reversible editor interaction that uses Pi’s existing “file reference” concept and extension boundaries.

## Approach

Implement this as a conditional editor decoration plus a one-shot autocomplete-provider layer. The editor decoration decides whether `Ctrl+T` belongs to the file picker or the existing Pi action; the provider launches fzf and hands the selected path back to Pi’s native completion application. This keeps process interaction separate from text mutation and avoids replacing either Pi’s editor semantics or `pi-vim`.

### Part A — Add a composable fzf file-reference extension
- **Ledger:** {"status":"completed","note":"Added the composable fzf file-reference extension, including active-token/quoting/fzf helpers, an in-place pi-vim-preserving editor decorator, one-shot provider, and TUI process handoff.","evidence":"Red→green focused Node harness: 6/6 Part-A cases pass via `node --test --test-name-pattern='finds|rejects|builds|composes|arms|picker' pi/agent/extensions/fzf-file-picker/test/*.test.mjs`. Offline explicit-entry smoke passes via `PI_BIN=/opt/homebrew/bin/pi node pi/agent/extensions/fzf-file-picker/test/smoke-load.mjs`; `fd 10.4.2` and `fzf 0.74.1` support the required options."}

Create a focused extension with testable helpers for active-token detection, fzf argument construction, NUL-delimited result handling, and Pi-compatible completion values. Start with failing unit cases for bare, partial, quoted, cursor-middle, and invalid `@` contexts.

On `session_start` in TUI mode, layer an autocomplete provider over Pi’s current provider and wrap the editor factory that is already installed. Decorate the existing editor in place so the complete `CustomEditor`/`pi-vim` surface, mode state, callbacks, undo behavior, autocomplete, and rendering remain owned by the original editor.

Intercept `Ctrl+T` only when the cursor is in an active @ file-reference token and, when available, `pi-vim` reports insert mode. Otherwise, delegate the key unchanged so thinking-block toggling and non-insert behavior remain intact. For a matching token, cancel only an already-visible inline autocomplete menu without changing Vim mode, arm a one-shot fzf request, and route through Pi’s forced file-completion path. The provider will return the selected file as one completion and delegate application to Pi’s existing `applyCompletion`, preserving token replacement, cursor placement, quoting, change notification, and undo semantics instead of mutating editor internals.

Launch `fd` and `fzf` as argument arrays rather than a shell command. Stream NUL-delimited `fd` output into fzf, use path scoring and the existing `FZF_DEFAULT_OPTS`, seed fzf with the partial token query, and show a single-select reverse 40%-height picker. Suspend and restart the Pi TUI around the interactive child process using the established `ctx.ui.custom()`/`tui.stop()` pattern, forcing a redraw afterward. Escape, no match, or an empty result must leave the prompt unchanged; missing executables and genuine process failures should produce a concise warning and still restore the TUI. Prevent overlapping picker launches.

Observable outcome: `@` followed by `Ctrl+T` opens fzf; selecting a file replaces the active token with one valid Pi file reference; cancellation is lossless; and ordinary inline `@` completion still works when `Ctrl+T` is not used.

### Part B — Integrate after pi-vim and prove regressions are absent
- **Ledger:** {"status":"blocked","note":"Implementation and automated integration verification are complete, but the required Stow deployment could not finish in this sandbox and the full live TUI canary matrix cannot be completed here.","evidence":"`npm --prefix pi/agent/extensions/fzf-file-picker run check` passed (7 harness tests plus offline explicit-entry smoke). Existing git-tree-checkpoints extension harness passed 13/13 and its smoke passed. A normal global Pi load passed offline. Scripted PTY canaries confirmed bare `@` Ctrl+T selection inserted one `@./AGENTS.md` reference and a partial quoted selection with a spaced filename inserted exactly `@\"./pi/agent/extensions/fzf-file-picker/test/tmp fzf picker file.txt\"`. `./install.sh config` was attempted as required but stopped before Stow: sandbox denied removal of existing `~/.zshrc`, `~/.zsh_profile`, `~/.bashrc`, and `~/.bash_profile`. A scripted Escape cancellation attempt timed out after fzf exited because the noninteractive PTY/input shutdown sequence left Pi open; no source failure was observed, but interactive cancellation, Ctrl+T thinking-toggle, and normal/visual Vim canaries remain unverified."}

Add the local extension directory to `pi/agent/settings.json` immediately after `npm:pi-vim`. Preserve all unrelated existing settings and working-tree changes. This ordering is an integration requirement: the fzf extension must wrap the editor created by `pi-vim`, not be overwritten by it. Deploy through the repository’s required Stow workflow with `./install.sh config`; do not create or replace symlinks manually.

Add an extension-load smoke test and focused harness coverage for editor/provider composition: delegation outside `@`, delegation in non-insert Vim modes, one-shot picker activation, active autocomplete cancellation, selected/cancelled/error outcomes, and settings order. Review the final diff to confirm that no unrelated editor, keybinding, Pi package, or dotfile behavior changed.

Observable outcome: Pi loads both extensions without diagnostics, the wrapper is active after `pi-vim`, and existing `Ctrl+T`, Vim editing, and built-in autocomplete behavior remain available outside the new context.

## Critical Files

- `pi/agent/extensions/fzf-file-picker/` — new extension, process integration, pure token/completion helpers, and focused tests.
- `pi/agent/settings.json` — establishes the required `pi-vim` then fzf-wrapper load order.
- `pi/agent/keybindings.json` — read-only regression boundary; `Ctrl+T` must not be globally rebound or disabled.
- `~/.pi/agent/npm/node_modules/pi-vim/index.ts` — read-only compatibility reference for the editor wrapper surface and insert-mode detection.

## Verification

- Run the new unit/harness tests with Node’s test runner. Success means all active-token, quoting, cancellation, delegation, process-error, and load-order cases pass.
- Run a Pi extension smoke load in offline mode with normal extension discovery disabled and only the new entry point supplied. Success means no load, syntax, shortcut-conflict, or extension diagnostics.
- Run the repository’s relevant existing Pi extension smoke/tests affected by editor or package loading; treat any new failure as a regression.
- After `./install.sh config`, perform TUI canaries:
  - Type bare `@`, press `Ctrl+T`, select a normal path, and confirm one `@relative/path` token is inserted at the cursor.
  - Type a partial and a quoted/spaced file reference, confirm fzf starts with that query, and confirm the selected token is replaced and quoted correctly.
  - Cancel fzf with Escape and confirm text, cursor context, and Vim insert mode remain usable.
  - Press `Ctrl+T` outside an active `@` token and confirm thinking blocks still toggle.
  - In pi-vim normal/visual modes, confirm `Ctrl+T` does not open fzf and representative insert, normal, autocomplete, submit, and undo operations still work.
- Failure signals include a blank or corrupted terminal after fzf exits, duplicate `@`, loss of prompt text on cancellation, fzf opening outside the active token, `pi-vim` being replaced, or a startup extension-order/conflict warning.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Add a composable fzf file-reference extension
- ⛔ Integrate after pi-vim and prove regressions are absent
<!-- pi-plan-mode:progress:end -->
