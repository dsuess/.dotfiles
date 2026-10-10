# Approve project MCP servers outside Git

## Context

Normal Pi launches replace built-in MCP integration with `srt-tool-routing`. Its `/mcp` command uses Pi's exported MCP manager with a controller-owned stdio transport. Admission currently permits only a fingerprinted Serena configuration in `/Users/dsuess/src/visonic/dev`.

The reported warning concerns duplicate `/mcp` ownership, not folder permissions. `pi/agent/settings.json` already contains `-builtin:mcp`, and its deployed path is a Stow symlink. The installed Pi loader emits the warning when a replaceable built-in meets an existing command registration. The reason the reported launch still selected that built-in is not established. Preserve the sandbox replacement rather than enabling host MCP as a workaround.

The requested change generalizes admission to project-local stdio MCP servers. Project trust remains necessary to read `.pi/mcp.json`; it does not imply routed MCP approval. Workspace approval does not add filesystem grants or change sandbox mode. Existing documentation and `pi/AGENTS.md` explicitly require a single reviewed Serena profile; update that contract as part of this change.

Approvals will bind canonical workspace paths to launch configuration, not project source contents. Accepted tradeoff: approved launchers and their dependencies can change without another prompt, but continue to run inside SRT. Configuration changes that alter launch authority require approval again. Remote HTTP/OAuth, user-global servers, and extension registrations remain outside scope.

## Questions & Answers

| Question | Answer |
|---|---|
| What should approving the current folder allow? | Routed Serena MCP, broadened by the user's note: “generally routed mcp?” |
| Which MCP servers should folder approval cover? | Project stdio servers from the current folder's `.pi/mcp.json`; not global servers or remote HTTP servers. |
| When should a saved folder approval require confirmation again? | On launch-config changes. Bind approval to the canonical folder and server definitions; ordinary project edits do not require approval again. |

## Approach

Keep the existing controller and sandbox transport. Replace the single-profile admission policy with explicit workspace approval and generalize server bookkeeping. Use Pi's built-in dialogs and MCP manager rather than a new UI framework. Retain separate provenance, project-trust, sandbox-policy, and planning checks.

### Part A — Resolve MCP command ownership without weakening routing
- **Ledger:** {"status":"completed","note":null,"evidence":"Launcher/installed-selection regressions pass, including upstream --yolo MCP selection, explicit --no-extensions/-ne, unchanged shell MCP dispatch, and print Bash. Real TUI fresh normal startup has exactly the routed manager, no duplicate-MCP warning, and the approved fixture starts through SRT. Historical warning remains unreproducible from current deployed settings; no installed file patches or warning suppression."}

Reproduce extension selection with the deployed settings and normal launcher. Determine whether the warning comes from overrides, stale sessions, or selection behavior in the installed Pi version. Add a regression for the established cause and make the smallest supported selection change. Do not patch installed dependency files or merely hide warnings.

Normal launches must have exactly one `/mcp` owner: the routing extension. Preserve upstream MCP behavior for shell-level `pi mcp` and `--yolo`; the existing global exclusion must not silently disable the latter. Keep unrelated user edits in settings and other files untouched.

Acceptance: a fresh normal launch has no duplicate-MCP warning and no host MCP connection; bypass and CLI tests demonstrate their intended upstream behavior.

### Part B — Add private workspace approval and confirmation
- **Ledger:** {"status":"completed","note":null,"evidence":"Added failing server-map reordering-during-confirmation regression, then canonicalized snapshot comparisons by server name while preserving argument order. All 16 approval tests pass, including persistence, canonical scope, launch drift, cancellation, concurrent OS writers, lock-wait config changes, malformed state, symlink/private-parent/FIFO rejection and reordered config. Real TUI startup/restart/change/cancel smoke and real-manager malformed-state fail-closed checks previously passed."}

