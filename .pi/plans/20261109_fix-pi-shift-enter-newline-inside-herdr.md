# Fix Shift+Enter newlines in Pi inside Herdr

## Context

The existing Claude-compatible Ghostty mapping in `ghostty/config` sends Shift+Enter as `ESC + Return` (`\x1b\r`). Preserve this unrelated, uncommitted mapping and the working Claude behavior.

The installed Pi 1.5.0 parser interprets that sequence differently depending on negotiated keyboard mode. A read-only reproduction with its actual `matchesKey`, `parseKey`, and `setKittyProtocolActive` functions confirmed:

- Kitty active: `ESC + Return` matches Shift+Enter.
- Kitty inactive: the same sequence matches Alt+Enter, Pi's follow-up action, not newline.
- Explicit CSI-u Shift+Enter (`\x1b[13;2u`) matches Shift+Enter in both modes.

This explains the reported failure along the legacy Herdr input path. The exact physical-key path and live negotiation have not yet been captured; deployment must include a physical-key smoke check rather than treating parser evidence as end-to-end proof.

Pi documentation describes Shift+Enter as a newline, but its legacy parser does not treat this custom terminal mapping as Shift+Enter. This is an input-encoding mismatch, not a missing newline binding. Current `pi/agent/keybindings.json` leaves the default newline binding intact. Pi also loads a Vim editor and an fzf editor wrapper, so the fix must compose with them rather than replace the editor.

Use Pi's supported terminal-input transformation API. No installed Homebrew package patches, launcher changes, Herdr configuration changes, or global keybinding changes are needed. The accepted ambiguity is that legacy Alt+Enter and Shift+Enter can produce identical bytes inside Herdr.

## Questions & Answers

| Question | Answer |
|---|---|
| Inside Herdr, should Pi treat ESC + Return as a newline, even when legacy Alt+Enter sends the same sequence? | Herdr-only normalization (Recommended): normalize it inside Herdr without changing Ghostty or Claude. Legacy Alt+Enter also becomes newline inside Herdr; explicitly encoded Alt+Enter remains a follow-up. |

## Approach

Add a small auto-discovered Pi extension that normalizes the ambiguous Herdr event into explicit CSI-u Shift+Enter. Transform input before application shortcuts and focused components receive it, retaining their existing editing semantics. Do not insert text directly, force Kitty protocol state, or introduce a second editor implementation.

### Part A — Normalize Herdr input and verify newline behavior
- **Ledger:** {"status":"completed","note":null,"evidence":"User confirmed manual host installation and, after the revised normalizer, reported 'works' and requested a scoped commit. Revised scope was explicitly approved: normalize all Herdr Alt+Enter encodings, including CSI-u and modifyOtherKeys, while leaving releases and unrelated inputs unchanged. Herdr v0.9.5 source confirmed ESC+Return decoding and protocol re-encoding. All 10 installed-runtime regression tests passed again before commit; all 5 check:ui tests passed; git diff --check passed. Tests cover framing, real TUI dispatch/editors, both Kitty modes, submission avoidance, paste/pass-through, lifecycle cleanup, and modal/fzf composition. A disposable pinned pi-vim probe confirmed newline behavior. Full npm --prefix pi run check from an ordinary host terminal remains unverified: sandbox attempts failed in launcher/extension smoke paths using generated HOME. No claim is made that the full native SRT/Docker gate passed or that separate idle/busy/Claude physical checks were individually observed. Latest user request authorizes committing the existing Ghostty Shift+Enter mapping alongside extension, tests, documentation, saved plan, and only the related AGENTS.md additions. Unrelated settings, Obsidian, stack-review and workflow edits remain excluded."}

Add a narrowly scoped extension under `pi/agent/extensions/herdr-shift-enter/`. During `session_start`, register `ctx.ui.onTerminalInput` only in TUI mode when `TERM_PROGRAM` identifies Herdr. Translate only the complete input event equal to `\x1b\r` into `\x1b[13;2u`; pass all other events through unchanged. Use the returned unsubscribe function for idempotent shutdown cleanup and verify session replacement and reload do not accumulate listeners.

The exact-event restriction must leave bracketed paste payloads, unrelated escape sequences, plain Return, Ctrl+J, explicit Shift+Enter, and explicit Alt+Enter untouched. Use the existing Pi input framing rather than adding timers or a stream parser. Verify its framing preserves the complete legacy event; if evidence contradicts this assumption, pause and revise the solution before broadening it.

Add regression coverage using the installed Pi runtime through `pi/test-helpers.mjs`. Reproduce the legacy misclassification first, then verify the normalized event inserts a newline without submitting or invoking follow-up. Include tests for active and inactive Kitty mode, Herdr-only activation, non-TUI modes, pass-through inputs and paste, and listener cleanup. Exercise actual TUI listener dispatch and an actual editor, not only a mocked callback; cover focused multiline UI and ensure editor composition is preserved.

Integrate the regression test into `pi/test-gate.mjs`. Add concise extension documentation explaining the encoding mismatch, scope, accepted legacy Alt+Enter ambiguity, and reload instructions. Keep the saved approval plan alongside the eventual implementation commit, as repository policy requires; do not commit or modify unrelated work.

Deploy only through `./install.sh config`, preserving existing settings and unrelated dirty files. The installer may stop because unrelated Obsidian settings are already modified; do not discard or commit those changes to bypass its safety checks. Report any deployment blocker precisely. After successful deployment, reload or restart Pi and perform the Herdr smoke check. Acceptance requires Shift+Enter to add a line without sending the draft, ordinary Enter to retain submission behavior, and Claude's existing mapping to remain unchanged.

## Critical Files

- `pi/agent/extensions/herdr-shift-enter/`: new Pi-side input compatibility boundary, tests, and short usage documentation.
- `pi/test-gate.mjs`: include deterministic regression coverage in the normal gate.
- `pi/test-helpers.mjs`: read-only reference for importing the installed Pi runtime in tests.
- `ghostty/config` and `pi/agent/keybindings.json`: read-only references; preserve the existing terminal mapping and action assignments.

## Verification

New behavior: with Kitty inactive and Herdr detected, type two lines separated by the legacy Shift+Enter event. The editor must contain both lines, and submission and follow-up handlers must remain uncalled. Repeat through actual TUI dispatch with a focused multiline component and with Kitty active.

Regression checks: plain Enter still submits; explicit CSI-u Alt+Enter still invokes follow-up; Ctrl+J and explicit Shift+Enter remain unchanged. Non-Herdr and non-TUI sessions install no normalizer. Paste containing the byte pair is not rewritten. Repeated session start/shutdown and reload leave exactly one active subscription, then none after shutdown. Preserve Vim-mode behavior and fzf editor ownership.

Run the narrow extension tests and `npm --prefix pi run check:ui`. Before completion, run `npm --prefix pi run check` from an ordinary host terminal as required by `pi/AGENTS.md`; if sandbox restrictions prevent this, state the unverified gate and its cause.

End-to-end smoke: after Stow deployment and reload or restart, physical Shift+Enter inside Herdr inserts a newline while idle and while composing during an agent response. It must not clear or queue the draft. Verify ordinary Enter and Claude still work. Failure to reproduce this is a signal to inspect the received event and keyboard negotiation, not to claim the fix is complete.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Normalize Herdr input and verify newline behavior
<!-- pi-plan-mode:progress:end -->
