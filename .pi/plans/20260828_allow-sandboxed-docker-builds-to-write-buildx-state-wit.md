# Fix Sandboxed Docker Buildx State Writes

## Context

Sandboxed `docker build` reaches the reviewed Buildx plugin, but Buildx then fails with `docker-config/buildx: operation not permitted`. The generated `DOCKER_CONFIG` currently lives below `descriptor.runtimeRoot`, which is controller state. `pi/sandbox/srt-policy.mjs` explicitly denies writes to that root, and SRT gives `denyWrite` precedence over `allowWrite`; listing the nested Docker directory as a generated writable root therefore cannot make it writable. This is the intended controller-state protection, not a reason to weaken the policy.

Buildx uses `$BUILDX_CONFIG` for configuration, state, and logs, falling back to `$DOCKER_CONFIG/buildx` when it is unset. Docker documents that lookup order at [Build variables](https://docs.docker.com/build/building/variables/#buildx_config), and Buildx implements the same fallback in [`util/confutil/config.go`](https://github.com/docker/buildx/blob/c07bc08336cf6ff573c2ebfc4deb53d51356c568/util/confutil/config.go). The narrow fix is therefore to keep the reviewed Docker CLI configuration and plugin links immutable while redirecting only Buildx’s mutable state to the already isolated tool-home tree.

The accepted SRT-routing ADR remains valid: Docker still uses only the workspace’s private broker and sidecar. No glossary or new ADR is warranted. The sandbox README should, however, distinguish the immutable Docker client configuration from credential-free mutable Buildx state because that is a security boundary.

There is also a verification gap: the prior Docker plan describes a complete routed build canary, but the current `test:native` gate only validates Docker Sandboxes compatibility and a raw Engine ping. This fix must add a focused policy regression and run the exact routed `docker build` path in a disposable workspace. Existing unrelated worktree changes, including current edits in controller and lifecycle-test files, must be preserved and excluded from this fix’s staged diff except for the new surgical hunks.

## Approach

Use Docker’s supported `BUILDX_CONFIG` separation rather than making all of `DOCKER_CONFIG` writable. This retains the reviewed plugin surface and controller-state denial while giving Buildx a private writable state directory under the generated tool home.

### Part A — Separate mutable Buildx state from immutable Docker configuration
- **Ledger:** {"status":"completed","note":"Created a mode-0700 generation-scoped Buildx directory under the writable tool home and made it the authoritative BUILDX_CONFIG while preserving the immutable controller-root Docker config.","evidence":"`node --test pi/sandbox/test-controller-lifecycle.mjs` passed (4/4) after the controller change."}

Create a mode-0700 Buildx state directory beneath the workspace/generation-scoped `toolHomeRoot`, which is already outside the protected controller root and explicitly writable by SRT. Set `BUILDX_CONFIG` authoritatively in `boundedEnvironment()` after request and host environment values, alongside the existing authoritative `DOCKER_CONFIG` and `DOCKER_HOST` values. Treat caller-provided `BUILDX_CONFIG` as control input so it cannot redirect Buildx state to host credentials or another path.

Keep `DOCKER_CONFIG`, its empty `config.json`, and the reviewed Buildx/Compose plugin links beneath the denied controller root. Do not relax `denyWrite`, move controller data into the writable plane, expose host `~/.docker`, or add another Docker endpoint. Buildx state may persist on the same workspace/generation lifecycle as the existing generated tool home, but it must remain credential-free and inaccessible outside the normal SRT policy.

Acceptance outcome: `docker build` can create and update Buildx state without an EPERM error, while a routed process still cannot modify `DOCKER_CONFIG/config.json` or replace the reviewed plugin links.

### Part B — Lock the filesystem and environment contract with regression coverage
- **Ledger:** {"status":"completed","note":"Added real controller/SRT coverage for authoritative Buildx state selection, nested writable state, controller-root separation, and immutable Docker config/plugin links.","evidence":"`node --test pi/sandbox/test-controller-lifecycle.mjs` passed (5/5); `npm --prefix pi/sandbox test` passed (25/25)."}

Extend the controller lifecycle coverage to execute through the real SRT controller and prove all sides of the boundary: a supplied `BUILDX_CONFIG` override is ignored, the controller-selected Buildx directory accepts nested state writes, and the adjacent Docker configuration remains unchanged and non-writable. Assert the paths are separated so a future refactor cannot silently place Buildx state back under `descriptor.runtimeRoot`.

Keep the lower-level Docker-client test focused on its existing responsibility—materializing an empty config with only reviewed plugins—unless implementation changes that helper’s interface. Do not make deterministic tests create a Docker sidecar or require a registry pull.

Acceptance outcome: the focused test fails under the current layout, passes with the separated Buildx state, and detects both a return of the original EPERM bug and an accidental broad write grant over the Docker client configuration.

### Part C — Document, deploy, and validate the exact user workflow
- **Ledger:** {"status":"completed","note":"Documented the split state boundary, deployed through Stow, validated an installed routed Docker build in a disposable workspace, and committed only the surgical fix plus its plan.","evidence":"`./install.sh config` passed; `/Users/dsuess/bin/pi -p --no-session \"!docker build -t <unique> .\"` built successfully in a disposable private sidecar; routed inspection succeeded, host Docker did not see the tag, and `pi-sbx reset <workspace> --force` removed the sidecar. `npm --prefix pi run check:deterministic` and `npm --prefix pi run check` passed. Initial commit `caba4c50` contains only the approved files and plan."}

Update `pi/sandbox/README.md` to state that `DOCKER_CONFIG` and reviewed plugin links are immutable, while Buildx configuration/state/logs use a separate writable generated directory. Preserve the existing no-host-credentials and private-broker language.

Deploy only through `./install.sh config`. From an ordinary host terminal, use a disposable temporary workspace and its isolated sidecar to run the documented leading-bang route through an actual minimal `docker build`; verify the build succeeds, the image is visible only in that sidecar, and cleanup removes the disposable sidecar without touching the current repository’s persistent Docker state. Run the repository gates, review the final diff, and stage/commit only this fix and its canonical `.pi/plans` document as required by repository policy. Preserve all pre-existing unrelated modifications byte-for-byte and unstaged.

Acceptance outcome: the same routed command shape that the user reported now completes a real build, the full gate passes, disposable Docker resources are removed, and no unrelated worktree hunk enters the fix commit.

## Critical Files

- `pi/sandbox/controller.mjs` — owns generated tool-home paths and the authoritative environment passed to every routed operation.
- `pi/sandbox/srt-policy.mjs` — read-only reference for the controller-root denial and tool-home write grant; its security policy should not be weakened.
- `pi/sandbox/test-controller-lifecycle.mjs` — real controller/SRT regression boundary for writable Buildx state and immutable Docker configuration.
- `pi/sandbox/README.md` — operator-facing security contract for Docker client configuration and Buildx state.

## Verification

**Regression checks**

- Run the focused sandbox tests and confirm the new controller test proves `BUILDX_CONFIG` is controller-selected and writable while `DOCKER_CONFIG` remains immutable.
- Run `npm --prefix pi run check:deterministic`, then deploy through Stow, then run the full `npm --prefix pi run check` gate from an ordinary host terminal.
- Confirm existing Docker CLI, Compose, controller startup, sidecar laziness, workspace writes, exact Unix-socket access, and `--yolo` behavior retain their current test results.

**Reported build scenario**

- In a disposable temporary workspace, run a minimal Dockerfile through the installed `pi -p --no-session "!docker build …"` path. Success means Buildx initializes its state, completes the build against the private sidecar, and returns exit code 0 with no `operation not permitted` diagnostic.
- Inspect the generated paths during the focused test or canary: Buildx state must be outside the controller root; `DOCKER_CONFIG/config.json` must remain `{}` and the plugin directory must still contain only the reviewed Buildx and Compose links.
- Reset only the disposable workspace sidecar with `pi-sbx`; leftover images, containers, sidecars, or changes to the current repository’s persistent sidecar are failure signals.

**Scope control**

- Review `git diff --check`, staged diff, and final `git status`. The fix commit must contain the canonical plan and only the new Buildx-state, regression-test, and documentation hunks; all pre-existing unrelated changes remain unstaged.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Separate mutable Buildx state from immutable Docker configuration
- ☑ Lock the filesystem and environment contract with regression coverage
- ☑ Document, deploy, and validate the exact user workflow
<!-- pi-plan-mode:progress:end -->
