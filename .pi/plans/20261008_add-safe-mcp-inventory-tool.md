# Add a trust-aware MCP inventory tool

## Context

Nested `pi mcp list` runs in routed Bash with a generated HOME. It lacks host trust records and global MCP configuration. Copying trust into that HOME would not inspect the current session's connections and would introduce shared-state and trust-refresh concerns.

The user selected a safe inventory tool instead of sandbox CLI connection checks or full Serena access. Implement `mcp_list` as an explicitly admitted host adapter. It lists configuration, not connection health, tools, or callable MCP capabilities. Do not copy trust, start servers, execute configuration commands, connect to URLs, or grant new filesystem access to Bash.

Installed Pi exposes `ctx.isProjectTrusted()` and `pi.getMcpServers()`. The former reflects the current session's trust, including session-only decisions. The latter contains only extension-registered servers, not file-configured servers or live connection status. Pi's internal `loadMcpConfig` is not a public runtime export. Use a small bounded metadata reader rather than an internal deep import or a second MCP runtime.

The SRT host-adapter manifest rejects unknown tools by provenance. The planning gate also uses an explicit inspection allowlist. Both require narrow integration. Arbitrary MCP tools remain unadmitted.

Existing uncommitted work includes launcher dispatch, launcher-chain filtering, unrelated configuration edits, and `check.out`. Preserve all of it. The existing host check log has controller readiness and temporary-file failures; those must not be silently treated as passes for this feature.

## Questions & Answers

| Question | Answer |
|---|---|
| Which behavior should we implement for the agent? | Safe inventory tool (Recommended): add mcp_list using current session trust; list configured server names, source, enabled state and transport, with no connections, secrets, trust copying, or server calls. |

## Approach

Create a canonical user-scoped extension with one no-argument tool. Read metadata fresh on each call using the current context, so there is no stale trust cache or independently persisted trust state. Return a bounded, deterministic configuration inventory with explicit limits on what it establishes.

### Part A — Implement a bounded, trust-aware configuration inventory
- **Ledger:** {"status":"completed","note":null,"evidence":"Added canonical mcp-inventory entry point and bounded metadata reader. node --test pi/agent/extensions/mcp-inventory/inventory.test.mjs passes 7 tests: fresh/session-only/missing trust, project read exclusion, precedence and namespace clashes, disabled transports, all output-channel secret checks, categorical diagnostics, count/file/path/output limits. No configuration expressions execute."}

Add `pi/agent/extensions/mcp-inventory/index.ts` and focused tests. Register `mcp_list` with a strict empty parameter schema and read-only annotations. Derive the agent directory from Pi's public `getAgentDir()` and the project directory from the current context; callers cannot select paths or inject configuration.

Read user `mcp.json` and, only when `ctx.isProjectTrusted()` is true, project `.pi/mcp.json`. Never read project configuration when trust is false or unavailable. Include extension-registered server metadata from `pi.getMcpServers()`. Apply file-over-registration and project-over-global precedence for same-name entries, consistent with Pi. Include disabled entries.

Return only server name, source scope/path, enabled state, and transport type. Include an explicit inventory-only marker and whether project configuration was included or skipped for trust. No `connected` claim, tool counts, server descriptions, commands, arguments, working-directory values, URLs, headers, environment values, OAuth configuration, or raw server configuration may reach tool text, details, or structured output.

Keep the metadata reader small: recognize the documented `mcpServers` shape and fields needed for inventory; do not recreate full MCP protocol validation. Bound file reads, server count, and output text. Missing configuration is normal. Malformed, oversized, unreadable, ambiguous, or unsupported metadata produces bounded categorical diagnostics, without raw parser errors or source excerpts that could expose secrets. Clearly distinguish configuration presence from upstream validity or connectivity.

Acceptance: trusted and session-only-trusted projects appear; untrusted projects are never read; disabled and overridden entries are represented consistently; malicious configuration values cannot trigger commands or leak configuration secrets.

### Part B — Admit the inventory tool without broadening MCP execution
- **Ledger:** {"status":"completed","note":null,"evidence":"Admitted only mcp_list with canonical user-scoped provenance and bounded read-only host effects; added planning inspection and audited child capability entries. 14 host-adapter/planning-gate tests pass, including canonical acceptance, six spoof boundaries, arbitrary MCP rejection, fast planning and restoration. Inventory plus existing subagent runtime suite passes 26 tests including child-specific trust without project reads."}

