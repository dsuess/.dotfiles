# Open the model selector when holding Ctrl+.

## Context

`pi/agent/keybindings.json` binds Ctrl+. to forward model cycling and Ctrl+Shift+. to backward cycling. Pi currently treats repeats as further cycles. The installed Pi 1.5.0 TUI requests Kitty press, repeat, and release reporting, and extension terminal-input listeners run before release filtering.

A hold must open a selector without changing the model. This requires deferring the short-tap cycle until release. Use a fixed approximately 500 ms threshold. Reuse the searchable selector already implemented in `pi/agent/extensions/command-palette.ts`, including its session-model scope, ordering, and `pi.setModel` behavior; do not introduce another selector or patch installed Pi.

The terminal path is Ghostty through Herdr. Protocol support in the parser does not prove that physical release events reach Pi. On input paths without reliable event reporting, retain existing native cycling rather than guess that a missing release means a hold. Ctrl+Shift+. remains unchanged. Unrelated working-tree changes must remain untouched.

## Questions & Answers

| Question | Answer |
|---|---|
| Should holding Ctrl+. preserve the immediate first cycle, or avoid changing models before the selector opens? | Hold opens without cycling. Delay cycling until release for short taps; a hold opens the selector without changing models. |

## Approach

Implement this as a small TUI input gesture integrated with the existing command-palette extension. Keep native forward cycling as the short-tap action and reuse the existing selector as the hold action. Separate gesture state from UI effects for deterministic timing tests.

### Part A — Add release-aware tap and hold handling
- **Ledger:** {"status":"blocked","note":"Physical Ctrl+. release reporting on the actual Ghostty → Herdr path is unverified; this sandbox has no controlling TTY. Stop before intercepting presses as required by the approved plan.","evidence":"stty -a < /dev/tty reports Device not configured; stdin and stdout are not TTYs. Installed Pi terminal.js requests Kitty flags 7 but marks protocol active for any nonzero reply; installed Herdr 0.9.5 changelog says Kitty releases were fixed, which does not demonstrate the current physical input path."}

Inspect the relevant extension and TUI documentation and existing input-test harness in full before editing. Establish a supported event-reporting detection path; do not enable hold timers solely because a legacy key press arrived.

For supported Ctrl+. presses in the main prompt, consume the initial press and start the hold timer. A release before the threshold cancels the timer and forwards one equivalent press through normal TUI dispatch so native cycling, model-selection events, and mode-specific default persistence remain intact. At the threshold, open the existing searchable model selector once without cycling. Consume subsequent gesture repeats and release, including when the selector closes before the key is released. Cancelling the selector must leave the original model unchanged.

Keep the gesture from opening over unrelated dialogs or taking input ownership from other focused components. Choose the smallest supported focus integration after verifying the installed API; do not use private installed-runtime patches. Clear timers and subscriptions on shutdown, reload, and session replacement. Prevent stale timers and async selector completions from affecting a replacement session. Preserve bracketed paste, unrelated keys, Ctrl+Shift+., and non-TUI modes.

If the actual terminal path cannot provide reliable release events or the public integration cannot preserve focus ownership, stop and report the specific limitation rather than silently approximate the agreed behavior. Acceptance: one tap cycles once on release; one hold opens one selector with no preliminary model change.

### Part B — Verify and document the gesture
- **Ledger:** {"status":"blocked","note":"Verification and gesture documentation depend on Part A; no gesture was implemented because physical release behavior is unverified.","evidence":"No implementation exists to test. The sandbox has no controlling TTY, and repository policy reserves the full npm check, deployment, and physical-key smoke tests for an ordinary host terminal."}

Add deterministic gesture and installed-TUI integration tests, following the existing Herdr Shift+Enter test pattern. Include the new tests in `pi/test-gate.mjs`. Verify that native cycling and the existing selector retain their distinct model-selection behavior and planning-profile persistence.

Add concise extension documentation covering the threshold, release-time tap behavior, supported terminal reporting, legacy fallback, unchanged backward shortcut, and host deployment and physical-key verification. No glossary or ADR is warranted for this small reversible UI gesture. Retain the saved plan document with the implementation if changes are committed, as required by repository policy.

Acceptance: focused automated tests pass, documented smoke checks distinguish protocol simulation from physical-key evidence, and no unrelated settings or terminal configuration changes appear in the diff.

## Critical Files

- `pi/agent/extensions/command-palette.ts`: existing selector and extension UI lifecycle; integration boundary for the gesture.
- `pi/agent/extensions/herdr-shift-enter/input.test.mjs`: read-only reference for installed stdin framing and TUI integration testing.
- `pi/test-gate.mjs`: deterministic regression gate registration.
- `pi/agent/keybindings.json`: read-only shortcut contract; retain current bindings.

## Verification

New scenarios: short press/release cycles exactly once; holding beyond the threshold opens exactly one selector without any cycle; repeats cannot reopen the selector or enter its search; Escape preserves the starting model; selecting a model changes it once. Exercise rapid separate taps, release at the threshold boundary, long holds without repeat events, missing release on unsupported paths, and cleanup with a pending timer.

Regression scenarios: backward cycling, native forward-cycle events, scoped-model ordering, planning versus implementation default persistence, draft preservation, unrelated overlays, paste, non-TUI sessions, and repeated extension lifecycle transitions.

Run the narrow focused tests locally where permitted. Run `npm --prefix pi run check` from an ordinary host terminal as required by repository policy; report any checks not run rather than claiming full verification.

Deploy only from an ordinary host terminal with `./install.sh config`, then reload or restart Pi. Physically test Ctrl+. in Ghostty through Herdr, both a tap and a hold, while idle and during a response. Confirm a hold does not change the model before selection and does not modify the draft. Test direct Ghostty if available. Failure to receive releases, duplicate dialogs, accidental cycling, or interception of another dialog blocks claiming end-to-end success.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ⛔ Add release-aware tap and hold handling
- ⛔ Verify and document the gesture
<!-- pi-plan-mode:progress:end -->
