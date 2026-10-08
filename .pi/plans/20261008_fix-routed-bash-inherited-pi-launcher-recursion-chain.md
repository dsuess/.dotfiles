# Keep launcher recursion state out of routed Bash

## Context

The MCP dispatch fix now skips session preflight, but bare `pi mcp list` still fails installed-binary resolution. Routed Bash inherits `PI_LAUNCHER_CHAIN` from the parent Pi launch. The value includes both the launcher and installed Pi binary, so a new command rejects the installed binary as already visited. Clearing this variable experimentally reaches upstream MCP help and list handling.

The recursion chain describes one launcher exec chain, not all descendants. Preserve launcher recursion protections. Do not change trust, filesystem grants, Serena configuration, or credential isolation.

## Approach

Remove parent launcher history at the routed tool environment boundary, not inside the launcher. Verify both environment filters and the real routed command after controller refresh.

### Part A — Strip stale launcher state at the routed environment boundary
- **Ledger:** {"status":"completed","note":null,"evidence":"Added guest sanitizer regression (observed failing before fix, now passes), controller inherited/override regression, and repository AGENTS.md prevention lesson. Only PI_LAUNCHER_CHAIN added to the two guest/controller filters; launcher untouched. All 11 routing tools tests and 16 launcher tests pass; diff checked/reviewed. Live controller regression cannot start under current routed sandbox: EPERM creating /tmp/pi-srt-501/c/<workspace-key>; host verification remains in Part B."}

Add regression assertions that guest environment sanitization and controller operations omit `PI_LAUNCHER_CHAIN`, including caller overrides. Strip only this additional variable in the relevant environment filters. Retain existing launcher recursion tests and all other environment behavior. Record a concrete prevention lesson in repository AGENTS.md, not the runtime system prompt.

Acceptance: independent routed Bash commands do not inherit parent exec-chain history, while launcher recursion protection remains intact.

### Part B — Verify bare MCP dispatch and report remaining limits
- **Ledger:** {"status":"blocked","note":"Requires ordinary host terminal Stow deployment/full gate and refreshed Pi controller for exact bare MCP smoke. Current routed sandbox cannot start regression controllers; running controller retains old environment filter.","evidence":"27 narrow tests pass (11 tools + 16 launcher, including recursion, isolated HOME, --yolo, npm-cache, leading bang). Direct execution of actual boundedEnvironment source excludes inherited and override PI_LAUNCHER_CHAIN and preserves ordinary values; node syntax checks and git diff --check pass. Live controller regression fails before assertions with EPERM mkdir /tmp/pi-srt-501/c/<key>. Exact bare pi mcp --help and pi mcp list both exit 1: cannot resolve installed Pi binary. No variable clearing used. Deployment and npm --prefix pi run check not performed from routed session because plan requires host evidence. Preserved check.out shows existing 146/148 SRT tests passing; failures: controller user-tool startup did not publish ready state and controller temp mktemp Operation not permitted. Request host ./install.sh config, full gate, controller refresh and exact bare MCP commands; trust/Serena connectivity not verified."}

Run launcher and routing environment regressions. Deploy only through `./install.sh config` from an ordinary host terminal and request host verification where the current routed session cannot run it. After the active controller uses the updated code, run the exact bare routed commands `pi mcp --help` and `pi mcp list` without clearing environment variables. Inspect list results for trust skips rather than claiming Serena connectivity. Run the full `npm --prefix pi run check` host gate and report any outstanding pre-existing controller failures shown in `check.out`.

Acceptance: exact bare commands reach upstream MCP handling in a refreshed session, or the remaining refresh/host verification blocker is explicitly recorded.

## Verification

- Guest sanitizer regression excludes parent launcher history.
- Controller regression excludes both inherited and override launcher history.
- Existing launcher recursion, isolated HOME, --yolo, npm-cache and leading-bang tests remain passing.
- Bare routed MCP help/list smoke requires the updated controller; do not treat manually clearing the variable as acceptance evidence.
- Full host gate and Stow deployment require host evidence; preserve unrelated existing changes and user-provided check.out.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Strip stale launcher state at the routed environment boundary
- ⛔ Verify bare MCP dispatch and report remaining limits
<!-- pi-plan-mode:progress:end -->
