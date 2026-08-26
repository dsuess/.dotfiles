# Make Pi `--yolo` Inherit into Subagents

## Context

`bin/pi --yolo` removes the wrapper-only flag and executes the installed Pi binary directly, but it currently leaves the caller’s `PATH` unchanged. The `subagent` runtime starts each child with the command name `pi` and inherits that `PATH`. When `~/bin/pi` precedes the installed binary—as it does in the normal shell configuration—the child resolves the wrapper again without `--yolo`, enters the normal Gondolin startup path, and therefore does not inherit the parent’s unsandboxed mode.

The normal sandboxed launcher already prevents the analogous wrapper re-entry by putting the installed Pi binary directory first in the child-facing `PATH`. Apply the same executable-precedence rule to the yolo launch while retaining yolo’s distinct contract: no Gondolin controller, no environment filtering, no private tool normalization, and no change to model-scope handling. Here, “inherit `--yolo`” means a subagent-style nested `pi` launch resolves the installed binary directly and remains unsandboxed; it does not mean forwarding a public Pi flag or introducing an ambient mode variable.

`pi/sandbox/README.md` currently says yolo is entirely outside the PATH contract because it inherits the unfiltered host environment. Sharpen that documentation: yolo still preserves the unfiltered host environment and host PATH entries, but it gives the installed Pi binary precedence so child Pi processes cannot accidentally re-enter the sandbox wrapper. This operational contract belongs in the sandbox README; no domain glossary or ADR is warranted for this small, reversible bug fix.

The workspace already contains unrelated changes. Keep this work limited to the launcher, its focused regression fixture, the sandbox documentation, and the committed plan document.

## Approach

Use launcher-level Pi executable resolution rather than modifying the subagent API. This fixes the root cause at the process boundary and keeps the existing subagent contract—spawn `pi` in the inherited process environment—unchanged.

### Part A — Preserve yolo mode across nested Pi launches
- **Ledger:** {"status":"completed","note":"Yolo now gives the resolved installed Pi directory executable precedence while preserving the remainder of the host PATH and all other host environment values.","evidence":"`bin/pi` sets `PATH=\"${real_pi%/*}:${PATH-}\"` immediately before its yolo `exec`; no controller, filtering, tool parsing, or subagent-runtime changes were made."}

Adjust the `--yolo` branch in `bin/pi` so the directory containing the resolved installed Pi executable is first in the environment’s `PATH` before the wrapper `exec`s that executable. Preserve the caller’s remaining PATH and all other host environment values without applying the normal sandbox allowlist.

Keep all existing yolo boundaries intact: print the warning, bypass QEMU/controller/image/handshake work, retain automatic or explicit model scoping, and pass through tool and other Pi arguments unchanged after removing only `--yolo`. Do not add an inheritance environment variable or teach the subagent extension about the wrapper-specific flag; executable precedence is sufficient and also avoids a spoofable second source of mode state.

Acceptance outcome: from a yolo parent, the subagent runtime’s existing `spawn("pi", ...)` reaches the installed Pi binary directly, with no `PI_GONDOLIN_SANDBOX` state and no controller startup. Normal sandboxed launches continue to use their filtered, installed-Pi-first PATH contract.

### Part B — Lock the process-boundary contract with tests and documentation
- **Ledger:** {"status":"completed","note":"Added and verified the yolo nested-Pi regression fixture and documented the normal/yolo PATH contracts.","evidence":"`bash pi/sandbox/test-wrapper.sh` passed its new installed-Pi nested probe (no preflight); subagent tests passed 29/29; `npm --prefix pi/sandbox test` passed all suites; `git diff --check` passed."}

Extend `pi/sandbox/test-wrapper.sh` with a subagent-style nested-Pi probe under `--yolo`. Verify that the nested command resolves and executes the fake installed Pi rather than the wrapper, remains unsandboxed, and does not invoke the fake controller. Retain assertions that yolo still exposes the host environment, preserves forwarded arguments, and honors automatic and explicit model scopes. Keep the existing normal-launch PATH-order tests as regression coverage for the sandboxed path.

Update the PATH-contract and unsandboxed-bypass sections of `pi/sandbox/README.md` to state that yolo preserves the unfiltered host environment but moves the installed Pi directory ahead of the wrapper specifically for child Pi and subagent inheritance. Record this canonical plan with the implementation commit, as required by the repository workflow.

## Critical Files

- `bin/pi` — owns `--yolo` detection, installed-Pi resolution, model-scope forwarding, and the child-facing process environment.
- `pi/sandbox/test-wrapper.sh` — provides the fake wrapper/real-Pi/controller boundary needed to reproduce and prevent nested yolo re-entry.
- `pi/agent/extensions/subagent/runtime.js` — read-only integration anchor showing that children intentionally spawn the command name `pi` with the inherited environment.
- `pi/sandbox/README.md` — documents the normal and yolo PATH/process-boundary contracts.

## Verification

- **New bug scenario:** Run the focused wrapper test and observe a yolo parent’s nested `pi` probe execute the fake installed binary directly, report no sandbox state, and produce no controller preflight.
- **Yolo regressions:** Confirm host credentials/environment remain visible, the warning remains present, forwarded tool arguments are not normalized, and automatic, bare, and explicit model-scope cases still pass.
- **Normal regressions:** Confirm normal launches still resolve nested `pi` to the installed binary while preserving the filtered safe PATH order and Gondolin handshake behavior.
- **Subagent contract:** Run the subagent extension tests to confirm children still use the inherited environment and command-name launch without API/schema changes.
- **Final suite:** Run `npm --prefix pi/sandbox test`. Review the final diff to ensure unrelated existing changes were not modified. A failure showing controller activity during the yolo nested probe means executable precedence is still wrong.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Preserve yolo mode across nested Pi launches
- ☑ Lock the process-boundary contract with tests and documentation
<!-- pi-plan-mode:progress:end -->
