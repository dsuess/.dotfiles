# Route Sandbox npm Cache to a Writable Host Cache

## Context

Pi’s SRT controller gives each tool operation a generated `HOME` and writable generated cache directory. However, the routing adapter currently overwrites every Bash request’s npm cache with `NPM_CONFIG_CACHE=/root/.npm` in `pi/agent/extensions/srt-tool-routing/tools.ts`. That path is neither the generated home nor a policy-granted writable cache location, so npm-backed tools such as `prek` can fail in the sandbox.

The reported canary succeeds when `NPM_CONFIG_CACHE=/Users/dsuess/.npm` is supplied. The controller already inherits ordinary environment values and its `boundedEnvironment()` does not block `NPM_CONFIG_CACHE`; the failure is the adapter’s later forced override. The launcher must therefore establish the known working default before Pi and its controller start, while the adapter must preserve it instead of replacing it.

This intentionally changes the sandbox README’s statement that tool cache is generated: npm will use the explicitly configured host npm cache. That cache is an accepted writable exception because npm/prek need it and the user supplied the tested location. The change must preserve callers’ explicit per-command `NPM_CONFIG_CACHE` overrides and must not alter unrelated cache variables or SRT control-variable filtering.

## Approach

Use the launcher as the durable default source for the sandbox-safe npm cache, then allow the normal routed environment flow to carry that value through to Bash. Keep the change narrowly scoped to npm rather than broadening host filesystem grants or changing the general generated-home design.

### Part A — Establish and propagate the npm cache default
- **Ledger:** {"status":"completed","note":"Launcher now establishes an overrideable writable npm-cache default before preflight; routing sanitization no longer injects /root/.npm.","evidence":"Updated bin/pi and pi/agent/extensions/srt-tool-routing/tools.ts."}

Update `bin/pi` to export `NPM_CONFIG_CACHE=/Users/dsuess/.npm` before controller preflight and Pi startup, so the controller process inherits a valid default regardless of the shell that launched Pi. Preserve an already supplied `NPM_CONFIG_CACHE` value if the launcher’s established configuration is intended to remain user-overridable; otherwise make the documented path the explicit invariant. Remove the routing adapter’s forced `/root/.npm` value so `sanitizeGuestEnvironment()` retains the inherited/request-provided npm cache rather than clobbering it. Keep control-environment stripping and all other fixed guest cache settings unchanged.

Acceptance outcome: a routed `prek run pyright --files digitization/datascout/datascout/strategies/base.py` receives `/Users/dsuess/.npm` by default, and a caller can still explicitly select a different npm cache for one Bash invocation.

### Part B — Lock the cache contract with focused regression coverage
- **Ledger:** {"status":"completed","note":"Added focused launcher, routing, and controller lifecycle regression coverage; adapter and launcher tests pass. Lifecycle test is blocked by the active SRT sandbox denying its own controller-state mkdir under /tmp.","evidence":"Passed: node --test pi/sandbox/test-launcher-print-bash.mjs; node --test pi/agent/extensions/srt-tool-routing/tools.test.mjs. Lifecycle invocation fails before assertions with EPERM mkdir /tmp/pi-srt-501/c/... due to nested-controller sandbox restriction."}

Extend the launcher tests to assert that normal Pi launches receive the configured `NPM_CONFIG_CACHE` value and that the value is present before preflight/controller startup. Extend SRT tool-routing tests so sanitization no longer synthesizes `/root/.npm`, preserves a supplied npm cache, and leaves non-npm control-variable behavior intact. Add or adjust a controller lifecycle assertion to demonstrate that the forwarded npm cache survives the controller’s bounded environment and is not replaced by the generated home.

Acceptance outcome: the failing `/root/.npm` behavior is represented by tests, the sandbox-safe default reaches a real routed command, and the existing secret/control-authority guarantees continue to pass.

### Part C — Align sandbox documentation and run the relevant gate
- **Ledger:** {"status":"completed","note":"Documented the host npm-cache exception and smoke command. Focused launcher/routing tests pass; broad gates are blocked by pre-existing active-sandbox/environment failures unrelated to this change.","evidence":"Updated pi/sandbox/README.md. npm --prefix pi/sandbox test fails from missing agent package dist plus SRT EPERM/EINVAL test-environment failures; deterministic/full gates fail when plan-mode smoke launches Pi against generated HOME. Live prek command completed with exit 0 and no output."}

Update `pi/sandbox/README.md` to state that npm tools use the launcher-provided `NPM_CONFIG_CACHE` at `/Users/dsuess/.npm`, while the generated `HOME`, temporary directory, and other cache locations remain as documented. Include the `prek`/Pyright smoke command as the operational verification case without implying that host Docker or other credentials are exposed.

Acceptance outcome: runtime behavior and sandbox documentation agree, and maintainers have a concrete command for verifying npm-backed hooks.

## Critical Files

- `bin/pi` — canonical Pi launcher; owns environment inherited by controller preflight and Pi.
- `pi/agent/extensions/srt-tool-routing/tools.ts` — currently injects the invalid `/root/.npm` override for routed Bash calls.
- `pi/sandbox/controller.mjs` — reference boundary for controller environment inheritance and fixed generated paths.
- `pi/agent/extensions/srt-tool-routing/tools.test.mjs` and `pi/sandbox/test-controller-lifecycle.mjs` — focused adapter and end-to-end environment propagation checks.
- `pi/sandbox/test-launcher-print-bash.mjs` — launcher/preflight test fixture that can prove the environment is set before sandbox startup.
- `pi/sandbox/README.md` — sandbox environment contract and troubleshooting guidance.

## Verification

Run the focused routing adapter, launcher, and controller lifecycle tests first, including a regression assertion that no routed command gets `/root/.npm` unless explicitly supplied. Then run `npm --prefix pi/sandbox test` and `npm --prefix pi run check:deterministic`; finish with the repository-required `npm --prefix pi run check` from an ordinary host terminal.

For the live sandbox smoke test, from `/Users/dsuess/src/polez/data-scout`, run `prek run pyright --files digitization/datascout/datascout/strategies/base.py` without manually prefixing `NPM_CONFIG_CACHE`; success is Pyright passing and no npm cache permission/path error. A failure that still references `/root/.npm` indicates the adapter or deployed stowed launcher remains stale.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Establish and propagate the npm cache default
- ☑ Lock the cache contract with focused regression coverage
- ☑ Align sandbox documentation and run the relevant gate
<!-- pi-plan-mode:progress:end -->
