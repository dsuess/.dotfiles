# Support approved local HTTP MCP in SRT routing

## Context

The existing extension owns `/mcp` and admits approved project-local stdio servers. The user requests HTTP connections to the local harness proxy without disabling SRT or introducing a bridge. Fibery and Slack must remain configured only in the consuming folder's `.pi/mcp.json`.

The approval reader rejects HTTP. The factory also rejects authentication providers. Installed Pi automatically creates an OAuth provider for HTTP entries. The new path must deliberately ignore that provider and never pass it to the HTTP transport.

The approval, stdio transport, and routed-manager baseline passes 27 tests. A bounded plain GET to `http://127.0.0.1:8788/mcp/Fibery` returned HTTP 406. This establishes endpoint reachability, not MCP initialization or tool execution.

The historical hang has no established cause. Repository and installed extension files are readable. The OS sandbox denies `ps` and the real `/Users/dsuess/.pi` directory. Investigate reproducible lifecycle risks without blaming the bridge or broadening sandbox access.

Preserve unrelated changes in `AGENTS.md` and the untracked `pi/package-lock.json`. Do not modify `pi/agent/AGENTS.md`.

## Approach

Reuse Pi's installed streamable HTTP implementation through an injected transport factory. Add a small approval-aware lifecycle wrapper rather than reimplementing MCP HTTP/SSE. Restrict network dispatch to approved endpoints, prohibit redirects and authentication recovery, bound messages, and enforce cancellation and finite request/cleanup deadlines.

Support literal loopback URLs using `127.0.0.1` or `[::1]`. Reject remote hosts, DNS aliases, URL credentials, query strings, fragments, headers, OAuth, mixed stdio/HTTP definitions, expansions, and unsupported fields. Remote HTTP and authentication are outside scope.

HTTP runs in the host extension, not a sandboxed child. Approval authorizes only endpoint access, not filesystem grants or process launches. Proxy-side Fibery and Slack operations do not run inside SRT. Require controller readiness and bind HTTP authority to the current client policy generation, even after `/sandbox off`.

Leave controller-owned stdio and its shared two-process limit unchanged. HTTP creates no stdio process and consumes no process slot. Preserve project trust, private approvals, declaration provenance, hidden offerings, direct exposure normalization, and planning restrictions. HTTP cannot gain the reviewed Serena exception.

Recheck approval at connection, tool execution, queued dispatch, and message receipt. Stale authority must hide tools and abort requests. Never replay an ambiguous tool POST. Cleanup can terminate the approved HTTP session but cannot reach a changed endpoint or refresh credentials.

Keep one `/mcp` owner. Do not install global Fibery/Slack definitions or add those definitions to this dotfiles workspace.

### Part A — Investigate connection and lifecycle failures
- **Ledger:** {"status":"completed","note":null,"evidence":"Baseline 27/27 passes. Added http-lifecycle.test.mjs: 4/4 local regression fixtures for stalled initialization/body cancellation, open SSE close during connection, and unresolved readiness at close. Inspected installed Pi 1.5.0 streamable-http, runtime connection retry/shutdown and routing shutdown order. Historical hang unresolved; no production proxy operations performed."}

Inspect upstream HTTP transport, manager startup, routing readiness, shutdown ordering, reload, and policy retirement. Reproduce stalled initialization, stalled bodies, open SSE streams, close during readiness, and close during connection with local fixtures. Read available historical evidence only through allowed paths.

Acceptance: demonstrated risks have reproducible regression cases. The historical hang remains unresolved unless actual evidence establishes its cause.

### Part B — Extend folder approval for local HTTP
- **Ledger:** {"status":"completed","note":null,"evidence":"Added failing HTTP approval tests then implementation. workspace-approval suite 19/19 passes; stdio fingerprints retained exactly. Literal loopback validation, canonical HTTP entry, endpoint fingerprint, mixed-field rejection, private persistence, trust/cancellation, alias scope, enabled additions, endpoint/transport drift and confirmation/lock-wait rechecks covered."}

Validate disjoint stdio and HTTP definitions. Accept `url` with omitted type, `http`, or `streamable-http`, plus existing shared enabled, exposure, description, and timeout fields. Canonicalize loopback URLs. Fingerprint endpoint and transport authority without changing existing stdio fingerprints.

Reuse private storage and save-time checks. Show HTTP endpoints in approval summaries. Explain host proxy access separately from sandboxed stdio. Update status for both kinds.

Acceptance: tests cover trust, persistence, cancellation, canonical folder scope, URL and transport changes, enabled additions, invalid fields, and changes during confirmation or lock waits. Existing stdio approval tests pass.

### Part C — Integrate an approval-aware HTTP transport
- **Ledger:** {"status":"completed","note":null,"evidence":"Focused 99 tests: 94 pass, 5 existing Visonic-checkout skips, zero failures. Real HTTP JSON/SSE initialization/list/call; cancellation, stalls, malformed/oversized JSON/SSE, redirects/auth rejection, loss, revocation, policy/controller retirement, bounded readiness/cleanup. Actual index.ts with upstream manager executes one fixture before two and discards automatic OAuth. Mixed HTTP/stdio test uses zero HTTP process slots and preserves planning/hidden/provenance. Stdio unresolved-readiness shutdown regression fixed without transport fallback."}

