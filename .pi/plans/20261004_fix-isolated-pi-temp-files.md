# Make sandboxed mktemp use isolated temporary storage

## Context

Pi routes shell and core file operations through the SRT controller. `controller.mjs` already creates a private temporary directory per workspace/controller generation, grants it filesystem access, and sets `TMPDIR` for child processes. The current routed environment confirms that setting survives a Bash login shell.

macOS documents that bare `mktemp`, `mktemp -d`, and `mktemp -t` can select `_CS_DARWIN_USER_TEMP_DIR` instead. Read-only inspection with `getconf DARWIN_USER_TEMP_DIR` returns the exact `/var/folders/.../T/` directory in the reported error. This directory is not in Pi's write allowlist. The failure has not yet been reproduced with file creation because planning mode prohibits mutations.

The user chose isolation over granting access to the macOS user temp directory, which other applications share. Retain the existing private temp lifetime and security boundary. The README's generated-temp-directory contract needs a compatibility caveat: `TMPDIR` alone does not govern every macOS temporary-file API.

Scope is ordinary PATH-resolved `mktemp` in sandboxed commands plus existing TMPDIR-aware runtimes. Absolute `/usr/bin/mktemp` calls, programs that bypass TMPDIR, and commands that replace PATH may remain restricted. Do not grant `/var/folders`, the macOS user temp directory, or all of `/tmp`. Do not alter host execution, global shell configuration, runtime prompts, or unrelated dirty files.

## Questions & Answers

| Question | Answer |
|---|---|
| Should Pi allow the macOS user temp directory for native temp-file compatibility? | Keep temp isolated: retain the private directory and add compatibility handling for mktemp; native programs that bypass TMPDIR may still fail. |

## Approach

Add a small controller-staged compatibility executable, not a global command replacement or new dependency. It will delegate secure file creation to the system mktemp implementation with explicit templates rooted in the existing generated temp directory. Keep policy enforcement as the authority boundary.

### Part A — Reproduce and repair isolated mktemp behavior
- **Ledger:** {"status":"blocked","note":"Implementation is present, but fresh-controller verification requires an ordinary host terminal: this session denies mkdir /tmp/pi-srt-501/c/<new workspace key>.","evidence":"Native /usr/bin/mktemp and -d reproduced /var/folders/.../T/ EPERM through this session's routed Bash. Staged compatibility command tests pass (default, directory, prefix, explicit paths, native errors), controller syntax passes. New runtime source included in source identity; Docker remains first on PATH. Real-controller test fails at startup with EPERM before assertions; nested pi print route cannot resolve installed binary."}

First add a native regression through the real controller that exercises bare `mktemp` and `mktemp -d` under the current policy. Capture the selected paths and failure before changing behavior.

Implement a narrowly scoped `mktemp` compatibility executable in a generated, sandbox-readable but non-writable command directory. Prefer native argument handling where verified to honor the explicit directory; otherwise translate only the implicit-temp and prefix forms into explicit templates. Preserve explicit template paths and directory arguments rather than silently relocating user-requested files. Handle the documented directory, prefix, quiet, and dry-run options correctly; preserve native error and exit behavior for invalid arguments. Do not use predictable filenames or implement random-name creation independently.

Put this executable ahead of the system mktemp on the controller-owned PATH while keeping the reviewed Docker client first. Reuse existing controller staging and policy boundaries without granting write access to controller state. Include new runtime source files in `client.mjs` source identity so old controllers cannot silently omit the fix. No launcher-wide TMPDIR changes are needed.

Verify that sandboxed core Bash and user Bash find the compatibility executable, that output files and directories are in the private temp root, and that subsequent routed operations can access and remove them. Check shell PATH behavior explicitly; do not claim coverage for shells or commands that replace the supplied PATH.

### Part B — Verify isolation and document the compatibility boundary
- **Ledger:** {"status":"blocked","note":"Coverage and documentation implemented; native controller, exact print route, deployment completion, and required ordinary-host full gate remain unverified.","evidence":"16 focused tests pass: staged default/directory/prefix/explicit/space-and-apostrophe paths, quiet/dry-run/errors/cleanup/re-staging, read-only policy, shared routing and unchanged host dispatch. Syntax and git diff --check pass. Real-controller regression attempts stop at mkdir /tmp/pi-srt-501/c/<key> EPERM. check:deterministic and check each stop after 137 passing plan-mode tests at smoke-load: nested launcher cannot resolve installed Pi binary. ./install.sh config reached Stow then exited at Herdr registration (sun_path capacity error); deployment cannot be confirmed from sandbox. README adds smoke command and compatibility/lifetime boundaries. Unrelated dirty files preserved."}

Add focused tests for default files and directories, prefix forms, explicit templates and directory arguments, paths containing spaces, failure status, and cleanup. Assert that controller/request environment overrides cannot redirect the default temporary root. Check Node's TMPDIR-aware temporary-file creation as a regression scenario.

Exercise the documented `pi -p --no-session "!…"` route and the shared model/user-Bash routing path. Verify host-mode dispatch remains unchanged. Negative tests must show that the macOS user temp directory and controller state remain unwritable and that the staged compatibility executable cannot be replaced by sandboxed tools.

Update `pi/sandbox/README.md` with the supported temporary-file behavior, isolation lifetime, explicit-system-binary limitation, and a concise smoke command. Deploy only through `./install.sh config`. Preserve unrelated changes in `bash/.bash_profile`, `codex/config.toml`, and `pi/agent/settings.json`. Include the canonical saved plan with the implementation if committing.

## Critical Files

- `pi/sandbox/controller.mjs`: generated state, child environment, staging, and effective policy integration.
- `pi/sandbox/client.mjs`: controller source identity and replacement.
- `pi/sandbox/test-controller-lifecycle.mjs`: actual sandboxed operation regressions and isolation assertions.
- `pi/agent/extensions/srt-tool-routing/tools.ts`: read-only integration reference for core Bash, user Bash, and host-mode dispatch.
- `pi/sandbox/README.md`: user-facing sandbox and temporary-storage contract.

## Verification

- Reproduction: establish whether native default mktemp selects the reported macOS directory under the current controller; revise the diagnosis before editing if it does not.
- Success: ordinary PATH-resolved mktemp file, directory, and prefix invocations succeed without user-supplied flags; default paths resolve inside the generated private temp directory.
- Regression: explicit-path behavior remains native, Node temporary files work, cross-operation file access works within one generation, and host execution remains unchanged.
- Security: no new broad filesystem grants; macOS shared temp and controller state remain protected; compatibility code is not sandbox-writable.
- Run focused tests, then `npm --prefix pi run check:deterministic`, deploy with `./install.sh config`, and run `npm --prefix pi run check` from an ordinary host terminal as required by repository guidance. If sandbox constraints prevent the host gate, report the exact unverified checks rather than treating nested execution as equivalent.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ⛔ Reproduce and repair isolated mktemp behavior
- ⛔ Verify isolation and document the compatibility boundary
<!-- pi-plan-mode:progress:end -->
