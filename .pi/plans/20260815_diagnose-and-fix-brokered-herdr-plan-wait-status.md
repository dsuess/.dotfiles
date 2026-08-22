# Restore Herdr status in sandboxed Pi sessions

## Context

The repository is not the behavior boundary. Live Herdr evidence shows that the normal sandboxed launch path is failing while a direct/native launch works:

- `w12:p5`, `w12:p6`, and `w16:p3` all run through `~/bin/pi`, have a live `herdr-status-broker.mjs`, but have no Herdr `agent_session` and no `screen_detection_skipped` flag.
- The plan-approval dialog is visibly open in `w12:p6`, yet `herdr agent explain w12:p6` uses `default_known_agent_idle_fallback` instead of reporting `blocked`.
- Green `working` states in `w12:p5` and `w16:p3` come from Herdr’s `working_literal` screen rule, including stale terminal text, rather than Pi lifecycle reports.
- `w16:p1` is the apparent exception: its process tree is a direct Pi process rather than the normal wrapper/broker chain. It has a current Pi session reference and `full_lifecycle_hook_authority`. Whether it was started with `--yolo` or by bypassing the wrapper, its native Herdr transport—not the `.dotfiles` working directory—is the material difference.

The loopback broker itself starts and accepts authenticated HTTP: all three sandboxed panes have listening broker processes, and the current broker distinguishes a valid token from an unauthorized request. The remaining failure is therefore between the sandboxed Pi reporter, broker forwarding, and Herdr authority establishment; broker process readiness alone is not sufficient evidence.

This contradicts `pi/sandbox/README.md`, which says a root TUI reports its current session before lifecycle state and becomes authoritative. It also exposes a test-composition gap. All current suites pass—six reporter tests, fourteen feedback-state tests, and seven combined reporter/broker tests—but they exercise mocked HTTP, the broker, and wrapper environment propagation separately. None proves that the real sandbox runtime, wrapper, loaded Pi extension, broker, and Herdr protocol establish authority together.

Keep the canonical state meanings: `blocked` means Pi is waiting for input or approval; `working` means active agent execution; `idle` means settled without a pending decision. Preserve the authenticated, status-only broker and do not expose Herdr’s native socket to sandboxed Pi. Preserve unrelated uncommitted settings and shell changes. No glossary or ADR is warranted because this repairs the existing documented lifecycle contract rather than introducing a domain term or architectural decision.

## Approach

Fix the actual sandboxed lifecycle path rather than adding plan-dialog screen patterns. Screen detection cannot reliably distinguish a current wait from stale `Working...` scrollback, while the existing feedback and plan-workflow events already carry the semantic state.

### Part A — Reproduce the real sandboxed authority failure

Add a composed regression boundary that uses the production wrapper environment, real sandbox-runtime launch path, real `herdr-agent-state.ts`, status broker, and a controlled fake Herdr Unix endpoint. Drive a root TUI lifecycle far enough to report a real session reference, then emit the durable plan approval state and leave the action dialog unresolved.

Instrument only the test boundary needed to identify where authority is lost: verify the reporter sees `HERDR_ENV`, pane identity, broker port, and token; verify the broker receives each request; retain broker response status and forwarding rejection details; and verify the fake Herdr endpoint observes session, metadata, and state in order. Do not log the bearer token or expose it to normal application output.

The regression must distinguish these failure classes rather than treating any missing final state as equivalent:

- extension disabled or not loaded;
- lifecycle callback not entered as a root TUI;
- sandboxed loopback request denied or misrouted;
- broker authentication/canonicalization rejection;
- native Herdr forwarding rejection;
- session report accepted but lifecycle authority not retained.

Keep the existing isolated tests. Their speed and precision remain useful, but the composed test becomes the acceptance boundary for the launch path that fails live.

Acceptance outcome: the current code fails the composed test at the same boundary observed in normal panes, while the direct/native control case remains authoritative.

### Part B — Repair brokered lifecycle authority

Apply the smallest fix at the boundary identified in Part A. A normal root TUI must establish one current reporter generation, send its canonical session reference before any lifecycle state, and receive an acknowledged broker response before treating delivery as successful. Failed startup delivery must not silently leave Herdr on screen detection; retain bounded retries and expose a concise, non-secret diagnostic through the existing Pi notification or debug path.

Preserve the current state model and ordering rules:

- durable plan approval and staged checkpoints remain `blocked` until resolved;
- blocking custom/select/editor UI composes with durable waits without clearing them early;
- `blocked` retains precedence over `working` and `idle`;
- retired or reloaded reporter generations cannot reclaim authority;
- non-TUI sessions remain silent;
- direct/native and sandboxed broker transports remain separate.

