# Expose Installed Developer Tools Safely Through SRT

## Context

The reported Homebrew ownership diagnosis is incorrect. The installed tools are usable from the host, primarily under `/opt/homebrew` and `~/.local`, while routed Bash currently receives a controller-fixed `PATH` containing only its generated Docker client, `/usr/local/bin`, `/usr/bin`, and `/bin`. A routed probe reproduced the failure: `brew` and the private Docker client were visible, but `uv`, Node/npm, direnv, gcloud, and Serena were not. Absolute Homebrew paths already execute under the SRT read policy; the missing host `PATH` prevents normal discovery, while Serena additionally needs read access to its uv-managed launcher, environment, and interpreter below the real home directory.

The precise problem is SRT command discovery and read/execute visibility, not POSIX ownership. This change must not run `chown` or `chmod`, grant write access to Homebrew or user tool installations, invoke package installation, or modify the Visonic project.

Per the user’s decision, routed processes will inherit the controller’s startup `PATH`; safety will come from SRT filesystem permissions rather than a second PATH allowlist. Entries that point into unreadable locations remain unusable. Entries inside the writable workspace may execute, which is acceptable because SRT already permits workspace reads, writes, and execution. The sole ordering exception is the existing generated Docker client, which must remain before the inherited PATH so `docker`, Buildx, and Compose continue to target the private sidecar required by `pi/adr/0001-srt-tool-routing.md`. Host Docker sockets, configuration, credentials, and control paths remain denied.

The inherited PATH includes `~/.local/bin`, but SRT’s real-home read deny still blocks Serena’s symlink target. Read grants must therefore cover only the required user-tool runtime boundaries, not all of `~/.local`, because that tree also contains uv credential state. The generated HOME and the denial of host gcloud, Docker, SSH, and other credential stores remain binding; project-local credentials inside the workspace and directly forwarded environment values remain available under the accepted SRT contract.

The worktree contains unrelated in-progress launcher, controller-lifecycle, Docker-sidecar, settings, Codex, and plan-state changes. Preserve those changes and stage only this tool-visibility fix, its canonical plan, tests, and documentation.

## Approach

Remove the duplicate fixed guest PATH policy and use the PATH captured by the trusted controller at startup. Keep SRT read/write policy as the authority: installed toolchains are readable and executable where approved, but package-manager state and credential stores are not writable or broadly exposed.

### Part A — Inherit PATH and grant read-only tool access
- **Ledger:** {"status":"completed","note":"Inherited controller startup PATH now follows the generated Docker client directory without extension replacement; user uv runtime roots are read-only, UV paths are canonical, and Serena config is copied into generated HOME.","evidence":"Passed node --test pi/sandbox/test-host-configuration.mjs pi/sandbox/test-srt-policy.mjs; node --test pi/agent/extensions/srt-tool-routing/tools.test.mjs; node --test pi/sandbox/test-controller-lifecycle.mjs (native client-cli Bash route checks Docker-first exact PATH, workspace PATH executable, generated Serena config, and denied uv-tool write)."}

Make `controller.mjs` construct routed PATH as the generated private Docker client directory followed by the inherited controller `process.env.PATH`, preserving every inherited entry and its order. Do not canonicalize, filter, or rebuild those inherited entries. Ensure the routing extension’s current fixed guest PATH cannot replace the inherited value, and apply the same environment behavior to model Bash, helper operations, and print-mode leading-bang commands. Request environment values may not replace controller or Docker authority; a command can still set its own PATH explicitly inside SRT, where filesystem permissions remain authoritative.

Retain existing read access to Homebrew and system installation prefixes. For uv-managed commands such as Serena, add read/execute visibility only to `~/.local/bin`, `~/.local/share/uv/tools`, and `~/.local/share/uv/python`. Set uv’s tool-directory variables to those canonical locations so `uv tool dir` discovers the existing installation despite the generated HOME. Do not add these paths to `allowWrite`, expose `~/.local/share/uv/credentials`, or broaden the grant to all of `~/.local`.

When a real Serena configuration exists, copy only `~/.serena/serena_config.yml` into the controller’s generated HOME before policy initialization. Serena may then create generated logs and runtime state while continuing to use workspace-local `.serena` project data. Do not expose the real Serena logs, memories, or mutable state directory.

Include every new security-sensitive policy/environment source in the controller source digest so an old controller cannot survive implementation changes. Observable completion means routed Bash inherits the host command search path and runs the already-installed uv, Node/npm, direnv, gcloud, and Serena binaries without attempting Homebrew or uv installation, while writes outside approved generated/workspace roots remain denied.

