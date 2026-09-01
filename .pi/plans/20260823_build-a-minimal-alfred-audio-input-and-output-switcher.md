# Build a Minimal Alfred Audio Device Switcher

## Context

The requested replacement has a deliberately narrow scope: `ai` opens a searchable list of connected Core Audio input devices, `ao` opens the equivalent output list, and selecting a row changes the macOS default. The current third-party workflow already claims similar behavior, but the user can only validate that it returns no device list, so the replacement must make discovery failures visible rather than presenting a blank Alfred result.

This repository manages Alfred workflows under `Alfred Workflows/` and deploys them with GNU Stow from `install.sh`. The only tracked workflow today is the unrelated `Hotkey Windows` workflow; it must remain unchanged. The installed third-party path named in the request is not visible inside the Linux planning sandbox, so migration will use a new workflow UUID and preserve the old installation until the replacement passes a macOS smoke test.

The chosen runtime is Homebrew's `switchaudio-osx` formula. `SwitchAudioSource` supports listing, reading, and setting input, output, and system-sound devices, while Alfred Script Filters accept JSON result items with stable IDs, arguments, subtitles, and validity state ([Homebrew formula](https://formulae.brew.sh/formula/switchaudio-osx), [SwitchAudioSource usage](https://github.com/deweller/switchaudio-osx), [Alfred Script Filter JSON](https://www.alfredapp.com/help/workflows/inputs/script-filter/json/)). The workflow will use macOS JavaScript for Automation (JXA) only as a small adapter around that CLI, avoiding the old workflow's Swift compilation path.