Store versioned approvals at `~/.pi/routed-mcp/approvals.json`, outside the Stow packages and repository. Create private directories and files, use atomic serialized updates, and reject unsafe symlink targets and malformed state. Keep the store inaccessible to sandboxed tools and server processes, including when launching from a broad workspace. Do not copy credentials or full server configurations into approval records; save canonical paths and normalized launch fingerprints.

Read bounded project configuration only after current-session project trust. Validate stdio definitions before offering approval. Fingerprint server name, configuration source, command, arguments, working directory, and literal environment. Adding or enabling an unapproved server or changing launch identity requires confirmation. Ignore formatting and object-key order. Keep command substitutions and environment expansion unsupported rather than evaluating them on the host. Reject HTTP/OAuth and unsupported launch-affecting fields with actionable diagnostics.

At interactive session startup, offer approval when eligible project servers lack matching saved approval. Show the canonical folder, server names, and launch summaries without exposing environment secrets. Confirmation saves and activates approval; rejection or cancellation starts no unapproved process and writes no approval. Avoid repeated prompts in the same session. Empty or untrusted projects need no MCP approval prompt.

Extend the existing `/mcp` command with explicit approval status, retry, and revocation controls while retaining manager status and reconnect behavior. Non-interactive sessions may use matching saved approvals but cannot create them. Recheck configuration after a dialog before committing approval. Revocation must retire current authority; other clients detect it before further calls or reconnects.

Acceptance: approving once survives restart without a Git diff; a changed launch definition prompts again; cancellation, untrusted configuration, invalid state, and missing approval fail closed for MCP while core tools remain usable.

### Part C — Route approved servers with independent live authority
- **Ledger:** {"status":"completed","note":null,"evidence":"Generalized facade to independent transport/definition records and normalized non-hidden exposure; checks live approval revision/config identity/policy generation before connection, tool execution, and queued transport sends. Preserved controller-owned process groups, two-process capacity, no replay/host fallback, disabled/hidden tools, and per-server withdrawal without core/host loadout resets. Original fingerprinted Serena classifier is required for planning inspection authority. 61 focused approval/routing/profile/transport tests passed, then 37 real-manager index tests and plan-mode check passed. Native SRT: two explicitly approved fixture servers execute independently, third hits capacity, revocation closes authority; adversarial server/descendants denied outside reads/writes; broad workspace cannot read/write/relocate approval state (3 native tests pass)."}

Generalize `routed-mcp.mjs` from one Serena transport and fixed names to per-server transport records and declarations. Bind each tool to its actual registered definition, approved server source, current workspace, and live policy generation. Validate current approval before connection and tool execution; retire stale processes and declarations without replaying calls.

Reuse `RoutedMcpTransport` and controller-owned process groups. Preserve generated HOME/cache behavior, filesystem restrictions, capability isolation, cleanup deadlines, and `/sandbox off` behavior: routed MCP stays sandboxed. Retain existing process and message limits, including the controller's two-process limit, with clear capacity errors rather than host fallback or unbounded expansion.

Expose eligible non-hidden tools directly for this initial generalization. Do not add codemode, discovery, or resource plumbing; report this exposure normalization in status and documentation. Honor disabled servers and hidden tools. Prevent one server's refresh from resetting core tools, host adapters, or another server's declarations.

Preserve the existing reviewed Serena inspection exception only when its original verified profile still matches. All other general MCP tools remain blocked during planning regardless of names or server hints. A server named `serena` cannot gain inspection authority merely by offering matching names. Planning exit may restore approved tools that arrived late, but never retired or unrelated definitions.

Require explicit approval for the existing Serena workspace on its first launch after migration; do not silently seed approvals from committed paths. Its verified profile may remain as the narrow planning-inspection classifier, not the general workspace allowlist.

Acceptance: two independent fixture servers work through SRT after approval, stale or revoked definitions cannot execute, and a tool that impersonates a Serena inspection name remains blocked during planning.

