# Fix subagent tool inheritance outside SRT

## Context

The subagent runtime always appends `--no-builtin-tools` through `childToolCliArgs()`. The SRT extension returns immediately unless `PI_SRT_ROUTING=1` or `PI_SRT_ROUTING_SANDBOX=1`. Without either activation flag, children lose native filesystem and Bash tools. The inherited environment allowlists have no effect because the routing extension is inactive.

A read-only reproduction in this session confirmed the failure. An inherited set containing `read`, `bash`, `grep`, `find`, `ls`, and `ketch_search` produced only `--no-builtin-tools`. The session has an empty `PI_SRT_ROUTING` value and no legacy activation flag.

This code belongs to the dotfiles repository under `pi/agent/extensions/`. Deployment uses Stow through `./install.sh config`, not direct edits to runtime files.

SRT activation and sandbox mode are different concepts. An SRT session with `/sandbox off` remains routed. Its children must retain the routed, fail-closed launch and must not inherit host-access authority.

The existing capability splitter admits seven core tools and known host adapters. It excludes recursive delegation, parent workflow tools, unknown tools, and MCP server tools. This fix preserves those boundaries rather than expanding custom-tool inheritance.

The subagent README claims unrestricted active-tool inheritance and preservation of overall order. The code instead uses admitted capabilities, grouped by core tools and host adapters. Correct that documentation conflict as part of this fix.

The installed Pi CLI supports explicit `--tools` allowlists and `--no-tools`. `--tools` also filters extension replacements, so the existing private post-handshake allowlists remain necessary for SRT launches. MCP callable access requires separate exclusion in native launches.

Unrelated staged and unstaged changes already exist. Preserve them, including runtime settings, the system prompt, sandbox configuration, and plan-mode changes.

The user explicitly requires all Pi tests, including native SRT/Docker checks. Targeted tests alone do not satisfy completion.

## Approach

Select child tool arguments from the inherited launch environment. Use the same exact activation values as the SRT extension. Preserve the current SRT launch and use an explicit admitted-tool allowlist for native launches.

### Part A — Restore native child tools without weakening routed launches
- **Ledger:** {"status":"in_progress","note":null,"evidence":"Starting Part A: investigate existing child-capabilities and subagent runtime, add regression coverage, and implement routing-aware tool selection."}

Add regression coverage before changing the launcher. Cover absent, empty, and non-activating routing values, plus both supported activation flags.

Extend `childToolCliArgs()` and its declaration to accept explicit routing context. Pass context derived from the runtime's `baseEnv`, which is also the source of the spawned child environment. Do not depend on unrelated global environment values in this decision.

For an active SRT launch, retain `--no-builtin-tools` and the private core-tool and host-adapter environment allowlists. Do not add a CLI allowlist that interferes with replacement-tool activation. Missing routing replacements or failed readiness must never enable native core tools.

For an inactive SRT launch, select the admitted inherited core tools and host adapters through `--tools`. Do not fall back to Pi defaults. For an empty admitted set, use `--no-tools`. Explicitly exclude MCP server and resource tools from native children so callable MCP access cannot bypass the inherited capability boundary.

Preserve extension discovery, planning inheritance, environment cleanup, cancellation, secure prompt transfer, and parent-only workflow exclusions. Do not change `bin/pi`, controller policy, saved grants, or the host-adapter admission list.

Make existing SRT runtime tests provide explicit routing environments. Add native-launch tests that prove omitted parent tools cannot become defaults. Include host-adapter-only and empty-capability cases. Acceptance requires correct arguments and an unchanged parent environment in every case.

### Part B — Check real tool availability and document the contract
- **Ledger:** {"status":"pending","note":null,"evidence":null}

Add a deterministic installed-Pi integration check using the generated tool selection. Inspect the resulting tool inventory without a provider request. Confirm native core tools actually exist and can read a temporary fixture. Confirm unrequested mutation tools, recursive delegation, parent workflow tools, and MCP offerings remain unavailable.

