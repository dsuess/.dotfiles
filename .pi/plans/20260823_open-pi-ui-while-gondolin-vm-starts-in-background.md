# Open Pi UI While Gondolin Starts

## Context

A cold sandboxed launch currently takes about 3.1 seconds on this host, versus about 1.1 seconds with an active controller. `bin/pi` waits for full image verification, VM boot, and guest Docker health before it starts the real Pi process. The largest cold-start phase is therefore invisible to the user even though Pi 0.84.2 already starts its TUI before it awaits extension `session_start` handlers.

The requested behavior conflicts with the current documented rule in `pi/sandbox/README.md` that Pi starts only after a healthy lease. Replace that rule with a more precise fail-closed boundary: the trusted host UI may start while Gondolin is starting, but no agent turn, model-directed tool, or user Bash command may cross the readiness gate until the extension has acquired and verified a healthy workspace lease. Native built-ins remain disabled from process launch, and replacement tools remain inactive until the existing controller, generation, Docker, and inventory checks pass.

Use **controller starting**, **host UI ready**, and **sandbox ready** as distinct states. “UI ready” means the editor, model/session controls, extensions, and status bar are available. A submitted turn waits before message construction and model execution, then continues automatically when the sandbox becomes ready. If startup fails, the queued turn is not sent and Pi exits fail-closed after showing the error. Missing launcher prerequisites still fail before any UI appears; image, VM, Docker, or lease failures can now appear after the TUI opens.

Keep the controller manifest healthy-only. Do not publish a usable lease, controller token, VM identity, or tool capability before readiness. The model-scope cache keeps its current filtering and refresh behavior, but its trusted metadata work may overlap controller startup because the new design intentionally permits reviewed host startup work before VM health. `--yolo` remains the only host-built-in bypass. Non-interactive modes may overlap internal work, but they must preserve their externally observable ready/handshake semantics.

This is a reversible startup/lifecycle refactor, so it does not warrant a new domain glossary or ADR. Update the sandbox documentation and repository development invariants because they currently state the superseded serialization rule. Preserve unrelated working-tree changes in `AGENTS.md`, `git/.gitconfig`, and existing untracked plan files, and commit this plan document with the implementation.

## Questions & Answers

| Question | Answer |
|---|---|
| While the Gondolin VM is still starting, what should pressing Enter do? | Queue turn (Recommended): keep the full TUI usable; wait before agent/model execution, then submit automatically when the sandbox is healthy. |

## Approach

Split trusted launch preparation from sandbox readiness. Start the workspace controller as soon as trusted scope validation succeeds, continue model-scope preparation in parallel, and launch host Pi with an immutable startup descriptor rather than a ready lease. The Gondolin extension owns the root lease, readiness promise, queued-input gate, lifecycle status, child capability publication, and release. The wrapper remains the process supervisor and independently requires a validated routing handshake before treating the session as sandbox-ready.

### Part A — Begin controller startup without waiting for readiness
- **Ledger:** {"status":"completed","note":"Split controller begin/acquire lifecycle; launcher now starts Pi with a non-capability descriptor and waits only for extension handshake.","evidence":"bash -n bin/pi; node --check pi/sandbox/client.mjs pi/sandbox/client-cli.mjs; npm --prefix pi/sandbox run test:wrapper"}

Refactor the normal `client-cli.mjs`/`client.mjs` preflight into separate begin and acquire phases. The begin phase validates the launch directory and canonical repository scope, derives the private controller paths, starts or joins exactly one workspace controller, allocates a private handshake location, and resolves the existing model scope while the controller verifies the image and boots the VM. Return only a bounded startup descriptor containing expected workspace identity and paths plus the model scope needed before Pi starts; it is not an authorization capability.

Change `bin/pi` to start the real Pi process after this begin phase instead of after `ensureControllerLease`. Continue passing `--no-builtin-tools` from process launch and sanitize the host environment as today. Pass the startup descriptor, requested built-in names, requested host-adapter names, and handshake path to Pi, but do not invent placeholder socket, lease, generation, or VM values.

Preserve current warm-controller behavior, trusted executable/PATH filtering, explicit model/tool argument precedence, model-cache refresh bounds, and one real Pi process. A cold controller must still perform complete image verification and Docker health before publishing its private healthy manifest. A corrupt image or failed VM now causes the already-visible host Pi to shut down; it must never cause host built-ins or unaudited tools to activate.

Make controller startup joining and cancellation explicit so the extension does not race by spawning a duplicate daemon. A cancelled root launch must stop a controller it uniquely started or let a shared controller continue, release any acquired lease, and leave no indefinitely heartbeating helper. Hard process death may rely on the existing bounded lease expiry, but ordinary exit and forwarded signals must retain prompt release and VM teardown.