### Part D — Document and verify the new authority boundary
- **Ledger:** {"status":"completed","note":null,"evidence":"Updated pi/sandbox/README.md and pi/AGENTS.md for project stdio approval, private storage, launch fingerprints/reapproval, commands/revocation, direct exposure, planning exception, unsupported transports and two-process limits. CONTEXT.md adds only project trust/routed approval terms and relationships; pi/agent/AGENTS.md unchanged. Final npm --prefix pi run check passed from host execution, including 200 SRT suite checks, native 4/4 and Docker/SRT canary; log /tmp/pi-routed-mcp-final-check.log. ./install.sh config passed with Obsidian baseline checks; log /tmp/pi-routed-mcp-final-install.log (existing two high-severity dependency audit advisories reported, no dependency changes). Final real PTY TUI smoke passed approval, restart without prompt, changed-args prompt, cancellation/no changed process, no duplicate-MCP warning; SHA256 of tracked git diff unchanged by approval smoke. Temporary fixture approval revoked and fixture removed. Actual launcher MCP CLI help passed. git diff --check clean. Restored only full-gate-generated model-default edits to initial settings, preserving all unrelated user edits. No commit made."}

Update `pi/sandbox/README.md` and `pi/AGENTS.md` to replace the Serena-only admission rule, describe the dialog and private storage, explain revocation and launch-config reapproval, and state unsupported transports, exposure normalization, planning restrictions, and process limits. Extend `CONTEXT.md` only with domain terms distinguishing routed MCP approval from project trust and filesystem grants. Do not change `pi/agent/AGENTS.md`.

Deploy tracked configuration changes only through `./install.sh config`, respecting its Obsidian clean-baseline checks. Approval data is runtime state and must not become a Stow package or tracked file. If changes are committed, include this saved plan in the same commit.

Acceptance: documentation matches observed behavior, approval operations do not change tracked files, and the focused tests plus the full Pi gate pass or have explicit environmental blockers recorded.

## Critical Files

- `bin/pi` and `pi/agent/settings.json`: normal-versus-bypass extension selection; preserve existing settings edits.
- `pi/agent/extensions/srt-tool-routing/routed-mcp.mjs` and `index.ts`: admission UI, manager integration, live tool provenance, and lifecycle.
- `pi/agent/extensions/srt-tool-routing/serena-profile.mjs`: existing verified inspection exception, no longer a global admission restriction.
- `pi/agent/extensions/plan-mode/planning-gate.js`: fail-closed planning behavior for generalized tools.
- `pi/sandbox/stdio-sessions.mjs` and sandbox policy code: existing process ownership, limits, and protection of private approval state.

## Verification

Regression checks cover normal launcher routing, `/mcp` ownership, CLI dispatch, `--yolo`, existing Serena inspection behavior, policy retirement, reload and conversation replacement, and planning entry/exit with late tool registration.

New approval tests cover canonical aliases, sibling and child directories receiving no inherited approval, reordered configuration, changed launch fields, new or newly enabled servers, cancellation, revocation, concurrent saves, malformed state, symlink attacks, and configuration changes while confirmation is open. No unapproved process may start. Approval persistence must leave `git diff` unchanged.

Use deterministic local stdio fixture servers to verify multiple server identities, direct/hidden exposure, process-capacity errors, tool-name spoofing, and connection loss without replay. Native sandbox tests must prove that server processes and descendants cannot read or alter the approval store or denied credentials and cannot use host Docker authority.

Run the focused routing, profile, transport, planning, and launcher tests during implementation. Before completion, run `npm --prefix pi run check` from an ordinary host terminal, as required by the repository. Perform a real interactive startup smoke test: approve a fixture workspace, restart without another prompt, change its launch configuration, cancel reapproval, and confirm no changed server starts. Record any native or interactive checks that cannot run rather than claiming them passed.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Resolve MCP command ownership without weakening routing
- ☑ Add private workspace approval and confirmation
- ☑ Route approved servers with independent live authority
- ☑ Document and verify the new authority boundary
<!-- pi-plan-mode:progress:end -->