Add the wrapper and select it through the manager facade. Deliberately discard the automatically supplied HTTP OAuth provider. Preserve stdio without host fallback. Keep declaration provenance and policy-generation checks for both kinds.

Abort requests and streams on revocation, controller loss, policy retirement, reload, replacement, and shutdown. Validate received messages before exposing them. Enforce byte limits and bounded cleanup. Surface failures without replay or core-tool shutdown.

Acceptance: real local fixtures cover initialization, tool listing/execution, JSON/SSE responses, notifications, hidden offerings, planning denial, endpoint drift, revocation, redirects, malformed/oversized messages, controller loss, policy drift, connection loss, and cancellation. Verify one server before two servers and mixed HTTP/stdio operation. Existing stdio and Serena tests pass.

### Part D — Document and verify the actual launcher
- **Ledger:** {"status":"completed","note":null,"evidence":"Updated pi/AGENTS.md, CONTEXT.md and sandbox README; added verify-local-http.mjs manual real-launcher one-before-two fixture procedure, syntax checked. Focused suite: 100 tests, 95 pass, 5 pre-existing missing-Visonic skips. Supporting core/policy suites 33/33; launcher dispatch suites 16/16. git diff --check passes. Actual index.ts/upstream manager fixture results verified through reload/new/resume/fork replacement harnesses and revocation. Real bin/pi RPC launch attempted: blocked at controller preflight by EPERM chmod /tmp/pi-srt-501/c/c012407d2d8252d996e3f0251d7ecb79fabc871faddb3ff9e43fdf258b90c21b. npm --prefix pi/sandbox test attempted: 237 pass, 24 fail, 9 skips; missing local ask-user-question Pi dependency, native EPERM sockets, Docker prerequisite errors. Full npm --prefix pi run check attempted: stops at pre-existing RTK stale-status test missing local Pi dependency. Native gate attempted separately: Docker Sandbox daemon temp symlink operation not permitted. Native/interactive acceptance remains unverified, with procedure documented. No global MCP definitions, production calls, bridge, or sandbox bypass added; no deployment or commit performed. Preserved unrelated AGENTS.md/package-lock and concurrent settings/Ghostty/Obsidian changes."}

Update `pi/AGENTS.md` and sandbox documentation where the stdio-only contract changes. Document loopback restrictions, host HTTP authority, invalidation, revocation, no OAuth, and unchanged stdio sandboxing. Include the user's folder-local example without deploying it globally. Update domain documentation only where applicable.

Add acceptance coverage using `bin/pi` and the actual extension. Exercise startup, tool execution, reload, replacement, revocation, and shutdown with one fixture before two. Include stalled-request cleanup, single `/mcp` ownership, and evidence that core filesystem and child tools still use SRT.

Deploy only through `./install.sh config` if needed and permitted. Attempt the full required gate. Record exact native/interactive blockers rather than claiming success. Include this saved plan with implementation changes if a commit is requested.

Acceptance: focused suites, deterministic routing, full gate, diff review, and real-launcher checks pass, or unavailable checks have exact blockers and reproducible procedures.

## Critical Files

- `pi/agent/extensions/srt-tool-routing/workspace-approval.mjs` and tests: validation, fingerprints, approval summaries, status.
- `pi/agent/extensions/srt-tool-routing/routed-mcp.mjs` and tests: transport selection, provenance, planning, retirement.
- `pi/agent/extensions/srt-tool-routing/mcp-transport.mjs` and tests: retain stdio behavior.
- A focused HTTP transport module and tests in the routing extension.
- `pi/agent/extensions/srt-tool-routing/index.ts`: inject the installed HTTP implementation through supported exports.
- `pi/sandbox/package.json` and acceptance tests: add HTTP and actual-launcher coverage to gates.
- `pi/AGENTS.md`, `pi/sandbox/README.md`, and `CONTEXT.md`: changed authority boundary where applicable.

## Verification

1. Baseline: `node --test pi/agent/extensions/srt-tool-routing/{workspace-approval,mcp-transport,routed-mcp}.test.mjs` passed 27/27.
2. Add failing HTTP approval and lifecycle regressions before implementation. Run focused suites after each change.
3. Run `npm --prefix pi/sandbox test` for deterministic integration.
4. Run real-launcher acceptance with local fixtures, one server before two. Inspect tool results, not only process exit status.
5. Safely attempt `npm --prefix pi run check`. The full gate requires ordinary host execution for native SRT/Docker checks. Document environment failures precisely.
6. Review `git diff --check` and the scoped diff. Confirm no global server definitions, bridge, sandbox bypass, unrelated edits, or approval data enters Git.

Success requires approved project-local URLs to connect through the existing `/mcp` owner. Changed or revoked definitions cannot dispatch requests. Planning blocks general HTTP MCP tools. Reload and shutdown terminate pending HTTP activity within bounded time. Core tools and stdio retain SRT behavior.

The historical hang remains unresolved unless evidence establishes its cause. Production Fibery/Slack calls require user-approved folder configuration and must not run automatically during dotfiles verification.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Investigate connection and lifecycle failures
- ☑ Extend folder approval for local HTTP
- ☑ Integrate an approval-aware HTTP transport
- ☑ Document and verify the actual launcher
<!-- pi-plan-mode:progress:end -->
