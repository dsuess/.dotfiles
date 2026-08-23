# Reduce Pi Startup Latency Without Changing Semantics

## Context

`bin/pi` has already removed two major startup costs: duplicate normal Pi launches and duplicate image verification. The committed benchmark records roughly 3.55 seconds for a cold controller and 1.34–1.38 seconds with an active controller and warm model cache. A forced daily model-catalog refresh was about 1.88 seconds. Those numbers must be remeasured because the current trace records phase counts, not durations.

The current launcher still performs avoidable serial work before the real Pi process starts:

- Repository scope is discovered in the wrapper, rediscovered by `client.mjs`, and rediscovered again by a cold controller. The controller’s independent discovery is a containment check and must remain; the client-side duplicate can use the wrapper’s already validated scope.
- A normal warm-cache launch starts separate Node processes for the Node version check, repository scope, controller acquisition, lease parsing, and model-scope cache lookup before it starts Pi.
- Controller acquisition completes before the launcher even checks the preferred-model cache, although a read-only cache probe is independent of controller startup.
- The handshake directory is created by a separate trusted `mktemp` process, and the launcher still requires host `rg` even though no launcher or controller path uses it.
- The Gondolin extension audits package metadata and canonical paths repeatedly during `session_start`, including two back-to-back full inventory audits before it writes the readiness handshake.
- Pi and its TypeScript extensions restart from source on each launch. Node 23 supports a persistent module compile cache through `NODE_COMPILE_CACHE`, and Jiti supports a persistent transpile cache through `JITI_FS_CACHE`; both can use the existing private Pi host-cache boundary. See the [Node module compile-cache documentation](https://nodejs.org/docs/latest-v23.x/api/module.html#module-compile-cache).

“Startup” has two distinct controller states—**cold controller** and **active controller**—and two model-cache states—**cache hit** and **refresh**. The benchmark and acceptance results must name those states rather than reporting one ambiguous startup number.

The no-functionality-change constraint rules out the largest but behavior-changing shortcuts. The controller must still stop immediately after its final lease, so retaining the roughly 1.15 GiB VM as a warm cache is out of scope. A cold controller must still hash and validate the complete image; a metadata-only image attestation would weaken corruption detection. The real Pi process must still start only after a healthy controller lease exists, because starting host extensions during VM boot changes failure side effects. Docker health, full extension inventory validation, the routing handshake, explicit model/tool precedence, and fail-closed behavior all remain mandatory.

No domain glossary or ADR exists. These are reversible launcher optimizations, so neither is warranted. `pi/sandbox/README.md` currently documents a fully serial controller-then-model-cache sequence; it must be updated if the safe cache probe becomes concurrent. Preserve unrelated working-tree changes in `AGENTS.md`, `git/.gitconfig`, and existing untracked plan files. Commit this plan document with the implementation as required by the repository workflow.

## Approach

Keep the host-control-plane/guest-tool-plane architecture and make required startup work happen once, with independent read-only work overlapped. First establish duration-level evidence, then consolidate the trusted preflight, enable source-validating runtime caches, and retain only optimizations that produce a repeatable improvement.

### Part A — Establish duration-level startup evidence
- **Ledger:** {"status":"completed","note":"Added opt-in timestamped phase tracing and disposable-cache benchmark dimensions.","evidence":"npm --prefix pi/sandbox run benchmark:startup -- --samples 5 --json: cold median 3560.6ms, active median 1375.4ms, forced refresh median 1333.0ms; all report phase durations and metadata/real Pi process counts."}

Upgrade `pi/sandbox/benchmark-startup.mjs` and the optional startup trace so they report elapsed duration for controller discovery/acquisition, image verification, policy creation, VM creation/start, Docker health, model-cache probe or refresh, real Pi initialization, routing-extension connection/audit, handshake, and total launch. Keep trace output opt-in, private, bounded, and inert during normal startup.

Expose Pi’s existing `PI_TIMING=1` diagnostics only through the benchmark path rather than generally forwarding ambient diagnostic variables into the sanitized child. Use a disposable benchmark model-cache file so cache-hit and forced-refresh samples do not read or rewrite the user’s production cache record. Preserve the existing disposable workspace/controller ownership and cleanup rules.

Record at least five post-warm-up samples for cold-controller/cache-hit, active-controller/cache-hit, and forced-refresh behavior before editing the critical path. The trace must continue to count real and metadata Pi launches so a lower elapsed time cannot hide duplicated work. Acceptance outcome: each reported total can be decomposed into phase durations, and the baseline identifies whether process startup, model probing, Pi resource loading, extension audit, or VM readiness dominates the remaining delay.

### Part B — Consolidate and parallelize the trusted preflight
- **Ledger:** {"status":"completed","note":"Normal launches now use one trusted preflight for validated scope, concurrent read-only model probe, healthy lease, and private handshake allocation.","evidence":"bash -n bin/pi; npm --prefix pi/sandbox run test:wrapper; model-scope/repository/controller suites pass. Five-sample benchmark active cache-hit median improved from Part A 1375.4ms to 1106.2ms; forced refresh emitted exactly one metadata and one real Pi process per sample."}

Refactor the normal `client-cli.mjs acquire` path into the single startup-preflight authority. Pass it the wrapper’s validated repository-scope record so `ensureControllerLease` does not run Git discovery again; a cold controller must still independently rediscover and validate that scope before mounting anything. Validate the passed record’s canonical paths, workspace-key derivation, launch-directory containment, and bounded field shape before use.

Split model-scope resolution into a read-only probe and a refresh step. Within the same Node preflight process, start controller acquisition and the cache probe concurrently. A fresh cache result can complete while the VM boots. If the cache is stale, missing, malformed, or source-mismatched, do not launch the metadata Pi process until the controller lease is healthy; this preserves the current controller-before-preflight failure semantics. Buffer model-cache warnings until controller acquisition succeeds. Explicit `--models`, catalog/help/package/auth commands, and all other existing bypass rules must skip the probe exactly as they skip automatic resolution today.

Have the successful preflight create the private handshake directory under the validated controller runtime root and return its path with the lease and optional model scope. Remove the separate launcher `mktemp` invocation and the unused host-`rg` prerequisite. Move the Node-version assertion into the trusted preflight entry point so normal startup does not launch a standalone Node process solely for that check. Keep `--yolo` behavior and its cached model scoping unchanged.

Acceptance outcomes: a warm eligible launch uses one preflight Node process rather than separate acquire and model-cache processes; a cache hit overlaps controller acquisition; a cache miss launches exactly one metadata Pi process only after controller health; the real Pi process still starts once and only after a valid lease; and controller, cache, parse, or scope failures release or expire capabilities without exposing host built-ins.

### Part C — Cache code safely and remove measured audit duplication
- **Ledger:** {"status":"completed","note":"Enabled private source-validating Node/Jiti caches and made the initial extension audit single-pass with per-audit path/package memoization.","evidence":"npm --prefix pi/sandbox run test:extension and test:inventory pass. Clearing then launching created host, node-compile, and jiti cache directories at mode 0700; Node created a version-keyed compile-cache directory."}

Set private, launcher-owned `NODE_COMPILE_CACHE` and `JITI_FS_CACHE` locations under `~/.cache/pi-gondolin/host/` for the normal sanitized Pi process, metadata Pi process, and trusted launcher/controller Node processes. Rely on Node and Jiti source invalidation rather than inventing a TTL. Keep `umask 077`, verify private directory/file permissions, and do not place credentials, lease tokens, controller manifests, policy results, tool inventories, or image-verification attestations in these caches. A missing, empty, corrupt, or stale code cache must be a performance miss, never a startup failure or authorization shortcut.

Use the Part A evidence to remove synchronous duplicate work on the measured path. At minimum, reuse the first `session_start` inventory result instead of immediately performing an identical second audit, canonicalize each source path once per audit, and read each unique adapter `package.json` once per audit rather than once per tool. Preserve fresh audits at later lifecycle boundaries such as `before_agent_start`; runtime tool or package tampering must still fail closed. Retain any further micro-optimization—such as reusing a validated controller socket instead of connect-and-discard or consolidating executable lookup—only if isolated benchmark samples show an improvement outside run-to-run noise.

Acceptance outcomes: the second and later launch with unchanged sources can consume valid compile/transpile caches; editing an extension or changing Node/Pi versions loads the new source; startup performs one complete initial inventory audit; and all later security revalidation points remain effective.

### Part D — Lock in behavior, performance, and documentation
- **Ledger:** {"status":"completed","note":"Added regression coverage and documented the concurrent preflight, code-cache boundaries, and benchmark dimensions.","evidence":"npm --prefix pi/sandbox test; npm --prefix pi/sandbox run test:native; plan-mode, subagent, and ask-user-question package checks passed. Ten-sample benchmark: cold 3091.8ms median (2455.7–3977.2), active 1118.3ms (799.1–1224.1), forced refresh 1132.9ms (1123.9–1164.9); each sample kept one real Pi, and refresh samples kept one metadata Pi."}

Extend model-scope, wrapper, client/controller, and Gondolin-extension tests for the new preflight boundary, concurrent cache hit, deferred refresh, scope validation, private handshake creation, code-cache invalidation, and deduplicated audit. Include ordering evidence that controller failure or image corruption prevents a metadata or real Pi launch, while a stale model cache refreshes once after health. Preserve argument quoting, explicit model and tool precedence, full-list behavior, environment filtering, PATH ordering, signal forwarding, lease cleanup, planning defaults, child inheritance, and `--yolo` as the only host-built-in bypass.

Update `pi/sandbox/README.md` with the concurrent read-only probe, private code-cache locations and invalidation behavior, revised process counts, benchmark dimensions, and the unchanged exclusions: no controller retention, no early Pi startup, and no cached image-integrity shortcut. Keep the terminology aligned with the host control plane and guest tool plane.

Acceptance outcome: all sandbox and extension regressions pass, native containment remains unchanged, and repeated benchmark results show a real improvement without changing process, integrity, readiness, or teardown semantics. Keep an optimization only when ten comparable post-warm-up samples improve the active-controller median by at least 5% or save a clearly attributable phase cost; cold-controller startup must not regress beyond noise. Report medians, ranges, phase deltas, and process counts before and after.

## Critical Files

- `bin/pi` — trusted executable discovery, sanitized environment, preflight invocation, real Pi launch, handshake wait, and lease cleanup.
- `pi/sandbox/client-cli.mjs`, `client.mjs`, and `repository-scope.mjs` — consolidated preflight, reusable validated scope, controller acquisition, and capability response.
- `pi/sandbox/model-scope-cache.mjs` — read-only cache probe, deferred refresh, source invalidation, and unchanged fallback policy.
- `pi/sandbox/benchmark-startup.mjs` and controller trace points — duration-level baseline and before/after evidence.
- `pi/agent/extensions/gondolin-sandbox/index.ts` and `host-adapters.ts` — handshake-critical controller connection and inventory audit without redundant startup I/O.
- `pi/sandbox/test-wrapper.sh`, focused sandbox tests, and `pi/sandbox/README.md` — behavior/process regressions and the authoritative startup contract.

## Verification

**Regression checks:** Run Bash syntax and diff checks, the focused model-scope, repository-scope, client/controller, wrapper, and Gondolin-extension suites, then the complete non-native sandbox suite. Run plan-mode, subagent, and structured-question package checks because their host adapters participate in the audited startup inventory.

**Ordering and failure scenarios:** Prove a cache hit can overlap acquisition, but a cache refresh and real Pi launch occur only after a healthy lease. Corrupt the image, controller manifest, scope record, model cache, compile cache, handshake, and adapter metadata independently. Each case must either recover as a cache miss where allowed or fail closed before tools activate. Confirm the final lease still stops the controller and VM promptly.

**Cache scenarios:** Compare empty and populated Node/Jiti caches, then modify an extension fixture and switch the fixture Node/Pi revision. The next launch must execute the changed source. Inspect cache permissions and content boundaries; credentials and lease values must not appear. Clear both code caches and confirm behavior is identical apart from timing.

**Model and CLI scenarios:** Cover warm, expired, malformed, provider-invalidated, stale-on-refresh-failure, explicit `--models`, explicit `--model`, `--list-models`, normal, planning, package/auth, no-tool, and `--yolo` launches. Assert metadata and real Pi process counts and argument order.

**Native and performance checks:** From an ordinary unsandboxed terminal, run the required native sandbox suite and at least ten measured samples for cold-controller/cache-hit and active-controller/cache-hit after untimed warm-ups, plus a forced-refresh observation. Compare medians, ranges, and phase durations with Part A. Full image verification, Docker health, routing handshake, one real Pi launch, and immediate final-lease teardown are mandatory success signals; retained VM state, early host-extension startup, skipped hashes, duplicated Pi processes, or improvements within measurement noise are failures.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Establish duration-level startup evidence
- ☑ Consolidate and parallelize the trusted preflight
- ☑ Cache code safely and remove measured audit duplication
- ☑ Lock in behavior, performance, and documentation
<!-- pi-plan-mode:progress:end -->
