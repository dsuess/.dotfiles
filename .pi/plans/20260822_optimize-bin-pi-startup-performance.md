# Optimize Sandboxed Pi Startup

## Context

`bin/pi` currently serializes trusted launcher setup, a Gondolin controller lease, Pi model discovery, the real Pi process, and the routing-extension handshake. Measurements on this macOS ARM64 host used `--mode rpc --no-session` with stdin closed, so they exercised full extension startup and handshake without making a model request:

| Scenario or phase | Observed time |
|---|---:|
| Fresh sandboxed startup | 4.9–5.4 s |
| Startup with an active workspace controller | 2.6–3.0 s |
| Repository scope discovery | about 22–47 ms |
| Full verification of the 723 MiB Gondolin image | about 0.26–0.34 s |
| Gondolin VM start | about 1.63 s |
| Guest Docker health check | about 0.56 s |
| Pi startup with the inherited controller and no wrapper model preflight | 0.83–0.89 s |

The largest avoidable costs are duplicate work. The launcher starts Pi once with `--list-models` and then starts it again, although Pi 0.84.2 already resolves `settings.json` `enabledModels` against authenticated models during normal startup. The launcher also verifies the complete image before acquiring a lease; a cold controller verifies the same image again, while an already-running controller has already validated and pinned its `imageGeneration`. Repeated safe-PATH scans and one-Node-process-per-JSON-field extraction add smaller process-launch costs.

The unavoidable cold path is currently VM boot plus Docker readiness. Overlapping that work with Pi startup would require publishing a controller capability before the sandbox is healthy and changing client and extension readiness semantics. That is intentionally excluded from this surgical pass. The controller will also continue to stop after the final lease: an idle controller and QEMU VM consumed about 1.15 GiB RSS in measurement, so retaining it solely to improve relaunch time is not a free optimization.

The user continued after leaving the optimization-scope questionnaire unanswered. This plan therefore uses the recommended assumptions: remove redundant work first, preserve immediate VM teardown, preserve the fail-closed handshake, and do not weaken full image verification on cold controller startup. No glossary or ADR structure exists, and these reversible implementation optimizations do not warrant creating either. A documentation conflict does exist: `pi/agent/extensions/plan-mode/README.md` still calls the boundary a “whole-process sandbox,” while current code and `pi/sandbox/README.md` define a trusted host control plane with Gondolin-routed model tools; documentation touched by this work must use the current boundary terminology.

## Approach

Keep the current architecture and readiness guarantees, but make each required startup operation happen once. Establish a repeatable benchmark first, remove duplicate Pi and image work, then reduce launcher-only process churn without introducing a new daemon, cache, early-ready state, or host-tool fallback.

### Part A — Establish a reproducible startup performance contract
- **Ledger:** {"status":"completed","note":"Added disposable native RPC startup benchmark with untimed warm-ups, cold-controller teardown checks, owned active-controller lease, medians/ranges, and optional phase tracing.","evidence":"`node --check pi/sandbox/benchmark-startup.mjs`; `bash -n bin/pi pi/sandbox/test-wrapper.sh`; `git diff --check`"}

Add a native startup benchmark under `pi/sandbox/` that launches the real wrapper in RPC no-session mode, closes stdin after initialization, and reports separate medians for a fresh workspace controller and an already-active controller. It must use a disposable workspace/controller identity, acquire and release only leases it owns, wait for its controller to stop between cold samples, avoid model requests and persistent sessions, and leave unrelated workspace controllers untouched.

Record the measured command count and phase boundaries needed to diagnose regressions: real Pi process launches, image-verifier launches, controller acquisition, child spawn, routing handshake, and total elapsed time. Keep absolute performance thresholds out of ordinary unit tests because QEMU and host load vary; deterministic wrapper fixtures should instead assert process counts and argument flow. The native benchmark is the observable acceptance tool for this machine.

Acceptance outcome: the unoptimized path can be reproduced without editing source, sending a model request, killing another session, or mistaking an active-controller run for a cold run.

### Part B — Remove redundant startup work
- **Ledger:** {"status":"completed","note":"Normal and planning launches now invoke Pi once with native model resolution; the controller alone verifies images on cold start. Cached safe PATH discovery and one bounded lease parse remove repeated bootstrap work.","evidence":"`npm --prefix pi/sandbox run test:wrapper` passed; `npm --prefix pi/sandbox run test:controller` passed; `bash -n bin/pi pi/sandbox/test-wrapper.sh`; `node --check pi/sandbox/{benchmark-startup,client,controller}.mjs`; `git diff --check`."}

Refactor `bin/pi` so normal startup executes the real Pi process only once. Let Pi consume `enabledModels`, `defaultProvider`, `defaultModel`, and explicit `--models`/`--model`/`--thinking` arguments through its documented native startup path. Preserve the special requirement that `--list-models` show the full authenticated catalog rather than being narrowed by settings. In `--plan`, let the plan-mode extension apply `defaultThinkingProvider`/`defaultThinkingModel` during its awaited `session_start`; preserve explicit CLI model priority and the extension’s distinction between user-supplied and workflow-selected models.

Stop invoking `build-gondolin-image.mjs --verify` in the launcher before every lease. Acquire without a caller-supplied image path so `client.mjs`/`controller.mjs` remain the single authority: a cold controller computes the expected digest, verifies every image asset and Pi metadata before publishing a healthy manifest, while an existing controller proves the already-verified image generation through its private manifest, socket, lease, and status checks. Missing or corrupt images must still fail before Pi receives active replacement tools.