Acceptance outcome: on a cold launch, controller startup and Pi initialization overlap; the trace reaches host UI initialization before VM/Docker readiness; an active controller remains a fast path; and no pre-ready file grants or controller capability are exposed to Pi.

### Part B — Gate queued turns on one extension-owned readiness promise
- **Ledger:** {"status":"completed","note":"Extension now publishes starting non-blockingly for TUI, gates input and user Bash on one readiness promise, and handles failed queued input fail-closed.","evidence":"npm --prefix pi/sandbox run test:extension; npm --prefix pi/sandbox test"}

Update `gondolin-sandbox/index.ts` so the root session creates one abortable controller-acquisition promise during TUI `session_start`, emits the existing lifecycle event with `health: "starting"`, and returns without awaiting that promise. This allows Pi to finish TUI initialization. In RPC, JSON, and print modes, keep startup externally blocked until the same readiness promise settles.

Before starting acquisition, remove Gondolin replacements and unaudited tools from the active set. When acquisition succeeds, verify the inherited workspace root/key, policy and image generations, VM identity, Docker health, requested tool inventory, host-adapter provenance, and replacement ownership exactly as today. Only then publish the final `PI_GONDOLIN_*` capability values to the root process for future child launches, activate the permitted tools, emit `healthy`, and write the success handshake. Children with a complete inherited capability must connect to the parent lease; they must not repeat root autostart.

Add an `input` readiness gate for interactive, RPC, initial, and extension-sourced user turns. If a user presses Enter while health is `starting`, await the shared promise before skill/template expansion, user-message construction, or model execution, then let the original submission continue automatically. Preserve later input handlers such as plan mode. Gate `user_bash` on the same promise so `!` and `!!` wait rather than run locally or fail spuriously. `/sandbox` and `/gondolin-status` should report the starting state without opening settings that require a live client; ordinary local UI commands remain usable.

On acquisition, audit, or handshake failure, settle all waiters with one failure, keep replacement tools inactive, emit `failed`, write a bounded failure handshake, notify the TUI, and request shutdown. A queued prompt must be handled without reaching the model. Keep `before_agent_start` as a fresh inventory revalidation point after readiness, not as the primary queue gate, because Pi catches extension errors from that event and would otherwise continue the turn.

Acceptance outcome: users can type, edit, change model/session UI, and press Enter during VM boot; the turn starts automatically after the status changes from `starting` to `healthy`; no model request or sandbox RPC occurs early; and failure exits without sending the queued prompt.

### Part C — Transfer lease lifecycle and child inheritance safely
- **Ledger:** {"status":"completed","note":"Root extension now owns/release lease, aborts startup on shutdown, clears child capability environment, and preserves inherited child disconnect behavior.","evidence":"npm --prefix pi/sandbox run test:extension (root queue, cancellation, one-time release coverage); npm --prefix pi/sandbox run test:wrapper"}

Make the extension-acquired root client the lease owner. On normal `session_shutdown`, stop status polling, abort any unfinished acquisition, release an acquired root lease exactly once, clear published child capability values, and emit `stopped`. Preserve inherited-child behavior: child clients disconnect without releasing the parent lease, and subagents, discussion children, planning execution, and session replacement continue to use the same workspace controller and settings generations.

Add abort support to the begin/wait/acquire path where needed so Ctrl+C during VM boot cannot block for the full startup timeout or leak a uniquely spawned controller. Coordinate the launcher’s signal forwarding and handshake monitor with extension cleanup: startup failure should not produce competing error paths, a success handshake should still be fully validated, and timeout bounds must now cover image/VM/Docker startup rather than only the post-lease routing audit.

Keep controller leases and tokens out of startup descriptors, trace files, model caches, and user-visible status. The final capability remains in the sanitized root process environment only after verification. Preserve immediate final-lease teardown, the 15-second crash-expiry backstop, and shared-controller semantics for concurrent roots.

Acceptance outcome: normal quit, startup cancellation, extension reload/session replacement, signal termination, child completion, and startup failure each leave the correct lease count and controller lifetime; a child cannot accidentally start a second controller or release its parent’s root lease.

### Part D — Lock in ordering, performance, and the revised contract
- **Ledger:** {"status":"completed","note":"Added delayed wrapper ordering coverage, composed lifecycle coverage, benchmark UI intervals, revised docs, and completed cold/active performance observation.","evidence":"npm --prefix pi/sandbox test; npm --prefix pi/sandbox run test:native; benchmark --samples 10: cold UI median 684.5ms / ready 2516.1ms, active UI median 751.5ms / ready 1004.7ms"}