Add only `mcp_list` to the SRT host-adapter manifest with canonical user-scoped provenance and explicit read-only host effects. Add it to the planning inspection allowlist so the agent can discover configuration before proposing changes. Verify normal execution, planning, fast-planning inspection, and mode transitions without enabling unknown tools.

Allow child inheritance only through the existing audited host-adapter capability list, using each child's own current trust context. Do not inherit parent trust authority through environment variables or arguments. Test provenance rejection for project-scoped or spoofed copies and retain existing fail-closed tool inventory behavior.

Acceptance: the canonical tool is available through normal tool routing and planning; spoofed tools remain blocked; neither this tool nor its integration admits arbitrary MCP calls.

### Part C — Document, deploy, and verify agent-facing inventory
- **Ledger:** {"status":"blocked","note":"Implementation, documentation and deterministic gate integration are complete. Host Stow deployment, a passing ordinary-host full gate, and refreshed-session trusted/untrusted mcp_list invocation require host evidence; the current session routes Bash into a generated HOME and cannot verify the real ~/.pi deployment.","evidence":"Latest focused command passes all 80 inventory, SRT provenance/tools/entrypoint, planning-gate and subagent runtime tests. git diff --check passes. ./install.sh config attempted: stow phase ran in generated HOME, then Herdr registration failed with local socket name length exceeds sun_path capacity. Read-only check of /Users/dsuess/.pi/agent/extensions/mcp-inventory/index.ts is Operation not permitted. npm --prefix pi run check attempted: 8 inventory and 139 plan unit tests passed, then plan-mode smoke failed waiting for controller readiness and stale/missing Docker runtime status; later gate stages did not run. Separate SRT suite exposed a manifest expectation needing mcp_list; fixed and verified in the 80-test focused run. Remaining SRT suite failures were socket sun_path limits and sandbox EPERM on temporary files. npm --prefix pi/sandbox run test:native attempted: verified SRT patch applied, but sandboxd failed because generated HOME/TMPDIR socket paths exceed platform sun_path limits. No refreshed real-session invocation evidence is available; historical check.out was not treated as a pass."}

Document `mcp_list` in `pi/sandbox/README.md` as the agent's supported configuration inventory. Contrast it with interactive `/mcp` for session connections and nested `pi mcp list` for separate sandboxed connection attempts. State that the tool does not test Serena or make its tools callable. Document output fields, trust skips, and bounded diagnostics.

Add focused tests to the repository deterministic gate. Run inventory, SRT provenance, planning-gate, and child-capability checks, then the full host gate. Deploy only through `./install.sh config`. Verify discovery and invocation in a refreshed Pi session with a trusted project fixture and an untrusted fixture. If current sandbox or stale runtime prevents deployment or a host-only check, record the exact blocker and request host evidence; do not weaken isolation to complete verification.

Acceptance: the agent can invoke the canonical `mcp_list` and receive a secret-free inventory that agrees with fixture configuration and the session's trust decision. Available tests pass and outstanding host checks are explicitly identified.

## Critical Files

- `pi/agent/extensions/mcp-inventory/`: new tool, metadata reader, and focused tests.
- `pi/agent/extensions/srt-tool-routing/host-adapters.ts` and `child-capabilities.js`: canonical admission and audited inheritance boundaries.
- `pi/agent/extensions/plan-mode/planning-gate.js`: planning inspection admission.
- `pi/test-gate.mjs`: regression integration.
- `pi/sandbox/README.md`: supported agent workflow and limitations.

## Verification

- Trusted, session-only-trusted, untrusted, and missing-trust-API contexts; verify no project file read for untrusted contexts.
- Missing/global/project/extension configuration; same-name precedence; disabled and stdio/HTTP entries; fresh trust/configuration on consecutive calls.
- Malformed and oversized JSON, unexpected shapes, unsafe scalar types, ambiguous transports, bounded counts/output, and read failures produce categorical diagnostics only.
- Secret sentinels in commands, arguments, URLs, descriptions, headers, environment, OAuth, and malformed JSON never appear in any output channel. Configuration expressions such as `!command` are never evaluated.
- Canonical provenance is admitted; project or forged provenance is rejected. Planning permits the inventory but not arbitrary MCP tools. Child calls use child trust.
- Run `npm --prefix pi run check` from an ordinary host terminal after Stow deployment and obtain real-session tool invocation evidence. Existing `check.out` is historical evidence, not a pass for the new feature.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Implement a bounded, trust-aware configuration inventory
- ☑ Admit the inventory tool without broadening MCP execution
- ⛔ Document, deploy, and verify agent-facing inventory
<!-- pi-plan-mode:progress:end -->
