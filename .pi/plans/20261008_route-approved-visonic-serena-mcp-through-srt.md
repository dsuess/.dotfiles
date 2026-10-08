# Route approved Serena tools through the sandbox

## Context

Normal Pi launches keep Pi on the host and route core tools through the SRT controller. Serena currently uses Pi's built-in MCP integration, which starts configured servers on the host. `srt-tool-routing/index.ts` excludes Serena from its permitted active tools and rejects it in its `tool_call` gate. Changing exposure or adding a name allowlist would not sandbox the server.

The target is `/Users/dsuess/src/visonic/dev`. Its `.pi/mcp.json` runs `.dev/run-serena-mcp.sh pi` with usage reporting disabled. That launcher checks the installed Serena 1.2.0, uses `.pi/serena-context.yml`, activates the repository, and disables dashboard and memory behavior. Nine tools have direct exposure: `search_for_pattern`, `get_symbols_overview`, `find_symbol`, `find_referencing_symbols`, `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `rename_symbol`, and `safe_delete_symbol`.

Pi exports `createMcpExtension` with a custom transport factory. Registering its `/mcp` command from a user extension replaces built-in session MCP handling. This provides a supported integration point without patching installed Pi. The controller's existing `exec` request ignores stdin and buffers client-side stream events until completion, so it cannot carry a live MCP connection unchanged.

Terminology matters: project trust permits configuration discovery; exposure controls presentation; routed admission authorizes a specific reviewed server and tool; SRT enforces filesystem and process restrictions. None substitutes for another. The planning mutation guard is an additional independent gate and currently rejects all Serena tools.

The initial approval covers only the canonical Visonic `dev` worktree. Serena remains sandboxed throughout normal launches, including after `/sandbox off`; `--yolo` retains upstream host-native behavior. Existing filesystem grants, generated HOME, environment filtering, private Docker endpoint, and unrestricted IP egress remain unchanged. This does not introduce general-purpose MCP approval or promise stronger network isolation.

Both repositories contain existing uncommitted changes, including routing tests, controller code, documentation, and Visonic MCP configuration. Preserve those changes. Do not modify Visonic's configuration to solve routing.

**Baseline reproduced before implementation:** At the user's request, the assistant ran the current `/Users/dsuess/bin/pi` launcher in `/Users/dsuess/src/visonic/dev`, using `-p --no-session --mode json` and a prompt beginning `test serena`. The prompt requested one read-only symbol lookup and prohibited edits, installation, settings changes, sandbox changes, nested Pi, and shell MCP clients. Runs were bounded to 120 seconds. An independent launcher-chain environment marker was removed; no sandbox bypass or trust override was used.

The first run exited zero, but its raw JSON output was too large for useful inspection. A second run summarized structured events and captured the actual failure:

- Tool: `mcp__serena__get_symbols_overview`.
- Arguments: `{"relative_path":"conductor/visonic_conductor/job.py","depth":0,"max_answer_chars":3000}`.
- `tool_execution_end` reported `isError: true` and `terminate: true`.
- Error: `Tool 'mcp__serena__get_symbols_overview' is not a trusted SRT tool-routing replacement or host adapter.`
- Pi exited zero with empty stderr. Process exit status alone therefore does not establish tool success.
- Git status was unchanged across the first run. Git status and a SHA-256 digest of the tracked binary diff were unchanged across the second run. These checks do not claim that ignored caches or ordinary runtime logs were unchanged.

This confirms invocation rejection, not a successful Serena lookup. It also sharpens the earlier static diagnosis: the active-tool filter does not guarantee that Serena stays absent from model declarations. Dynamic registration can make the tool visible before the invocation gate rejects it. Regression tests must cover this ordering, rather than assume Serena is always invisible.

No implementation, configuration changes, structural-edit tests, or outside-path mutation probes were performed. The baseline does not prove server-process confinement; that remains a post-implementation requirement.

## Questions & Answers

| Question | Answer |
|---|---|
| Where should the initial Serena approval apply: Visonic dev only, all Visonic worktrees, or multiple named projects? | User replied “go” to the proposed defaults; proceed with the recommended Visonic dev-only approval. |
| Should Serena stay sandboxed after `/sandbox off`, or follow sandbox mode? | User replied “go” to the proposed defaults; proceed with Serena remaining sandboxed during normal launches. |
| Can the assistant test the current behavior now? | User asked “can you test it yourself now?” The assistant ran bounded read-only Pi diagnostics in Visonic and captured the actual routing rejection before revising this plan. Mutation and confinement acceptance tests remain deferred until implementation is approved. |

## Approach

Reuse Pi's MCP client and manager behind a routing-owned transport. Add one reviewed Serena admission profile and a bounded controller-owned stdio channel. Keep MCP admission separate from host-adapter admission. Centralize tool eligibility so startup, dynamic registration, invocation, and planning composition agree. Use the reproduced invocation failure as the behavioral baseline; all implementation Parts remain pending.

### Part A — Add controller-owned sandboxed stdio sessions
- **Ledger:** {"status":"completed","note":null,"evidence":"Implemented protocol v2 process.open/input/close, connection-owned policy-bound bounded stdio sessions, incremental client delivery, source-digest inclusion, serialized retirement, shutdown/disconnect process-group cleanup, and complete PI_SRT_* environment filtering. Focused command node --test pi/sandbox/test-stdio-sessions.mjs pi/sandbox/test-controller-stdio.mjs pi/sandbox/test-client-lease-recovery.mjs passed 14/14. Native fixture proved parent/subprocess outside read/write and symlink denial, in-workspace write, live core exec, policy retirement, and TERM-resistant descendant cleanup on close/disconnect; native test also passed five consecutive runs. Broader sandbox suite passed 153/155 before the final added startup-deadline case; failures are synthetic HOME missing configured ~/.agents directory and temp probe receiving OS denial. Those broad-gate failures remain for Part D verification and are not claimed as success."}

Extend the private controller protocol and client with bounded process-open, input, output, and close behavior suitable for MCP. Reuse the existing SRT spawn policy and environment construction rather than creating a second sandbox implementation. Deliver output incrementally instead of retaining a server's lifetime output in memory.

Bind each process handle to its owning client connection and captured effective policy generation. Other clients, including clients sharing a lease, cannot send input to or close it. Enforce frame limits, buffering/backpressure bounds, process-count limits, and startup/close deadlines. Idle MCP sessions must not consume the core operation pool or permanently block idle-only controls. Do not expose this channel as a model tool or a launcher bypass.

Terminate the complete process group on disconnect, shutdown, startup failure, and retirement. Close old-policy sessions before a changed policy becomes effective; recreate lazily under the new snapshot. Failed cleanup must block further Serena execution rather than retain stale authority. Controller failure cannot select a host transport. Preserve existing core-tool off-mode behavior independently. Never replay a potentially executed edit after transport loss.

Include protocol/source identity updates in the existing integrity mechanism. Keep routing tokens, controller descriptors, host sockets, agents, and launcher-chain state out of the child environment.

Acceptance: deterministic channel tests demonstrate bidirectional traffic, bounded output, ownership isolation, effective-policy binding, process-group cleanup, and unchanged core `exec` behavior. A native fixture demonstrates that both its main process and subprocesses inherit SRT restrictions.

### Part B — Connect only the reviewed Serena profile
- **Ledger:** {"status":"completed","note":null,"evidence":"Reconciled the real-startup gap: controller-owned stdio now forces NPM_CONFIG_CACHE into the existing generated cache/npm directory; core exec keeps its previous caller cache behavior and filesystem grants are unchanged. Native stdio test proves caller-selected host cache is ignored and generated cache is writable; native adversarial MCP read/write/subprocess denial tests pass. Retired only task-created partial generated TypeScript/Bash LSP resources after verifying no other root used them; no host installations/configuration were changed. Redeployed through ./install.sh config, then normal model-driven Pi acceptance succeeded: real job.py symbol overview, independently verified disposable replace_symbol_body edit, and outside/symlink read/write rejection. Evidence report /var/folders/xx/lzq40tcj2ls4d2205yx5yh880000gn/T/pi-serena-acceptance-3e07bf2a661d46fb9da537d6cb4de8bb.json includes controller ancestry and unchanged Visonic status/tracked diff. Earlier handshake-only evidence remains accurate but was insufficient for language-server readiness."}

Add routing-owned session MCP integration using exported `createMcpExtension` and the new transport. Activate this replacement only for normal SRT launches; leave `--yolo` and shell-level MCP CLI dispatch unchanged. Wait for controller readiness and restored client policy before starting Serena.

Create a reviewed profile that binds the canonical workspace, trusted project configuration source, server name, stdio command, arguments, literal environment, and working directory. Validate canonical launcher identity and reviewed launch-affecting files, including the setup checker and Pi context. Record reviewed content fingerprints so changing a command or launcher cannot silently retain admission. Do not infer approval from the `serena` name, a tool prefix, server annotations, or merely having project trust. Validate again when reconnecting; changed identity fails closed and requires a reviewed profile update.

Load project configuration only with current session trust. Reject unsupported transports, extra command arguments, command-valued environment expansion, and unapproved file or extension registrations before they start or connect. Use a narrow facade around the reused MCP factory to restrict configuration, registrations, and registered tool definitions. Do not invoke Pi's default host transport or evaluate unapproved configuration commands. Preserve useful `/mcp` failure/status reporting without granting additional authority through manager exposure changes.

Allow exactly the nine reviewed tool names, intersected with actual server offerings and configured exposure. Suppress resource tools, generic discovery activation, onboarding, memories, basic file/shell tools, and unexpected new tools. Retain Pi's normal argument validation and tool event pipeline. Missing optional offerings remain unavailable; never fabricate a working tool.

Use the controller's existing generated Serena HOME/configuration and installed uv runtime paths. Diagnose startup prerequisites without granting host HOME or broadening filesystem policy. Serena and language-server writes belong in currently permitted repository or generated runtime paths.

Acceptance: a fake MCP server can connect only through the routing transport; spoofed configuration, launcher drift, untrusted projects, HTTP servers, same-name extension registrations, and arbitrary servers cannot spawn or connect. The genuine reviewed launcher reaches MCP initialization under SRT with the project config unchanged.

### Part C — Admit verified tools across routing and planning lifecycles
- **Ledger:** {"status":"completed","note":null,"evidence":"Joined live routed-MCP authority, schema identity and canonical routing-source provenance to inventory, permitted-name refresh and invocation gates without adding Serena to HOST_ADAPTER_NAMES. Added loadout declaration projection and per-turn audits; late approved offerings refresh only the existing loadout. Planning synchronously queries verified inspection offerings and exposes exactly the four reviewed inspection tools, never server readOnlyHint; edits registered during the guard become available on exit. Policy/session retirement hides tools immediately and reconnects lazily under current-client policy without replay. 54 routing/MCP tests pass, including actual Pi agent-core runToolCall results for verified success, baseline/spoof rejection and nested planning edit denial, withdrawals, policy refresh, controller loss/off mode and all five replacement reasons. Plan-mode package check passes 139 tests plus its configured checks. git diff --check passes."}

Add a distinct routed-MCP provenance check, not a Serena entry in `HOST_ADAPTER_NAMES`. Bind admitted tool definitions to the canonical routing extension and its verified server session/profile. Share that decision across inventory verification, permitted-name computation, and `tool_call` checks.

First encode the reproduced failure as a regression scenario: a direct Serena tool registers after an inventory pass, reaches the declared tool set, and is rejected at invocation. The fix must make a verified, sandbox-backed instance succeed while retaining rejection for an identical name without verified authority. The test must inspect the actual tool result, not just process exit status or tool visibility.

Handle tools that arrive after startup or a slow first connection, tool-list changes, withdrawals, reconnects, and session replacement. A newly registered approved tool must become usable without weakening the startup handshake. A withdrawn, hidden, or invalidated tool must become unreachable immediately. Avoid broad active-tool resets that restore tools the planning guard deliberately removed. Prevent unapproved late registrations from being presented as available capabilities.

Extend planning composition narrowly: the four approved inspection tools may run during planning, while all five structural-edit tools remain blocked. Use the reviewed classification, not server-supplied `readOnlyHint`. Ensure edits become available after leaving planning even if Serena registered while the guard was active. Keep nested invocation subject to the same checks; generic codemode, discovery, and resource tools receive no new admission.

Retire MCP sessions on `/reload`, `/new`, `/resume`, `/fork`, and quit. Reconnect under the correct current-client policy rather than reusing another client's authority. Retain existing sandbox-mode semantics for core tools; document that routed Serena remains sandboxed and requires a healthy controller even while core execution is off.

Acceptance: regression tests cover both routing gates, source spoofing, late registration before and after planning transitions, withdrawals, changed configuration on reconnect, nested calls, failed controllers, session replacement, and policy refresh. No scenario makes an arbitrary MCP tool callable or a structural edit callable during planning.

### Part D — Verify real Serena and document the boundary
- **Ledger:** {"status":"completed","note":null,"evidence":"Implemented and deployed documentation/boundary invariants in pi/sandbox/README.md and pi/AGENTS.md; runtime system prompt unchanged. Added repeatable bounded model-driven acceptance script pi/sandbox/verify-serena.mjs and wired adversarial MCP/native stdio tests into existing gates. Final real acceptance report /var/folders/xx/lzq40tcj2ls4d2205yx5yh880000gn/T/pi-serena-acceptance-68d2c93a765b4e248d5cffa1ab1bb21d.json proves exact job.py symbols, successful disposable replace_symbol_body with independently checked bytes, outside and symlink read/write rejection, live controller ancestry for every launch, unchanged outside bytes, fixture cleanup, and unchanged Visonic status/tracked diff. Fake-server tests prove unapproved tool calls and arbitrary/same-name registrations cannot execute or start; native MCP server/subprocess probes return EPERM for outside and symlink reads/writes. Reconciled the two original broad-gate failures with test-only corrections: create configured .agents in synthetic HOME, suppress expected denied-redirection stderr before opening targets, require normal-shell wrapper and verify OS denial when login startup replaces PATH. No grants or host installation permissions changed. Final npm --prefix pi run check:deterministic, ./install.sh config, and npm --prefix pi run check all exited 0. Full gate includes plan-mode 139/139, SRT deterministic 175/175, native 2/2 and successful Pi/disposable sidecar canary. Logs: /tmp/pi-serena-deterministic-final.log, /tmp/pi-serena-deploy-final.log, /tmp/pi-serena-full-final.log. Final git diff --check passes; reviewed task changes against dirty baseline and preserved unrelated changes, including runtime model settings."}

The assistant will perform verification, not delegate the manual test back to the user. After implementation and deployment, repeat the normal Pi launch in `/Users/dsuess/src/visonic/dev` with a prompt beginning `test serena`. Use bounded execution and summarize JSON events rather than dumping the full session/system prompt. Capture actual tool-call names, arguments, results, and sandbox/process evidence; model prose or inventory metadata alone is not proof.

Repeat the baseline `get_symbols_overview` call against `conductor/visonic_conductor/job.py` and verify a non-error result containing real symbols. If that file changes or disappears, document the reason and select another existing source file. Exercise an approved structural edit against a uniquely named disposable source fixture inside the repository, verify its bytes independently, then remove only the test-owned fixture. Preserve all existing user changes and compare repository status and tracked diffs before and after cleanup.

Test denied access to harmless fixtures outside permitted paths, including a repository symlink to an outside fixture. Assert both read and write denial and unchanged outside bytes. Serena may reject a path before reaching the OS; also use the native adversarial MCP fixture through the identical transport to prove SRT denial rather than relying solely on Serena's own project checks. Prove an unapproved tool on an approved test server and an arbitrary server remain blocked, with no host fallback.

Update `pi/sandbox/README.md` and the relevant Pi development invariants to distinguish routed MCP tools from host adapters, explain the reviewed profile and its maintenance, describe lifecycle/policy refresh behavior, and clarify `/sandbox off`, `--yolo`, inventory, and CLI differences. The current statement that all MCP tools remain unadmitted must become an explicit exception for this reviewed profile. Document that a zero Pi exit code can accompany a rejected tool call. Do not change the runtime system prompt. No new glossary or ADR is needed for this bounded integration.

Wire new tests into existing deterministic and native gates. Deploy only through `./install.sh config`. Run `npm --prefix pi run check` from an ordinary host terminal before completion. Review the final diff against the initial dirty baseline, and retain the approved plan document with its implementation if committing.

Acceptance: assistant-collected evidence satisfies lookup, in-repository edit, outside-path denial, and unapproved-tool rejection. Test fixtures are cleaned up, Visonic configuration is unchanged, and the full Pi gate passes or any environmental blocker is explicitly reported rather than treated as success.

## Critical Files

- `pi/agent/extensions/srt-tool-routing/index.ts` and `host-adapters.ts`: routing ownership, both admission gates, and the boundary separating host adapters from routed MCP.
- `pi/sandbox/controller.mjs`, `client.mjs`, and `protocol.mjs`: sandbox process creation, connection-bound authority, streaming transport, and cleanup.
- `pi/agent/extensions/srt-tool-routing/policy-service.mjs` and `pi/sandbox/client-policy.mjs`: effective-policy transitions and stale-session revocation.
- `pi/agent/extensions/plan-mode/planning-gate.js` and `index.ts`: mutation restrictions and dynamic active-tool composition.
- `/Users/dsuess/src/visonic/dev/.pi/mcp.json`, `.dev/run-serena-mcp.sh`, `.dev/install-serena.sh`, and `.pi/serena-context.yml`: read-only approval inputs; not routing implementation targets.

## Verification

Already performed: bounded real Pi launch in the target worktree, with a read-only `test serena` prompt. Structured events confirmed rejection of `mcp__serena__get_symbols_overview` with the exact routing error recorded in Context. Git status and tracked diff checks found no change across the second run. This is baseline failure evidence, not acceptance of the proposed fix.

New behavior to verify after implementation: successful real symbol lookup; reversible approved edit with independent byte checks; denied outside read/write and symlink escape; unknown tool and server rejection; no host server startup; language-server subprocess confinement.

Security regressions: altered launcher/configuration identity, untrusted project, spoofed provenance, changed tool lists, delayed registration, malformed/oversized traffic, cancellation, connection loss, duplicate close, client isolation, grant revocation, and no edit replay after ambiguous failure.

Workflow regressions: planning permits only the reviewed inspection subset; planning exit restores approved edits; reload and conversation replacement do not retain stale server authority; `/sandbox off` leaves Serena under SRT; `--yolo`, MCP CLI dispatch, core tools, Ketch, and metadata-only `mcp_list` retain their existing behavior.

Run narrow tests during development, then `npm --prefix pi run check:deterministic`, Stow deployment via `./install.sh config`, and the required full `npm --prefix pi run check` from an ordinary host terminal. The assistant runs available checks and reports exact blockers for any check that cannot run. A metadata listing, successful MCP handshake alone, application-only path rejection, zero CLI exit status, or a model's success claim does not satisfy end-to-end verification.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Add controller-owned sandboxed stdio sessions
- ☑ Connect only the reviewed Serena profile
- ☑ Admit verified tools across routing and planning lifecycles
- ☑ Verify real Serena and document the boundary
<!-- pi-plan-mode:progress:end -->