Do not broaden broker methods, weaken token authentication, expose `HERDR_SOCKET_PATH` inside the sandbox, add a Herdr or Ketch network broker beyond the existing status capability, or compensate with screen-scraping rules. If the failure is caused by wrapper environment propagation, fix and test that propagation. If it is caused by broker canonicalization or Herdr acknowledgement handling, repair that contract without bypassing the broker.

Acceptance outcome: a sandboxed root Pi reports an active `agent_session`, Herdr disables screen detection for that pane, and an unresolved plan action dialog reports `blocked` with `waiting for feedback`.

### Part C — Lock in diagnostics and operational guidance

Extend wrapper, reporter, broker, and feedback regression coverage only where needed for the proven failure. Include startup acknowledgement failure, successful authority establishment, session replacement/reload, stale retry suppression, and unresolved plan approval. Ensure tests fail with a transport- or authority-specific assertion instead of only observing a wrong sidebar color.

Update `pi/sandbox/README.md` to describe the validated startup signal and troubleshooting check. Document that a live broker process is not sufficient: `herdr agent get <pane>` must include the current Pi session, and `herdr agent explain <pane>` must show `full_lifecycle_hook_authority`. State that fallback `working_literal` or `default_known_agent_idle_fallback` during a Pi question indicates integration failure. Keep the documented security boundary unchanged.

Deploy only through the existing Stow workflow. Do not replace symlinks manually, and do not overwrite the generated Herdr integration without preserving the tracked broker adaptation.

## Critical Files

- `bin/pi` — starts the sandboxed Pi process, status-only broker, and broker capability environment.
- `pi/agent/extensions/herdr-agent-state.ts` — establishes session identity, transport acknowledgement, lifecycle ordering, and reporter authority.
- `pi/agent/extensions/herdr-feedback-state/index.ts` — converts blocking UI and durable plan workflow waits into semantic `herdr:blocked` events.
- `pi/sandbox/herdr-status-broker.mjs` — authenticates, canonicalizes, and forwards the narrow Herdr status capability.
- `pi/sandbox/test-wrapper.sh` and `pi/sandbox/test-herdr-agent-state.mjs` — existing boundaries to connect with a real sandboxed launch regression.
- `pi/sandbox/README.md` — currently documents authority as guaranteed and must reflect the validated diagnostic contract.

## Verification

Regression checks:

- Run the reporter, feedback-state, broker, wrapper, repository-scope, and plan workflow-dialog suites. Existing direct-socket, retry, reload, overlapping wait, and sandbox containment scenarios must remain green.
- Confirm the broker still accepts only canonical status/session/metadata/release methods, confines session paths, fixes caller-controlled identity fields, and never exposes the native Herdr socket to sandboxed Pi.
- Review the final diff and confirm unrelated `pi/agent/settings.json`, `zsh/.zshrc`, and other user changes are untouched.

New-feature scenarios:

1. Launch the composed sandbox fixture with a fake Herdr endpoint. Verify session, metadata, and initial lifecycle reports arrive in order through the broker.
2. Enter planning mode, submit a plan, and keep the action dialog open. Verify the latest canonical state is `blocked` with `waiting for feedback` and no screen fallback is involved.
3. Resolve the dialog into implementation and verify `working`; dismiss it with no active turn and verify `idle` while durable pending approval remains available for reopening as designed.
4. Reload or replace the Pi session while a wait is active. Verify only the current generation reports and the new session reference precedes its state.
5. Break each startup boundary deliberately in the fixture. Verify the test or diagnostic identifies extension disablement, HTTP failure, broker rejection, or Herdr forwarding failure without exposing credentials.

Live canary after Stow deployment:

- Start a normal sandboxed Pi in both `.dotfiles` and another repository. Repository location must not change behavior.
- `herdr agent get <pane>` must include the current Pi `agent_session`.
- `herdr agent explain <pane>` must report `screen_detection_skip_reason: full_lifecycle_hook_authority`.
- While the plan action dialog or another blocking Pi question is visible, Herdr must report `blocked`. After the answer, it must transition to `working` or `idle` according to Pi lifecycle.
- A `working_literal` match, `default_known_agent_idle_fallback`, missing session reference, or merely listening broker with no authority is a failure signal.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☐ Reproduce the real sandboxed authority failure
- ☐ Repair brokered lifecycle authority
- ☐ Lock in diagnostics and operational guidance
<!-- pi-plan-mode:progress:end -->
