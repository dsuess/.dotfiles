# Restore Herdr’s Stock Pi Integration

## Context

Pi currently reports lifecycle state through a locally forked stack rather than Herdr’s bundled integration alone. The tracked `pi/agent/extensions/herdr-agent-state.ts` carries Herdr’s generated v8 marker but contains broker transport, plan-completion semantics, retry/reconciliation logic, and other local behavior. A second `herdr-status-reporter.ts`, the `herdr-feedback-state` reducer, a host HTTP broker, launcher orchestration, producer-composed tests, and dedicated diagnostics add further authorities and state transitions. This complexity has repeatedly produced stale or incorrect status.

Herdr’s official model is simpler: `herdr integration install pi` writes one generated extension, and that extension uses `HERDR_ENV`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` to report Pi’s `session_start`, `agent_start`, and `agent_settled` lifecycle directly to Herdr. The current upstream and pinned Herdr 0.8.0 asset are both integration version 8 and match the earlier unmodified repository copy ([Herdr integration documentation](https://herdr.dev/docs/integrations/), [Herdr v8 Pi asset](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.0/src/integration/assets/pi/herdr-agent-state.ts)). Pi extensions run on the host with the process’s permissions, while this repository’s Gondolin architecture isolates model-directed built-in tools in the guest. The official extension therefore does not need a separate host proxy ([Pi extension documentation](https://raw.githubusercontent.com/earendil-works/pi-mono/main/packages/coding-agent/docs/extensions.md)).

“Stock Pi integration” means one byte-for-byte Herdr-managed `herdr-agent-state.ts` plus transparent delivery of Herdr’s inherited environment through the launcher's intentional `env -i` boundary. Local status semantics, reducers, diagnostics, retries, metadata, and broker capabilities are removed. Generic producer contracts such as `rpiv:ask-user:prompt`, `rpiv:ask-user:blocked`, and `plan-mode:workflow-state` remain because they are independently documented package/workflow APIs; after the Herdr bridge is deleted, they no longer customize Herdr. This also avoids violating the questionnaire package’s explicit immutable public-event policy.

The existing Herdr UI configuration, Claude integration, and Neovim navigation are outside this change because they do not customize Pi’s Herdr lifecycle reporter. Historical plan documents remain as records. Existing unrelated worktree changes—especially the startup tracing edits already present in `bin/pi`—must be preserved and merged around rather than reverted.

## Approach

Restore a single upstream-owned lifecycle authority and make the sandbox launcher transparent to the environment Herdr already supplies. Remove every local Pi-to-Herdr semantic and proxy layer, then align tests and documentation with that reduced boundary.

### Part A — Restore the generated integration and delete local status layers
- **Ledger:** {"status":"in_progress","note":"Inspecting the current generated integration and local status layers before restoring the upstream asset.","evidence":null}

Replace `pi/agent/extensions/herdr-agent-state.ts` with the exact Herdr v8 Pi asset bundled by the pinned Herdr 0.8.0 release. Do not retain local comments, imports, transport alternatives, completed-plan overrides, metadata reports, commands, or reconciliation code in this Herdr-managed file.

Delete the adjacent local reporter, feedback reducer and its tests, integration-upgrade test, questionnaire-to-Herdr composed test, host status broker, and broker/reporter/composed sandbox tests. Remove the obsolete broker test script from `pi/sandbox/package.json` so the ordinary sandbox suite contains only maintained Gondolin boundaries. Remove broker-only environment fixtures such as `HERDR_PI_STATUS_TOKEN`; retain generic credential-sanitization coverage.

Do not alter the questionnaire prompt event, its public blocked-lifetime event, or plan mode’s generic workflow event. They remain valid extension contracts but have no Herdr consumer after this Part. Acceptance is one Herdr lifecycle extension identical to upstream and no second reporter, reducer, proxy, diagnostics command, or custom lifecycle authority loaded by Pi.

### Part B — Pass Herdr’s native capability directly through the launcher
- **Ledger:** {"status":"pending","note":null,"evidence":null}

Remove `HERDR_STATUS_BROKER`, broker process state, startup/readiness/token handling, cleanup, and `HERDR_PI_STATUS_PORT`/`HERDR_PI_STATUS_TOKEN` injection from `bin/pi`. Preserve Herdr’s native inherited variables across the launcher’s clean environment: `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_SOCKET_PATH`, and `HERDR_BIN_PATH` when supplied by Herdr. The generated extension remains a no-op when its required native variables are absent, matching upstream behavior.

Remove Herdr-specific environment stripping from the questionnaire discussion-child launcher and retain only its generic Pi session/provider cleanup. Those children run through non-TUI modes, which the official extension already excludes from lifecycle authority. This eliminates another local Herdr policy while preserving discussion isolation and Gondolin tool routing.

Update the wrapper fixture to prove direct native values reach the real host Pi unchanged and that no broker endpoint or token is created. Make these edits surgically around the existing uncommitted startup-performance tracing in `bin/pi`; acceptance requires both behaviors to coexist with no lost worktree changes.

### Part C — Align documentation and repository guidance
- **Ledger:** {"status":"pending","note":null,"evidence":null}

Update `pi/AGENTS.md` to remove rules that require custom feedback aggregation, terminal acknowledgement reconciliation, broker transport, or broker isolation. Retain a concise ownership rule: the generated Pi integration is upstream Herdr content and must not be locally patched. Keep live verification guidance based on `herdr integration status`, `herdr agent get`, and `herdr agent explain`.

Update `pi/sandbox/README.md` so the host control plane no longer claims a Herdr broker. Remove the Herdr-specific completed-plan override from the plan-mode README, and remove broker/authoritative-Herdr wording from questionnaire documentation while preserving its generic event contract. Do not rewrite historical plans or unrelated Herdr configuration.

Commit the new canonical plan document with the implementation, as required by the repository workflow. Acceptance is that current documentation describes one official direct-socket integration and the Gondolin tool boundary without any stale proxy or custom-status claims.

## Critical Files

- `pi/agent/extensions/herdr-agent-state.ts` — sole Pi lifecycle authority; must exactly match Herdr’s generated v8 asset.
- `bin/pi` — clean-environment launcher boundary that must pass Herdr’s native capability directly while preserving unrelated in-progress startup tracing.
- `pi/sandbox/package.json` and `pi/sandbox/test-wrapper.sh` — maintained sandbox suite and direct-environment regression boundary after broker removal.
- `pi/agent/packages/ask-user-question/discussion/runtime.ts` — nested-child environment policy from which Herdr-specific filtering is removed.
- `pi/AGENTS.md`, `pi/sandbox/README.md`, and `pi/agent/extensions/plan-mode/README.md` — current operational and ownership contract.

## Verification

Regression checks:

- Compare `pi/agent/extensions/herdr-agent-state.ts` byte-for-byte with the pinned Herdr 0.8.0 v8 asset; any local diff is a failure.
- Search active Pi and sandbox code for deleted reporter/reducer/broker paths and `HERDR_PI_STATUS_*` variables. Historical plans are excluded from this check.
- Run Bash syntax checks and the wrapper suite. The wrapper must preserve the four native Herdr variables, omit broker variables, retain startup tracing, complete the Gondolin handshake, and release its controller lease normally.
- Run the questionnaire package tests after removing its Herdr-composed test, including discussion-child environment coverage. Run the plan-mode checks after removing only Herdr-specific documentation. Run the full sandbox unit/wrapper suite and the required native sandbox suite from an unsandboxed terminal.
- Review `git diff` and `git status` before deployment to confirm unrelated pre-existing modifications and untracked plans/benchmarks were neither reverted nor absorbed accidentally.

Deployment and live canary:

- Deploy only through `./install.sh config` so the canonical dotfile source remains Stow-managed.
- In a fresh Pi pane launched by Herdr, confirm `herdr integration status` identifies the current v8 Pi integration. During one ordinary prompt, `herdr agent get <pane>` must move from working to idle/done, retain the current Pi session reference, and `herdr agent explain <pane>` must show lifecycle-hook authority rather than screen fallback.
- Confirm no broker process, readiness directory, loopback status port, token, local `/herdr-status` command, or second `herdr:pi` reporter exists. A missing native Herdr environment, any local diff from the generated asset, stale broker artifact, competing authority, or failure to return to idle/done is a release blocker.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ▶ Restore the generated integration and delete local status layers
- ☐ Pass Herdr’s native capability directly through the launcher
- ☐ Align documentation and repository guidance
<!-- pi-plan-mode:progress:end -->