Retain routed regression coverage for successful replacement activation and missing or failed routing readiness. Include both activation flags and the SRT off-mode child boundary.

Update `pi/agent/extensions/subagent/README.md` to describe admitted capabilities and the two launch paths. Remove claims of unrestricted custom-tool inheritance or overall order preservation. Record a focused prevention rule in `pi/AGENTS.md`: native-tool suppression requires active routing, while routed children must always remain fail-closed. Do not edit `pi/agent/AGENTS.md`.

Run the relevant subagent and routing checks during development. Acceptance requires those checks to pass and the documentation to match the implemented launch behavior.

### Part C — Run every Pi test and review the final changes
- **Ledger:** {"status":"pending","note":null,"evidence":null}

Run `npm --prefix pi run check` from an ordinary host terminal. This is the mandatory full Pi gate, not the deterministic-only mode. It includes all configured extension checks, deterministic routing tests, session archive native isolation, and native SRT/Docker checks.

The gate stops on its first failure. If an unrelated baseline failure stops it, run the remaining configured suites separately. Account for every suite rather than treating an early gate exit as a complete test run. Correct failures caused by this change and rerun the affected suites and full gate.

Report each failure or blocked suite with its cause and execution evidence. Do not skip native checks silently, substitute targeted tests for the full gate, or claim full verification while any required suite remains blocked. Do not change unrelated code to conceal baseline failures.

Review the final diff for scope and preserve all unrelated changes. Deploy only through `./install.sh config` if deployment is needed. If its Obsidian round-trip blocks deployment, report the blocker without discarding configuration changes. Keep the saved plan document with the implementation changes in any eventual commit.

Acceptance requires a complete suite-level test account and a reviewed diff. Full verification requires every configured Pi suite to pass, including native SRT/Docker checks.

## Critical Files

- `pi/agent/extensions/srt-tool-routing/child-capabilities.js` and `.d.ts`: capability classification and routing-aware CLI selection.
- `pi/agent/extensions/subagent/runtime.js`: inherited environment and child process construction.
- `pi/agent/extensions/subagent/test/`: launcher regressions and real tool-inventory coverage.
- `pi/agent/extensions/srt-tool-routing/index.ts`: read-only reference for activation and fail-closed readiness behavior.
- `pi/agent/extensions/subagent/README.md` and `pi/AGENTS.md`: runtime contract and prevention rule.
- `pi/test-gate.mjs`: read-only reference for the complete suite inventory and fail-fast behavior.

## Verification

New native-launch scenarios:

- Absent or empty routing flags preserve exactly the admitted inherited core tools and host adapters.
- Non-`1` values do not activate routing, consistent with the extension.
- A read-only inherited set includes `read`, `grep`, `find`, and `ls` without adding `write` or `edit`.
- Host-adapter-only inheritance enables no native defaults.
- Empty inheritance enables no tools.
- A real native tool inventory contains the selected tools, and `read` successfully reads a temporary fixture without a model call.
- MCP tools and parent-only capabilities cannot escape the inherited selection.

Routed regression scenarios:

- Either supported activation flag retains `--no-builtin-tools` and private allowlists.
- Missing or failed routing never exposes native core tools.
- Parent `/sandbox off` does not select the native child path or transfer off authority.
- Planning restrictions, parent environment isolation, secure prompt cleanup, cancellation, and output bounds remain unchanged.

Full Pi regression requirement:

- Run `npm --prefix pi run check` in its full mode from an ordinary host terminal.
- Execute every configured suite, including native session archive isolation and native SRT/Docker checks.
- If the gate stops early, execute the remaining suites separately and report their results.
- Record passed, failed, and blocked suites with exact blockers. Full verification requires no failed or blocked suites.
- Rerun the full gate after correcting change-related failures.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ▶ Restore native child tools without weakening routed launches
- ☐ Check real tool availability and document the contract
- ☐ Run every Pi test and review the final changes
<!-- pi-plan-mode:progress:end -->
