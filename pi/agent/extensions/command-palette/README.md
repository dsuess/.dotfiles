# Model cycling gesture

In Pi's TUI, a short Ctrl+. tap cycles forward when the key is released. Holding Ctrl+. for 200 ms opens the command palette's searchable model selector without cycling first. Escape leaves the model unchanged. Ctrl+Shift+. still cycles backward.

The gesture requires Kitty keyboard event reporting and a focused prompt. It activates only after Pi has received a key-release event in the current session, because some terminals and multiplexers accept the Kitty protocol but do not forward releases. Until then, and on legacy input, Ctrl+. keeps native immediate cycling. The first press after startup can therefore cycle natively.

Pi must load the palette after pi-vim and the fzf wrapper; `agent/settings.json` lists it in that order. If your launch command uses `--no-extensions`, the gesture is not loaded.

## Verify and deploy

Run `node --test pi/agent/extensions/command-palette/*.test.mjs` for the focused tests. `runtime.test.mjs` drives Pi's real interactive runtime and extension loader. Run `npm --prefix pi run check` from an ordinary host terminal for the full gate.

Deploy from an ordinary host terminal with `./install.sh config`, then reload or restart Pi. Tap and hold Ctrl+. both directly in Ghostty and inside Herdr, while idle and during a response. Confirm the tap cycles once on release, the hold opens one selector without changing the model, Escape preserves the model, and the draft stays intact. Check Ctrl+Shift+. and another open dialog as well. These physical checks are separate from automated protocol simulation.
