# Herdr Shift+Enter

This extension fixes an input-encoding mismatch in Pi 1.5.0 inside Herdr.
Ghostty sends Shift+Enter as `ESC + Return` (`\x1b\r`) with the existing Claude-compatible mapping.
Herdr decodes those bytes as Alt+Enter and re-encodes them for the pane's negotiated keyboard protocol.
The result can be CSI-u or modifyOtherKeys Alt+Enter, not the original byte pair.
Pi then invokes the follow-up action.

In TUI mode with `TERM_PROGRAM=herdr`, the extension converts Alt+Enter press and repeat events to CSI-u Shift+Enter (`\x1b[13;2u`).
Pi then applies the active component's normal Shift+Enter behavior.
The extension does not replace the editor, insert text directly, or change keyboard protocol state.
It leaves all other events unchanged, including bracketed paste.

All Alt+Enter encodings inside Herdr become Shift+Enter, including explicit CSI-u and modifyOtherKeys events.
Key release events remain unchanged.
Outside Herdr and in non-TUI modes, the extension installs no input listener.
Session shutdown removes the listener, and repeated session starts replace it.

## Deployment

1. Run `./install.sh config` from the repository root.
2. If the installer reports modified Obsidian settings, resolve those changes separately before deployment.
3. In Pi, run `/reload`, or restart Pi.
4. Inside Herdr, use physical Shift+Enter to add a line to a draft while idle.
5. Repeat during an agent response.
6. Check that neither action submits, clears, or queues the draft.
7. Check that ordinary Enter still submits.
8. Check that Claude still accepts the existing Ghostty mapping.

## Regression tests

Run `node --test pi/agent/extensions/herdr-shift-enter/input.test.mjs` from the repository root.
The normal Pi gate also runs these tests.

Tests use the installed Pi runtime, stdin framing, TUI dispatch, main editor, and multiline dialog.
Composition coverage uses Pi's modal-editor example and the repository's actual fzf wrapper.
It does not replace a physical-key check with the installed pi-vim package.
