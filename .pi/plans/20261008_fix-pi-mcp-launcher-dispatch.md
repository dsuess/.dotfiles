# Fix MCP CLI dispatch in the Pi launcher

## Context

`pi mcp list` invoked through sandboxed Bash fails in `bin/pi` before Pi or Serena starts. The launcher resolves its controller client relative to `$HOME`; routed operations intentionally receive a generated HOME without controller files. The reported `/tmp/pi-srt-501/.../home/.pi/sandbox/client-cli.mjs` path matches this behavior.

Installed Pi dispatches MCP CLI commands only when its first argument is `mcp`, before ordinary session argument parsing. Its MCP documentation states that these commands do not load extensions. The wrapper currently performs session controller preflight for these commands and would prepend `--no-builtin-tools`, which also breaks upstream first-argument dispatch. MCP CLI operations therefore need a separate launcher path, not controller access in the generated HOME.

Scope is the launcher failure, not enabling new host MCP tool authority or changing Serena configuration. The Visonic `.pi/mcp.json` and `.dev/run-serena-mcp.sh` files could not be read: both direct reads and a safe Bash retry returned permission errors. Serena connectivity remains unverified.

Preserve upstream configuration and project-trust behavior. Sandboxed CLI commands retain their generated HOME and may ignore project MCP configuration because host trust state is absent. Interactive `/mcp` inspects connections in the existing host Pi session; it is not equivalent to a new `pi mcp list` process inside routed Bash. Do not copy host trust, credentials, or controller capabilities into the sandbox.

## Approach

Add a narrow leading-subcommand dispatch to the existing launcher. Reuse installed-binary resolution and recursion protection, but do not run session preflight or inject session flags for MCP CLI commands. This is ordinary execution in the caller's current security context, not a host-execution broker or sandbox bypass.

### Part A — Dispatch MCP CLI commands without session bootstrap
- **Ledger:** {"status":"completed","note":null,"evidence":"Added test-launcher-mcp.mjs; baseline failed six MCP cases at SRT platform preflight. Narrow leading-mcp exec added after unchanged --yolo branch and before platform/controller checks. node --test pi/sandbox/test-launcher-*.mjs passes all 16 tests, including isolated HOME, unchanged argv/nonzero status/HOME/canonical cwd/cache, missing-controller fail-closed, executable resolution, --yolo, leading-bang and npm cache. bash -n bin/pi passed."}

Add regression coverage with an isolated HOME lacking controller files and a fake installed Pi executable. Demonstrate the current failure, then dispatch only when the first forwarded argument is exactly `mcp`, before SRT platform and controller prerequisites. Forward arguments unchanged and preserve exit status, working directory, HOME, and the existing executable-resolution protections. Keep explicit `--yolo` semantics unchanged.

Cover `mcp list`, `mcp list --json`, MCP help and another MCP subcommand to verify transparent forwarding. Check that a later argument or prompt containing `mcp` does not select this path. Normal sessions must still fail closed without controller files; existing leading-bang and npm-cache behavior must remain intact. Never inject `--no-builtin-tools` into MCP command arguments.

Acceptance: MCP CLI dispatch reaches installed Pi without controller state, while ordinary session startup retains its existing security checks.

### Part B — Document and verify the execution boundary
- **Ledger:** {"status":"blocked","note":"Code and documentation are done, but required verification is not complete: user-provided full gate fails two controller tests before native checks; successful host Stow deployment not confirmed; exact bare routed MCP command hits inherited launcher-chain resolution. Serena files are denied by the current filesystem boundary.","evidence":"README documents transparent leading-MCP dispatch, generated HOME/trust limits, interactive /mcp distinction, server subprocess effects, and retained OS restrictions. git diff --check and bash -n passed. All 16 launcher tests pass locally and in user-provided check.out. check.out shows 146/148 routing tests passing; controller startup PATH test fails readiness and controller-temp test fails mktemp permission; native gate did not run. ./install.sh config attempted only via prescribed installer but failed Herdr socket-length registration under generated HOME. Controlled routed smoke with inherited PI_LAUNCHER_CHAIN removed reaches upstream help (exit 0); list --json exits 0 with empty servers and explicit project-not-trusted note, not Serena connectivity. Exact pi mcp --help/list fails installed-binary resolution due to inherited chain; recursion protections unchanged. Visonic direct reads and safe absolute cat retries both return EPERM. Unrelated existing changes preserved; check.out left untouched."}

Update `pi/sandbox/README.md` to distinguish MCP CLI dispatch from interactive `/mcp`, explain generated-HOME configuration and trust limitations, and clarify that dispatch preserves existing OS sandbox restrictions. Do not describe `mcp list` as side-effect-free: it connects to enabled servers and can start subprocesses.

Run launcher regressions and deterministic repository checks. Deploy only through `./install.sh config`; run the full `npm --prefix pi run check` gate from an ordinary host terminal. Use the real routed Bash path to smoke-test `pi mcp --help` and inspect `pi mcp list --json` in a controlled workspace. A trust-related skipped configuration must be reported as such, not as successful Serena verification. Do not alter Visonic files, host trust state, filesystem grants, or MCP admission policy.

Preserve unrelated existing changes in `bash/.bash_profile`, `codex/config.toml`, and `pi/agent/settings.json`. Include the saved plan document if the implementation is committed.

Acceptance: documentation matches actual dispatch and isolation behavior; available checks pass, with any host-only or Serena-specific verification limitations explicitly reported.

## Verification

- New regression: missing controller files no longer prevent a leading MCP command from reaching installed Pi; arguments and nonzero exit status survive unchanged.
- Security regression: non-MCP launches still fail closed; no host HOME, credentials, trust records, controller capabilities, or filesystem exceptions are introduced.
- Existing regressions: `--yolo`, print-mode leading-bang routing, and npm-cache forwarding remain unchanged.
- Native smoke: the exact routed Bash command `pi mcp --help` reaches upstream help without a missing-controller error. `pi mcp list --json` reaches MCP handling and accurately reports connection or trust results.
- Full gate: run `npm --prefix pi run check` from an ordinary host terminal after Stow deployment. Do not claim completion of unavailable native checks or successful Serena connectivity without evidence.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Dispatch MCP CLI commands without session bootstrap
- ⛔ Document and verify the execution boundary
<!-- pi-plan-mode:progress:end -->