“Available” is defined as every currently connected device registered with Core Audio for the requested direction. Discoverable but disconnected AirPlay routes are explicitly outside scope because `SwitchAudioSource` does not expose them reliably ([AirPlay limitation](https://github.com/deweller/switchaudio-osx/issues/63)). Aggregate, virtual, USB, Bluetooth, Continuity, and already-connected AirPlay devices remain eligible when the CLI reports them.

Output selection must update both the default media output and the default system sound-effects output. The CLI implementation can print a failure yet return success from its Core Audio setter, and UID selection is substring-based, so the adapter must not trust command status or use UID matching as proof of success ([upstream setter source](https://raw.githubusercontent.com/deweller/switchaudio-osx/master/audio_switch.c)). It will select the exact numeric device ID from the freshly generated list and then query both defaults to verify the observable state. A partial media/system change is reported accurately rather than claimed as success.

No new domain glossary or ADR is warranted: the terminology is standard macOS/Alfred language, and the selected runtime and migration strategy are easy to reverse. The canonical plan document saved for this work must be committed with the implementation, per repository policy.

## Questions & Answers

| Question | Answer |
|---|---|
| Why build an alternative when the installed workflow already exposes configurable input/output keywords? | The existing workflow is broken. |
| Which replacement runtime should be used? | Use the recommended Homebrew CLI boundary. |
| What should `ao` change? | Change media output and alerts. |
| How should the replacement relate to `user.workflow.B9E1D133-3C38-4CEC-A6A5-F4AF22C8A9E1`? | Create a new workflow, validate it, then retire the old one. |
| Which current failure must the replacement avoid? | No device list; that is the only failure the user can validate. |
| What does “all available sources” include? | Connected Core Audio devices; disconnected AirPlay discovery is not required. |
| What selection feedback is required? | Mark the current device and notify on success or actionable failure. |

## Approach

Create one small, repo-managed Alfred workflow with two Script Filters and a shared JXA adapter. Keep Alfred responsible for query filtering and workflow presentation; keep `SwitchAudioSource` responsible for Core Audio access; keep the adapter responsible for safe parsing, exact selection, verification, and useful errors. Do not copy the feature-heavy favorite, hotkey, remote, or recompilation machinery from the old workflow.

### Part A — Add the managed workflow and dependency
- **Ledger:** {"status":"completed","note":"Added new UUID-managed Audio Device Switcher workflow definition with ai/ao Script Filters, direction-specific actions, shared notification node, and macOS Homebrew dependency.","evidence":"info.plist parsed with Python and contains ai/ao filters; `bash -n install.sh` and `git diff --check` pass. Stow dry run is deferred: this Linux sandbox lacks the vendored Stow prerequisite `perl`."}

Add a new `user.workflow.<UUID>` directory under `Alfred Workflows/` with a unique bundle ID, an `info.plist`, and the shared JXA script. Configure two optional-argument Script Filters:

- `ai`, titled **Audio Input**, lists and filters current input devices.
- `ao`, titled **Audio Output**, lists and filters current output devices.

Each filter connects to a direction-specific switch action and then one notification path. The notification text comes from the adapter so it can distinguish success, complete failure, and the partial case where media output changed but system alerts did not. Use a stable device UID for Alfred's learning key when available, but pass the freshly listed numeric Core Audio device ID to the action to avoid ambiguous substring selection. Keep the workflow minimal: no favorites, extra hotkeys, hidden ignore lists, runtime compilation, or mutable files in the stowed workflow directory.

Add `switchaudio-osx` to the macOS Homebrew CLI tools installed by `install.sh`. Resolve the executable from Alfred's standard Apple Silicon and Intel Homebrew locations and return an invalid, actionable Alfred row when it is absent. Do not source interactive shell configuration or depend on the user's terminal `PATH`.

Acceptance outcome: `./install.sh config` can Stow the new workflow without changing the existing `Hotkey Windows` workflow, and a machine provisioned through `./install.sh software` receives the required CLI.

### Part B — Make discovery and switching observable and exact
- **Ledger:** {"status":"completed","note":"Implemented the shared JXA adapter with safe CLI record parsing, diagnostic Script Filter rows, exact numeric-ID switching, and observed input/output/system verification.","evidence":"`node tests/audio-device-switcher.test.js` passes fixture cases for CRLF, Unicode/punctuation, duplicate names, UID fallback, current marking, missing/empty/malformed/command-current failures, and verified/partial switch notifications. `node --check` passes."}

Implement the adapter around fixed, validated operations only: `list input`, `list output`, `switch input <id>`, and `switch output <id>`. Parse the CLI record format into structured device objects and generate Alfred JSON with `JSON.stringify`, preserving Unicode, quotes, commas, and other device-name characters. Treat malformed command output, command failure, a missing executable, and a genuinely empty device set as distinct invalid result rows so the original blank-list symptom cannot recur silently.

For each list:

- Include every device returned for that direction without favorites or filtering beyond the user's Alfred query.
- Compare against the current default and mark that row with a clear subtitle.
- Use stable match text and autocomplete data so device-name search works naturally.
- Preserve enough identity in each row to disambiguate duplicate display names without exposing noisy identifiers unless needed.

For input selection, set the exact device ID and query the current input afterward. For output selection, set that ID first as the default output and then as the system sound-effects output; query both properties afterward. Return success only when the observed IDs match. If a device disappears between listing and selection, if either property remains unchanged, or if the two output properties diverge, return a concise notification that names the failed state. Do not attempt a risky automatic rollback after a partial output change.

Acceptance outcome: Alfred always shows either connected devices or a useful diagnostic row, the current device is visibly marked, exact duplicate-name devices remain selectable, and notifications never claim an unverified switch.

### Part C — Validate safely and retire the old workflow
- **Ledger:** {"status":"blocked","note":"Linux-safe validation and the implementation commit are complete, but mandatory macOS Core Audio/Alfred smoke tests cannot run in this Linux sandbox. The old workflow remains installed and must not be retired yet.","evidence":"Passed: fixture test, Node syntax check, all Alfred plist graph-reference checks, optional ai/ao filter config check, Hotkey plist byte comparison, install.sh syntax, and whitespace checks. Stow dry run is also blocked because this sandbox has neither `stow` nor required `perl`. Commit: cd1d3378."}

Keep parsing and result construction separable from JXA's macOS command adapter so fixture tests can exercise normal devices, duplicate names, Unicode and punctuation, current-device marking, empty output, and malformed output in the Linux development sandbox. Validate the plist structure and graph references programmatically, and check `install.sh` syntax and the final diff.

On macOS, first verify `SwitchAudioSource` directly, then Stow the new workflow and smoke-test both Alfred keywords with at least two real devices where available. Confirm output selection by independently querying both `output` and `system`, not merely by observing the notification. Keep the old workflow installed during this canary. Only after `ai` and `ao` pass should the old `user.workflow.B9E1D133-3C38-4CEC-A6A5-F4AF22C8A9E1` workflow be removed through Alfred Preferences; do not add destructive cleanup of that machine-specific directory to `install.sh`.

Acceptance outcome: the replacement is proven on the real macOS audio graph before the old workflow is retired, with rollback available until that point.

## Critical Files

- `Alfred Workflows/user.workflow.<new-UUID>/info.plist` — Defines the two Script Filters, switch actions, notifications, bundle identity, and workflow graph.
- `Alfred Workflows/user.workflow.<new-UUID>/audio.js` — Adapts `SwitchAudioSource` records to Alfred JSON, performs exact switches, and verifies resulting defaults.
- `install.sh` — Adds the macOS `switchaudio-osx` software dependency while retaining the existing Stow deployment boundary.
- `Alfred Workflows/user.workflow.1E6B39A6-5659-4F64-B85B-000324F27BE8/info.plist` — Read-only regression boundary for the existing `Hotkey Windows` workflow.
- `/Users/dsuess/.config/Alfred.alfredpreferences/workflows/user.workflow.B9E1D133-3C38-4CEC-A6A5-F4AF22C8A9E1` — Runtime-only migration reference; preserve until the replacement passes and retire through Alfred, not by copying it into the repository.

## Verification

**Regression checks**

- Parse every tracked Alfred `info.plist` and confirm all connection UIDs refer to defined objects.
- Confirm the existing `Hotkey Windows` plist is byte-for-byte unchanged.
- Run shell syntax validation on `install.sh` and inspect the diff for unrelated changes.
- Run Stow in a temporary target or simulation to confirm both workflow directories deploy without collisions.

**New workflow scenarios**

- Fixture-test CLI parsing and Alfred JSON for LF/CR line endings, Unicode, quotes, commas, duplicate names, stable UIDs, and a marked current device.
- Fixture-test missing CLI, empty lists, malformed records, command errors, vanished devices, and media/system partial output results; each must produce an actionable row or notification rather than blank output or false success.
- On macOS, compare `ai` and `ao` rows with `SwitchAudioSource -a -t input -f cli` and `SwitchAudioSource -a -t output -f cli`; every connected device must appear under the correct keyword.
- Search each list by a partial device name and verify Alfred filters it correctly.
- Select an input and confirm `SwitchAudioSource -c -t input -f cli` reports its exact ID.
- Select an output and confirm both `SwitchAudioSource -c -t output -f cli` and `SwitchAudioSource -c -t system -f cli` report its exact ID.
- Reopen each list and confirm the new current row is marked; verify the preceding notification accurately reported the result.

The current planning sandbox is Linux and cannot exercise Core Audio, JXA, Alfred, or the live target directory. Those macOS smoke checks therefore remain mandatory before the old workflow is retired.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Add the managed workflow and dependency
- ☑ Make discovery and switching observable and exact
- ⛔ Validate safely and retire the old workflow
<!-- pi-plan-mode:progress:end -->