Within the shell bootstrap, compute the canonical safe PATH entries once after repository exclusions are known and reuse their first-match order for QEMU, Node, ripgrep, `mktemp`, the real Pi binary, controller PATH, and child PATH assembly. Batch lease-manifest validation and field extraction into one trusted parse rather than starting Node once per field; use a versioned, bounded record shape and reject path delimiters that cannot be represented unambiguously. Retain the independently discovered expected workspace root/key comparison, repository-local shim exclusion, credential filtering, argument quoting, nested-Pi resolution, and Bash 3.2 compatibility.

Do not add controller idle retention, cached image-integrity results, asynchronous Docker readiness, or early controller manifests. These would change resource or fail-closed semantics rather than merely remove duplication.

Acceptance outcome: a normal or planning launch performs one real Pi startup; an active controller triggers no image hash pass; a cold controller performs exactly one full image verification; model cycling/defaults remain correct; and every sandbox identity and tool-source check still completes before the launcher treats Pi as ready.

### Part C — Lock in startup, lifecycle, and boundary regressions
- **Ledger:** {"status":"completed","note":"Added deterministic one-Pi/one-cold-verify wrapper coverage, plan-mode startup-priority coverage, the native benchmark contract, and boundary/startup documentation.","evidence":"Passed: `bash pi/sandbox/test-wrapper.sh`; sandbox broker/controller/extension/repository/Ketch checks; plan-mode tests and integration checks with `PI_PACKAGE_ROOT=/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent`; `npm --prefix pi/sandbox run test:native`. Five-sample benchmark: cold median 3550.8 ms (2757.0–4195.8), active-controller median 1377.7 ms (1151.5–1538.3); traces reported exactly one Pi launch, cold one image verification, and active zero image verifications."}

Extend `pi/sandbox/test-wrapper.sh` fixtures to count real Pi and image-verifier invocations and cover normal, planning, explicit-model, explicit-model-scope, full-list-model, no-tool, failed-image, failed-controller, failed-handshake, PATH-order, quoting, Herdr, signal, and `--yolo` paths. Add focused plan-mode coverage proving a fresh `--plan` branch settles on the planning default, normal startup settles on the implementation default, and an explicit CLI model remains higher priority without the removed launcher marker.

Retain controller/native tests proving that cold startup validates the complete pinned image, two roots share one healthy VM, final lease release stops the controller promptly, cancellation/restart semantics remain fail-closed, and stale or mismatched manifests cannot become warm-start shortcuts. Update `pi/sandbox/README.md` with the single-verification and native-model-resolution startup contract, benchmark procedure, and cold-versus-active-controller terminology. Correct the stale whole-process wording in the plan-mode README to match the host-control-plane/guest-tool-plane boundary; no broader documentation rewrite is in scope.

Acceptance outcome: tests fail if Pi is launched twice, a warm launch rehashes the image, a cold launch skips integrity verification, planning defaults regress, a released VM lingers, or any controller/extension failure exposes host built-ins.

## Critical Files

- `bin/pi` — trusted bootstrap, model argument flow, controller lease acquisition, sanitized child environment, handshake, and cleanup.
- `pi/sandbox/client-cli.mjs`, `client.mjs`, and `controller.mjs` — lease record boundary and the single cold-start image/VM readiness authority.
- `pi/sandbox/test-wrapper.sh` and the new native startup benchmark — deterministic process-count regressions and measured cold/active-controller performance.
- `pi/agent/extensions/plan-mode/index.ts` and its tests — planning-default selection and explicit CLI model precedence after launcher preselection is removed.
- `pi/sandbox/README.md` and `pi/agent/extensions/plan-mode/README.md` — authoritative startup and containment terminology.

## Verification

**Regression checks:** Run Bash syntax and diff checks, the wrapper suite, controller/protocol/policy tests, Gondolin extension tests, plan-mode checks, and the complete sandbox native suite required by `pi/AGENTS.md`. Confirm repository-local executables remain excluded, launch PATH order remains stable, all tool-selection flags retain their current meaning, Herdr cleanup and signal forwarding still release the lease, `--yolo` remains the only host-built-in bypass, and malformed/missing controller inputs fail closed.

**Model scenarios:** In normal, `--plan`, explicit `--model`, explicit `--models`, and `--list-models` launches, verify implementation/planning defaults, thinking level, scoped model cycle, unavailable-model diagnostics, and explicit-CLI precedence. The real Pi invocation count must be one for each launch; a hidden preflight `--list-models` invocation is a failure.

**Image and lifecycle scenarios:** With an active validated controller, verify startup performs zero full image-verifier invocations and matches the controller’s image generation. With no controller, verify exactly one complete image verification occurs before a healthy manifest and routing handshake. Corrupt an image fixture and prove startup stops; release the final lease and prove the manifest, socket, controller, and QEMU process disappear within the existing bound.

**Performance scenarios:** From an unsandboxed terminal, run at least five measured RPC no-session samples per mode after one untimed warm-up. Against the recorded medians of roughly 5.0 seconds cold and 2.8 seconds with an active controller, target at least a 20% cold-start reduction and a 50% active-controller reduction on this host (approximately no more than 4.0 seconds cold and 1.4 seconds active-controller). Report medians and ranges. Failure signals are a second Pi process, a warm image hash, benchmark/controller leakage, or improvements obtained by retaining the 1.15 GiB VM after the final lease.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Establish a reproducible startup performance contract
- ☑ Remove redundant startup work
- ☑ Lock in startup, lifecycle, and boundary regressions
<!-- pi-plan-mode:progress:end -->