Extend deterministic wrapper fixtures with a delayed controller to prove the real Pi/TUI marker appears before readiness, the handshake appears only afterward, and a prompt submitted in between remains pending. Update the former failed-image assertion: trusted Pi may now start and show the failure, but no model request, active replacement, host fallback, or successful handshake is allowed. Retain pre-UI failures for missing QEMU, Node, controller source, routing extension, or real Pi.

Add focused extension tests for non-blocking TUI `session_start`, `starting` lifecycle publication, delayed input and user-Bash continuation, one-time activation, plan-mode tool composition during startup, failure handling, non-interactive blocking, root versus inherited-child behavior, environment publication, acquisition cancellation, and lease release. Keep a production-shaped composed statusbar test so `starting`, `healthy`, `failed`, and `stopped` render through the real lifecycle consumer.

Enhance `benchmark-startup.mjs` tracing to report launch-to-host-UI and host-UI-to-sandbox-ready intervals in addition to total handshake time. A native TUI smoke test should use a delayed/cold VM and verify that the editor accepts text before `vm_start_complete`, then that the queued turn proceeds only after `docker_health_complete` and routing audit. Keep ordinary performance tests threshold-free, but compare at least ten cold and active-controller samples; retain the change only if time-to-UI is observably earlier and cold sandbox-ready median does not regress beyond noise. The expected cold total should improve by overlapping Pi’s roughly 0.8-second initialization with VM startup, while the active-controller path should remain near its current baseline.

Update `pi/sandbox/README.md` startup sequence and `pi/AGENTS.md` launcher invariants to document the new fail-closed readiness gate, lifecycle terms, queued-submit behavior, failure UX, root lease ownership, and unchanged exclusions. Do not describe the whole Pi process as VM-isolated.

Acceptance outcome: unit, wrapper, composed extension, child/inventory, complete sandbox, and native suites pass; traces prove UI-before-VM-ready ordering; queued turns prove no early model/tool execution; and documentation no longer claims that the host Pi process starts only after a healthy lease.

## Critical Files

- `bin/pi` — trusted preparation, early real-Pi spawn, sanitized startup descriptor, handshake supervision, signals, and emergency cleanup.
- `pi/sandbox/client-cli.mjs` and `pi/sandbox/client.mjs` — split controller begin/acquire lifecycle, model-scope overlap, cancellation, and root lease acquisition.
- `pi/agent/extensions/gondolin-sandbox/index.ts` and `events.ts` — readiness promise, input/Bash gates, lifecycle status, capability activation, and root/child lease ownership.
- `pi/sandbox/test-wrapper.sh`, extension/composed tests, and `benchmark-startup.mjs` — ordering, fail-closed, lifecycle, and performance evidence.
- `pi/sandbox/README.md` and `pi/AGENTS.md` — authoritative revised startup and containment contract.

## Verification

- **Regression checks:** Run Bash syntax/diff checks, the complete non-native sandbox suite, plan-mode/subagent/structured-question checks, and the required full native sandbox suite from an unsandboxed terminal. Confirm explicit model/tool flags, PATH filtering, model-cache behavior, inventory audits, session replacement, and `--yolo` remain unchanged.
- **New startup scenarios:** Delay VM readiness and verify TUI initialization and editable input occur first. Submit one turn and one `!` command while starting; each must wait and then execute once after health. Force image, VM, Docker, manifest, generation, inventory, and handshake failures independently; queued work must not reach the model or any tool.
- **Lease and process scenarios:** Exit or signal Pi before acquisition, between acquisition and activation, after readiness, and while a child is active. Verify no duplicate controller, leaked root lease, premature shared-controller stop, or child-owned release. Abrupt death must converge through lease expiry.
- **Performance observation:** Compare at least ten post-warm-up cold and active-controller samples with the current approximate medians of 3.1 seconds and 1.1 seconds. Report time-to-host-UI, time-to-sandbox-ready, phase ordering, medians/ranges, and real/metadata Pi process counts. Earlier UI plus unchanged fail-closed ordering is mandatory; a faster number caused by skipped image, Docker, generation, inventory, or handshake checks is failure.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Begin controller startup without waiting for readiness
- ☑ Gate queued turns on one extension-owned readiness promise
- ☑ Transfer lease lifecycle and child inheritance safely
- ☑ Lock in ordering, performance, and the revised contract
<!-- pi-plan-mode:progress:end -->