### Part B — Verify the permission boundary and document it
- **Ledger:** {"status":"completed","note":"Documented the PATH and read-only policy, deployed through Stow, verified installed tool discovery and Serena from Visonic, and committed only the approved implementation, tests, docs, and canonical plan.","evidence":"Passed npm --prefix pi run check and npm --prefix pi/sandbox test; ./install.sh config completed; installed /Users/dsuess/bin/pi leading-bang route preserved Docker-first PATH, resolved uv/node/npm/direnv/gcloud/serena, used generated Docker client, and Visonic dev .dev/run-serena-mcp.sh --check passed. Disposable workspace PATH executable ran while uv credentials and /opt/homebrew writes were denied. Commit 652cc568."}

Add deterministic environment and policy tests proving that the inherited PATH is preserved exactly after the private Docker prefix, duplicate fixed PATH construction is removed, optional or workspace PATH entries are not filtered, required uv runtime roots are readable, uv credential state is excluded, Serena receives generated configuration, and installation roots never enter SRT write permissions. Add a native controller scenario through the same routed Bash path used by Pi.

Update the SRT operator documentation to state that PATH is inherited and is not a security boundary. Document that SRT filesystem permissions determine whether a discovered executable can run or mutate state, list the narrow user-tool read grants, and explicitly prohibit ownership or mode changes as a sandbox workaround. No ADR change is needed because private Docker routing and the existing trust-domain decision remain unchanged.

Deploy only through `./install.sh config`, then selectively stage and commit the implementation, tests, documentation, and canonical `.pi/plans` document together. Preserve all unrelated dirty worktree changes byte-for-byte and unstaged.

## Critical Files

- `pi/sandbox/controller.mjs` — authoritative inherited environment, Docker-first PATH composition, generated Serena state, and SRT policy assembly.
- `pi/agent/extensions/srt-tool-routing/tools.ts` — removal of the conflicting fixed guest PATH while retaining control-variable stripping.
- `pi/sandbox/host-configuration.mjs` and `srt-policy.mjs` — narrow user-tool read roots and the no-write security boundary.
- `pi/sandbox/test-host-configuration.mjs`, `test-srt-policy.mjs`, and `test-controller-lifecycle.mjs` — deterministic permission checks and native routed-command coverage.
- `pi/sandbox/README.md` — operator guidance for inherited PATH and prohibited host permission changes.

## Verification

**Regression checks**

- Run the focused sandbox and routing-extension suites. Existing controller leases, generated HOME, direct secret forwarding, authority stripping, private Docker selection, Buildx state, cancellation, and policy tests must remain green.
- Run `npm --prefix pi run check:deterministic`, deploy with `./install.sh config`, and run `npm --prefix pi run check` from an ordinary host terminal.
- Confirm the final diff contains no ownership/mode-changing command, no Visonic project change, no read grant covering all of `~/.local`, and no write grant for `/opt/homebrew`, `/usr/local`, `~/.local/bin`, or uv tool/runtime roots.
- Compare unrelated dirty-file diffs before staging and after the commit; any staged or changed unrelated hunk is a failure.

**Installed-tool scenarios**

- Through the installed Pi leading-bang route from the Visonic worktree, verify routed PATH equals the inherited host PATH with only the private Docker client prepended.
- Verify `command -v` and harmless version/help calls succeed for `uv`, `node`, `npm`, `direnv`, `gcloud`, and `serena` at their inherited locations.
- Run the repository’s Serena `--check` path and verify it recognizes the pinned existing uv-tool installation and generated copy of its configuration instead of invoking `uv tool install`.
- Verify npm finds the inherited Homebrew Node interpreter, gcloud finds the inherited Homebrew Python interpreter, and `docker` still resolves to the generated private client. A host Docker resolution is a failure.
- Add a disposable workspace directory to PATH and prove its executable can run inside SRT, confirming PATH is not being used as an allowlist; then prove the same process cannot read protected uv credential state or write to Homebrew/user installation roots.
- Inspect the SRT policy or use disposable sentinel targets to prove installed package trees are read/execute-only. Any successful protected write, package installation attempt, host Docker selection, or recommendation to `chown`/`chmod` the host installation keeps the change incomplete.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Inherit PATH and grant read-only tool access
- ☑ Verify the permission boundary and document it
<!-- pi-plan-mode:progress:end -->
