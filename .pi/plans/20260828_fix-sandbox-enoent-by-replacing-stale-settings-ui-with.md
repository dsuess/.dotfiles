# Make /sandbox Report Live SRT Status

## Context

`/sandbox` currently constructs `SandboxSettingsStore`, whose default `load()` unconditionally reads `~/.pi/sandbox/settings.json`. The SRT cutover deliberately removed that tracked file, while the current controller builds its policy directly and does not implement the settings UI’s mounts, ingress, or reload contract. Creating a replacement JSON file would only hide the `ENOENT`: edits shown by the inherited UI would not affect the active controller.

The command must therefore report controller truth rather than revive the retired settings model. It will be read-only, will not create a Docker sidecar, and will continue to direct persistent Docker lifecycle work to `pi-sbx`. The existing `/srt-routing-status` command remains available for compatibility.

Repository documentation conflicts with the code by describing mutable or persistent `/sandbox` settings. Update those statements to describe the current fixed controller policy and read-only status surface. Preserve all unrelated worktree changes, including the existing `pi/AGENTS.md` launcher-testing addition.

## Questions & Answers

| Question | Answer |
|---|---|
| What should `/sandbox` do under the current SRT architecture? | Read-only status (Recommended) — remove the stale settings-file dependency, show actual controller, workspace, generation, broker, and sidecar state, and keep `pi-sbx` for Docker management. |

## Approach

Replace the mechanically retained settings editor with a small status view backed only by `client.status()`. Remove the obsolete file-backed settings path so the command cannot regress to displaying controls that the controller does not honor.

### Part A — Replace stale settings with controller status
- **Ledger:** {"status":"completed","note":"Replaced the editable settings UI with a controller-status command and retired the file-backed settings store/schema.","evidence":"`/sandbox` now calls `client.status()` through `status-view.ts`; `settings-view.ts`, `settings-store.ts`, and its obsolete coverage were removed. The handler has no settings, reload, reset, or sidecar lifecycle path."}

Rewire the `/sandbox` handler in `pi/agent/extensions/srt-tool-routing/index.ts` to query the connected controller and display a concise, mode-safe status summary. Report the actual health, canonical workspace, attached clients, policy/runtime generations, broker state, and whether the sidecar/Docker daemon is healthy or not yet created. Include the `pi-sbx` management hint without exposing capabilities, tokens, environment values, or arbitrary host actions.

Remove the unused `SandboxSettingsStore` construction and the inherited editable settings implementation. Delete its obsolete schema/store coverage rather than retaining an apparently supported configuration surface. The command must perform no filesystem read or write, policy reload, sidecar creation, or sidecar reset.

Acceptance outcome: invoking `/sandbox` with no `~/.pi/sandbox/settings.json` succeeds and reports the current controller state; a workspace that has never used Docker still has no sidecar afterward.

### Part B — Lock in behavior and align operator documentation
- **Ledger:** {"status":"completed","note":"Added deterministic command coverage and documented the read-only controller-status contract.","evidence":"Added `sandbox-status.test.mjs` to `pi/sandbox`'s test command; it covers absent and healthy sidecars, status fields, no settings file, and no reload/reset calls. Updated `pi/sandbox/README.md` and `pi/AGENTS.md`. Verification passed: `npm --prefix pi/sandbox test`; `npm --prefix pi run check:deterministic`; `npm --prefix pi run check`; `git diff --check`."}

Add focused status-view and command wiring coverage using a fake controller with no settings file. Cover both absent and healthy sidecar states, the documented status fields, and the absence of settings or lifecycle mutation calls. Include this focused regression in the existing deterministic SRT package test command so the repository gate catches a future return to file-backed loading.

Update `pi/sandbox/README.md` and the relevant maintainer wording in `pi/AGENTS.md` to state that `/sandbox` is read-only, controller policy is controller-derived, and `pi-sbx` owns persistent Docker management. Do not claim that editable grants, mounts, ingress, or persistent settings are currently applied.

Acceptance outcome: tests fail if `/sandbox` reads `settings.json`, advertises unsupported editing, or mutates controller/sidecar state, and the documentation matches observable behavior.

## Critical Files

- `pi/agent/extensions/srt-tool-routing/index.ts` — `/sandbox` command registration and connected-controller boundary.
- `pi/agent/extensions/srt-tool-routing/settings-view.ts` and `settings-store.ts` — stale editable UI/store to replace or retire with a read-only status view.
- `pi/sandbox/package.json` — deterministic regression-test entry point.
- `pi/sandbox/README.md` and `pi/AGENTS.md` — operator and maintainer contract for the command.

## Verification

**Regression checks**

- Run the focused status test with no `~/.pi/sandbox/settings.json`; success is a rendered/notified status and no `ENOENT`.
- Run `npm --prefix pi/sandbox test` to cover the new regression plus existing controller, policy, and sidecar behavior.
- Run `npm --prefix pi run check:deterministic`, then the required full `npm --prefix pi run check` from an ordinary host terminal.

**Behavior scenarios**

- With no sidecar, `/sandbox` reports “not created” rather than “starting,” and controller metadata confirms no sidecar was created by inspection.
- With an owned healthy sidecar, `/sandbox` reports its bounded identity and healthy Docker state.
- Failure signals are any settings-file access, editable option, unsupported reload/reset request, secret-bearing output, new sidecar creation, or regression in `/srt-routing-status`.

Review the final diff and `git diff --check`, confirming that unrelated worktree changes remain intact.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Replace stale settings with controller status
- ☑ Lock in behavior and align operator documentation
<!-- pi-plan-mode:progress:end -->
