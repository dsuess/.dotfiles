# Make SRT Host Tool Resolution Portable

## Context

Pi’s SRT policy already grants read/execute visibility to reviewed installation roots such as `/opt/homebrew`, `/usr/local`, `~/bin`, and the narrow uv-managed tool roots. Routed operations inherit the controller’s startup `PATH`, with the generated private Docker client prepended. On this machine, `rg` resolves to `/opt/homebrew/bin/rg`; `/usr/bin/rg` does not exist.

The immediate error is therefore not an SRT permission denial. The routed `grep` adapter bypasses the established PATH contract by hard-coding `/usr/bin/rg`; routed `find` has the same latent defect for `/usr/bin/fd`. Model-directed Bash already supports arbitrary host-installed tools discoverable through the inherited PATH, subject to SRT filesystem permissions. The missing architectural rule is that routed adapters which call optional host-installed developer tools must use PATH-resolved executable names rather than assume an installation prefix.

“Host-installed tool” means an executable discoverable through the controller’s inherited PATH and readable under the fixed SRT policy. It does not include controller-owned platform/runtime dependencies such as `/bin/bash`, the current Node executable, generated Docker shims, or host-native credential helpers that are deliberately resolved and validated outside model-directed routing. PATH remains discovery, not authority: SRT filesystem permissions continue to decide whether a discovered executable can run or mutate its target.

Per the user’s feedback, this change will establish a reusable invariant for future routed adapters, not only patch `rg`. It must not add filesystem grants, filter or reconstruct PATH, resolve tools through a login shell, expose credentials, change ownership or modes, or create symlinks. No ADR is warranted because the existing SRT trust boundary is unchanged, but the adapter-authoring rule should be documented.

The worktree has unrelated changes in `oh-my-zsh/.oh-my-zsh`, `pi/agent/settings.json`, and an existing plan. Preserve them unchanged and outside this work.

## Approach

Make PATH-based host-tool discovery an explicit, tested routing-extension contract, then migrate every current optional host-tool invocation to it. Keep commands as argument vectors and preserve all existing SRT confinement, output limits, and result formatting.

### Part A — Establish portable host-tool routing
- **Ledger:** {"status":"blocked","note":"Implementation is complete, but required host-native verification cannot run inside this routed SRT session. The lifecycle suite cannot create its own controller state under /tmp/pi-srt-501/c (EPERM); both check gates stop earlier because this generated HOME lacks ~/.pi/agent/settings.json. Deploy/install and routed Pi smoke tests require an ordinary host terminal.","evidence":"Passed: node --test pi/agent/extensions/srt-tool-routing/tools.test.mjs (6/6); node --check for modified JS; git diff --check; direct PATH smoke resolved rg and fd to /opt/homebrew/bin and completed harmless searches. Lifecycle suite attempted but all tests hit the pre-existing nested-controller EPERM before assertions."}

Introduce a small routing helper or equivalent single boundary for optional host-installed executables. It must accept only a validated bare executable name, reject path-qualified or malformed values, and pass that name as the first element of the existing argument vector. It must not inspect the host filesystem, run `which` or a shell, cache an absolute path, or alter PATH. This keeps discovery aligned with the controller startup environment and avoids assumptions about Apple Silicon Homebrew, Intel Homebrew, `/usr/local`, or reviewed user-tool roots.

Use this boundary for all current optional host-tool calls in the routing extension: `rg` for grep and `fd` for find. Retain direct argument-vector execution, including the existing `--` separators, limits, glob/literal behavior, and abort handling. Do not apply the helper to fixed platform/runtime executables whose absolute identity is part of the controller protocol, such as `/bin/bash`.

Add focused tests for the generic invariant: accepted bare names remain bare, names containing path separators or otherwise unsafe syntax are rejected, and routed host tools are never coupled to `/usr/bin`, `/usr/local`, or `/opt/homebrew`. Update grep/find tests and their fake client to prove both adapters use the shared PATH-based mechanism without `-lc` or string-built shell commands. Add a native controller fixture under an already approved user-tool root such as `~/.local/bin` and invoke it by basename, proving the inherited PATH resolves a host-installed executable while its installation remains read-only.

Document the distinction in `pi/sandbox/README.md`: optional host-installed tools used by routed adapters are invoked by validated basename through inherited PATH; fixed controller/platform dependencies may retain reviewed absolute paths; filesystem policy remains the security boundary. This gives future adapter work a clear rule and regression target rather than relying on knowledge of this incident.

Acceptance means current and future routed adapters have one explicit portable mechanism for invoking PATH-installed host tools, grep/find no longer report nonexistent `/usr/bin/rg` or `/usr/bin/fd`, and no security grant or shell-resolution behavior changes.

## Critical Files

- `pi/agent/extensions/srt-tool-routing/tools.ts` — defines routed execution and the reusable optional host-tool boundary used by grep/find.
- `pi/agent/extensions/srt-tool-routing/tools.test.mjs` — verifies basename validation, argument-vector execution, and adapter portability.
- `pi/sandbox/test-controller-lifecycle.mjs` — proves a PATH-installed user tool resolves through the real controller route and remains confined.
- `pi/sandbox/README.md` — records the authoring rule and its boundary from fixed platform executables.
- `pi/sandbox/controller.mjs` and `pi/sandbox/srt-policy.mjs` — read-only architectural references for inherited PATH and approved executable roots; no policy change is expected.

## Verification

**Regression checks**

- Run the focused routing-extension tests. Confirm basename validation rejects absolute and relative paths, grep/find still preserve their output and limit contracts, and neither adapter uses a shell or installation-prefix-specific executable path.
- Run the controller lifecycle test containing the synthetic host-installed executable. Success requires basename discovery through inherited PATH and denial of writes to its approved installation root.
- Run `npm --prefix pi run check:deterministic` to detect routing, controller, policy, and extension regressions.

**Installed-tool scenarios**

- Deploy only through `./install.sh config`, then run routed Pi grep and find operations against a small known repository target. Success is normal match/file output using the installed `rg` and `fd`, with no `/usr/bin/rg` or `/usr/bin/fd` error.
- Through routed Bash, compare `command -v rg` and `command -v fd` with successful harmless invocations. Also smoke-test another PATH-installed host tool to prove the behavior is generic rather than search-tool-specific.
- Run the full `npm --prefix pi run check` gate from an ordinary host terminal. If environment-dependent native checks cannot run, report the exact remaining gap.
- Review the final diff for any hard-coded installation prefix added to optional routed tools, PATH reconstruction, login-shell resolution, new SRT grants, symlink or permission workaround, or unrelated dirty-file changes. Any such change is a failure.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ⛔ Establish portable host-tool routing
<!-- pi-plan-mode:progress:end -->
